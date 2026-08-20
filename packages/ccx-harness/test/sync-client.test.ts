import assert from "node:assert/strict";
import test from "node:test";
import { SessionStore } from "../src/session/store.ts";
import { redactionMarker, redactSecrets, redactString, truncationMarker, type SessionSyncBundle } from "../src/sync/bundle.ts";
import { SessionSyncClient, type SyncSendResult, type SyncTransport } from "../src/sync/client.ts";
import { SyncOutbox } from "../src/sync/outbox.ts";

class RecordingTransport implements SyncTransport {
  readonly sent: SessionSyncBundle[] = [];
  constructor(private readonly results: SyncSendResult[] = []) {}

  async send(bundle: SessionSyncBundle): Promise<SyncSendResult> {
    this.sent.push(bundle);
    return this.results.shift() ?? { ok: true };
  }
}

function fixture(options: { literals?: string[]; results?: SyncSendResult[] } = {}) {
  const store = new SessionStore(":memory:");
  const outbox = new SyncOutbox(store.unsafeDatabase());
  const transport = new RecordingTransport(options.results ?? []);
  const client = new SessionSyncClient({
    deviceId: "laptop-1",
    outbox,
    platform: "linux",
    redactLiterals: () => options.literals ?? [],
    retryCooldownMs: 1_000,
    sessions: store,
    transport
  });
  return { client, outbox, store, transport };
}

function seed(store: SessionStore): void {
  store.createSession({
    credentialFingerprint: "fp-a",
    id: "s1",
    mode: "code",
    model: "opus-5",
    provider: "acme",
    userId: "alice"
  });
  store.appendMessage("s1", "user", "hello");
  store.startTurn({ id: "t1", requestId: "r1", sessionId: "s1" });
  const call = store.recordToolCall({ args: { command: "env" }, name: "bash", source: "builtin", turnId: "t1" });
  store.completeToolCall(call, "ok", "PATH=/usr/bin", 9);
}

test("a successful flush ships everything once and empties the queue", async () => {
  const f = fixture();
  seed(f.store);

  const result = await f.client.flushOnce();
  assert.equal(result.status, "sent");
  assert.equal(result.sent, 4);
  assert.equal(f.outbox.depth(), 0);

  const second = await f.client.flushOnce();
  assert.equal(second.status, "empty", "nothing should ship twice");
  assert.equal(f.transport.sent.length, 1);
  f.store.close();
});

test("the bundle carries no user id for the collector to trust", async () => {
  const f = fixture();
  seed(f.store);
  await f.client.flushOnce();

  const wire = JSON.stringify(f.transport.sent[0]);
  assert.equal(wire.includes("alice"), false, "the wire format must not carry a claimed identity");
  assert.ok(f.transport.sent[0].sessions[0].credentialFingerprint);
  f.store.close();
});

test("this device's own key never reaches the collector", async () => {
  const apiKey = "an-issued-provider-key-value";
  const f = fixture({ literals: [apiKey] });
  f.store.createSession({
    credentialFingerprint: "fp-a",
    id: "s1",
    mode: "code",
    model: "opus-5",
    provider: "acme",
    userId: "alice"
  });
  f.store.appendMessage("s1", "user", `please run: curl -H "authorization: ${apiKey}" https://x`);

  await f.client.flushOnce();
  const wire = JSON.stringify(f.transport.sent[0]);
  assert.equal(wire.includes(apiKey), false);
  assert.ok(wire.includes(redactionMarker));
  f.store.close();
});

test("credential shapes in tool output are redacted", async () => {
  const f = fixture();
  f.store.createSession({
    credentialFingerprint: "fp-a",
    id: "s1",
    mode: "code",
    model: "opus-5",
    provider: "acme",
    userId: "alice"
  });
  f.store.startTurn({ id: "t1", requestId: "r1", sessionId: "s1" });
  const call = f.store.recordToolCall({ args: {}, name: "bash", source: "builtin", turnId: "t1" });
  f.store.completeToolCall(
    call,
    "ok",
    { stdout: "OPENAI_KEY=sk-abcdefghijklmnopqrstuvwx\nAWS=AKIAIOSFODNN7EXAMPLE" },
    3
  );

  await f.client.flushOnce();
  const wire = JSON.stringify(f.transport.sent[0]);
  assert.equal(wire.includes("sk-abcdefghijklmnopqrstuvwx"), false);
  assert.equal(wire.includes("AKIAIOSFODNN7EXAMPLE"), false);
  f.store.close();
});

test("a transient failure keeps the work queued and backs off", async () => {
  const f = fixture({ results: [{ message: "network down", ok: false, permanent: false }] });
  seed(f.store);

  const failed = await f.client.flushOnce(0);
  assert.equal(failed.status, "failed");
  assert.equal(failed.deadLettered, false);
  assert.equal(f.outbox.depth(), 4, "nothing may be acked before the collector accepts it");

  // Still inside the cooldown: the next tick must not hammer the collector.
  assert.equal((await f.client.flushOnce(500)).status, "empty");
  assert.equal(f.transport.sent.length, 1);

  const retried = await f.client.flushOnce(2_000);
  assert.equal(retried.status, "sent");
  assert.equal(f.outbox.depth(), 0);
  f.store.close();
});

test("a permanent rejection dead-letters instead of wedging the queue", async () => {
  const f = fixture({ results: [{ message: "collector responded 400", ok: false, permanent: true, status: 400 }] });
  seed(f.store);

  const result = await f.client.flushOnce(0);
  assert.equal(result.status, "failed");
  assert.equal(result.deadLettered, true);
  assert.equal(f.client.deadLetterCount(), 1);
  assert.equal(f.outbox.depth(), 0, "a bundle the collector will never accept must not block the queue");

  f.store.appendMessage("s1", "user", "queued after the poison batch");
  assert.equal((await f.client.flushOnce(1)).status, "sent");
  f.store.close();
});

test("rows deleted before they shipped are dropped, not resent forever", async () => {
  const f = fixture();
  seed(f.store);
  f.store.deleteSession("s1");

  const result = await f.client.flushOnce();
  assert.equal(result.status, "empty");
  assert.equal(result.dropped, 4);
  assert.equal(f.outbox.depth(), 0);
  assert.equal(f.transport.sent.length, 0, "an empty bundle is not worth a request");
  f.store.close();
});

test("a change made while a bundle is in flight ships on the next pass", async () => {
  const f = fixture();
  seed(f.store);
  await f.client.flushOnce();

  f.store.finishTurn("t1", "succeeded");
  const second = await f.client.flushOnce();
  assert.equal(second.status, "sent");
  assert.equal(f.transport.sent[1].turns[0]?.status, "succeeded");
  f.store.close();
});

test("redactString leaves ordinary prose alone", () => {
  const prose = "The sk- prefix marks an API key, and AKIA is an AWS one. Bearer with no token is fine.";
  assert.equal(redactString(prose), prose);
});

test("redactSecrets caps a runaway string and survives a cycle", () => {
  const long = "x".repeat(200_000);
  assert.ok(String(redactSecrets(long)).endsWith(truncationMarker));

  const cyclic: Record<string, unknown> = { name: "root" };
  cyclic.self = cyclic;
  assert.deepEqual(redactSecrets(cyclic), { name: "root", self: "[circular]" });
});

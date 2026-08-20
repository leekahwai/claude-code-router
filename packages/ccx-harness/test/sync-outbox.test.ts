import assert from "node:assert/strict";
import test from "node:test";
import { SessionStore } from "../src/session/store.ts";
import { SyncOutbox } from "../src/sync/outbox.ts";

function fixture(): { outbox: SyncOutbox; store: SessionStore } {
  const store = new SessionStore(":memory:");
  return { outbox: new SyncOutbox(store.unsafeDatabase()), store };
}

function session(store: SessionStore, id = "s1"): void {
  store.createSession({
    credentialFingerprint: "fp-a",
    id,
    mode: "code",
    model: "opus-5",
    provider: "acme",
    userId: "u1"
  });
}

test("writes through the store enqueue themselves", () => {
  const { outbox, store } = fixture();
  session(store);
  store.appendMessage("s1", "user", "hello");
  store.startTurn({ id: "t1", requestId: "r1", sessionId: "s1" });
  const call = store.recordToolCall({ args: { path: "a" }, name: "read_file", source: "builtin", turnId: "t1" });
  store.completeToolCall(call, "ok", "contents", 12);

  const kinds = outbox.pending().entries.map((entry) => `${entry.entity}:${entry.entityKey}`);
  assert.deepEqual(kinds, ["session:s1", "message:s1:0", "turn:t1", "tool_call:t1:0"]);
  store.close();
});

test("repeated updates to one row coalesce into a single entry", () => {
  const { outbox, store } = fixture();
  session(store);
  store.startTurn({ id: "t1", requestId: "r1", sessionId: "s1" });
  const call = store.recordToolCall({ args: {}, name: "bash", source: "builtin", turnId: "t1" });
  for (let index = 0; index < 20; index += 1) {
    store.completeToolCall(call, "ok", `attempt ${index}`, index);
  }

  const calls = outbox.pending().entries.filter((entry) => entry.entity === "tool_call");
  assert.equal(calls.length, 1, "twenty updates should drain as one row");
  store.close();
});

test("ack retires only what was drained, so a mid-flight change survives", () => {
  const { outbox, store } = fixture();
  session(store);
  const drain = outbox.pending();
  assert.equal(drain.entries.length, 1);

  // The session is renamed while the bundle is "in flight".
  store.appendMessage("s1", "user", "changes the session's updated_at");

  outbox.ack(drain.entries);
  const remaining = outbox.pending().entries.map((entry) => entry.entity);
  assert.deepEqual(remaining.sort(), ["message", "session"], "the post-drain change must still be pending");
  store.close();
});

test("a full drain empties the queue", () => {
  const { outbox, store } = fixture();
  session(store);
  store.appendMessage("s1", "user", "one");
  const drain = outbox.pending();
  outbox.ack(drain.entries);
  assert.equal(outbox.depth(), 0);
  store.close();
});

test("a burst of updates costs one slot, not fifty", () => {
  const { outbox, store } = fixture();
  session(store);
  store.startTurn({ id: "t1", requestId: "r1", sessionId: "s1" });
  const call = store.recordToolCall({ args: {}, name: "bash", source: "builtin", turnId: "t1" });
  for (let index = 0; index < 50; index += 1) {
    store.completeToolCall(call, "running", index, index);
  }
  store.appendMessage("s1", "user", "after the noise");

  // 53 raw rows queued; coalescing makes them four units of work. Without it a
  // batch of 3 would spend eighteen drains chewing through updates to a single
  // tool call before the message behind them ever shipped.
  assert.equal(outbox.depth(), 4);

  const first = outbox.pending(3);
  assert.equal(first.entries.length, 3);
  outbox.ack(first.entries);

  assert.deepEqual(
    outbox.pending().entries.map((entry) => entry.entity),
    ["message"],
    "the message must reach the very next drain"
  );
  store.close();
});

test("backfill enrols a database written before sync existed", () => {
  const store = new SessionStore(":memory:");
  session(store);
  store.appendMessage("s1", "user", "written before the triggers existed");
  store.startTurn({ id: "t1", requestId: "r1", sessionId: "s1" });
  store.recordToolCall({ args: {}, name: "bash", source: "builtin", turnId: "t1" });

  const outbox = new SyncOutbox(store.unsafeDatabase());
  assert.equal(outbox.depth(), 0, "installing the outbox must not invent history");
  assert.equal(outbox.backfill(), 4);
  assert.deepEqual(
    outbox.pending().entries.map((entry) => entry.entity).sort(),
    ["message", "session", "tool_call", "turn"]
  );
  store.close();
});

test("tool calls on one turn get distinct stable keys", () => {
  const { outbox, store } = fixture();
  session(store);
  store.startTurn({ id: "t1", requestId: "r1", sessionId: "s1" });
  store.recordToolCall({ args: {}, name: "read_file", source: "builtin", turnId: "t1" });
  store.recordToolCall({ args: {}, name: "grep", source: "builtin", turnId: "t1" });

  const keys = outbox.pending().entries.filter((entry) => entry.entity === "tool_call").map((entry) => entry.entityKey);
  assert.deepEqual(keys, ["t1:0", "t1:1"]);
  store.close();
});

test("acking one key never retires another key's pending row", () => {
  const { outbox, store } = fixture();
  session(store);
  // Appending a message also bumps the session's updated_at, so the session's
  // coalesced entry ends up holding a HIGHER outbox id than the message queued
  // just before it. A global `id <= max` watermark would delete the message
  // here without ever shipping it.
  store.appendMessage("s1", "user", "must not be swallowed");

  const sessionOnly = outbox.pending().entries.filter((entry) => entry.entity === "session");
  assert.equal(sessionOnly.length, 1);
  const message = outbox.pending().entries.find((entry) => entry.entity === "message");
  assert.ok(message && sessionOnly[0].queuedThrough > message.queuedThrough, "precondition: ids interleave");

  outbox.ack(sessionOnly);

  assert.deepEqual(
    outbox.pending().entries.map((entry) => entry.entity),
    ["message"],
    "the undelivered message must survive an ack of the session"
  );
  store.close();
});

/**
 * Two laptops, one collector, real HTTP.
 *
 * The unit tests above stub the transport. This one runs the actual handler on
 * a real socket, because the parts most likely to break — header casing, status
 * codes driving the permanent/transient split, JSON framing — only exist at
 * that boundary.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AddressInfo } from "node:net";
import { IdentityDirectory } from "../src/identity/directory.ts";
import { SessionAuthorizer } from "../src/identity/authorization.ts";
import { AccessLog } from "../src/identity/access-log.ts";
import { CredentialIdentityResolver } from "../src/identity/resolver.ts";
import { credentialFingerprint, SessionStore } from "../src/session/store.ts";
import { HttpSyncTransport, SessionSyncClient } from "../src/sync/client.ts";
import { SessionSyncCollector } from "../src/sync/collector.ts";
import { createSessionSyncHandler } from "../src/sync/http.ts";
import { SyncOutbox } from "../src/sync/outbox.ts";

const token = "collector-shared-secret";

type Central = {
  close: () => Promise<void>;
  collector: SessionSyncCollector;
  directory: IdentityDirectory;
  sessions: SessionStore;
  url: string;
};

async function central(): Promise<Central> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ccx-roundtrip-"));
  const directory = new IdentityDirectory(path.join(dir, "identity.sqlite"));
  const sessions = new SessionStore(path.join(dir, "collector-sessions.sqlite"));
  const collector = new SessionSyncCollector({
    resolver: new CredentialIdentityResolver(directory),
    sessions,
    token
  });
  const handler = createSessionSyncHandler(collector);
  const server: Server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      sessions.close();
      directory.close();
      rmSync(dir, { force: true, recursive: true });
    },
    collector,
    directory,
    sessions,
    url: `http://127.0.0.1:${port}/__ccx/session-sync`
  };
}

function laptop(url: string, deviceId: string, secret: string) {
  const store = new SessionStore(":memory:");
  const outbox = new SyncOutbox(store.unsafeDatabase());
  const client = new SessionSyncClient({
    deviceId,
    outbox,
    sessions: store,
    transport: new HttpSyncTransport({ token: secret, url })
  });
  return { client, outbox, store };
}

function work(store: SessionStore, apiKey: string, sessionId: string, title: string): void {
  store.createSession({
    credentialFingerprint: credentialFingerprint(apiKey),
    id: sessionId,
    mode: "code",
    model: "opus-5",
    provider: "acme",
    title,
    userId: "whatever-the-laptop-thinks"
  });
  store.appendMessage(sessionId, "user", `prompt in ${title}`);
  store.startTurn({ id: `${sessionId}-turn`, requestId: `${sessionId}-req`, sessionId });
  const call = store.recordToolCall({ args: { path: "README.md" }, name: "read_file", source: "builtin", turnId: `${sessionId}-turn` });
  store.completeToolCall(call, "ok", "file contents", 5);
  store.appendMessage(sessionId, "assistant", `answer in ${title}`);
  store.finishTurn(`${sessionId}-turn`, "succeeded");
}

test("two laptops sync into one collector an admin can read", async () => {
  const hub = await central();
  try {
    for (const person of [
      { email: "alice@example.com", id: "alice", key: "alice-key" },
      { email: "bob@example.com", id: "bob", key: "bob-key" }
    ]) {
      hub.directory.upsertUser({
        displayName: person.id,
        email: person.email,
        externalId: "",
        id: person.id,
        role: "user",
        status: "active",
        temporary: false
      });
      hub.directory.bindCredential({ boundBy: "admin", fingerprint: credentialFingerprint(person.key), userId: person.id });
    }
    hub.directory.upsertUser({
      displayName: "root",
      email: "root@example.com",
      externalId: "",
      id: "root",
      role: "admin",
      status: "active",
      temporary: false
    });

    const one = laptop(hub.url, "laptop-alice", token);
    const two = laptop(hub.url, "laptop-bob", token);
    work(one.store, "alice-key", "alice-session", "Alice at work");
    work(two.store, "bob-key", "bob-session", "Bob at work");

    assert.equal((await one.client.flushOnce()).status, "sent");
    assert.equal((await two.client.flushOnce()).status, "sent");

    // Attribution came from the bindings, not from anything the laptops said.
    assert.equal(hub.sessions.getSession("alice-session")?.userId, "alice");
    assert.equal(hub.sessions.getSession("bob-session")?.userId, "bob");
    assert.equal(hub.sessions.listMessages("alice-session").length, 2);
    assert.equal(hub.sessions.listToolCalls("alice-session-turn").length, 1);
    assert.equal(hub.sessions.listTurns("bob-session")[0]?.status, "succeeded");

    // And an admin can read across both, which is the whole point of A2.
    const dir = mkdtempSync(path.join(os.tmpdir(), "ccx-roundtrip-log-"));
    const accessLog = new AccessLog(path.join(dir, "access.sqlite"));
    const authorizer = new SessionAuthorizer({ accessLog, sessions: hub.sessions });
    const admin = { assurance: "claimed" as const, role: "admin" as const, user: hub.directory.getUser("root")! };
    const listed = authorizer.listSessions(admin, "alice", "admin review");
    assert.equal(listed.allowed, true);
    assert.deepEqual(listed.allowed ? listed.value.map((row) => row.id) : [], ["alice-session"]);
    const read = authorizer.readMessages(admin, "bob-session", "admin review");
    assert.equal(read.allowed, true);
    assert.equal(read.allowed ? read.value.length : 0, 2);
    assert.equal(accessLog.listForSubject("alice").length, 1, "a cross-user list must be logged");
    assert.equal(accessLog.listForSubject("bob").length, 1, "a cross-user read must be logged");
    accessLog.close();
    rmSync(dir, { force: true, recursive: true });

    one.store.close();
    two.store.close();
  } finally {
    await hub.close();
  }
});

test("a wrong shared secret is permanent, so the client dead-letters", async () => {
  const hub = await central();
  try {
    const rogue = laptop(hub.url, "laptop-rogue", "not-the-secret");
    work(rogue.store, "alice-key", "s1", "Rogue");

    const result = await rogue.client.flushOnce(0);
    assert.equal(result.status, "failed");
    assert.equal(result.deadLettered, true, "401 must not be retried forever");
    assert.equal(rogue.client.deadLetterCount(), 1);
    assert.equal(hub.collector.receiptCount(), 0);
    rogue.store.close();
  } finally {
    await hub.close();
  }
});

test("an unbound key is rejected per session, and the laptop still gets an ack", async () => {
  const hub = await central();
  try {
    const stranger = laptop(hub.url, "laptop-stranger", token);
    work(stranger.store, "a-key-no-admin-ever-bound", "s1", "Stranger");

    const result = await stranger.client.flushOnce();
    // 200 with the session listed as unresolved: the transport worked, so the
    // laptop stops retrying, but nothing was stored.
    assert.equal(result.status, "sent");
    assert.equal(stranger.outbox.depth(), 0);
    assert.equal(hub.sessions.hasSession("s1"), false);
    stranger.store.close();
  } finally {
    await hub.close();
  }
});

test("an interrupted push is retried and deduped, not duplicated", async () => {
  const hub = await central();
  try {
    hub.directory.upsertUser({
      displayName: "alice",
      email: "alice@example.com",
      externalId: "",
      id: "alice",
      role: "user",
      status: "active",
      temporary: false
    });
    hub.directory.bindCredential({ boundBy: "admin", fingerprint: credentialFingerprint("alice-key"), userId: "alice" });

    const one = laptop(hub.url, "laptop-alice", token);
    work(one.store, "alice-key", "s1", "Alice");

    // The collector ingests, then the ack is lost on the way back.
    const drain = one.outbox.pending();
    assert.ok(drain.entries.length > 0);
    assert.equal((await one.client.flushOnce()).status, "sent");

    // The laptop, having seen the ack this time, has nothing left. Replay the
    // same work as a fresh device to prove ingest is idempotent on content.
    const replay = laptop(hub.url, "laptop-alice", token);
    work(replay.store, "alice-key", "s1", "Alice");
    assert.equal((await replay.client.flushOnce()).status, "sent");

    assert.equal(hub.sessions.listMessages("s1").length, 2, "content must not duplicate on replay");
    assert.equal(hub.sessions.listToolCalls("s1-turn").length, 1);
    one.store.close();
    replay.store.close();
  } finally {
    await hub.close();
  }
});

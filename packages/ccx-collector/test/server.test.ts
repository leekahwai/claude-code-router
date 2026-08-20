import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  credentialFingerprint,
  HttpSyncTransport,
  SessionStore,
  SessionSyncClient,
  SyncOutbox
} from "@ccx/harness";
import { startCollector } from "../src/server.ts";

const apiKey = "issued-to-alice";
const token = "collector-token";

async function collector() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "ccx-collector-server-"));
  const running = await startCollector({ dataDir, token });
  running.directory.upsertUser({
    displayName: "Alice",
    email: "alice@example.com",
    externalId: "",
    id: "alice",
    role: "user",
    status: "active",
    temporary: false
  });
  running.directory.bindCredential({ boundBy: "admin", fingerprint: credentialFingerprint(apiKey), userId: "alice" });
  return {
    ...running,
    dispose: async () => {
      await running.close();
      rmSync(dataDir, { force: true, recursive: true });
    }
  };
}

function laptop(url: string) {
  const store = new SessionStore(":memory:");
  const client = new SessionSyncClient({
    deviceId: "laptop-1",
    outbox: new SyncOutbox(store.unsafeDatabase()),
    sessions: store,
    transport: new HttpSyncTransport({ token, url })
  });
  return { client, store };
}

test("a laptop syncs into the standalone collector", async () => {
  const hub = await collector();
  try {
    const one = laptop(hub.url);
    one.store.createSession({
      credentialFingerprint: credentialFingerprint(apiKey),
      id: "s1",
      mode: "code",
      model: "opus-5",
      provider: "acme",
      title: "real work",
      userId: "ignored-by-the-collector"
    });
    one.store.appendMessage("s1", "user", "hello collector");

    assert.equal((await one.client.flushOnce()).status, "sent");
    assert.equal(hub.sessions.getSession("s1")?.userId, "alice");
    assert.equal(hub.sessions.listMessages("s1").length, 1);
    one.store.close();
  } finally {
    await hub.dispose();
  }
});

test("healthz reports how much has arrived", async () => {
  const hub = await collector();
  try {
    const before = await (await fetch(`http://127.0.0.1:${hub.port}/healthz`)).json();
    assert.deepEqual(before, { ok: true, receipts: 0 });

    const one = laptop(hub.url);
    one.store.createSession({
      credentialFingerprint: credentialFingerprint(apiKey),
      id: "s1",
      mode: "work",
      model: "opus-5",
      provider: "acme",
      userId: "x"
    });
    await one.client.flushOnce();

    const after = await (await fetch(`http://127.0.0.1:${hub.port}/healthz`)) .json() as { receipts: number };
    assert.equal(after.receipts, 1);
    one.store.close();
  } finally {
    await hub.dispose();
  }
});

test("unknown paths and methods are refused", async () => {
  const hub = await collector();
  try {
    assert.equal((await fetch(`http://127.0.0.1:${hub.port}/anything`)).status, 404);
    assert.equal((await fetch(hub.url)).status, 405, "GET on the sync path is not allowed");
    assert.equal(
      (await fetch(hub.url, { body: "{}", headers: { "x-ccx-session-sync": "wrong" }, method: "POST" })).status,
      401
    );
    assert.equal(
      (await fetch(hub.url, { body: "not json", headers: { "x-ccx-session-sync": token }, method: "POST" })).status,
      400
    );
  } finally {
    await hub.dispose();
  }
});

test("an admin can read every synced session through the authorizer", async () => {
  const hub = await collector();
  try {
    hub.directory.upsertUser({
      displayName: "Root",
      email: "root@example.com",
      externalId: "",
      id: "root",
      role: "admin",
      status: "active",
      temporary: false
    });
    const one = laptop(hub.url);
    one.store.createSession({
      credentialFingerprint: credentialFingerprint(apiKey),
      id: "s1",
      mode: "code",
      model: "opus-5",
      provider: "acme",
      userId: "x"
    });
    one.store.appendMessage("s1", "user", "reviewed later");
    await one.client.flushOnce();

    const admin = { assurance: "claimed" as const, role: "admin" as const, user: hub.directory.getUser("root")! };
    const listed = hub.authorizer.listSessions(admin, "alice", "compliance review");
    assert.equal(listed.allowed, true);
    assert.deepEqual(listed.allowed ? listed.value.map((row) => row.id) : [], ["s1"]);

    const alice = { assurance: "claimed" as const, role: "user" as const, user: hub.directory.getUser("alice")! };
    assert.equal(hub.authorizer.listSessions(alice, "root").allowed, false, "a user may not read another's");
    one.store.close();
  } finally {
    await hub.dispose();
  }
});

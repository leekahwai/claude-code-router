import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CcxConfigStore,
  createSessionSyncHandler,
  credentialFingerprint,
  CredentialIdentityResolver,
  IdentityDirectory,
  SessionStore,
  SessionSyncCollector,
  SyncOutbox
} from "@ccx/harness";
import { startTranscriptSync } from "../src/sync-wiring.ts";

const apiKey = "an-issued-key";
const token = "shared";

type Harness = {
  close: () => Promise<void>;
  config: CcxConfigStore;
  collectorSessions: SessionStore;
  dataDir: string;
  sessions: SessionStore;
  url: string;
};

async function harness(): Promise<Harness> {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "ccx-wiring-"));
  const directory = new IdentityDirectory(path.join(dataDir, "identity.sqlite"));
  directory.upsertUser({
    displayName: "Alice",
    email: "alice@example.com",
    externalId: "",
    id: "alice",
    role: "user",
    status: "active",
    temporary: false
  });
  directory.bindCredential({ boundBy: "admin", fingerprint: credentialFingerprint(apiKey), userId: "alice" });

  const collectorSessions = new SessionStore(path.join(dataDir, "collector.sqlite"));
  const handler = createSessionSyncHandler(
    new SessionSyncCollector({
      resolver: new CredentialIdentityResolver(directory),
      sessions: collectorSessions,
      token
    })
  );
  const server: Server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      collectorSessions.close();
      directory.close();
      rmSync(dataDir, { force: true, recursive: true });
    },
    collectorSessions,
    config: new CcxConfigStore(dataDir),
    dataDir,
    sessions: new SessionStore(path.join(dataDir, "sessions.sqlite")),
    url: `http://127.0.0.1:${port}/__ccx/session-sync`
  };
}

function enableSync(config: CcxConfigStore, url: string): void {
  const current = config.load();
  config.save({ ...current, sync: { ...current.sync, collectorUrl: url, token } });
}

test("sync stays off until an administrator configures a collector", async () => {
  const h = await harness();
  try {
    assert.equal(startTranscriptSync({ apiKey, config: h.config, sessions: h.sessions }), undefined);

    // No outbox table, so a machine with sync off does not accumulate a queue.
    const tables = h.sessions
      .unsafeDatabase()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ccx_sync_outbox'")
      .all();
    assert.deepEqual(tables, []);

    // A device id is still minted, so enabling sync later needs no migration.
    assert.match(h.config.load().sync.deviceId, /^[0-9a-f-]{36}$/);
    h.sessions.close();
  } finally {
    await h.close();
  }
});

test("switching sync on ships the history already on disk, exactly once", async () => {
  const h = await harness();
  try {
    h.sessions.createSession({
      credentialFingerprint: credentialFingerprint(apiKey),
      id: "s1",
      mode: "code",
      model: "opus-5",
      provider: "acme",
      title: "before sync existed",
      userId: "alice"
    });
    h.sessions.appendMessage("s1", "user", "an older conversation");

    enableSync(h.config, h.url);
    const client = startTranscriptSync({ apiKey, config: h.config, sessions: h.sessions });
    assert.ok(client);
    client.stop();

    assert.equal((await client.flushOnce()).status, "sent");
    assert.equal(h.collectorSessions.getSession("s1")?.userId, "alice");
    assert.equal(h.collectorSessions.listMessages("s1").length, 1);
    assert.ok(h.config.load().sync.backfilledAt, "the backfill marker must be recorded");

    // A second launch must not re-queue the whole history.
    const relaunched = startTranscriptSync({ apiKey, config: h.config, sessions: h.sessions });
    assert.ok(relaunched);
    relaunched.stop();
    assert.equal(new SyncOutbox(h.sessions.unsafeDatabase()).depth(), 0);
    h.sessions.close();
  } finally {
    await h.close();
  }
});

test("the device's own key is stripped from what it ships", async () => {
  const h = await harness();
  try {
    enableSync(h.config, h.url);
    const client = startTranscriptSync({ apiKey, config: h.config, sessions: h.sessions });
    assert.ok(client);
    client.stop();

    h.sessions.createSession({
      credentialFingerprint: credentialFingerprint(apiKey),
      id: "s1",
      mode: "code",
      model: "opus-5",
      provider: "acme",
      userId: "alice"
    });
    h.sessions.appendMessage("s1", "user", `my key is ${apiKey}, please use it`);
    await client.flushOnce();

    const stored = JSON.stringify(h.collectorSessions.listMessages("s1")[0]?.content);
    assert.equal(stored.includes(apiKey), false);
    assert.ok(stored.includes("[redacted]"));
    h.sessions.close();
  } finally {
    await h.close();
  }
});

test("work done offline catches up when the collector comes back", async () => {
  const h = await harness();
  try {
    // Point at a port nothing is listening on: the laptop is on a train.
    const current = h.config.load();
    h.config.save({ ...current, sync: { ...current.sync, collectorUrl: "http://127.0.0.1:1/nope", token } });
    const offline = startTranscriptSync({ apiKey, config: h.config, sessions: h.sessions });
    assert.ok(offline);
    offline.stop();

    h.sessions.createSession({
      credentialFingerprint: credentialFingerprint(apiKey),
      id: "s1",
      mode: "work",
      model: "opus-5",
      provider: "acme",
      userId: "alice"
    });
    h.sessions.appendMessage("s1", "user", "written while offline");

    const failed = await offline.flushOnce(0);
    assert.equal(failed.status, "failed");
    assert.equal(failed.deadLettered, false, "an unreachable collector is transient, not poison");
    assert.equal(offline.deadLetterCount(), 0);
    assert.equal(new SyncOutbox(h.sessions.unsafeDatabase()).depth(), 2, "the work is still queued");

    // Back on the network.
    enableSync(h.config, h.url);
    const online = startTranscriptSync({ apiKey, config: h.config, sessions: h.sessions });
    assert.ok(online);
    online.stop();
    assert.equal((await online.flushOnce()).status, "sent");
    assert.equal(h.collectorSessions.listMessages("s1").length, 1);
    h.sessions.close();
  } finally {
    await h.close();
  }
});

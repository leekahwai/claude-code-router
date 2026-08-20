import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { IdentityDirectory } from "../src/identity/directory.ts";
import { CredentialIdentityResolver } from "../src/identity/resolver.ts";
import { credentialFingerprint, SessionStore } from "../src/session/store.ts";
import { SESSION_SYNC_SCHEMA, type SessionSyncBundle } from "../src/sync/bundle.ts";
import { SessionSyncCollector } from "../src/sync/collector.ts";

const aliceKey = "key-for-alice";
const bobKey = "key-for-bob";

type Fixture = {
  close: () => void;
  collector: SessionSyncCollector;
  directory: IdentityDirectory;
  sessions: SessionStore;
};

function fixture(options: { token?: string } = {}): Fixture {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ccx-collector-"));
  const directory = new IdentityDirectory(path.join(dir, "identity.sqlite"));
  for (const person of [
    { email: "alice@example.com", id: "alice", key: aliceKey },
    { email: "bob@example.com", id: "bob", key: bobKey }
  ]) {
    directory.upsertUser({
      displayName: person.id,
      email: person.email,
      externalId: "",
      id: person.id,
      role: "user",
      status: "active",
      temporary: false
    });
    directory.bindCredential({ boundBy: "admin", fingerprint: credentialFingerprint(person.key), userId: person.id });
  }
  const sessions = new SessionStore(":memory:");
  const collector = new SessionSyncCollector({
    resolver: new CredentialIdentityResolver(directory),
    sessions,
    ...(options.token ? { token: options.token } : {})
  });
  return {
    close: () => {
      sessions.close();
      directory.close();
      rmSync(dir, { force: true, recursive: true });
    },
    collector,
    directory,
    sessions
  };
}

function bundle(overrides: Partial<SessionSyncBundle> = {}): SessionSyncBundle {
  return {
    bundleId: "b1",
    device: { id: "laptop-1", platform: "linux" },
    messages: [],
    schema: SESSION_SYNC_SCHEMA,
    sessions: [],
    toolCalls: [],
    turns: [],
    ...overrides
  };
}

function syncSession(id: string, key: string) {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    credentialFingerprint: credentialFingerprint(key),
    id,
    mode: "code" as const,
    model: "opus-5",
    policyVersion: "v1",
    profileId: "ccx-code",
    provider: "acme",
    title: "a session",
    updatedAt: "2026-01-01T00:01:00.000Z",
    workspaceDir: "/home/alice/project"
  };
}

test("the person is resolved from the fingerprint, not taken from the wire", () => {
  const f = fixture();
  try {
    const outcome = f.collector.ingest({
      ...bundle({ sessions: [syncSession("s1", aliceKey)] }),
      // A hostile client trying to file its transcript under Bob. The format
      // has no userId field, so this is ignored rather than trusted.
      sessions: [{ ...syncSession("s1", aliceKey), userId: "bob" }]
    });
    assert.equal(outcome.ok, true);
    assert.equal(f.sessions.getSession("s1")?.userId, "alice");
  } finally {
    f.close();
  }
});

test("a session cannot be re-attributed by a later bundle", () => {
  const f = fixture();
  try {
    f.collector.ingest(bundle({ sessions: [syncSession("s1", aliceKey)] }));
    // Bob's laptop claims the same session id with his own fingerprint.
    const second = f.collector.ingest(
      bundle({ bundleId: "b2", sessions: [{ ...syncSession("s1", bobKey), title: "renamed" }] })
    );
    assert.equal(second.ok, true);

    const stored = f.sessions.getSession("s1");
    assert.equal(stored?.userId, "alice", "ownership is write-once");
    assert.equal(stored?.credentialFingerprint, credentialFingerprint(aliceKey));
    assert.equal(stored?.title, "renamed", "mutable metadata still updates");
  } finally {
    f.close();
  }
});

test("an unresolvable fingerprint drops its session but not the bundle", () => {
  const f = fixture();
  try {
    const outcome = f.collector.ingest(
      bundle({
        messages: [
          { content: "kept", createdAt: "t", role: "user", seq: 0, sessionId: "s1" },
          { content: "dropped", createdAt: "t", role: "user", seq: 0, sessionId: "s2" }
        ],
        sessions: [syncSession("s1", aliceKey), syncSession("s2", "a-key-nobody-bound")]
      })
    );

    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.unresolvedSessions, ["s2"]);
    assert.equal(outcome.accepted.sessions, 1);
    assert.equal(outcome.accepted.messages, 1, "the orphan message must not be stored");
    assert.equal(f.sessions.hasSession("s2"), false);
  } finally {
    f.close();
  }
});

test("a revoked key stops new transcripts arriving", () => {
  const f = fixture();
  try {
    f.directory.revokeCredential(credentialFingerprint(aliceKey));
    const outcome = f.collector.ingest(bundle({ sessions: [syncSession("s1", aliceKey)] }));
    assert.deepEqual(outcome.unresolvedSessions, ["s1"]);
    assert.equal(f.sessions.hasSession("s1"), false);
  } finally {
    f.close();
  }
});

test("messages are write-once, so a laptop cannot revise history", () => {
  const f = fixture();
  try {
    f.collector.ingest(
      bundle({
        messages: [{ content: "the original", createdAt: "t", role: "user", seq: 0, sessionId: "s1" }],
        sessions: [syncSession("s1", aliceKey)]
      })
    );
    f.collector.ingest(
      bundle({
        bundleId: "b2",
        messages: [{ content: "rewritten", createdAt: "t", role: "user", seq: 0, sessionId: "s1" }]
      })
    );
    assert.equal(f.sessions.listMessages("s1")[0]?.content, "the original");
  } finally {
    f.close();
  }
});

test("a repeated bundle id is accepted once", () => {
  const f = fixture();
  try {
    const payload = bundle({
      messages: [{ content: "hi", createdAt: "t", role: "user", seq: 0, sessionId: "s1" }],
      sessions: [syncSession("s1", aliceKey)]
    });
    const first = f.collector.ingest(payload);
    const second = f.collector.ingest(payload);

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.accepted.messages, 0);
    assert.equal(f.collector.receiptCount(), 1);
  } finally {
    f.close();
  }
});

test("a later bundle attaches to a session the collector already holds", () => {
  const f = fixture();
  try {
    f.collector.ingest(bundle({ sessions: [syncSession("s1", aliceKey)] }));
    const outcome = f.collector.ingest(
      bundle({
        bundleId: "b2",
        messages: [{ content: "later", createdAt: "t", role: "assistant", seq: 0, sessionId: "s1" }],
        toolCalls: [
          {
            approvedBy: "policy",
            args: { path: "a" },
            durationMs: 4,
            name: "read_file",
            result: "ok",
            seq: 0,
            server: "",
            source: "builtin" as const,
            status: "ok" as const,
            turnId: "t1"
          }
        ],
        turns: [
          {
            endedAt: "",
            error: "",
            id: "t1",
            requestId: "r1",
            sessionId: "s1",
            startedAt: "2026-01-01T00:02:00.000Z",
            status: "running" as const
          }
        ]
      })
    );

    assert.equal(outcome.accepted.messages, 1);
    assert.equal(outcome.accepted.turns, 1);
    assert.equal(outcome.accepted.toolCalls, 1);
    assert.equal(f.sessions.listToolCalls("t1").length, 1);
  } finally {
    f.close();
  }
});

test("tool calls from two machines with the same local id stay distinct", () => {
  const f = fixture();
  try {
    f.collector.ingest(
      bundle({
        sessions: [syncSession("s1", aliceKey)],
        turns: [
          { endedAt: "", error: "", id: "t1", requestId: "r1", sessionId: "s1", startedAt: "a", status: "running" as const }
        ]
      })
    );
    f.collector.ingest(
      bundle({
        bundleId: "b2",
        sessions: [syncSession("s2", bobKey)],
        turns: [
          { endedAt: "", error: "", id: "t2", requestId: "r2", sessionId: "s2", startedAt: "a", status: "running" as const }
        ]
      })
    );

    // Both laptops recorded this as their local tool call id 1, seq 0.
    for (const turnId of ["t1", "t2"]) {
      f.collector.ingest(
        bundle({
          bundleId: `call-${turnId}`,
          toolCalls: [
            {
              approvedBy: "",
              args: {},
              durationMs: 1,
              name: `from-${turnId}`,
              result: null,
              seq: 0,
              server: "",
              source: "builtin" as const,
              status: "ok" as const,
              turnId
            }
          ]
        })
      );
    }

    assert.equal(f.sessions.listToolCalls("t1")[0]?.name, "from-t1");
    assert.equal(f.sessions.listToolCalls("t2")[0]?.name, "from-t2");
  } finally {
    f.close();
  }
});

test("a malformed bundle is rejected whole", () => {
  const f = fixture();
  try {
    const outcome = f.collector.ingest({ ...bundle(), schema: "ccx.session-sync.v99" });
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /unsupported schema/);
    assert.equal(f.collector.receiptCount(), 0);
  } finally {
    f.close();
  }
});

test("the shared secret gates the transport", () => {
  const f = fixture({ token: "s3cret" });
  try {
    assert.equal(f.collector.authorize("s3cret"), true);
    assert.equal(f.collector.authorize("wrong"), false);
    assert.equal(f.collector.authorize(undefined), false);
  } finally {
    f.close();
  }
});

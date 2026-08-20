import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionStore, credentialFingerprint } from "../src/session/store.ts";

function store(): { close: () => void; value: SessionStore } {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ccx-sessions-"));
  const value = new SessionStore(path.join(directory, "sessions.sqlite"));
  return {
    close: () => {
      value.close();
      rmSync(directory, { force: true, recursive: true });
    },
    value
  };
}

const base = {
  credentialFingerprint: credentialFingerprint("sk-test-key"),
  mode: "code" as const,
  model: "claude-opus-5",
  provider: "anthropic",
  userId: "ada"
};

test("the credential fingerprint is a hash, never the key", () => {
  const key = "sk-ant-secret-value";
  const fingerprint = credentialFingerprint(key);
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(!fingerprint.includes(key));
  assert.equal(fingerprint, credentialFingerprint(`  ${key}  `), "surrounding whitespace must not change identity");
  assert.notEqual(fingerprint, credentialFingerprint("sk-ant-other-value"));
});

test("creates and reads back a session", () => {
  const { close, value } = store();
  try {
    const session = value.createSession({ ...base, id: "s1", title: "Refactor auth" });
    assert.equal(session.id, "s1");
    assert.equal(session.userId, "ada");
    assert.equal(session.mode, "code");
    assert.equal(session.model, "claude-opus-5");
    assert.deepEqual(value.getSession("s1"), session);
  } finally {
    close();
  }
});

test("messages keep insertion order and get contiguous sequence numbers", () => {
  const { close, value } = store();
  try {
    value.createSession({ ...base, id: "s1" });
    value.appendMessage("s1", "user", "first");
    value.appendMessage("s1", "assistant", [{ text: "second", type: "text" }]);
    value.appendMessage("s1", "user", "third");

    const messages = value.listMessages("s1");
    assert.deepEqual(messages.map((message) => message.seq), [0, 1, 2]);
    assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "user"]);
    assert.deepEqual(messages[1].content, [{ text: "second", type: "text" }]);
  } finally {
    close();
  }
});

test("appending a message touches the session's updated_at", () => {
  const { close, value } = store();
  try {
    value.createSession({ ...base, createdAt: "2026-01-01T00:00:00.000Z", id: "s1" });
    value.appendMessage("s1", "user", "hello", "2026-01-02T00:00:00.000Z");
    assert.equal(value.getSession("s1")?.updatedAt, "2026-01-02T00:00:00.000Z");
  } finally {
    close();
  }
});

test("turns record their gateway request id and terminal status", () => {
  const { close, value } = store();
  try {
    value.createSession({ ...base, id: "s1" });
    value.startTurn({ id: "t1", requestId: "req-1", sessionId: "s1" });
    assert.equal(value.getTurn("t1")?.status, "running");

    value.finishTurn("t1", "succeeded");
    const turn = value.getTurn("t1");
    assert.equal(turn?.status, "succeeded");
    assert.equal(turn?.requestId, "req-1", "the join key back to CCR usage must survive");
    assert.ok(turn?.endedAt);
  } finally {
    close();
  }
});

test("a cancelled turn keeps its reason", () => {
  const { close, value } = store();
  try {
    value.createSession({ ...base, id: "s1" });
    value.startTurn({ id: "t1", requestId: "r", sessionId: "s1" });
    value.finishTurn("t1", "cancelled", "cancelled by user");
    const turn = value.getTurn("t1");
    assert.equal(turn?.status, "cancelled");
    assert.equal(turn?.error, "cancelled by user");
  } finally {
    close();
  }
});

test("tool calls attach to their turn and complete in place", () => {
  const { close, value } = store();
  try {
    value.createSession({ ...base, id: "s1" });
    value.startTurn({ id: "t1", requestId: "r", sessionId: "s1" });
    const id = value.recordToolCall({
      args: { path: "a.ts" },
      name: "read_file",
      source: "builtin",
      turnId: "t1"
    });
    value.completeToolCall(id, "ok", { bytes: 120 }, 45);

    const [call] = value.listToolCalls("t1");
    assert.equal(call.name, "read_file");
    assert.equal(call.status, "ok");
    assert.equal(call.durationMs, 45);
    assert.deepEqual(call.args, { path: "a.ts" });
    assert.deepEqual(call.result, { bytes: 120 });
  } finally {
    close();
  }
});

test("sessions are scoped to their user", () => {
  const { close, value } = store();
  try {
    value.createSession({ ...base, id: "s1", userId: "ada" });
    value.createSession({ ...base, id: "s2", userId: "grace" });
    assert.deepEqual(value.listSessions("ada").map((session) => session.id), ["s1"]);
    assert.deepEqual(value.listSessions("grace").map((session) => session.id), ["s2"]);
  } finally {
    close();
  }
});

test("deleting a session removes its messages, turns and tool calls", () => {
  const { close, value } = store();
  try {
    value.createSession({ ...base, id: "s1" });
    value.appendMessage("s1", "user", "hello");
    value.startTurn({ id: "t1", requestId: "r", sessionId: "s1" });
    value.recordToolCall({ args: {}, name: "bash", source: "builtin", turnId: "t1" });

    value.deleteSession("s1");

    assert.equal(value.getSession("s1"), undefined);
    assert.deepEqual(value.listMessages("s1"), [], "cascade must reach messages");
    assert.deepEqual(value.listTurns("s1"), [], "cascade must reach turns");
    assert.deepEqual(value.listToolCalls("t1"), [], "cascade must reach tool calls");
  } finally {
    close();
  }
});

test("a session survives reopening the database", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ccx-sessions-"));
  const file = path.join(directory, "sessions.sqlite");
  try {
    const first = new SessionStore(file);
    first.createSession({ ...base, id: "s1", title: "Persisted" });
    first.appendMessage("s1", "user", "still here");
    first.close();

    const second = new SessionStore(file);
    assert.equal(second.getSession("s1")?.title, "Persisted");
    assert.equal(second.listMessages("s1").length, 1);
    second.close();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

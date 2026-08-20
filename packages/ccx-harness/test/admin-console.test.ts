import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AdminConsole } from "../src/admin/console.ts";
import { TranscriptIndex } from "../src/admin/transcript-index.ts";
import { excerpt, messageText } from "../src/admin/text.ts";
import { AccessLog } from "../src/identity/access-log.ts";
import { SessionAuthorizer } from "../src/identity/authorization.ts";
import { IdentityDirectory } from "../src/identity/directory.ts";
import type { Identity } from "../src/identity/resolver.ts";
import { credentialFingerprint, SessionStore } from "../src/session/store.ts";

type Fixture = {
  accessLog: AccessLog;
  admin: Identity;
  alice: Identity;
  bob: Identity;
  close: () => void;
  console: AdminConsole;
  directory: IdentityDirectory;
  sessions: SessionStore;
};

function identity(directory: IdentityDirectory, id: string): Identity {
  const user = directory.getUser(id)!;
  return { assurance: "claimed", role: user.role, user };
}

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ccx-admin-"));
  const directory = new IdentityDirectory(path.join(dir, "identity.sqlite"));
  const accessLog = new AccessLog(path.join(dir, "access.sqlite"));
  const sessions = new SessionStore(":memory:");

  for (const person of [
    { id: "alice", role: "user" as const },
    { id: "bob", role: "user" as const },
    { id: "root", role: "admin" as const }
  ]) {
    directory.upsertUser({
      displayName: person.id,
      email: `${person.id}@example.com`,
      externalId: "",
      id: person.id,
      role: person.role,
      status: "active",
      temporary: false
    });
    directory.bindCredential({
      boundBy: "setup",
      fingerprint: credentialFingerprint(`${person.id}-key`),
      userId: person.id
    });
  }

  const index = new TranscriptIndex(sessions.unsafeDatabase());
  return {
    accessLog,
    admin: identity(directory, "root"),
    alice: identity(directory, "alice"),
    bob: identity(directory, "bob"),
    close: () => {
      sessions.close();
      accessLog.close();
      directory.close();
      rmSync(dir, { force: true, recursive: true });
    },
    console: new AdminConsole({
      accessLog,
      authorizer: new SessionAuthorizer({ accessLog, sessions }),
      directory,
      index,
      sessions
    }),
    directory,
    sessions
  };
}

function conversation(sessions: SessionStore, userId: string, sessionId: string, text: string): void {
  sessions.createSession({
    credentialFingerprint: credentialFingerprint(`${userId}-key`),
    id: sessionId,
    mode: "code",
    model: "opus-5",
    provider: "acme",
    title: `${userId} session`,
    userId
  });
  sessions.appendMessage(sessionId, "user", [{ text, type: "text" }]);
  sessions.startTurn({ id: `${sessionId}-t1`, requestId: "r1", sessionId });
  const call = sessions.recordToolCall({ args: { path: "a.ts" }, name: "read_file", source: "builtin", turnId: `${sessionId}-t1` });
  sessions.completeToolCall(call, "ok", "file body", 7);
  sessions.appendMessage(sessionId, "assistant", [{ text: `answering: ${text}`, type: "text" }]);
  sessions.finishTurn(`${sessionId}-t1`, "succeeded");
}

test("a non-admin cannot reach any cross-user surface", () => {
  const f = fixture();
  try {
    conversation(f.sessions, "bob", "bob-1", "bob's private work");
    assert.equal(f.console.overview(f.alice).allowed, false);
    assert.equal(f.console.users(f.alice).allowed, false);
    assert.equal(f.console.search(f.alice, { userId: "bob" }).allowed, false);
    assert.equal(f.console.transcript(f.alice, "bob-1").allowed, false);
    assert.equal(f.console.exportUser(f.alice, "bob").allowed, false);
    assert.equal(f.console.deleteSession(f.alice, "bob-1", "because").allowed, false);
    assert.equal(f.console.deleteUserData(f.alice, "bob", "because").allowed, false);
    assert.equal(f.console.accessLog(f.alice, { subjectUserId: "bob" }).allowed, false);
    assert.equal(f.accessLog.listRecent().length, 0, "a denied read must not be recorded as a read");
  } finally {
    f.close();
  }
});

test("searching across people is logged with the query itself", () => {
  const f = fixture();
  try {
    conversation(f.sessions, "alice", "alice-1", "the quarterly migration plan");
    conversation(f.sessions, "bob", "bob-1", "unrelated chatter");

    const found = f.console.search(f.admin, { reason: "incident 42", text: "migration" });
    assert.equal(found.allowed, true);
    assert.deepEqual(found.allowed ? found.value.map((hit) => hit.session.id) : [], ["alice-1"]);
    assert.ok(found.allowed && found.value[0]?.excerpt.includes("migration"));

    const logged = f.accessLog.listRecent();
    assert.equal(logged.length, 1);
    assert.equal(logged[0]?.action, "search");
    assert.equal(logged[0]?.subjectUserId, "*", "an unscoped search reads everyone");
    assert.match(logged[0]?.reason ?? "", /text="migration"/);
    assert.match(logged[0]?.reason ?? "", /reason="incident 42"/);
  } finally {
    f.close();
  }
});

test("a search that finds nothing is still a read, and still logged", () => {
  const f = fixture();
  try {
    conversation(f.sessions, "alice", "alice-1", "nothing relevant here");
    const found = f.console.search(f.admin, { text: "zzzznotpresent" });
    assert.deepEqual(found.allowed ? found.value : null, []);
    assert.equal(f.accessLog.listRecent().length, 1);
  } finally {
    f.close();
  }
});

test("searching your own transcripts is not an audit event", () => {
  const f = fixture();
  try {
    conversation(f.sessions, "alice", "alice-1", "my own notes");
    const found = f.console.search(f.alice, { text: "notes", userId: "alice" });
    assert.equal(found.allowed, true);
    assert.equal(found.allowed ? found.value.length : 0, 1);
    assert.equal(f.accessLog.listRecent().length, 0);
  } finally {
    f.close();
  }
});

test("search input is escaped, not passed to the FTS parser", () => {
  const f = fixture();
  try {
    conversation(f.sessions, "alice", "alice-1", "the quarterly migration plan");
    conversation(f.sessions, "bob", "bob-1", "unrelated chatter");

    const hits = (text: string): string[] => {
      const found = f.console.search(f.admin, { text });
      assert.equal(found.allowed, true, `search must not throw on ${JSON.stringify(text)}`);
      return found.allowed ? found.value.map((hit) => hit.session.id) : [];
    };

    assert.deepEqual(hits("migration"), ["alice-1"], "precondition: a plain term matches");

    // Each of these is an FTS5 operator or a syntax error if passed through
    // raw. Injected, the first would match every indexed row.
    assert.deepEqual(hits('" OR body : *'), [], "an injected disjunction must not return everyone");
    assert.deepEqual(hits("migration OR chatter"), [], "OR must be literal text, not an operator");
    assert.deepEqual(hits("NEAR(migration plan)"), [], "NEAR must be literal text");
    assert.deepEqual(hits('"'), [], "a lone quote must not error");

    // Punctuation inside a term is dropped by the tokenizer, so `migration*`
    // searches for the word `migration` rather than acting as FTS5's prefix
    // operator. That is ordinary full-text behaviour, not injection: the term
    // still cannot reach outside its own phrase.
    assert.deepEqual(hits("migration*"), ["alice-1"]);
  } finally {
    f.close();
  }
});

test("reading someone's transcript is logged; reading your own is not", () => {
  const f = fixture();
  try {
    conversation(f.sessions, "alice", "alice-1", "hello");
    assert.equal(f.console.transcript(f.alice, "alice-1").allowed, true);
    assert.equal(f.accessLog.listRecent().length, 0);

    const read = f.console.transcript(f.admin, "alice-1", "support ticket 7");
    assert.equal(read.allowed, true);
    assert.equal(read.allowed ? read.value.messages.length : 0, 2);
    assert.equal(read.allowed ? read.value.toolCalls.length : 0, 1);
    assert.equal(read.allowed ? read.value.user?.id : "", "alice");

    const logged = f.accessLog.listForSubject("alice");
    assert.equal(logged.length, 1);
    assert.equal(logged[0]?.reason, "support ticket 7");
  } finally {
    f.close();
  }
});

test("deletion requires a reason and is recorded before it happens", () => {
  const f = fixture();
  try {
    conversation(f.sessions, "alice", "alice-1", "delete me");
    assert.equal(f.console.deleteSession(f.admin, "alice-1", "  ").allowed, false);
    assert.equal(f.sessions.hasSession("alice-1"), true, "a rejected delete must not delete");

    const removed = f.console.deleteSession(f.admin, "alice-1", "retention policy");
    assert.equal(removed.allowed, true);
    assert.equal(f.sessions.hasSession("alice-1"), false);

    const logged = f.accessLog.listForSubject("alice");
    assert.equal(logged[0]?.action, "delete-session");
    assert.equal(logged[0]?.reason, "retention policy");
  } finally {
    f.close();
  }
});

test("deleting a person's data removes it from search too", () => {
  const f = fixture();
  try {
    conversation(f.sessions, "alice", "alice-1", "a memorable phrase");
    conversation(f.sessions, "alice", "alice-2", "another memorable phrase");
    conversation(f.sessions, "bob", "bob-1", "a memorable phrase of bob's");

    const removed = f.console.deleteUserData(f.admin, "alice", "left the company");
    assert.equal(removed.allowed, true);
    assert.equal(removed.allowed ? removed.value.sessions : 0, 2);

    const found = f.console.search(f.admin, { text: "memorable" });
    assert.deepEqual(found.allowed ? found.value.map((hit) => hit.session.id) : [], ["bob-1"]);

    // The person's credentials are revoked and the account suspended, so
    // nothing new arrives, but the user row survives to anchor the audit trail.
    assert.equal(f.directory.getUser("alice")?.status, "suspended");
    assert.equal(f.directory.listBindings("alice").every((binding) => binding.revokedAt !== ""), true);
    assert.equal(f.accessLog.listForSubject("alice").length, 1);
  } finally {
    f.close();
  }
});

test("a person can see who read their material, and nobody else's", () => {
  const f = fixture();
  try {
    conversation(f.sessions, "alice", "alice-1", "hello");
    conversation(f.sessions, "bob", "bob-1", "hello");
    f.console.transcript(f.admin, "alice-1", "review");
    f.console.transcript(f.admin, "bob-1", "review");

    const mine = f.console.accessLog(f.alice);
    assert.equal(mine.allowed, true);
    assert.equal(mine.allowed ? mine.value.length : 0, 1);
    assert.equal(mine.allowed ? mine.value[0]?.subjectUserId : "", "alice");

    assert.equal(f.console.accessLog(f.alice, { subjectUserId: "bob" }).allowed, false);
  } finally {
    f.close();
  }
});

test("one admin can audit another admin", () => {
  const f = fixture();
  try {
    f.directory.upsertUser({
      displayName: "second",
      email: "second@example.com",
      externalId: "",
      id: "second-admin",
      role: "admin",
      status: "active",
      temporary: false
    });
    conversation(f.sessions, "alice", "alice-1", "hello");
    f.console.transcript(f.admin, "alice-1", "curiosity");

    const auditor = identity(f.directory, "second-admin");
    const trail = f.console.accessLog(auditor, { actorUserId: "root" });
    assert.equal(trail.allowed, true);
    assert.equal(trail.allowed ? trail.value[0]?.reason : "", "curiosity");
  } finally {
    f.close();
  }
});

test("the overview surfaces what still has to be replaced before rollout", () => {
  const f = fixture();
  try {
    f.directory.upsertUser({
      displayName: "bootstrap",
      email: "",
      externalId: "",
      id: "bootstrap-admin",
      role: "admin",
      status: "active",
      temporary: true
    });
    conversation(f.sessions, "alice", "alice-1", "hello");

    const view = f.console.overview(f.admin);
    assert.equal(view.allowed, true);
    if (!view.allowed) {
      return;
    }
    assert.equal(view.value.counts.sessions, 1);
    assert.equal(view.value.counts.messages, 2);
    assert.equal(view.value.counts.toolCalls, 1);
    assert.equal(view.value.indexedMessages, 2);
    assert.deepEqual(view.value.temporaryAccounts.map((user) => user.id), ["bootstrap-admin"]);
  } finally {
    f.close();
  }
});

test("the user list pairs directory entries with real activity", () => {
  const f = fixture();
  try {
    conversation(f.sessions, "alice", "alice-1", "hello");
    conversation(f.sessions, "alice", "alice-2", "hello again");
    f.directory.revokeCredential(credentialFingerprint("bob-key"));

    const rows = f.console.users(f.admin);
    assert.equal(rows.allowed, true);
    if (!rows.allowed) {
      return;
    }
    const alice = rows.value.find((row) => row.user.id === "alice");
    const bob = rows.value.find((row) => row.user.id === "bob");
    assert.equal(alice?.sessions, 2);
    assert.ok(alice?.lastActiveAt);
    assert.equal(bob?.sessions, 0);
    assert.deepEqual(bob?.bindings, { active: 0, revoked: 1 });
  } finally {
    f.close();
  }
});

test("an export carries the whole conversation, not just its metadata", () => {
  const f = fixture();
  try {
    conversation(f.sessions, "alice", "alice-1", "export me");
    const exported = f.console.exportUser(f.admin, "alice", "subject access request");
    assert.equal(exported.allowed, true);
    if (!exported.allowed) {
      return;
    }
    assert.equal(exported.value.sessions.length, 1);
    assert.equal(exported.value.sessions[0]?.messages.length, 2);
    assert.equal(exported.value.sessions[0]?.turns.length, 1);
    assert.equal(exported.value.sessions[0]?.toolCalls.length, 1);
    assert.equal(exported.value.user?.email, "alice@example.com");
    assert.equal(f.accessLog.listForSubject("alice")[0]?.action, "export-user");
  } finally {
    f.close();
  }
});

test("messageText flattens every block shape the turn loop writes", () => {
  assert.equal(messageText([{ text: "plain", type: "text" }]), "plain");
  assert.equal(
    messageText([{ input: { path: "a.ts" }, name: "read_file", type: "tool_use" }]),
    'read_file({"path":"a.ts"})'
  );
  assert.equal(
    messageText([{ content: [{ text: "result body", type: "text" }], tool_use_id: "x", type: "tool_result" }]),
    "result body"
  );
  assert.equal(messageText([{ thinking: "reasoning aloud", type: "thinking" }]), "reasoning aloud");
  assert.equal(messageText("a bare string"), "a bare string");
  assert.equal(messageText(null), "");
});

test("excerpt centres on the match", () => {
  const text = `${"a".repeat(300)} NEEDLE ${"b".repeat(300)}`;
  const window = excerpt(text, ["needle"], 20);
  assert.ok(window.includes("NEEDLE"));
  assert.ok(window.startsWith("…") && window.endsWith("…"));
  assert.ok(window.length < 100);
});

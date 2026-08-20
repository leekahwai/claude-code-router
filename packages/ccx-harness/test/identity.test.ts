import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccessLog } from "../src/identity/access-log.ts";
import { IdentityDirectory } from "../src/identity/directory.ts";
import { CredentialIdentityResolver, resolutionMessage } from "../src/identity/resolver.ts";
import { SessionAuthorizer } from "../src/identity/authorization.ts";
import { SessionStore, credentialFingerprint } from "../src/session/store.ts";

function world() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ccx-id-"));
  const identity = new IdentityDirectory(path.join(directory, "identity.sqlite"));
  const accessLog = new AccessLog(path.join(directory, "access.sqlite"));
  const sessions = new SessionStore(path.join(directory, "sessions.sqlite"));

  identity.upsertUser({ displayName: "Ada", email: "ada@x", externalId: "", id: "ada", role: "user", status: "active" });
  identity.upsertUser({ displayName: "Grace", email: "g@x", externalId: "", id: "grace", role: "user", status: "active" });
  identity.upsertUser({ displayName: "Root", email: "r@x", externalId: "", id: "root", role: "admin", status: "active" });

  identity.bindCredential({ boundBy: "root", fingerprint: credentialFingerprint("sk-ada"), userId: "ada" });
  identity.bindCredential({ boundBy: "root", fingerprint: credentialFingerprint("sk-grace"), userId: "grace" });
  identity.bindCredential({ boundBy: "root", fingerprint: credentialFingerprint("sk-root"), userId: "root" });

  const resolver = new CredentialIdentityResolver(identity);
  const authorizer = new SessionAuthorizer({ accessLog, sessions });

  const make = (userId: string, id: string) =>
    sessions.createSession({
      credentialFingerprint: credentialFingerprint(`sk-${userId}`),
      id,
      mode: "code",
      model: "m",
      provider: "p",
      userId
    });

  return {
    accessLog,
    authorizer,
    cleanup: () => {
      identity.close();
      accessLog.close();
      sessions.close();
      rmSync(directory, { force: true, recursive: true });
    },
    identity,
    make,
    resolver,
    sessions,
    who: (key: string) => {
      const result = resolver.resolve(key);
      assert.ok(result.ok, `expected ${key} to resolve`);
      return result.identity;
    }
  };
}

test("a key resolves to the person it was bound to, with claimed assurance", () => {
  const w = world();
  try {
    const resolved = w.resolver.resolve("sk-ada");
    assert.ok(resolved.ok);
    assert.equal(resolved.identity.user.id, "ada");
    assert.equal(resolved.identity.role, "user");
    // An emailed key is transferable, so the identity it yields is claimed.
    assert.equal(resolved.identity.assurance, "claimed");
  } finally {
    w.cleanup();
  }
});

test("an unbound key resolves to nobody rather than to a default user", () => {
  const w = world();
  try {
    const resolved = w.resolver.resolve("sk-never-issued");
    assert.equal(resolved.ok, false);
    assert.equal(resolved.ok === false ? resolved.reason : "", "no-binding");
    assert.match(resolutionMessage("no-binding"), /not recognised/);
  } finally {
    w.cleanup();
  }
});

test("a revoked key stops resolving", () => {
  const w = world();
  try {
    w.identity.revokeCredential(credentialFingerprint("sk-ada"));
    const resolved = w.resolver.resolve("sk-ada");
    assert.equal(resolved.ok, false);
    assert.equal(resolved.ok === false ? resolved.reason : "", "revoked");
  } finally {
    w.cleanup();
  }
});

test("a suspended account stops resolving even with a live key", () => {
  const w = world();
  try {
    w.identity.upsertUser({ displayName: "Ada", email: "ada@x", externalId: "", id: "ada", role: "user", status: "suspended" });
    assert.equal(w.resolver.resolve("sk-ada").ok, false);
  } finally {
    w.cleanup();
  }
});

test("a credential cannot be bound to a user who does not exist", () => {
  const w = world();
  try {
    assert.throws(
      () => w.identity.bindCredential({ boundBy: "root", fingerprint: "f".repeat(64), userId: "ghost" }),
      /unknown user/
    );
  } finally {
    w.cleanup();
  }
});

test("rebinding a key moves it to the new person and clears the revocation", () => {
  const w = world();
  try {
    const fingerprint = credentialFingerprint("sk-ada");
    w.identity.revokeCredential(fingerprint);
    w.identity.bindCredential({ boundBy: "root", fingerprint, userId: "grace" });
    const resolved = w.resolver.resolve("sk-ada");
    assert.ok(resolved.ok);
    assert.equal(resolved.identity.user.id, "grace");
  } finally {
    w.cleanup();
  }
});

test("rule 1: a user reads their own session and no one else's", () => {
  const w = world();
  try {
    w.make("ada", "s-ada");
    w.make("grace", "s-grace");
    const ada = w.who("sk-ada");

    assert.equal(w.authorizer.readSession(ada, "s-ada").allowed, true);

    const other = w.authorizer.readSession(ada, "s-grace");
    assert.equal(other.allowed, false);
    // Same answer as a missing id, so ids are not probeable for existence.
    assert.equal(other.allowed === false ? other.reason : "", "No such session.");
    assert.equal(w.authorizer.readSession(ada, "does-not-exist").allowed === false, true);
  } finally {
    w.cleanup();
  }
});

test("rule 2: an admin may read any session, and the read is logged", () => {
  const w = world();
  try {
    w.make("ada", "s-ada");
    const root = w.who("sk-root");

    const result = w.authorizer.readSession(root, "s-ada", "incident 4821");
    assert.equal(result.allowed, true);

    const entries = w.accessLog.listForSubject("ada");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].actorUserId, "root");
    assert.equal(entries[0].action, "read-session");
    assert.equal(entries[0].sessionId, "s-ada");
    assert.equal(entries[0].reason, "incident 4821");
  } finally {
    w.cleanup();
  }
});

test("an owner reading their own session is not logged as an access", () => {
  const w = world();
  try {
    w.make("ada", "s-ada");
    w.authorizer.readSession(w.who("sk-ada"), "s-ada");
    assert.deepEqual(w.accessLog.listForSubject("ada"), [], "using your own app is not surveillance");
  } finally {
    w.cleanup();
  }
});

test("there is no path to another person's transcript that skips the log", () => {
  const w = world();
  try {
    w.make("ada", "s-ada");
    w.sessions.appendMessage("s-ada", "user", "something private");
    const root = w.who("sk-root");

    const messages = w.authorizer.readMessages(root, "s-ada", "audit");
    assert.equal(messages.allowed, true);
    assert.equal(messages.allowed ? messages.value.length : 0, 1);
    assert.equal(w.accessLog.listForSubject("ada").length, 1, "reading the transcript logs, not just the session");
  } finally {
    w.cleanup();
  }
});

test("listing and exporting someone else's material are logged too", () => {
  const w = world();
  try {
    w.make("ada", "s-ada");
    const root = w.who("sk-root");

    w.authorizer.listSessions(root, "ada", "quarterly review");
    w.authorizer.exportUser(root, "ada", "subject request");

    const actions = w.accessLog.listForSubject("ada").map((entry) => entry.action).sort();
    assert.deepEqual(actions, ["export-user", "list-sessions"]);
  } finally {
    w.cleanup();
  }
});

test("a non-admin cannot list or export another person's material", () => {
  const w = world();
  try {
    const ada = w.who("sk-ada");
    assert.equal(w.authorizer.listSessions(ada, "grace").allowed, false);
    assert.equal(w.authorizer.exportUser(ada, "grace").allowed, false);
    assert.deepEqual(w.accessLog.listForSubject("grace"), [], "a refusal is not an access");
  } finally {
    w.cleanup();
  }
});

test("rule 3: the log is visible by actor, so admins can audit each other", () => {
  const w = world();
  try {
    w.make("ada", "s-ada");
    w.authorizer.readSession(w.who("sk-root"), "s-ada", "why");
    const byActor = w.accessLog.listByActor("root");
    assert.equal(byActor.length, 1);
    assert.equal(byActor[0].subjectUserId, "ada");
  } finally {
    w.cleanup();
  }
});

test("rule 3: the log cannot be edited or deleted, enforced by the database", () => {
  const w = world();
  try {
    w.make("ada", "s-ada");
    w.authorizer.readSession(w.who("sk-root"), "s-ada", "original reason");
    const entry = w.accessLog.listRecent()[0];

    // Reach past the API, as a bug or a SQLite shell would.
    const raw = (w.accessLog as unknown as { database: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } })
      .database;
    assert.throws(
      () => raw.prepare("UPDATE ccx_access_log SET reason = ? WHERE id = ?").run("covered up", entry.id),
      /append-only/
    );
    assert.throws(() => raw.prepare("DELETE FROM ccx_access_log WHERE id = ?").run(entry.id), /append-only/);

    assert.equal(w.accessLog.get(entry.id)?.reason, "original reason");
  } finally {
    w.cleanup();
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { credentialFingerprint, SessionStore } from "@ccx/harness";
import { startCollector } from "../src/server.ts";

const adminKey = "root-key";
const aliceKey = "alice-key";

async function hub() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "ccx-admin-http-"));
  const running = await startCollector({ dataDir });
  for (const person of [
    { id: "alice", role: "user" as const },
    { id: "bob", role: "user" as const },
    { id: "root", role: "admin" as const }
  ]) {
    running.directory.upsertUser({
      displayName: person.id,
      email: `${person.id}@example.com`,
      externalId: "",
      id: person.id,
      role: person.role,
      status: "active",
      temporary: false
    });
    running.directory.bindCredential({
      boundBy: "setup",
      fingerprint: credentialFingerprint(`${person.id}-key`),
      userId: person.id
    });
  }

  const base = `http://127.0.0.1:${running.port}`;
  const call = async (route: string, options: { body?: unknown; key?: string; method?: string } = {}) => {
    const response = await fetch(`${base}/__ccx/admin${route}`, {
      ...(options.body === undefined ? { method: options.method ?? "GET" } : { body: JSON.stringify(options.body), method: "POST" }),
      headers: {
        "content-type": "application/json",
        ...(options.key === null ? {} : { "x-ccx-admin-key": options.key ?? adminKey })
      }
    });
    return { body: (await response.json().catch(() => ({}))) as Record<string, unknown>, status: response.status };
  };

  return {
    ...running,
    base,
    call,
    dispose: async () => {
      await running.close();
      rmSync(dataDir, { force: true, recursive: true });
    },
    seed(userId: string, sessionId: string, text: string) {
      const sessions = running.sessions as SessionStore;
      sessions.createSession({
        credentialFingerprint: credentialFingerprint(`${userId}-key`),
        id: sessionId,
        mode: "code",
        model: "opus-5",
        provider: "acme",
        title: `${userId}: ${text.slice(0, 20)}`,
        userId
      });
      sessions.appendMessage(sessionId, "user", [{ text, type: "text" }]);
      sessions.startTurn({ id: `${sessionId}-t1`, requestId: "r1", sessionId });
      sessions.finishTurn(`${sessionId}-t1`, "succeeded");
    }
  };
}

test("the admin API refuses a missing or unbound key", async () => {
  const h = await hub();
  try {
    const noKey = await fetch(`${h.base}/__ccx/admin/whoami`);
    assert.equal(noKey.status, 401);

    const unknown = await h.call("/whoami", { key: "nobody-bound-this" });
    assert.equal(unknown.status, 403);
    assert.equal(unknown.body.error, "This key is not permitted here.");

    h.directory.revokeCredential(credentialFingerprint(aliceKey));
    const revoked = await h.call("/whoami", { key: aliceKey });
    assert.equal(revoked.status, 403);
    assert.equal(
      revoked.body.error,
      "This key is not permitted here.",
      "revoked and unknown must be indistinguishable, or the directory is probeable"
    );
  } finally {
    await h.dispose();
  }
});

test("whoami reports the resolved person and their assurance", async () => {
  const h = await hub();
  try {
    const me = await h.call("/whoami");
    assert.equal(me.status, 200);
    assert.equal(me.body.userId, "root");
    assert.equal(me.body.role, "admin");
    assert.equal(me.body.assurance, "claimed");
  } finally {
    await h.dispose();
  }
});

test("a non-admin key is refused on every cross-user endpoint", async () => {
  const h = await hub();
  try {
    h.seed("bob", "bob-1", "bob's work");
    for (const route of ["/overview", "/users"]) {
      assert.equal((await h.call(route, { key: aliceKey })).status, 403, route);
    }
    assert.equal((await h.call("/search", { body: { userId: "bob" }, key: aliceKey })).status, 403);
    assert.equal((await h.call("/transcript", { body: { sessionId: "bob-1" }, key: aliceKey })).status, 403);
    assert.equal((await h.call("/delete-session", { body: { reason: "x", sessionId: "bob-1" }, key: aliceKey })).status, 403);
    assert.equal(h.sessions.hasSession("bob-1"), true);
  } finally {
    await h.dispose();
  }
});

test("an admin can search, read and audit over HTTP", async () => {
  const h = await hub();
  try {
    h.seed("alice", "alice-1", "the quarterly migration plan");
    h.seed("bob", "bob-1", "lunch options");

    const found = await h.call("/search", { body: { reason: "incident 42", text: "migration" } });
    assert.equal(found.status, 200);
    const hits = found.body as unknown as Array<{ session: { id: string } }>;
    assert.deepEqual(hits.map((hit) => hit.session.id), ["alice-1"]);

    const read = await h.call("/transcript", { body: { reason: "incident 42", sessionId: "alice-1" } });
    assert.equal(read.status, 200);
    const transcript = read.body as unknown as { messages: Array<{ text: string }>; user: { id: string } };
    assert.equal(transcript.user.id, "alice");
    assert.equal(transcript.messages[0]?.text, "the quarterly migration plan");

    const audit = await h.call("/access-log");
    const entries = audit.body as unknown as Array<{ action: string; reason: string }>;
    assert.deepEqual(entries.map((entry) => entry.action).sort(), ["read-session", "search"]);
    assert.ok(entries.some((entry) => entry.reason.includes("incident 42")));
  } finally {
    await h.dispose();
  }
});

test("deleting over HTTP still requires a reason", async () => {
  const h = await hub();
  try {
    h.seed("alice", "alice-1", "delete me");
    const noReason = await h.call("/delete-session", { body: { sessionId: "alice-1" } });
    assert.equal(noReason.status, 403);
    assert.match(String(noReason.body.error), /reason is required/);
    assert.equal(h.sessions.hasSession("alice-1"), true);

    const removed = await h.call("/delete-session", { body: { reason: "retention", sessionId: "alice-1" } });
    assert.equal(removed.status, 200);
    assert.equal(h.sessions.hasSession("alice-1"), false);
  } finally {
    await h.dispose();
  }
});

test("a person may see reads of their own material and no further", async () => {
  const h = await hub();
  try {
    h.seed("alice", "alice-1", "hello");
    h.seed("bob", "bob-1", "hello");
    await h.call("/transcript", { body: { reason: "review", sessionId: "alice-1" } });
    await h.call("/transcript", { body: { reason: "review", sessionId: "bob-1" } });

    const mine = await h.call("/access-log", { key: aliceKey });
    assert.equal(mine.status, 200);
    const entries = mine.body as unknown as Array<{ subjectUserId: string }>;
    assert.deepEqual(entries.map((entry) => entry.subjectUserId), ["alice"]);

    assert.equal((await h.call("/access-log?subjectUserId=bob", { key: aliceKey })).status, 403);
  } finally {
    await h.dispose();
  }
});

test("unknown endpoints and bad bodies are refused cleanly", async () => {
  const h = await hub();
  try {
    assert.equal((await h.call("/nope")).status, 404);
    const bad = await fetch(`${h.base}/__ccx/admin/search`, {
      body: "not json",
      headers: { "content-type": "application/json", "x-ccx-admin-key": adminKey },
      method: "POST"
    });
    assert.equal(bad.status, 400);
  } finally {
    await h.dispose();
  }
});

test("the console is served and cannot be walked out of", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "ccx-console-"));
  const consoleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "console");
  const running = await startCollector({ consoleDir, dataDir });
  try {
    const base = `http://127.0.0.1:${running.port}`;
    // Without the trailing slash the page's relative asset URLs resolve
    // against the root, so /admin must redirect rather than render.
    const bare = await fetch(`${base}/admin`, { redirect: "manual" });
    assert.equal(bare.status, 301);
    assert.equal(bare.headers.get("location"), "/admin/");

    const page = await fetch(`${base}/admin/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Work \/ Code administration/);

    assert.equal((await fetch(`${base}/admin/main.js`)).status, 200);
    // An unknown path inside the console falls back to index.html, as a
    // single-page app needs; it must not fall out of the directory.
    assert.equal((await fetch(`${base}/admin/anything`)).status, 200);
    const escaped = await fetch(`${base}/admin/../../../etc/passwd`, { redirect: "manual" });
    assert.notEqual(escaped.status, 200);
  } finally {
    await running.close();
    rmSync(dataDir, { force: true, recursive: true });
  }
});

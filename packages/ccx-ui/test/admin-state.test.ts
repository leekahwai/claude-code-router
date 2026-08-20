import assert from "node:assert/strict";
import test from "node:test";
import { AdminApi, AdminApiError } from "../src/admin/api.ts";
import { adminReducer, initialAdminState, reasonRequired, type AdminState } from "../src/admin/state.ts";

const me = {
  assurance: "claimed" as const,
  displayName: "Root",
  email: "root@example.com",
  role: "admin" as const,
  userId: "root"
};

function signedIn(patch: Partial<AdminState> = {}): AdminState {
  return { ...initialAdminState, me, ...patch };
}

test("a failed request clears the spinner", () => {
  const loading = adminReducer(signedIn(), { type: "loading" });
  assert.equal(loading.loading, true);
  const failed = adminReducer(loading, { error: "Not permitted.", type: "error" });
  assert.equal(failed.loading, false);
  assert.equal(failed.error, "Not permitted.");
});

test("a success clears an error left from the previous attempt", () => {
  const failed = adminReducer(signedIn(), { error: "boom", type: "error" });
  const recovered = adminReducer(failed, { hits: [], type: "hits" });
  assert.equal(recovered.error, "");
});

test("changing whose material is in view drops what is on screen", () => {
  const viewing = signedIn({
    hits: [{ excerpt: "x", matchedSeq: 0, session: session("alice-1", "alice"), user: undefined }],
    scopeUserId: "alice",
    searched: true,
    transcript: { messages: [], session: session("alice-1", "alice"), toolCalls: [], turns: [], user: undefined }
  });
  const rescoped = adminReducer(viewing, { type: "scope", userId: "bob" });
  assert.deepEqual(rescoped.hits, [], "alice's hits must not appear under bob's name");
  assert.equal(rescoped.transcript, undefined);
  assert.equal(rescoped.searched, false);
  assert.equal(rescoped.scopeUserId, "bob");
});

test("an empty result is distinguishable from not having searched", () => {
  assert.equal(signedIn().searched, false);
  assert.equal(adminReducer(signedIn(), { hits: [], type: "hits" }).searched, true);
});

test("switching tab closes an open transcript", () => {
  const viewing = signedIn({
    transcript: { messages: [], session: session("alice-1", "alice"), toolCalls: [], turns: [], user: undefined }
  });
  assert.equal(adminReducer(viewing, { tab: "audit", type: "tab" }).transcript, undefined);
});

test("signing out leaves nothing behind", () => {
  const busy = signedIn({
    audit: [{ action: "read-session", actorUserId: "root", at: "t", id: 1, reason: "r", sessionId: "s", subjectUserId: "alice" }],
    hits: [{ excerpt: "secret", matchedSeq: 0, session: session("alice-1", "alice"), user: undefined }],
    reason: "an investigation",
    users: []
  });
  assert.deepEqual(adminReducer(busy, { type: "signed-out" }), initialAdminState);
});

test("a reason is required for someone else's material, not your own", () => {
  const state = signedIn();
  assert.equal(reasonRequired(state, "alice"), true);
  assert.equal(reasonRequired(state, "root"), false, "reading your own needs no justification");
  assert.equal(reasonRequired({ ...state, reason: "  " }, "alice"), true, "whitespace is not a reason");
  assert.equal(reasonRequired({ ...state, reason: "ticket 9" }, "alice"), false);
});

test("the client sends the key as a header and surfaces the server's message", async () => {
  const seen: Array<{ headers: Record<string, string>; method: string; url: string }> = [];
  const api = new AdminApi({
    baseUrl: "http://collector.test",
    fetchImpl: (async (url: string, init: RequestInit) => {
      seen.push({
        headers: init.headers as Record<string, string>,
        method: init.method ?? "GET",
        url
      });
      return {
        json: async () => ({ error: "Not permitted." }),
        ok: false,
        status: 403
      };
    }) as unknown as typeof fetch,
    key: "the-key"
  });

  await assert.rejects(
    () => api.transcript("s1", "why"),
    (error: unknown) => {
      assert.ok(error instanceof AdminApiError);
      assert.equal(error.message, "Not permitted.");
      assert.equal(error.status, 403);
      return true;
    }
  );
  assert.equal(seen[0]?.headers["x-ccx-admin-key"], "the-key");
  assert.equal(seen[0]?.method, "POST");
  assert.equal(seen[0]?.url, "http://collector.test/__ccx/admin/transcript");
});

test("a search omits filters that were left blank", async () => {
  let sent: Record<string, unknown> = {};
  const api = new AdminApi({
    fetchImpl: (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      return { json: async () => [], ok: true, status: 200 };
    }) as unknown as typeof fetch,
    key: "k"
  });
  await api.search({ text: "migration" });
  assert.deepEqual(sent, { text: "migration" });
});

function session(id: string, userId: string) {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    id,
    mode: "code" as const,
    model: "opus-5",
    provider: "acme",
    title: id,
    updatedAt: "2026-01-01T00:00:00.000Z",
    userId
  };
}

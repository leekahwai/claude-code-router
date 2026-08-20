import assert from "node:assert/strict";
import test from "node:test";
import type { CcxTurnEvent } from "@ccx/desktop/contract";
import {
  conversationReducer,
  initialConversation,
  type ConversationState,
  type TranscriptEntry
} from "../src/work/state.ts";

const session = "s1";

function run(events: Array<CcxTurnEvent | { type: "submit"; text: string }>): ConversationState {
  return events.reduce<ConversationState>((state, entry) => {
    if (entry.type === "submit") {
      return conversationReducer(state, { text: entry.text, type: "submit" });
    }
    return conversationReducer(state, { event: entry as CcxTurnEvent, type: "event" });
  }, initialConversation(session));
}

const start: CcxTurnEvent = { requestId: "r", sessionId: session, turnId: "t", type: "turn-start" };
const end: CcxTurnEvent = { sessionId: session, status: "ok", type: "turn-end" };

test("selecting a session sets the id events are filtered against", () => {
  // Regression: the view started with an empty session id and never synced it,
  // so the reducer discarded every event as belonging to another session. The
  // pure tests could not see it because they construct state already correct.
  let state = initialConversation("");
  state = conversationReducer(state, { sessionId: session, type: "select" });
  assert.equal(state.sessionId, session);

  state = conversationReducer(state, {
    event: { sessionId: session, text: "arrived", type: "text" },
    type: "event"
  });
  assert.match(String((state.entries[0] as { text: string }).text), /arrived/);
});

test("selecting a different session clears the previous transcript", () => {
  let state = run([{ text: "old", type: "submit" }]);
  state = conversationReducer(state, { sessionId: "s2", type: "select" });
  assert.deepEqual(state.entries, []);
  assert.equal(state.busy, false);
  assert.equal(state.sessionId, "s2");
});

test("re-selecting the same session leaves the transcript alone", () => {
  const state = run([{ text: "keep me", type: "submit" }]);
  const same = conversationReducer(state, { sessionId: session, type: "select" });
  assert.equal(same, state);
});

test("streaming deltas accumulate into one assistant bubble", () => {
  const state = run([
    { text: "hello", type: "submit" },
    start,
    { sessionId: session, text: "Hel", type: "text" },
    { sessionId: session, text: "lo ", type: "text" },
    { sessionId: session, text: "there", type: "text" },
    end
  ]);

  assert.deepEqual(state.entries, [
    { kind: "user", text: "hello" },
    { kind: "assistant", streaming: false, text: "Hello there", thinking: "" }
  ]);
  assert.equal(state.busy, false);
});

test("the composer is busy for the duration of a turn", () => {
  let state = run([{ text: "go", type: "submit" }]);
  assert.equal(state.busy, true);
  state = conversationReducer(state, { event: end, type: "event" });
  assert.equal(state.busy, false);
});

test("a tool card opens and closes without landing inside the model's text", () => {
  const state = run([
    { text: "go", type: "submit" },
    start,
    { sessionId: session, text: "Let me check.", type: "text" },
    { callId: "c1", input: { path: "a.ts" }, name: "read_file", sessionId: session, type: "tool-start" },
    { callId: "c1", isError: false, sessionId: session, summary: "120 bytes", type: "tool-end" },
    { sessionId: session, text: "It says hello.", type: "text" },
    end
  ]);

  const kinds = state.entries.map((entry) => entry.kind);
  assert.deepEqual(kinds, ["user", "assistant", "tool", "assistant"]);

  const card = (state.entries[2] as Extract<TranscriptEntry, { kind: "tool" }>).card;
  assert.equal(card.status, "done");
  assert.equal(card.isError, false);
  assert.equal(card.summary, "120 bytes");

  // The text either side stayed in separate bubbles rather than merging.
  assert.equal((state.entries[1] as { text: string }).text, "Let me check.");
  assert.equal((state.entries[3] as { text: string }).text, "It says hello.");
});

test("a failed tool is marked on its own card", () => {
  const state = run([
    { text: "go", type: "submit" },
    start,
    { callId: "c1", input: {}, name: "bash", sessionId: session, type: "tool-start" },
    { callId: "c1", isError: true, sessionId: session, summary: "not available in this mode", type: "tool-end" },
    end
  ]);
  const card = (state.entries[1] as Extract<TranscriptEntry, { kind: "tool" }>).card;
  assert.equal(card.isError, true);
  assert.match(String(card.summary), /not available/);
});

test("parallel tool cards close independently and in any order", () => {
  const state = run([
    { text: "go", type: "submit" },
    start,
    { callId: "c1", input: {}, name: "alpha", sessionId: session, type: "tool-start" },
    { callId: "c2", input: {}, name: "beta", sessionId: session, type: "tool-start" },
    { callId: "c2", isError: false, sessionId: session, summary: "B", type: "tool-end" },
    { callId: "c1", isError: false, sessionId: session, summary: "A", type: "tool-end" },
    end
  ]);
  const cards = state.entries
    .filter((entry): entry is Extract<TranscriptEntry, { kind: "tool" }> => entry.kind === "tool")
    .map((entry) => entry.card);
  assert.deepEqual(cards.map((card) => [card.name, card.status, card.summary]), [
    ["alpha", "done", "A"],
    ["beta", "done", "B"]
  ]);
});

test("events for another session are ignored", () => {
  const state = run([
    { text: "go", type: "submit" },
    start,
    { sessionId: "other", text: "SHOULD NOT APPEAR", type: "text" },
    { sessionId: session, text: "mine", type: "text" },
    end
  ]);
  const text = state.entries.map((entry) => ("text" in entry ? entry.text : "")).join("");
  assert.ok(!text.includes("SHOULD NOT APPEAR"), "two conversations must not interleave");
});

test("a cancelled turn stops the spinner and says so", () => {
  const state = run([
    { text: "go", type: "submit" },
    start,
    { sessionId: session, text: "partial", type: "text" },
    { sessionId: session, status: "cancelled", type: "turn-end" }
  ]);
  assert.equal(state.busy, false);
  assert.deepEqual(state.entries.at(-1), { kind: "notice", text: "Stopped.", tone: "info" });
  // Partial output is kept, not discarded.
  assert.match(String((state.entries[1] as { text: string }).text), /partial/);
});

test("an errored turn surfaces the detail", () => {
  const state = run([
    { text: "go", type: "submit" },
    start,
    { detail: "Gateway returned 401", sessionId: session, status: "error", type: "turn-end" }
  ]);
  assert.deepEqual(state.entries.at(-1), { kind: "notice", text: "Gateway returned 401", tone: "error" });
});

test("an assistant bubble that never received text is dropped", () => {
  const state = run([
    { text: "go", type: "submit" },
    start,
    { callId: "c1", input: {}, name: "t", sessionId: session, type: "tool-start" },
    { callId: "c1", isError: false, sessionId: session, summary: "ok", type: "tool-end" },
    end
  ]);
  assert.deepEqual(state.entries.map((entry) => entry.kind), ["user", "tool"]);
});

test("loaded skills are recorded once for the chip row", () => {
  const state = run([
    { text: "go", type: "submit" },
    start,
    { name: "deploy", sessionId: session, type: "skill-loaded" },
    { name: "deploy", sessionId: session, type: "skill-loaded" },
    { name: "audit", sessionId: session, type: "skill-loaded" },
    end
  ]);
  assert.deepEqual(state.skillsLoaded, ["deploy", "audit"]);
});

test("a permission prompt is captured, and only for this session", () => {
  let state = initialConversation(session);
  state = conversationReducer(state, {
    ask: { detail: "Run: npm test", id: "p1", risk: "execute", sessionId: "other", toolName: "bash" },
    type: "permission-ask"
  });
  assert.equal(state.pendingPermission, undefined);

  state = conversationReducer(state, {
    ask: { detail: "Run: npm test", id: "p1", risk: "execute", sessionId: session, toolName: "bash" },
    type: "permission-ask"
  });
  assert.equal(state.pendingPermission?.detail, "Run: npm test");

  state = conversationReducer(state, { type: "permission-resolved" });
  assert.equal(state.pendingPermission, undefined);
});

test("a turn ending clears a prompt that was never answered", () => {
  let state = conversationReducer(initialConversation(session), {
    ask: { detail: "Run: rm -rf /", id: "p1", risk: "execute", sessionId: session, toolName: "bash" },
    type: "permission-ask"
  });
  state = conversationReducer(state, { event: end, type: "event" });
  assert.equal(state.pendingPermission, undefined, "a stale prompt would block the composer forever");
});

test("history replays as the live stream rendered it, without plumbing", () => {
  const state = conversationReducer(initialConversation(session), {
    messages: [
      { content: [{ text: "do the thing", type: "text" }], role: "user", seq: 0 },
      {
        content: [
          { text: "Checking.", type: "text" },
          { id: "c1", input: { path: "a.ts" }, name: "read_file", type: "tool_use" }
        ],
        role: "assistant",
        seq: 1
      },
      { content: [{ content: "file body", tool_use_id: "c1", type: "tool_result" }], role: "user", seq: 2 },
      { content: [{ text: "Done.", type: "text" }], role: "assistant", seq: 3 }
    ],
    type: "load-history"
  });

  assert.deepEqual(state.entries.map((entry) => entry.kind), ["user", "assistant", "tool", "assistant"]);
  // The tool_result must not reappear as if a person typed it.
  const userTexts = state.entries.filter((entry) => entry.kind === "user").map((entry) => (entry as { text: string }).text);
  assert.deepEqual(userTexts, ["do the thing"]);
});

test("usage is tracked for the live token counter", () => {
  const state = run([
    { text: "go", type: "submit" },
    start,
    { inputTokens: 1200, outputTokens: 40, sessionId: session, type: "usage" },
    end
  ]);
  assert.deepEqual(state.usage, { inputTokens: 1200, outputTokens: 40 });
});

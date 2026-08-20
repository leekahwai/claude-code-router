/**
 * Conversation view state, as a pure reducer over IPC events.
 *
 * The rendering logic lives here rather than inside components so it can be
 * tested without a DOM — and because streaming UIs fail in ways that are hard
 * to see by eye: a delta appended to the wrong turn, a tool card that never
 * closes, a cancelled turn still showing a spinner.
 */
import type { CcxMessage, CcxPermissionAsk, CcxTurnEvent } from "@ccx/desktop/contract";

export type ToolCardState = {
  callId: string;
  input: unknown;
  isError?: boolean;
  name: string;
  status: "done" | "running";
  summary?: string;
};

export type TranscriptEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; thinking: string; streaming: boolean }
  | { kind: "tool"; card: ToolCardState }
  | { kind: "notice"; text: string; tone: "error" | "info" };

export type ConversationState = {
  /** Non-empty while a turn is in flight; used to disable the composer. */
  busy: boolean;
  entries: TranscriptEntry[];
  pendingPermission?: CcxPermissionAsk;
  sessionId: string;
  skillsLoaded: string[];
  usage: { inputTokens: number; outputTokens: number };
};

export function initialConversation(sessionId: string): ConversationState {
  return {
    busy: false,
    entries: [],
    sessionId,
    skillsLoaded: [],
    usage: { inputTokens: 0, outputTokens: 0 }
  };
}

export type ConversationAction =
  /**
   * Switch the view to a session. This also sets the id the reducer filters
   * incoming events against — without it every event is discarded as belonging
   * to another session.
   */
  | { type: "select"; sessionId: string }
  | { type: "event"; event: CcxTurnEvent }
  | { type: "submit"; text: string }
  | { type: "permission-ask"; ask: CcxPermissionAsk }
  | { type: "permission-resolved" }
  | { type: "load-history"; messages: CcxMessage[] };

export function conversationReducer(state: ConversationState, action: ConversationAction): ConversationState {
  switch (action.type) {
    case "select":
      return action.sessionId === state.sessionId ? state : initialConversation(action.sessionId);

    case "submit":
      return {
        ...state,
        busy: true,
        entries: [...state.entries, { kind: "user", text: action.text }]
      };

    case "permission-ask":
      // A prompt for another session must not steal this view's focus.
      return action.ask.sessionId === state.sessionId ? { ...state, pendingPermission: action.ask } : state;

    case "permission-resolved":
      return { ...state, pendingPermission: undefined };

    case "load-history":
      return { ...state, entries: action.messages.flatMap(historyEntries) };

    case "event":
      return applyEvent(state, action.event);

    default:
      return state;
  }
}

function applyEvent(state: ConversationState, event: CcxTurnEvent): ConversationState {
  // Events are broadcast; a view renders only its own session.
  if (event.sessionId !== state.sessionId) {
    return state;
  }

  switch (event.type) {
    case "turn-start":
      return { ...state, busy: true };

    case "text":
      return { ...state, entries: appendToAssistant(state.entries, { text: event.text }) };

    case "thinking":
      return { ...state, entries: appendToAssistant(state.entries, { thinking: event.text }) };

    case "tool-start":
      return {
        ...state,
        entries: [
          // Close the open assistant bubble first, so a tool card never lands
          // inside the text the model was mid-way through writing.
          ...sealAssistant(state.entries),
          { card: { callId: event.callId, input: event.input, name: event.name, status: "running" }, kind: "tool" }
        ]
      };

    case "tool-end":
      return { ...state, entries: closeToolCard(state.entries, event) };

    case "skill-loaded":
      return state.skillsLoaded.includes(event.name)
        ? state
        : { ...state, skillsLoaded: [...state.skillsLoaded, event.name] };

    case "usage":
      return {
        ...state,
        usage: { inputTokens: event.inputTokens, outputTokens: event.outputTokens }
      };

    case "turn-end": {
      const entries = sealAssistant(state.entries);
      return {
        ...state,
        busy: false,
        entries:
          event.status === "ok"
            ? entries
            : [
                ...entries,
                {
                  kind: "notice",
                  text: event.status === "cancelled" ? "Stopped." : event.detail || "Something went wrong.",
                  tone: event.status === "cancelled" ? "info" : "error"
                }
              ],
        // A pending prompt is meaningless once the turn is over.
        pendingPermission: undefined
      };
    }

    default:
      return state;
  }
}

/** Append to the open assistant bubble, opening one if the last entry is not. */
function appendToAssistant(
  entries: TranscriptEntry[],
  delta: { text?: string; thinking?: string }
): TranscriptEntry[] {
  const last = entries.at(-1);
  if (last?.kind === "assistant" && last.streaming) {
    return [
      ...entries.slice(0, -1),
      {
        ...last,
        text: last.text + (delta.text ?? ""),
        thinking: last.thinking + (delta.thinking ?? "")
      }
    ];
  }
  return [
    ...entries,
    { kind: "assistant", streaming: true, text: delta.text ?? "", thinking: delta.thinking ?? "" }
  ];
}

/** Mark the open assistant bubble finished, dropping it if it stayed empty. */
function sealAssistant(entries: TranscriptEntry[]): TranscriptEntry[] {
  const last = entries.at(-1);
  if (last?.kind !== "assistant" || !last.streaming) {
    return entries;
  }
  if (!last.text && !last.thinking) {
    return entries.slice(0, -1);
  }
  return [...entries.slice(0, -1), { ...last, streaming: false }];
}

function closeToolCard(
  entries: TranscriptEntry[],
  event: Extract<CcxTurnEvent, { type: "tool-end" }>
): TranscriptEntry[] {
  return entries.map((entry) =>
    entry.kind === "tool" && entry.card.callId === event.callId
      ? {
          ...entry,
          card: { ...entry.card, isError: event.isError, status: "done" as const, summary: event.summary }
        }
      : entry
  );
}

/** Render stored history the same way live events would have rendered it. */
function historyEntries(message: CcxMessage): TranscriptEntry[] {
  const blocks = Array.isArray(message.content) ? message.content : [message.content];

  if (message.role === "user") {
    const toolResults = blocks.filter(isBlockOfType("tool_result"));
    if (toolResults.length > 0) {
      // Tool results were rendered as cards when they happened; replaying them
      // as user messages would show the model's own plumbing as if a person
      // had typed it.
      return [];
    }
    return [{ kind: "user", text: textOf(blocks) }];
  }

  if (message.role === "assistant") {
    const text = textOf(blocks);
    const toolUses = blocks.filter(isBlockOfType("tool_use"));
    return [
      ...(text ? [{ kind: "assistant" as const, streaming: false, text, thinking: "" }] : []),
      ...toolUses.map((block) => ({
        card: {
          callId: String((block as Record<string, unknown>).id ?? ""),
          input: (block as Record<string, unknown>).input,
          name: String((block as Record<string, unknown>).name ?? ""),
          status: "done" as const
        },
        kind: "tool" as const
      }))
    ];
  }

  return [];
}

function isBlockOfType(type: string) {
  return (block: unknown): boolean =>
    typeof block === "object" && block !== null && (block as { type?: unknown }).type === type;
}

function textOf(blocks: unknown[]): string {
  return blocks
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }
      if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text") {
        return String((block as { text?: unknown }).text ?? "");
      }
      return "";
    })
    .filter(Boolean)
    .join("");
}

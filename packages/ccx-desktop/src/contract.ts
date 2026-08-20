/**
 * The IPC contract between the harness (main) and the Work/Code views.
 *
 * Fixed before either side is built, because the renderer and the turn loop are
 * developed against it independently and a drifting contract is the classic way
 * that goes wrong.
 *
 * Direction matters:
 *   - invoke  renderer -> main, request/response
 *   - stream  main -> renderer, fire-and-forget, high frequency
 *   - ask     main -> renderer, awaits an answer (permission prompts)
 *
 * Nothing here carries a credential. The API key stays in main; the renderer
 * never sees it.
 */

export const CCX_CHANNELS = {
  /** invoke: list sessions for the signed-in user. */
  sessionList: "ccx:session:list",
  /** invoke: create a session and return it. */
  sessionCreate: "ccx:session:create",
  /** invoke: full transcript for one session. */
  sessionMessages: "ccx:session:messages",
  /** invoke: start a turn. Resolves when the exchange finishes. */
  turnStart: "ccx:turn:start",
  /** invoke: cancel the in-flight exchange for a session. */
  turnInterrupt: "ccx:turn:interrupt",
  /** invoke: config the view needs to render itself. */
  viewConfig: "ccx:view:config",
  /** stream (main -> renderer): incremental turn events. */
  turnEvent: "ccx:turn:event",
  /** ask (main -> renderer): a permission decision is needed. */
  permissionAsk: "ccx:permission:ask",
  /** invoke: the renderer's answer to a permission ask. */
  permissionAnswer: "ccx:permission:answer"
} as const;

export type CcxMode = "code" | "work";

export type CcxSessionSummary = {
  createdAt: string;
  id: string;
  mode: CcxMode;
  model: string;
  title: string;
  updatedAt: string;
};

export type CcxMessage = {
  content: unknown;
  role: "assistant" | "system" | "tool" | "user";
  seq: number;
};

/**
 * Events streamed to the renderer during a turn.
 *
 * `sessionId` is on every event so a view showing one session ignores traffic
 * from another rather than interleaving two conversations.
 */
export type CcxTurnEvent =
  | { type: "turn-start"; sessionId: string; turnId: string; requestId: string }
  | { type: "text"; sessionId: string; text: string }
  | { type: "thinking"; sessionId: string; text: string }
  | { type: "tool-start"; sessionId: string; callId: string; name: string; input: unknown }
  | { type: "tool-end"; sessionId: string; callId: string; isError: boolean; summary: string }
  | { type: "skill-loaded"; sessionId: string; name: string }
  | { type: "turn-end"; sessionId: string; status: "cancelled" | "error" | "ok"; detail?: string }
  | { type: "usage"; sessionId: string; inputTokens: number; outputTokens: number };

export type CcxPermissionAsk = {
  detail: string;
  id: string;
  risk: "execute" | "read" | "write";
  sessionId: string;
  toolName: string;
};

export type CcxPermissionAnswer = {
  allow: boolean;
  id: string;
  remember: boolean;
};

export type CcxStartTurnRequest = {
  sessionId: string;
  text: string;
};

export type CcxStartTurnResult = {
  cancelled: boolean;
  iterations: number;
  stopReason: string;
  toolCallCount: number;
};

export type CcxViewConfig = {
  /** Shown beside the session list; the pack is visible to administrators. */
  retentionNotice: string;
  /** Empty when the user has not configured a provider yet. */
  blockedReason?: string;
  mode: CcxMode;
  model: string;
  skills: Array<{ description: string; name: string }>;
  userId: string;
};

export const DEFAULT_RETENTION_NOTICE =
  "Conversations in this app are saved and may be reviewed by an administrator.";

/** Type guard used on the renderer side, where IPC payloads arrive untyped. */
export function isCcxTurnEvent(value: unknown): value is CcxTurnEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<CcxTurnEvent>;
  return typeof candidate.type === "string" && typeof (candidate as { sessionId?: unknown }).sessionId === "string";
}

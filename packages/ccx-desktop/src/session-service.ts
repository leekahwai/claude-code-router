/**
 * Owns the turn loops and translates them into IPC events.
 *
 * The renderer holds no credentials and makes no provider calls: it sends text
 * and receives events. Permission prompts round-trip through here so a decision
 * is always made by the harness, with the renderer only relaying a human's
 * answer.
 */
import { randomUUID } from "node:crypto";
import type {
  CcxPermissionAnswer,
  CcxPermissionAsk,
  CcxStartTurnRequest,
  CcxStartTurnResult,
  CcxTurnEvent
} from "./contract";
import type { PermissionOutcome, PermissionRequest, SessionStore, TurnLoop } from "@ccx/harness";

export type SessionServiceOptions = {
  /** Delivers an event to the renderer. */
  emit: (event: CcxTurnEvent) => void;
  /** Asks the renderer for a permission decision. */
  ask: (ask: CcxPermissionAsk) => void;
  loopFor: (sessionId: string) => TurnLoop;
  sessions: SessionStore;
};

type Pending = {
  reject: (error: Error) => void;
  resolve: (outcome: PermissionOutcome) => void;
};

export class SessionService {
  private readonly inFlight = new Map<string, AbortController>();
  private readonly pendingPermissions = new Map<string, Pending>();

  constructor(private readonly options: SessionServiceOptions) {}

  async startTurn(request: CcxStartTurnRequest): Promise<CcxStartTurnResult> {
    if (this.inFlight.has(request.sessionId)) {
      throw new Error("A turn is already running for this session.");
    }
    const controller = new AbortController();
    this.inFlight.set(request.sessionId, controller);
    const loop = this.options.loopFor(request.sessionId);

    try {
      const result = await loop.runExchange({
        onEvent: (event) => this.forward(request.sessionId, event),
        sessionId: request.sessionId,
        signal: controller.signal,
        userText: request.text
      });

      this.options.emit({
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        sessionId: request.sessionId,
        type: "usage"
      });
      this.options.emit({
        sessionId: request.sessionId,
        status: result.cancelled ? "cancelled" : "ok",
        type: "turn-end"
      });
      return {
        cancelled: result.cancelled,
        iterations: result.iterations,
        stopReason: result.stopReason,
        toolCallCount: result.toolCallCount
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.options.emit({ detail, sessionId: request.sessionId, status: "error", type: "turn-end" });
      throw error;
    } finally {
      this.inFlight.delete(request.sessionId);
      // Any prompt still outstanding belongs to a turn that is over.
      this.failPendingPermissions(request.sessionId);
    }
  }

  interrupt(sessionId: string): boolean {
    const controller = this.inFlight.get(sessionId);
    controller?.abort();
    return Boolean(controller);
  }

  /**
   * The PermissionPrompter handed to the harness. Resolves when the renderer
   * answers; the harness decides what the answer means.
   */
  prompter(sessionId: string) {
    return (request: PermissionRequest): Promise<PermissionOutcome> =>
      new Promise<PermissionOutcome>((resolve, reject) => {
        const id = randomUUID();
        this.pendingPermissions.set(id, { reject, resolve });
        this.options.ask({
          detail: request.detail,
          id,
          risk: request.risk,
          sessionId,
          toolName: request.toolName
        });
      });
  }

  /** Relay of a human's answer. Unknown ids are ignored, not fatal. */
  answerPermission(answer: CcxPermissionAnswer): boolean {
    const pending = this.pendingPermissions.get(answer.id);
    if (!pending) {
      return false;
    }
    this.pendingPermissions.delete(answer.id);
    pending.resolve({
      approvedBy: "user",
      decision: answer.allow ? "allow" : "deny",
      remember: answer.remember
    });
    return true;
  }

  isBusy(sessionId: string): boolean {
    return this.inFlight.has(sessionId);
  }

  /** Cancel everything; used when the window closes or the app quits. */
  shutdown(): void {
    for (const controller of this.inFlight.values()) {
      controller.abort();
    }
    this.inFlight.clear();
    for (const [id, pending] of this.pendingPermissions) {
      pending.reject(new Error("Shutting down."));
      this.pendingPermissions.delete(id);
    }
  }

  /** Translate harness stream events into the renderer's contract. */
  private forward(sessionId: string, event: { type: string } & Record<string, unknown>): void {
    switch (event.type) {
      case "message_start":
        this.options.emit({
          requestId: String(event.requestId ?? ""),
          sessionId,
          turnId: String(event.turnId ?? ""),
          type: "turn-start"
        });
        return;
      case "text_delta":
        this.options.emit({ sessionId, text: String(event.text ?? ""), type: "text" });
        return;
      case "thinking_delta":
        this.options.emit({ sessionId, text: String(event.thinking ?? ""), type: "thinking" });
        return;
      case "tool_use_start":
        this.options.emit({
          callId: String(event.id ?? ""),
          input: undefined,
          name: String(event.name ?? ""),
          sessionId,
          type: "tool-start"
        });
        return;
      default:
        return;
    }
  }

  private failPendingPermissions(sessionId: string): void {
    for (const [id, pending] of this.pendingPermissions) {
      pending.resolve({ approvedBy: "turn-ended", decision: "deny" });
      this.pendingPermissions.delete(id);
      void id;
      void sessionId;
    }
  }
}

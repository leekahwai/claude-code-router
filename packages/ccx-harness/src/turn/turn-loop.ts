/**
 * The turn loop: stream, detect tool_use, execute, resume, until the model
 * stops asking for tools.
 *
 * Terminology: one *exchange* is one user message and everything that follows
 * it. One *turn* is one gateway request within that exchange, which is why
 * `ccx_turns` carries a `request_id` — it is the row that joins to CCR's
 * usage_events.
 */
import { randomUUID } from "node:crypto";
import type { AssemblerEvent } from "../stream/anthropic-stream";
import type { SessionStore } from "../session/store";
import type { TurnMetricsStore } from "../metrics/store";
import { streamMessages, UpstreamHttpError, type StreamMessagesResult } from "./provider-client";
import type { ToolExecutor } from "./tools";

export type TurnLoopOptions = {
  apiKey: string;
  baseUrl: string;
  /** Extra request body fields — where provider-specific tuning belongs. */
  extraBody?: Record<string, unknown>;
  maxIterations?: number;
  maxTokens?: number;
  metrics?: TurnMetricsStore;
  model: string;
  policyVersion?: string;
  sessions: SessionStore;
  /** Assembled once per request; H1 keeps it static, H4 layers policy in. */
  system?: string;
  tools?: ToolExecutor;
  userId: string;
};

export type ExchangeResult = {
  cancelled: boolean;
  iterations: number;
  requestIds: string[];
  stopReason: string;
  text: string;
  toolCallCount: number;
  usage: { inputTokens: number; outputTokens: number };
};

const defaultMaxIterations = 16;
const defaultMaxTokens = 64_000;

export class TurnLoop {
  constructor(private readonly options: TurnLoopOptions) {}

  async runExchange(input: {
    onEvent?: (event: AssemblerEvent) => void;
    sessionId: string;
    signal?: AbortSignal;
    userText: string;
  }): Promise<ExchangeResult> {
    const { sessions } = this.options;
    const maxIterations = this.options.maxIterations ?? defaultMaxIterations;

    sessions.appendMessage(input.sessionId, "user", [{ text: input.userText, type: "text" }]);

    const requestIds: string[] = [];
    let iterations = 0;
    let toolCallCount = 0;
    let text = "";
    let stopReason = "";
    let cancelled = false;
    const usage = { inputTokens: 0, outputTokens: 0 };

    while (iterations < maxIterations) {
      iterations += 1;
      const requestId = randomUUID();
      const turnId = randomUUID();
      requestIds.push(requestId);
      sessions.startTurn({ id: turnId, requestId, sessionId: input.sessionId });

      let result: StreamMessagesResult;
      try {
        result = await streamMessages(
          {
            apiKey: this.options.apiKey,
            baseUrl: this.options.baseUrl,
            body: this.requestBody(input.sessionId),
            requestId,
            signal: input.signal
          },
          input.onEvent
        );
      } catch (error) {
        const message = error instanceof UpstreamHttpError ? error.message : formatError(error);
        sessions.finishTurn(turnId, "error", message);
        throw error;
      }

      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      stopReason = result.stopReason;
      text += textOf(result.blocks);

      // Persist whatever arrived before deciding what to do next, so a
      // cancelled or errored turn still leaves the transcript intact.
      if (result.blocks.length > 0) {
        sessions.appendMessage(input.sessionId, "assistant", result.blocks);
      }
      this.recordMetrics(input.sessionId, requestId, turnId, result);

      if (result.cancelled || input.signal?.aborted) {
        sessions.finishTurn(turnId, "cancelled", "cancelled by client");
        cancelled = true;
        break;
      }
      if (result.error) {
        sessions.finishTurn(turnId, "error", result.error.message);
        break;
      }

      if (result.stopReason !== "tool_use" || result.toolUses.length === 0) {
        sessions.finishTurn(turnId, "succeeded");
        break;
      }

      // Parallel tool calls are executed concurrently and their results are
      // returned in ONE user message. Splitting them across messages trains the
      // model to stop issuing parallel calls.
      const outcomes = await Promise.all(
        result.toolUses.map(async (call) => {
          const started = Date.now();
          const rowId = sessions.recordToolCall({
            args: call.input,
            name: call.name,
            source: "mcp",
            turnId
          });
          const outcome = this.options.tools
            ? await this.options.tools.execute({ input: call.input, name: call.name }, input.signal)
            : { content: `No tool executor configured for "${call.name}".`, isError: true };
          sessions.completeToolCall(rowId, outcome.isError ? "error" : "ok", outcome.content, Date.now() - started);
          return { call, outcome };
        })
      );
      toolCallCount += outcomes.length;

      sessions.appendMessage(
        input.sessionId,
        "user",
        outcomes.map(({ call, outcome }) => ({
          content: toToolResultContent(outcome.content),
          ...(outcome.isError ? { is_error: true } : {}),
          tool_use_id: call.id,
          type: "tool_result"
        }))
      );
      sessions.finishTurn(turnId, "succeeded");

      if (input.signal?.aborted) {
        cancelled = true;
        break;
      }
    }

    return { cancelled, iterations, requestIds, stopReason, text, toolCallCount, usage };
  }

  private requestBody(sessionId: string): Record<string, unknown> {
    const messages = this.options.sessions.listMessages(sessionId).map((message) => ({
      content: message.content,
      // tool_result blocks are authored by us but belong to the user turn.
      role: message.role === "assistant" ? "assistant" : "user"
    }));

    const definitions = this.options.tools?.definitions() ?? [];
    return {
      max_tokens: this.options.maxTokens ?? defaultMaxTokens,
      messages,
      model: this.options.model,
      ...(this.options.system ? { system: this.options.system } : {}),
      ...(definitions.length > 0 ? { tools: definitions } : {}),
      ...this.options.extraBody
    };
  }

  private recordMetrics(sessionId: string, requestId: string, turnId: string, result: StreamMessagesResult): void {
    this.options.metrics?.record({
      mcpCalls: result.toolUses.length,
      mode: "code",
      policyVersion: this.options.policyVersion ?? "",
      requestId,
      sessionId,
      turnId,
      userId: this.options.userId
    });
  }
}

function textOf(blocks: StreamMessagesResult["blocks"]): string {
  return blocks
    .filter((block): block is { text: string; type: "text" } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** The API accepts a string or content blocks; anything else is serialised. */
function toToolResultContent(content: unknown): unknown {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content;
  }
  return JSON.stringify(content ?? null);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

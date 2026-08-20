/**
 * Incremental parser for the Anthropic Messages streaming format.
 *
 * The harness is a raw HTTP client of the CCR gateway, not an SDK consumer, so
 * it parses the wire format directly. Frame shapes are taken from the Messages
 * streaming reference; `input_json_delta` carrying `partial_json` is confirmed
 * against CCR's own handling (observability/request-log-store.ts:2323 and
 * gateway/features/context-archive-continuation.ts:474).
 *
 * Two responsibilities, kept separate so each is testable on its own:
 *   SseDecoder      bytes -> SSE events, tolerant of chunk boundaries
 *   MessageAssembler events -> accumulated content blocks + usage + stop reason
 */

export type SseEvent = {
  data: string;
  event: string;
};

/** Bytes to SSE events. Handles frames split across arbitrary chunks. */
export class SseDecoder {
  private buffer = "";

  push(chunk: Buffer | string): SseEvent[] {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const events: SseEvent[] = [];

    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match) {
        break;
      }
      const raw = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const parsed = parseSseFrame(raw);
      if (parsed) {
        events.push(parsed);
      }
    }

    return events;
  }

  /** Flush a trailing frame that arrived without its terminating blank line. */
  finish(): SseEvent[] {
    const remainder = this.buffer;
    this.buffer = "";
    const parsed = remainder.trim() ? parseSseFrame(remainder) : undefined;
    return parsed ? [parsed] : [];
  }
}

function parseSseFrame(raw: string): SseEvent | undefined {
  let event = "";
  const dataLines: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    // A single leading space after the colon is part of the framing, not data.
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") {
      event = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }

  if (dataLines.length === 0) {
    return undefined;
  }
  return { data: dataLines.join("\n"), event };
}

export type TextBlock = { text: string; type: "text" };
export type ThinkingBlock = { thinking: string; type: "thinking" };
export type ToolUseBlock = { id: string; input: unknown; name: string; type: "tool_use" };
export type AssembledBlock = TextBlock | ThinkingBlock | ToolUseBlock;

export type StreamUsage = {
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  inputTokens: number;
  outputTokens: number;
};

export type AssemblerEvent =
  | { type: "message_start"; model: string }
  | { type: "text_delta"; index: number; text: string }
  | { type: "thinking_delta"; index: number; thinking: string }
  | { type: "tool_use_start"; index: number; id: string; name: string }
  | { type: "block_stop"; index: number }
  | { type: "message_stop" }
  | { type: "error"; message: string; errorType: string };

type PartialBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; thinking: string }
  | { kind: "tool_use"; id: string; json: string; name: string };

/**
 * Accumulates streamed frames into finished blocks.
 *
 * Deliberately does not throw on malformed frames: a provider that emits one
 * bad frame mid-stream should not lose the turn's completed content. Undecodable
 * frames are counted and reported instead.
 */
export class MessageAssembler {
  private readonly blocks = new Map<number, PartialBlock>();
  private malformedFrames = 0;
  private model = "";
  private stopReason = "";
  private streamError: { message: string; type: string } | undefined;
  private readonly usage: StreamUsage = {
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    inputTokens: 0,
    outputTokens: 0
  };

  /** Feed one SSE event. Returns the semantic events it produced. */
  push(sse: SseEvent): AssemblerEvent[] {
    if (sse.data.trim() === "[DONE]") {
      return [{ type: "message_stop" }];
    }

    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(sse.data) as Record<string, unknown>;
    } catch {
      this.malformedFrames += 1;
      return [];
    }

    const type = typeof frame.type === "string" ? frame.type : sse.event;

    switch (type) {
      case "message_start":
        return this.onMessageStart(frame);
      case "content_block_start":
        return this.onBlockStart(frame);
      case "content_block_delta":
        return this.onBlockDelta(frame);
      case "content_block_stop":
        return [{ index: numberOf(frame.index), type: "block_stop" }];
      case "message_delta":
        return this.onMessageDelta(frame);
      case "message_stop":
        return [{ type: "message_stop" }];
      case "error":
        return this.onError(frame);
      case "ping":
      default:
        return [];
    }
  }

  private onMessageStart(frame: Record<string, unknown>): AssemblerEvent[] {
    const message = recordOf(frame.message);
    this.model = stringOf(message?.model);
    this.readUsage(recordOf(message?.usage));
    return [{ model: this.model, type: "message_start" }];
  }

  private onBlockStart(frame: Record<string, unknown>): AssemblerEvent[] {
    const index = numberOf(frame.index);
    const block = recordOf(frame.content_block);
    const blockType = stringOf(block?.type);

    if (blockType === "tool_use") {
      const id = stringOf(block?.id);
      const name = stringOf(block?.name);
      this.blocks.set(index, { id, json: "", kind: "tool_use", name });
      return [{ id, index, name, type: "tool_use_start" }];
    }
    if (blockType === "thinking") {
      this.blocks.set(index, { kind: "thinking", thinking: stringOf(block?.thinking) });
      return [];
    }
    this.blocks.set(index, { kind: "text", text: stringOf(block?.text) });
    return [];
  }

  private onBlockDelta(frame: Record<string, unknown>): AssemblerEvent[] {
    const index = numberOf(frame.index);
    const delta = recordOf(frame.delta);
    const deltaType = stringOf(delta?.type);
    const existing = this.blocks.get(index);

    if (deltaType === "text_delta") {
      const text = stringOf(delta?.text);
      const block: PartialBlock = existing?.kind === "text" ? existing : { kind: "text", text: "" };
      block.text += text;
      this.blocks.set(index, block);
      return text ? [{ index, text, type: "text_delta" }] : [];
    }

    if (deltaType === "thinking_delta") {
      const thinking = stringOf(delta?.thinking);
      const block: PartialBlock = existing?.kind === "thinking" ? existing : { kind: "thinking", thinking: "" };
      block.thinking += thinking;
      this.blocks.set(index, block);
      return thinking ? [{ index, thinking, type: "thinking_delta" }] : [];
    }

    if (deltaType === "input_json_delta") {
      // Tool arguments arrive as JSON string fragments; only the concatenation
      // is valid JSON, so parsing is deferred to finish().
      const block: PartialBlock = existing?.kind === "tool_use"
        ? existing
        : { id: "", json: "", kind: "tool_use", name: "" };
      block.json += stringOf(delta?.partial_json);
      this.blocks.set(index, block);
      return [];
    }

    // signature_delta and any future delta type: ignored, not an error.
    return [];
  }

  private onMessageDelta(frame: Record<string, unknown>): AssemblerEvent[] {
    const delta = recordOf(frame.delta);
    const reason = stringOf(delta?.stop_reason);
    if (reason) {
      this.stopReason = reason;
    }
    this.readUsage(recordOf(frame.usage));
    return [];
  }

  private onError(frame: Record<string, unknown>): AssemblerEvent[] {
    const error = recordOf(frame.error);
    this.streamError = {
      message: stringOf(error?.message) || "Upstream stream error.",
      type: stringOf(error?.type) || "error"
    };
    return [{ errorType: this.streamError.type, message: this.streamError.message, type: "error" }];
  }

  private readUsage(usage: Record<string, unknown> | undefined): void {
    if (!usage) {
      return;
    }
    // message_start carries input counts; message_delta carries the running
    // output count. Take the larger value so a late frame cannot regress it.
    this.usage.inputTokens = Math.max(this.usage.inputTokens, numberOf(usage.input_tokens));
    this.usage.outputTokens = Math.max(this.usage.outputTokens, numberOf(usage.output_tokens));
    this.usage.cacheReadInputTokens = Math.max(
      this.usage.cacheReadInputTokens,
      numberOf(usage.cache_read_input_tokens)
    );
    this.usage.cacheCreationInputTokens = Math.max(
      this.usage.cacheCreationInputTokens,
      numberOf(usage.cache_creation_input_tokens)
    );
  }

  finish(): {
    blocks: AssembledBlock[];
    error?: { message: string; type: string };
    malformedFrames: number;
    model: string;
    stopReason: string;
    toolUses: ToolUseBlock[];
    usage: StreamUsage;
  } {
    const blocks: AssembledBlock[] = [...this.blocks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, block]) => {
        if (block.kind === "text") {
          return { text: block.text, type: "text" } as TextBlock;
        }
        if (block.kind === "thinking") {
          return { thinking: block.thinking, type: "thinking" } as ThinkingBlock;
        }
        return { id: block.id, input: parseToolInput(block.json), name: block.name, type: "tool_use" } as ToolUseBlock;
      });

    return {
      blocks,
      ...(this.streamError ? { error: this.streamError } : {}),
      malformedFrames: this.malformedFrames,
      model: this.model,
      stopReason: this.stopReason,
      toolUses: blocks.filter((block): block is ToolUseBlock => block.type === "tool_use"),
      usage: { ...this.usage }
    };
  }
}

/** Empty fragments mean "no arguments", which is `{}` rather than a failure. */
function parseToolInput(json: string): unknown {
  const trimmed = json.trim();
  if (!trimmed) {
    return {};
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return {};
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

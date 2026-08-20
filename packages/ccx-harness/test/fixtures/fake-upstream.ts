/**
 * A scriptable stand-in for the CCR gateway.
 *
 * The turn loop is the hardest part of the harness, and the failure modes that
 * matter — a stream cut mid-block, a malformed frame, an error frame after
 * partial text — are ones a real provider only produces by luck. Scripting them
 * makes those cases ordinary tests.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

export type ScriptedTurn = {
  /** Written verbatim; use for malformed-frame cases. */
  raw?: string;
  /** Frames as (event, data) pairs, serialised into SSE. */
  frames?: Array<[string, unknown]>;
  /** Destroy the socket after this many frames, simulating a cut stream. */
  cutAfterFrames?: number;
  /** Milliseconds between frames, for cancellation tests. */
  delayMs?: number;
  /** Respond with this status and body instead of a stream. */
  httpError?: { body: unknown; status: number };
};

export type RecordedRequest = {
  body: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  path: string;
};

export class FakeUpstream {
  readonly requests: RecordedRequest[] = [];
  private index = 0;
  private server?: Server;
  private url = "";

  constructor(private readonly script: ScriptedTurn[]) {}

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${address.port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }

  get baseUrl(): string {
    return this.url;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    } catch {
      body = {};
    }
    this.requests.push({ body, headers: request.headers, path: request.url ?? "" });

    const turn = this.script[this.index] ?? this.script.at(-1);
    this.index += 1;
    if (!turn) {
      response.writeHead(500).end("no script");
      return;
    }

    if (turn.httpError) {
      response.writeHead(turn.httpError.status, { "content-type": "application/json" });
      response.end(JSON.stringify(turn.httpError.body));
      return;
    }

    response.writeHead(200, {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
      "x-client-request-id": String(request.headers["x-client-request-id"] ?? "")
    });

    if (turn.raw !== undefined) {
      response.end(turn.raw);
      return;
    }

    const frames = turn.frames ?? [];
    for (const [index, [event, data]] of frames.entries()) {
      if (turn.cutAfterFrames !== undefined && index >= turn.cutAfterFrames) {
        // Let the already-written frames reach the client before cutting.
        // Destroying immediately discards Node's buffered output, which
        // produces a connection failure rather than the partial stream this
        // is meant to simulate.
        await new Promise((resolve) => setTimeout(resolve, 20));
        response.destroy();
        return;
      }
      // Await the flush callback so each frame is actually on the wire.
      await new Promise<void>((resolve) => {
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`, () => resolve());
      });
      if (turn.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, turn.delayMs));
      }
    }
    response.end();
  }
}

/** Frames for a turn that answers with text and stops. */
export function textTurnFrames(text: string, outputTokens = 5): Array<[string, unknown]> {
  return [
    ["message_start", { message: { id: "msg", model: "claude-opus-5", usage: { input_tokens: 20 } }, type: "message_start" }],
    ["content_block_start", { content_block: { text: "", type: "text" }, index: 0, type: "content_block_start" }],
    ["content_block_delta", { delta: { text, type: "text_delta" }, index: 0, type: "content_block_delta" }],
    ["content_block_stop", { index: 0, type: "content_block_stop" }],
    ["message_delta", { delta: { stop_reason: "end_turn" }, type: "message_delta", usage: { output_tokens: outputTokens } }],
    ["message_stop", { type: "message_stop" }]
  ];
}

/** Frames for a turn that requests one or more tools and stops on tool_use. */
export function toolTurnFrames(
  calls: Array<{ id: string; input: unknown; name: string }>,
  leadingText = ""
): Array<[string, unknown]> {
  const frames: Array<[string, unknown]> = [
    ["message_start", { message: { id: "msg", model: "claude-opus-5", usage: { input_tokens: 30 } }, type: "message_start" }]
  ];
  let index = 0;
  if (leadingText) {
    frames.push(
      ["content_block_start", { content_block: { text: "", type: "text" }, index, type: "content_block_start" }],
      ["content_block_delta", { delta: { text: leadingText, type: "text_delta" }, index, type: "content_block_delta" }],
      ["content_block_stop", { index, type: "content_block_stop" }]
    );
    index += 1;
  }
  for (const call of calls) {
    const json = JSON.stringify(call.input);
    frames.push(
      ["content_block_start", { content_block: { id: call.id, input: {}, name: call.name, type: "tool_use" }, index, type: "content_block_start" }],
      ["content_block_delta", { delta: { partial_json: json.slice(0, 3), type: "input_json_delta" }, index, type: "content_block_delta" }],
      ["content_block_delta", { delta: { partial_json: json.slice(3), type: "input_json_delta" }, index, type: "content_block_delta" }],
      ["content_block_stop", { index, type: "content_block_stop" }]
    );
    index += 1;
  }
  frames.push(
    ["message_delta", { delta: { stop_reason: "tool_use" }, type: "message_delta", usage: { output_tokens: 12 } }],
    ["message_stop", { type: "message_stop" }]
  );
  return frames;
}

/**
 * Streaming client for the local CCR gateway.
 *
 * The harness speaks the Anthropic Messages protocol to the gateway; the
 * gateway decides which provider actually serves it. That is why this client
 * sends no Anthropic-only tuning parameters of its own — `thinking`,
 * `output_config` and friends are rejected by several providers CCR can route
 * to, so they are opt-in via `extraBody` for deployments that know their
 * routing, rather than defaulted here.
 */
import { MessageAssembler, SseDecoder, type AssemblerEvent } from "../stream/anthropic-stream";

export type StreamMessagesRequest = {
  apiKey: string;
  baseUrl: string;
  body: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
  path?: string;
  /** Sent as x-client-request-id; the join key into CCR's usage_events. */
  requestId: string;
  signal?: AbortSignal;
};

export type StreamMessagesResult = ReturnType<MessageAssembler["finish"]> & {
  cancelled: boolean;
  httpStatus: number;
};

export class UpstreamHttpError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`Gateway returned ${status}: ${body.slice(0, 500)}`);
    this.name = "UpstreamHttpError";
  }
}

export async function streamMessages(
  request: StreamMessagesRequest,
  onEvent?: (event: AssemblerEvent) => void
): Promise<StreamMessagesResult> {
  const url = new URL(request.path ?? "/v1/messages", request.baseUrl).toString();
  const decoder = new SseDecoder();
  const assembler = new MessageAssembler();

  let response: Response;
  try {
    response = await fetch(url, {
      body: JSON.stringify({ ...request.body, stream: true }),
      headers: {
        "accept": "text/event-stream",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": request.apiKey,
        "x-client-request-id": request.requestId,
        ...request.extraHeaders
      },
      method: "POST",
      signal: request.signal
    });
  } catch (error) {
    if (isAbortError(error)) {
      return { ...assembler.finish(), cancelled: true, httpStatus: 0 };
    }
    throw error;
  }

  if (!response.ok) {
    throw new UpstreamHttpError(response.status, await response.text().catch(() => ""));
  }
  if (!response.body) {
    return { ...assembler.finish(), cancelled: false, httpStatus: response.status };
  }

  const reader = response.body.getReader();
  let cancelled = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      for (const sse of decoder.push(Buffer.from(value))) {
        for (const event of assembler.push(sse)) {
          onEvent?.(event);
        }
      }
    }
    // A stream cut mid-frame leaves a trailing partial; flush whatever parses.
    for (const sse of decoder.finish()) {
      for (const event of assembler.push(sse)) {
        onEvent?.(event);
      }
    }
  } catch (error) {
    if (!isAbortError(error) && !isPrematureClose(error)) {
      throw error;
    }
    // Cancellation and a premature close both leave partial content that the
    // caller still needs to persist, so neither is rethrown.
    cancelled = isAbortError(error);
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return { ...assembler.finish(), cancelled, httpStatus: response.status };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

const prematureCloseCodes = new Set([
  "ECONNRESET",
  "ERR_STREAM_PREMATURE_CLOSE",
  "UND_ERR_SOCKET"
]);

/**
 * A stream cut mid-turn is normal operationally — a proxy restart, a dropped
 * link — and must not lose the partial content already assembled.
 *
 * undici surfaces it as `TypeError: fetch failed` with the real code on
 * `error.cause`, so the cause chain has to be walked rather than checking the
 * top-level error. Missing that made a socket cut throw instead of returning
 * the partial turn.
 */
function isPrematureClose(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && prematureCloseCodes.has(code)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

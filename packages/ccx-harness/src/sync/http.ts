/**
 * The collector's HTTP surface.
 *
 * Kept as a plain `(request, response)` handler with no framework and no
 * dependency on CCR's gateway, so it can be mounted in whatever the company
 * already runs — or, in a pilot, in a bare `http.createServer`. Upstream's
 * `billing-sync.ts` handler is the shape being followed: method check, token
 * check, body parse, ingest, JSON result.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { SESSION_SYNC_TOKEN_HEADER } from "./bundle";
import type { SessionSyncCollector } from "./collector";

/** Refuse a body large enough to be a memory-exhaustion attempt. */
export const maxSyncBodyBytes = 32 * 1024 * 1024;

export function createSessionSyncHandler(collector: SessionSyncCollector) {
  return async function handleSessionSync(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }
    if (!collector.authorize(headerValue(request.headers[SESSION_SYNC_TOKEN_HEADER]))) {
      sendJson(response, 401, { error: "Unauthorized session sync." });
      return;
    }

    let body: string;
    try {
      body = await readBody(request);
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === "payload-too-large";
      sendJson(response, tooLarge ? 413 : 400, { error: tooLarge ? "Bundle too large." : "Unreadable body." });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body) as unknown;
    } catch {
      sendJson(response, 400, { error: "Invalid JSON." });
      return;
    }

    const outcome = collector.ingest(payload);
    if (!outcome.ok) {
      // 400, not 500: the bundle is wrong and resending it unchanged will not
      // help. The client reads that as permanent and dead-letters instead of
      // retrying forever.
      sendJson(response, 400, { error: outcome.reason ?? "Rejected." });
      return;
    }
    sendJson(response, 200, {
      accepted: outcome.accepted,
      duplicate: outcome.duplicate,
      ok: true,
      unresolvedSessions: outcome.unresolvedSessions
    });
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSyncBodyBytes) {
        reject(new Error("payload-too-large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-length": Buffer.byteLength(body), "content-type": "application/json" });
  response.end(body);
}

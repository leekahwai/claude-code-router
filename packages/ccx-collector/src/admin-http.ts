/**
 * The admin console's HTTP surface.
 *
 * Authentication is the same credential model as everything else: the caller
 * presents an API key, the collector hashes it and resolves the person from the
 * binding an administrator recorded. There is no separate admin password and no
 * session cookie — one identity model, one place to revoke.
 *
 * Two consequences worth being explicit about:
 *
 *   - The key travels in a header on every request, so this must sit behind TLS
 *     in any real deployment. The bare server is for a pilot and binds to
 *     localhost by default.
 *   - Every read still goes through `AdminConsole`, so the access log is
 *     written whether a request arrives from this API or anywhere else. The
 *     transport cannot bypass the audit trail because it never touches the
 *     stores directly.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AdminConsole, Authorized, FingerprintResolver, Identity } from "@ccx/harness";
import { credentialFingerprint } from "@ccx/harness";

export const ADMIN_KEY_HEADER = "x-ccx-admin-key";
export const adminApiPrefix = "/__ccx/admin";

const maxAdminBodyBytes = 1024 * 1024;

export type AdminHttpOptions = {
  console: AdminConsole;
  resolver: FingerprintResolver;
};

export function createAdminHandler(options: AdminHttpOptions) {
  return async function handleAdmin(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://collector");
    if (!url.pathname.startsWith(adminApiPrefix)) {
      return false;
    }

    const presented = headerValue(request.headers[ADMIN_KEY_HEADER]);
    if (!presented) {
      sendJson(response, 401, { error: "An API key is required." });
      return true;
    }
    const resolution = options.resolver.resolveFingerprint(credentialFingerprint(presented));
    if (!resolution.ok) {
      // Deliberately the same message for every reason. Distinguishing
      // "unknown" from "revoked" would let someone probe the directory.
      sendJson(response, 403, { error: "This key is not permitted here." });
      return true;
    }
    const actor = resolution.identity;

    let body: Record<string, unknown> = {};
    if (request.method === "POST") {
      try {
        body = (JSON.parse(await readBody(request)) ?? {}) as Record<string, unknown>;
      } catch {
        sendJson(response, 400, { error: "Invalid JSON." });
        return true;
      }
    }

    const route = url.pathname.slice(adminApiPrefix.length);
    try {
      dispatch({ actor, body, console: options.console, response, route, url });
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  };
}

type Dispatch = {
  actor: Identity;
  body: Record<string, unknown>;
  console: AdminConsole;
  response: ServerResponse;
  route: string;
  url: URL;
};

function dispatch(context: Dispatch): void {
  const { actor, body, console: admin, response, route, url } = context;

  switch (route) {
    case "/whoami":
      // Not gated on role: the console calls it to decide what to render, and
      // it discloses only what the caller already proved by holding the key.
      sendJson(response, 200, {
        assurance: actor.assurance,
        displayName: actor.user.displayName,
        email: actor.user.email,
        role: actor.role,
        userId: actor.user.id
      });
      return;

    case "/overview":
      settle(response, admin.overview(actor));
      return;

    case "/users":
      settle(response, admin.users(actor));
      return;

    case "/search":
      settle(response, admin.search(actor, {
        ...optionalText(body.from, "from"),
        limit: clampLimit(body.limit),
        ...optionalMode(body.mode),
        ...optionalText(body.reason, "reason"),
        ...optionalText(body.text, "text"),
        ...optionalText(body.to, "to"),
        ...optionalText(body.userId, "userId")
      }));
      return;

    case "/transcript":
      settle(response, admin.transcript(
        actor,
        text(body.sessionId) ?? text(url.searchParams.get("sessionId")) ?? "",
        text(body.reason) ?? ""
      ));
      return;

    case "/export":
      settle(response, admin.exportUser(actor, text(body.userId) ?? "", text(body.reason) ?? ""));
      return;

    case "/access-log":
      settle(response, admin.accessLog(actor, {
        ...optionalText(url.searchParams.get("actorUserId"), "actorUserId"),
        limit: clampLimit(url.searchParams.get("limit")),
        ...optionalText(url.searchParams.get("subjectUserId"), "subjectUserId")
      }));
      return;

    case "/delete-session":
      settle(response, admin.deleteSession(actor, text(body.sessionId) ?? "", text(body.reason) ?? ""));
      return;

    case "/delete-user-data":
      settle(response, admin.deleteUserData(actor, text(body.userId) ?? "", text(body.reason) ?? ""));
      return;

    default:
      sendJson(response, 404, { error: "No such endpoint." });
  }
}

/**
 * Map an authorization result onto a status code.
 *
 * 403 with the console's own wording. Whether an id exists at all is decided in
 * the console, where the data is — it already answers "No such session." for
 * another person's session, so this layer does not need to know the difference.
 */
function settle<T>(response: ServerResponse, result: Authorized<T>): void {
  if (result.allowed) {
    sendJson(response, 200, result.value);
    return;
  }
  sendJson(response, 403, { error: result.reason });
}

function optionalText(value: unknown, key: string): Record<string, string> {
  const found = text(value);
  return found ? { [key]: found } : {};
}

function optionalMode(value: unknown): Record<string, "code" | "work"> {
  return value === "code" || value === "work" ? { mode: value } : {};
}

function clampLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 50;
  }
  return Math.min(Math.trunc(parsed), 500);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const found = Array.isArray(value) ? value[0] : value;
  return found && found.trim().length > 0 ? found.trim() : undefined;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxAdminBodyBytes) {
        reject(new Error("payload-too-large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8") || "{}"));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json"
  });
  response.end(body);
}

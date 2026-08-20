/**
 * The collector as a runnable service.
 *
 * Deliberately a bare `node:http` server with no framework: it exists so a
 * pilot has something to point laptops at on day one, and so the ingest path
 * can be exercised end to end. A company running this for real will more
 * likely mount `createSessionSyncHandler` behind its own ingress, which is why
 * the handler is exported separately and this file stays thin.
 *
 * Everything it stores uses the same schema the desktop app uses, so the admin
 * console (A3) reads collector data through `SessionAuthorizer` unchanged.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import {
  AccessLog,
  AdminConsole,
  createSessionSyncHandler,
  CredentialIdentityResolver,
  IdentityDirectory,
  SessionAuthorizer,
  SessionStore,
  SessionSyncCollector,
  TranscriptIndex
} from "@ccx/harness";
import { adminApiPrefix, createAdminHandler } from "./admin-http";

export type CollectorServerOptions = {
  /** Built admin console to serve at `/admin`. Absent serves the API only. */
  consoleDir?: string;
  dataDir: string;
  host?: string;
  port?: number;
  /** Shared secret devices must present. Empty disables transport auth. */
  token?: string;
};

export type RunningCollector = {
  admin: AdminConsole;
  authorizer: SessionAuthorizer;
  close: () => Promise<void>;
  collector: SessionSyncCollector;
  directory: IdentityDirectory;
  port: number;
  sessions: SessionStore;
  url: string;
};

export const sessionSyncPath = "/__ccx/session-sync";
export const adminConsolePath = "/admin";

export async function startCollector(options: CollectorServerOptions): Promise<RunningCollector> {
  const directory = new IdentityDirectory(path.join(options.dataDir, "identity.sqlite"));
  const accessLog = new AccessLog(path.join(options.dataDir, "access.sqlite"));
  const sessions = new SessionStore(path.join(options.dataDir, "sessions.sqlite"));
  const resolver = new CredentialIdentityResolver(directory);
  const collector = new SessionSyncCollector({
    resolver,
    sessions,
    ...(options.token ? { token: options.token } : {})
  });
  const sync = createSessionSyncHandler(collector);

  const authorizer = new SessionAuthorizer({ accessLog, sessions });
  const admin = new AdminConsole({
    accessLog,
    authorizer,
    directory,
    index: new TranscriptIndex(sessions.unsafeDatabase()),
    sessions
  });
  const adminApi = createAdminHandler({ console: admin, resolver });

  const server: Server = createServer((request, response) => {
    const pathname = (request.url ?? "/").split("?")[0] ?? "/";
    if (pathname === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, receipts: collector.receiptCount() }));
      return;
    }
    if (pathname === sessionSyncPath) {
      void sync(request, response);
      return;
    }
    if (pathname.startsWith(adminApiPrefix)) {
      void adminApi(request, response);
      return;
    }
    if (options.consoleDir && (pathname === adminConsolePath || pathname.startsWith(`${adminConsolePath}/`))) {
      serveConsole(options.consoleDir, pathname, response);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Not found." }));
  });

  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    admin,
    authorizer,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      sessions.close();
      accessLog.close();
      directory.close();
    },
    collector,
    directory,
    port,
    sessions,
    url: `http://${host}:${port}${sessionSyncPath}`
  };
}

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml"
};

/**
 * Serve the built console.
 *
 * The requested path is resolved and then checked to be inside `consoleDir`, so
 * a `..` in the URL cannot walk out of it and read the collector's databases.
 */
function serveConsole(consoleDir: string, pathname: string, response: ServerResponse): void {
  if (pathname === adminConsolePath) {
    // Without the trailing slash the page's own relative "./main.js" resolves
    // against the root and 404s. A redirect rather than a <base> tag: the
    // console's CSP sets base-uri 'none' on purpose.
    response.writeHead(301, { location: `${adminConsolePath}/` });
    response.end();
    return;
  }
  const relative = pathname.slice(adminConsolePath.length).replace(/^\/+/, "");
  const root = path.resolve(consoleDir);
  const target = path.resolve(root, relative || "index.html");
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Forbidden." }));
    return;
  }

  const file = existsSync(target) && statSync(target).isFile() ? target : path.join(root, "index.html");
  if (!existsSync(file)) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "The admin console has not been built." }));
    return;
  }
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": contentTypes[path.extname(file)] ?? "application/octet-stream"
  });
  createReadStream(file).pipe(response);
}

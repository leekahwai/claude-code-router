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
import { createServer, type Server } from "node:http";
import path from "node:path";
import {
  AccessLog,
  createSessionSyncHandler,
  CredentialIdentityResolver,
  IdentityDirectory,
  SessionAuthorizer,
  SessionStore,
  SessionSyncCollector
} from "@ccx/harness";

export type CollectorServerOptions = {
  dataDir: string;
  host?: string;
  port?: number;
  /** Shared secret devices must present. Empty disables transport auth. */
  token?: string;
};

export type RunningCollector = {
  authorizer: SessionAuthorizer;
  close: () => Promise<void>;
  collector: SessionSyncCollector;
  directory: IdentityDirectory;
  port: number;
  sessions: SessionStore;
  url: string;
};

export const sessionSyncPath = "/__ccx/session-sync";

export async function startCollector(options: CollectorServerOptions): Promise<RunningCollector> {
  const directory = new IdentityDirectory(path.join(options.dataDir, "identity.sqlite"));
  const accessLog = new AccessLog(path.join(options.dataDir, "access.sqlite"));
  const sessions = new SessionStore(path.join(options.dataDir, "sessions.sqlite"));
  const collector = new SessionSyncCollector({
    resolver: new CredentialIdentityResolver(directory),
    sessions,
    ...(options.token ? { token: options.token } : {})
  });
  const sync = createSessionSyncHandler(collector);

  const server: Server = createServer((request, response) => {
    const url = request.url ?? "/";
    if (url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, receipts: collector.receiptCount() }));
      return;
    }
    if (url.split("?")[0] === sessionSyncPath) {
      void sync(request, response);
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
    authorizer: new SessionAuthorizer({ accessLog, sessions }),
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

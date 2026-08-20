/**
 * The collector process itself. Launched by serve.mjs, which picks the runtime
 * that can load better-sqlite3 here.
 *
 * Registering the people whose transcripts it will accept is a separate,
 * deliberate act: a fingerprint with no binding is rejected, so an unregistered
 * laptop cannot deposit anything here.
 */
import path from "node:path";
import "../../ccx-vendor/tools/ccr-alias-hook.mjs";

const { startCollector } = await import("../src/server.ts");

const dataDir = process.env.CCX_COLLECTOR_DATA_DIR ?? path.join(process.cwd(), ".ccx-collector");
const running = await startCollector({
  dataDir,
  host: process.env.CCX_COLLECTOR_HOST ?? "127.0.0.1",
  port: Number(process.env.CCX_COLLECTOR_PORT ?? 8787),
  token: process.env.CCX_COLLECTOR_TOKEN ?? ""
});

process.stdout.write(`[ccx-collector] listening on ${running.url}\n`);
process.stdout.write(`[ccx-collector] data directory ${path.resolve(dataDir)}\n`);
if (!process.env.CCX_COLLECTOR_TOKEN) {
  process.stdout.write("[ccx-collector] warning: no CCX_COLLECTOR_TOKEN set, transport auth is disabled\n");
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void running.close().then(() => process.exit(0));
  });
}

/**
 * Run the collector.
 *
 *   CCX_COLLECTOR_DATA_DIR=/var/lib/ccx \
 *   CCX_COLLECTOR_TOKEN=... \
 *   npm run -w @ccx/collector start
 *
 * A launcher rather than the server itself: better-sqlite3 is built for one
 * ABI, and on a machine set up for the desktop app that ABI is Electron's. The
 * probe picks whichever runtime can actually open a database, so the collector
 * runs on a developer laptop and a plain server alike.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSqliteRuntime } from "../../ccx-vendor/tools/sqlite-runtime.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const runtime = resolveSqliteRuntime();

const child = spawn(
  runtime.command,
  ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", path.join(here, "serve-main.mjs")],
  { env: { ...process.env, ...runtime.env }, stdio: "inherit" }
);

child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
child.on("error", (error) => {
  console.error(`Failed to start the collector: ${error.message}`);
  process.exit(1);
});

/**
 * Run a render smoke under whichever runtime can load better-sqlite3.
 *
 * The admin console smoke starts a real collector in-process, so it opens
 * SQLite — and on a machine set up for the desktop app that binding is built
 * for Electron's ABI. Same probe the test runner uses; Playwright itself works
 * under either runtime.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSqliteRuntime } from "../../ccx-vendor/tools/sqlite-runtime.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = process.argv[2];
if (!script) {
  console.error("Usage: node tools/run-render-smoke.mjs <script>");
  process.exit(2);
}

const runtime = resolveSqliteRuntime();
const child = spawn(
  runtime.command,
  ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", path.resolve(here, "..", script)],
  { env: { ...process.env, ...runtime.env }, stdio: "inherit" }
);

child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
child.on("error", (error) => {
  console.error(`Failed to start the render smoke: ${error.message}`);
  process.exit(1);
});

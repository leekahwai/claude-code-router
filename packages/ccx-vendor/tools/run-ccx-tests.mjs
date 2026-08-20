/**
 * Run @ccx package tests under whichever runtime can load better-sqlite3.
 *
 * The native module is compiled for exactly one ABI. A developer following the
 * repo's own setup runs `npm run rebuild:sqlite3`, which builds it for Electron;
 * a lighter setup builds it for Node. Upstream solves this for its core suite
 * with a probe in build/run-tests.mjs ("node-with-electron-fallback"). We mirror
 * that logic here rather than dictating one setup, so `npm test` works in both.
 *
 *   node tools/run-ccx-tests.mjs "test/**\/*.test.ts"
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSqliteRuntime } from "./sqlite-runtime.mjs";

const hookPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "ccr-alias-hook.mjs");
const patterns = process.argv.slice(2);

if (patterns.length === 0) {
  console.error("Usage: node tools/run-ccx-tests.mjs <test-glob> [...]");
  process.exit(2);
}

const executable = resolveSqliteRuntime();

const child = spawn(
  executable.command,
  [
    "--disable-warning=ExperimentalWarning",
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    "--test",
    "--import",
    hookPath,
    ...patterns
  ],
  {
    env: { ...process.env, ...executable.env },
    stdio: "inherit"
  }
);

child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : code ?? 0);
});
child.on("error", (error) => {
  console.error(`Failed to start the test runtime: ${error.message}`);
  process.exit(1);
});

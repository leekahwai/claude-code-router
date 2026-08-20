/**
 * Which runtime can actually load better-sqlite3 here.
 *
 * The native module is compiled for exactly one ABI. A developer following the
 * repo's own setup runs `npm run rebuild:sqlite3`, which builds it for Electron;
 * a server or a lighter setup builds it for Node. Upstream solves this for its
 * core suite with a probe in build/run-tests.mjs ("node-with-electron-fallback").
 * Mirrored here so both the test runner and the collector work in either setup
 * rather than dictating one.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const requireFromHere = createRequire(import.meta.url);

export function resolveSqliteRuntime() {
  const probe = spawnSync(process.execPath, [
    "-e",
    "const Database = require('better-sqlite3'); new Database(':memory:').close();"
  ], { stdio: "ignore" });

  if (probe.status === 0) {
    return { command: process.execPath, env: {} };
  }

  try {
    return { command: requireFromHere("electron"), env: { ELECTRON_RUN_AS_NODE: "1" } };
  } catch {
    // No Electron available either. Run under Node and let the real failure
    // surface, rather than hiding it behind a launcher error.
    return { command: process.execPath, env: {} };
  }
}

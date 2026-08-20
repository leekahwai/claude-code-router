/**
 * Launch the real Electron app twice against a throwaway data directory and
 * assert the Work/Code surface actually comes up.
 *
 * Everything else in this product is tested under plain Node or headless
 * Chromium. Neither exercises the thing that most often breaks: the packaged
 * main bundle, the sandboxed preload, and the file:// renderer load. This does.
 *
 * Run 1 must provision the temporary administrator exactly once and pass every
 * in-page check. Run 2, against the same data directory, must pass again and
 * must NOT provision a second administrator — a bootstrap that re-fires is a
 * back door.
 *
 * Set CCX_SMOKE_KEEP=1 to keep the temporary data directory for inspection.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const electronBinary = require("electron");
const bootstrapPattern = /^\[ccx] Temporary administrator provisioned\. API key: (\S+)$/;
const runTimeoutMs = 120_000;

function hasCommand(command) {
  return spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).status === 0;
}

function launch(dataDir, apiKey) {
  const electronArgs = [repoRoot];
  // Chromium refuses its own sandbox when the process is root (CI containers).
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    electronArgs.unshift("--no-sandbox");
  }

  let command = electronBinary;
  let args = electronArgs;
  if (!process.env.DISPLAY && hasCommand("xvfb-run")) {
    command = "xvfb-run";
    args = ["-a", electronBinary, ...electronArgs];
  }

  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CCR_INTERNAL_HOME_DIR: dataDir,
      CCX_API_KEY: apiKey ?? "",
      CCX_PROJECT_DIR: repoRoot,
      CCX_SMOKE: "1"
    },
    timeout: runTimeoutMs
  });

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const lines = output.split("\n");
  return {
    bootstrapKeys: lines.map((line) => bootstrapPattern.exec(line.trim())?.[1]).filter(Boolean),
    checks: lines.filter((line) => line.startsWith("[ccx-smoke] check ")),
    failures: lines.filter((line) => line.startsWith("[ccx-smoke] failure: ")),
    output,
    passed: lines.some((line) => line.trim() === "[ccx-smoke] PASS"),
    status: result.status,
    viewConfig: readViewConfig(lines)
  };
}

function readViewConfig(lines) {
  const line = lines.find((candidate) => candidate.includes("[ccx-smoke] check viewConfig: "));
  if (!line) {
    return undefined;
  }
  try {
    return JSON.parse(line.slice(line.indexOf("{")));
  } catch {
    return undefined;
  }
}

const problems = [];
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccx-electron-smoke-"));

try {
  let provisionedKey;

  /**
   * Each run is a full app launch against the same data directory.
   * `expectedKeys` is how many provisioning lines the run may print;
   * `expectedUser` is the identity the window must resolve to ("" = blocked).
   */
  const runs = [
    { expectedKeys: 1, expectedUser: "bootstrap-admin", key: () => "", label: "first run, no key" },
    { expectedKeys: 0, expectedUser: "bootstrap-admin", key: () => provisionedKey, label: "second run, provisioned key" },
    { expectedKeys: 0, expectedUser: "", key: () => "ccx-unbound-key-for-smoke", label: "third run, unbound key" }
  ];

  for (const spec of runs) {
    process.stdout.write(`[ccx-smoke-runner] ${spec.label}\n`);
    const run = launch(dataDir, spec.key());
    for (const check of run.checks) {
      process.stdout.write(`  ${check}\n`);
    }

    if (!run.passed || run.status !== 0) {
      problems.push(`${spec.label}: exited ${run.status} without PASS`);
      for (const failure of run.failures) {
        problems.push(`${spec.label}: ${failure}`);
      }
      if (run.failures.length === 0) {
        process.stderr.write(run.output);
      }
    }

    if (run.bootstrapKeys.length !== spec.expectedKeys) {
      problems.push(`${spec.label}: expected ${spec.expectedKeys} provisioning key(s), saw ${run.bootstrapKeys.length}`);
    }
    provisionedKey = provisionedKey ?? run.bootstrapKeys[0];

    const user = run.viewConfig?.user;
    if (user !== spec.expectedUser) {
      problems.push(`${spec.label}: expected identity "${spec.expectedUser}", saw "${user ?? "<none>"}"`);
    }
    if (spec.expectedUser === "" && !run.viewConfig?.blocked) {
      problems.push(`${spec.label}: an unbound key was not blocked`);
    }
  }

  if (!provisionedKey) {
    problems.push("first run never printed a provisioning key");
  }
} finally {
  if (process.env.CCX_SMOKE_KEEP === "1") {
    process.stdout.write(`[ccx-smoke-runner] kept ${dataDir}\n`);
  } else {
    fs.rmSync(dataDir, { force: true, recursive: true });
  }
}

if (problems.length > 0) {
  for (const problem of problems) {
    process.stderr.write(`[ccx-smoke-runner] ${problem}\n`);
  }
  process.exit(1);
}

process.stdout.write("[ccx-smoke-runner] ok\n");

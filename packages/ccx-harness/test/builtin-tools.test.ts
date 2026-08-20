import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BuiltinTools } from "../src/tools/builtin.ts";
import { defaultModePolicies, PermissionGate } from "../src/tools/permissions.ts";
import { Workspace } from "../src/tools/workspace.ts";

const allowAll = {
  allowed: { execute: "allow", read: "allow", write: "allow" }
} as const;

function setup(limits = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccx-builtin-"));
  const workspace = new Workspace(root);
  const gate = new PermissionGate({ policy: allowAll });
  return {
    cleanup: () => rmSync(root, { force: true, recursive: true }),
    tools: new BuiltinTools({ gate, limits, policy: allowAll, workspace }),
    workspace
  };
}

test("write then read round-trips through the workspace", async () => {
  const s = setup();
  try {
    const written = await s.tools.execute("write_file", { content: "hello file", path: "dir/a.txt" });
    assert.equal(written.isError, undefined);
    assert.equal(readFileSync(path.join(s.workspace.root, "dir/a.txt"), "utf8"), "hello file");

    const read = await s.tools.execute("read_file", { path: "dir/a.txt" });
    assert.equal(read.content, "hello file");
  } finally {
    s.cleanup();
  }
});

test("reading a file over the size limit is refused rather than blowing context", async () => {
  const s = setup({ maxReadBytes: 16 });
  try {
    writeFileSync(path.join(s.workspace.root, "big.txt"), "x".repeat(64));
    const outcome = await s.tools.execute("read_file", { path: "big.txt" });
    assert.equal(outcome.isError, true);
    assert.match(String(outcome.content), /limit is 16/);
  } finally {
    s.cleanup();
  }
});

test("glob matches by extension and skips node_modules and dotfiles", async () => {
  const s = setup();
  try {
    mkdirSync(path.join(s.workspace.root, "src"), { recursive: true });
    mkdirSync(path.join(s.workspace.root, "node_modules/pkg"), { recursive: true });
    mkdirSync(path.join(s.workspace.root, ".git"), { recursive: true });
    writeFileSync(path.join(s.workspace.root, "src/a.ts"), "");
    writeFileSync(path.join(s.workspace.root, "src/b.js"), "");
    writeFileSync(path.join(s.workspace.root, "node_modules/pkg/c.ts"), "");
    writeFileSync(path.join(s.workspace.root, ".git/d.ts"), "");

    const outcome = await s.tools.execute("glob", { pattern: "*.ts" });
    const lines = String(outcome.content).split("\n").sort();
    assert.deepEqual(lines, [path.join("src", "a.ts")]);
  } finally {
    s.cleanup();
  }
});

test("grep reports file, line number and content", async () => {
  const s = setup();
  try {
    writeFileSync(path.join(s.workspace.root, "code.ts"), "const a = 1;\nconst target = 2;\n");
    const outcome = await s.tools.execute("grep", { pattern: "target" });
    assert.match(String(outcome.content), /code\.ts:2: const target = 2;/);
  } finally {
    s.cleanup();
  }
});

test("an invalid regular expression is an error message, not a crash", async () => {
  const s = setup();
  try {
    const outcome = await s.tools.execute("grep", { pattern: "([unclosed" });
    assert.equal(outcome.isError, true);
    assert.match(String(outcome.content), /Invalid regular expression/);
  } finally {
    s.cleanup();
  }
});

test("bash runs in the workspace root and returns output", async () => {
  const s = setup();
  try {
    writeFileSync(path.join(s.workspace.root, "marker.txt"), "");
    const outcome = await s.tools.execute("bash", { command: "ls" });
    assert.match(String(outcome.content), /marker\.txt/);
    assert.equal(outcome.isError, undefined);
  } finally {
    s.cleanup();
  }
});

test("a non-zero exit is surfaced as an error with its output", async () => {
  const s = setup();
  try {
    const outcome = await s.tools.execute("bash", { command: "echo oops >&2; exit 3" });
    assert.equal(outcome.isError, true);
    assert.match(String(outcome.content), /oops/);
  } finally {
    s.cleanup();
  }
});

test("a hanging command is killed at the timeout", async () => {
  const s = setup({ bashTimeoutMs: 150 });
  try {
    const started = Date.now();
    const outcome = await s.tools.execute("bash", { command: "sleep 10" });
    assert.equal(outcome.isError, true);
    assert.match(String(outcome.content), /timeout/);
    assert.ok(Date.now() - started < 5000, "the timeout must actually fire");
  } finally {
    s.cleanup();
  }
});

test("cancelling the turn kills a running command", async () => {
  const s = setup({ bashTimeoutMs: 10_000 });
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const outcome = await s.tools.execute("bash", { command: "sleep 10" }, controller.signal);
    assert.equal(outcome.isError, true);
    assert.match(String(outcome.content), /cancelled/);
  } finally {
    s.cleanup();
  }
});

test("command output is truncated at the byte limit", async () => {
  const s = setup({ maxOutputBytes: 128 });
  try {
    const outcome = await s.tools.execute("bash", { command: "head -c 100000 /dev/zero | tr '\\0' 'a'" });
    assert.ok(String(outcome.content).length <= 300, "unbounded output would flood the context window");
  } finally {
    s.cleanup();
  }
});

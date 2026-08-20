import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BuiltinTools } from "../src/tools/builtin.ts";
import { HarnessTools } from "../src/tools/registry.ts";
import { defaultModePolicies, PermissionGate, type ModePolicy, type PermissionRequest } from "../src/tools/permissions.ts";
import { Workspace } from "../src/tools/workspace.ts";

function setup(policy: ModePolicy, prompter?: Parameters<typeof PermissionGate>[0] extends never ? never : undefined) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccx-tools-"));
  const workspace = new Workspace(root);
  const gate = new PermissionGate({ policy });
  const builtin = new BuiltinTools({ gate, policy, workspace });
  return {
    builtin,
    cleanup: () => rmSync(root, { force: true, recursive: true }),
    gate,
    tools: new HarnessTools({ builtin, gate, policy }),
    workspace
  };
}

test("Work mode advertises no shell and no write tools", () => {
  const s = setup(defaultModePolicies.work);
  try {
    const names = s.tools.definitions().map((definition) => definition.name).sort();
    assert.deepEqual(names, ["glob", "grep", "read_file"]);
    assert.ok(!names.includes("bash"), "Work must not hold a shell");
    assert.ok(!names.includes("write_file"), "Work must not write to disk");
  } finally {
    s.cleanup();
  }
});

test("Code mode advertises the full builtin surface", () => {
  const s = setup(defaultModePolicies.code);
  try {
    const names = s.tools.definitions().map((definition) => definition.name).sort();
    assert.deepEqual(names, ["bash", "glob", "grep", "read_file", "write_file"]);
  } finally {
    s.cleanup();
  }
});

test("Work mode refuses a shell call even if the model asks for it directly", async () => {
  const s = setup(defaultModePolicies.work);
  try {
    const outcome = await s.tools.execute({ input: { command: "echo pwned" }, name: "bash" });
    assert.equal(outcome.isError, true);
    assert.match(String(outcome.content), /not available in this mode/);
  } finally {
    s.cleanup();
  }
});

test("Work mode refuses a write even though the tool exists in code", async () => {
  const s = setup(defaultModePolicies.work);
  try {
    const outcome = await s.tools.execute({ input: { content: "x", path: "a.txt" }, name: "write_file" });
    assert.equal(outcome.isError, true);
    assert.throws(() => readFileSync(path.join(s.workspace.root, "a.txt")), /ENOENT/);
  } finally {
    s.cleanup();
  }
});

test("reads are allowed without prompting in both modes", async () => {
  for (const policy of [defaultModePolicies.work, defaultModePolicies.code]) {
    const s = setup(policy);
    try {
      writeFileSync(path.join(s.workspace.root, "note.txt"), "hello");
      const outcome = await s.tools.execute({ input: { path: "note.txt" }, name: "read_file" });
      assert.equal(outcome.content, "hello");
      assert.equal(outcome.isError, undefined);
    } finally {
      s.cleanup();
    }
  }
});

test("a gated action with no prompter is denied, never silently allowed", async () => {
  const s = setup(defaultModePolicies.code);
  try {
    const outcome = await s.tools.execute({ input: { command: "echo hi" }, name: "bash" });
    assert.equal(outcome.isError, true, "a headless run must not acquire a shell unasked");
  } finally {
    s.cleanup();
  }
});

test("an approved prompt lets the action through and can be remembered", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccx-tools-"));
  const asked: PermissionRequest[] = [];
  try {
    const workspace = new Workspace(root);
    const policy = defaultModePolicies.code;
    const gate = new PermissionGate({
      policy,
      prompter: async (request) => {
        asked.push(request);
        return { approvedBy: "ada", decision: "allow", remember: true };
      }
    });
    const builtin = new BuiltinTools({ gate, policy, workspace });
    const tools = new HarnessTools({ builtin, gate, policy });

    const first = await tools.execute({ input: { content: "one", path: "a.txt" }, name: "write_file" });
    assert.equal(first.isError, undefined);
    assert.equal(readFileSync(path.join(workspace.root, "a.txt"), "utf8"), "one");

    await tools.execute({ input: { content: "two", path: "b.txt" }, name: "write_file" });
    assert.equal(asked.length, 1, "a remembered decision must not re-prompt");
    assert.deepEqual(gate.rememberedDecisions(), [{ decision: "allow", key: "write:write_file" }]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a declined prompt is reported to the model rather than thrown", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccx-tools-"));
  try {
    const workspace = new Workspace(root);
    const policy = defaultModePolicies.code;
    const gate = new PermissionGate({
      policy,
      prompter: async () => ({ approvedBy: "ada", decision: "deny" as const })
    });
    const builtin = new BuiltinTools({ gate, policy, workspace });
    const outcome = await new HarnessTools({ builtin, gate, policy }).execute({
      input: { command: "rm -rf /" },
      name: "bash"
    });
    assert.equal(outcome.isError, true);
    assert.match(String(outcome.content), /declined/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("the prompt describes what is about to happen", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccx-tools-"));
  const asked: PermissionRequest[] = [];
  try {
    const workspace = new Workspace(root);
    const policy = defaultModePolicies.code;
    const gate = new PermissionGate({
      policy,
      prompter: async (request) => {
        asked.push(request);
        return { approvedBy: "ada", decision: "deny" as const };
      }
    });
    const builtin = new BuiltinTools({ gate, policy, workspace });
    await new HarnessTools({ builtin, gate, policy }).execute({
      input: { command: "npm test" },
      name: "bash"
    });
    assert.equal(asked[0].detail, "Run: npm test");
    assert.equal(asked[0].risk, "execute");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a path escape is refused by the tool, not just the workspace helper", async () => {
  const s = setup(defaultModePolicies.work);
  try {
    const outcome = await s.tools.execute({ input: { path: "../../etc/passwd" }, name: "read_file" });
    assert.equal(outcome.isError, true);
    assert.match(String(outcome.content), /outside the workspace/);
  } finally {
    s.cleanup();
  }
});

test("an unknown tool name is reported, not thrown", async () => {
  const s = setup(defaultModePolicies.code);
  try {
    const outcome = await s.tools.execute({ input: {}, name: "definitely_not_a_tool" });
    assert.equal(outcome.isError, true);
    assert.match(String(outcome.content), /Unknown tool/);
  } finally {
    s.cleanup();
  }
});

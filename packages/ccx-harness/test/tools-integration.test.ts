import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { GatewayMcpServerConfig } from "@ccr/core/contracts/app";
import { SessionStore, credentialFingerprint } from "../src/session/store.ts";
import { TurnLoop } from "../src/turn/turn-loop.ts";
import { BuiltinTools } from "../src/tools/builtin.ts";
import { HarnessTools } from "../src/tools/registry.ts";
import { McpRegistry } from "../src/mcp/registry.ts";
import { defaultModePolicies, PermissionGate, type ModePolicy } from "../src/tools/permissions.ts";
import { Workspace } from "../src/tools/workspace.ts";
import { FakeUpstream, textTurnFrames, toolTurnFrames, type ScriptedTurn } from "./fixtures/fake-upstream.ts";

const echoServerPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "ccx-vendor",
  "test",
  "fixtures",
  "echo-mcp-server.mjs"
);

const echoServer: GatewayMcpServerConfig = {
  args: [echoServerPath],
  command: process.execPath,
  env: {},
  name: "echo",
  protocolVersion: "2024-11-05",
  requestTimeoutMs: 10_000,
  startupTimeoutMs: 10_000,
  stdioMessageMode: "newline-json",
  transport: "stdio"
};

async function build(script: ScriptedTurn[], policy: ModePolicy, options: { mcp?: boolean } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ccx-int-"));
  const workspace = new Workspace(path.join(directory, "workspace"));
  const sessions = new SessionStore(path.join(directory, "sessions.sqlite"));
  const upstream = new FakeUpstream(script);
  const baseUrl = await upstream.start();

  const gate = new PermissionGate({
    policy,
    prompter: async () => ({ approvedBy: "ada", decision: "allow" as const, remember: true })
  });
  const builtin = new BuiltinTools({ gate, policy, workspace });
  const mcp = options.mcp ? new McpRegistry({ servers: [echoServer] }) : undefined;
  await mcp?.discover();

  sessions.createSession({
    credentialFingerprint: credentialFingerprint("sk"),
    id: "s1",
    mode: "code",
    model: "claude-opus-5",
    provider: "anthropic",
    userId: "ada"
  });

  return {
    cleanup: async () => {
      await mcp?.close();
      await upstream.stop();
      sessions.close();
      rmSync(directory, { force: true, recursive: true });
    },
    loop: new TurnLoop({
      apiKey: "sk",
      baseUrl,
      model: "claude-opus-5",
      sessions,
      tools: new HarnessTools({ builtin, gate, ...(mcp ? { mcp } : {}), policy }),
      userId: "ada"
    }),
    sessions,
    upstream,
    workspace
  };
}

test("the loop calls a real MCP server and feeds the result back", async () => {
  const h = await build(
    [
      { frames: toolTurnFrames([{ id: "t1", input: { text: "round trip" }, name: "mcp__echo__echo" }]) },
      { frames: textTurnFrames("The tool said round trip.") }
    ],
    defaultModePolicies.code,
    { mcp: true }
  );
  try {
    const result = await h.loop.runExchange({ sessionId: "s1", userText: "use the echo tool" });
    assert.equal(result.iterations, 2);
    assert.equal(result.toolCallCount, 1);

    const followUp = h.upstream.requests[1].body.messages as Array<Record<string, unknown>>;
    const block = (followUp[2].content as Array<Record<string, unknown>>)[0];
    assert.equal(block.type, "tool_result");
    assert.equal(block.is_error, undefined);
    assert.match(String(block.content), /round trip/);
  } finally {
    await h.cleanup();
  }
});

test("MCP tool definitions reach the gateway request alongside builtins", async () => {
  const h = await build([{ frames: textTurnFrames("ok") }], defaultModePolicies.code, { mcp: true });
  try {
    await h.loop.runExchange({ sessionId: "s1", userText: "hi" });
    const tools = h.upstream.requests[0].body.tools as Array<{ name: string }>;
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["bash", "glob", "grep", "mcp__echo__echo", "read_file", "write_file"]);
  } finally {
    await h.cleanup();
  }
});

test("Work mode advertises MCP and reads but never a shell", async () => {
  const h = await build([{ frames: textTurnFrames("ok") }], defaultModePolicies.work, { mcp: true });
  try {
    await h.loop.runExchange({ sessionId: "s1", userText: "hi" });
    const names = (h.upstream.requests[0].body.tools as Array<{ name: string }>).map((tool) => tool.name).sort();
    assert.deepEqual(names, ["glob", "grep", "mcp__echo__echo", "read_file"]);
  } finally {
    await h.cleanup();
  }
});

test("Work mode refuses an MCP call, since MCP reaches out of the machine", async () => {
  const h = await build(
    [
      { frames: toolTurnFrames([{ id: "t1", input: { text: "x" }, name: "mcp__echo__echo" }]) },
      { frames: textTurnFrames("understood") }
    ],
    defaultModePolicies.work,
    { mcp: true }
  );
  try {
    await h.loop.runExchange({ sessionId: "s1", userText: "go" });
    const followUp = h.upstream.requests[1].body.messages as Array<Record<string, unknown>>;
    const block = (followUp[2].content as Array<Record<string, unknown>>)[0];
    assert.equal(block.is_error, true);
    assert.match(String(block.content), /not available in this mode/);
  } finally {
    await h.cleanup();
  }
});

test("a builtin write through the loop lands on disk and is audited", async () => {
  const h = await build(
    [
      {
        frames: toolTurnFrames([
          { id: "t1", input: { content: "generated", path: "out/result.txt" }, name: "write_file" }
        ])
      },
      { frames: textTurnFrames("written") }
    ],
    defaultModePolicies.code
  );
  try {
    await h.loop.runExchange({ sessionId: "s1", userText: "write it" });
    assert.equal(readFileSync(path.join(h.workspace.root, "out/result.txt"), "utf8"), "generated");

    const turn = h.sessions.listTurns("s1")[0];
    const [call] = h.sessions.listToolCalls(turn.id);
    assert.equal(call.name, "write_file");
    assert.equal(call.status, "ok");
    assert.deepEqual(call.args, { content: "generated", path: "out/result.txt" });
  } finally {
    await h.cleanup();
  }
});

test("a path escape attempted through the model is refused and recorded", async () => {
  const h = await build(
    [
      { frames: toolTurnFrames([{ id: "t1", input: { path: "../../../etc/passwd" }, name: "read_file" }]) },
      { frames: textTurnFrames("cannot") }
    ],
    defaultModePolicies.code
  );
  try {
    await h.loop.runExchange({ sessionId: "s1", userText: "read passwd" });
    const followUp = h.upstream.requests[1].body.messages as Array<Record<string, unknown>>;
    const block = (followUp[2].content as Array<Record<string, unknown>>)[0];
    assert.equal(block.is_error, true);
    assert.match(String(block.content), /outside the workspace/);

    const turn = h.sessions.listTurns("s1")[0];
    assert.equal(h.sessions.listToolCalls(turn.id)[0].status, "error");
  } finally {
    await h.cleanup();
  }
});

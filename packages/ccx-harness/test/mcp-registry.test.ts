import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { GatewayMcpServerConfig } from "@ccr/core/contracts/app";
import { McpRegistry, namespacedToolName, parseNamespacedToolName } from "../src/mcp/registry.ts";

const vendorFixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "ccx-vendor",
  "test",
  "fixtures",
  "echo-mcp-server.mjs"
);

function stdioServer(name: string, args: string[] = [vendorFixture]): GatewayMcpServerConfig {
  return {
    args,
    command: process.execPath,
    env: {},
    name,
    protocolVersion: "2024-11-05",
    requestTimeoutMs: 10_000,
    startupTimeoutMs: 10_000,
    stdioMessageMode: "newline-json",
    transport: "stdio"
  };
}

test("tool names round-trip through the namespace convention", () => {
  assert.equal(namespacedToolName("my server", "do_thing"), "mcp__my-server__do_thing");
  assert.deepEqual(parseNamespacedToolName("mcp__my-server__do_thing"), {
    server: "my-server",
    tool: "do_thing"
  });
  assert.equal(parseNamespacedToolName("read_file"), undefined);
});

test("discovery lists tools and namespaces them by server", async () => {
  const registry = new McpRegistry({ servers: [stdioServer("echo")] });
  try {
    const status = await registry.discover();
    assert.deepEqual(status, [{ name: "echo", state: "ready", toolCount: 1 }]);

    const definitions = registry.definitions();
    assert.equal(definitions.length, 1);
    assert.equal(definitions[0].name, "mcp__echo__echo");
    assert.equal(definitions[0].description, "Echo the input back.");
    assert.ok(registry.handles("mcp__echo__echo"));
    assert.ok(!registry.handles("mcp__echo__missing"));
  } finally {
    await registry.close();
  }
});

test("calling a tool returns its result", async () => {
  const registry = new McpRegistry({ servers: [stdioServer("echo")] });
  try {
    await registry.discover();
    const outcome = await registry.call("mcp__echo__echo", { text: "through mcp" });
    assert.equal(outcome.isError, undefined);
    assert.deepEqual(outcome.content, { content: [{ text: "through mcp", type: "text" }] });
  } finally {
    await registry.close();
  }
});

test("a broken server fails alone and leaves the others usable", async () => {
  const registry = new McpRegistry({
    connectTimeoutMs: 4000,
    servers: [stdioServer("good"), stdioServer("broken", ["/nonexistent-script-ccx.mjs"])]
  });
  try {
    const status = await registry.discover();
    const byName = Object.fromEntries(status.map((entry) => [entry.name, entry]));
    assert.equal(byName.good.state, "ready");
    assert.equal(byName.broken.state, "failed");
    assert.ok(byName.broken.error);

    // The healthy server is still fully usable.
    assert.equal(registry.definitions().length, 1);
    const outcome = await registry.call("mcp__good__echo", { text: "still works" });
    assert.equal(outcome.isError, undefined);
  } finally {
    await registry.close();
  }
});

test("calling a tool on a failed server is reported, not thrown", async () => {
  const registry = new McpRegistry({
    connectTimeoutMs: 4000,
    servers: [stdioServer("broken", ["/nonexistent-script-ccx.mjs"])]
  });
  try {
    await registry.discover();
    const outcome = await registry.call("mcp__broken__anything", {});
    assert.equal(outcome.isError, true);
    assert.match(String(outcome.content), /unavailable/);
  } finally {
    await registry.close();
  }
});

test("the allow list narrows which servers are pooled at all", async () => {
  const registry = new McpRegistry({
    allowedServers: ["kept"],
    servers: [stdioServer("kept"), stdioServer("excluded")]
  });
  try {
    const status = await registry.discover();
    assert.deepEqual(status.map((entry) => entry.name), ["kept"]);
  } finally {
    await registry.close();
  }
});

test("calling an unknown server or a non-MCP name is an error message", async () => {
  const registry = new McpRegistry({ servers: [] });
  try {
    assert.match(String((await registry.call("mcp__nope__x", {})).content), /No MCP server/);
    assert.match(String((await registry.call("read_file", {})).content), /not an MCP tool name/);
  } finally {
    await registry.close();
  }
});

test("close shuts down pooled stdio child processes", async () => {
  const registry = new McpRegistry({ servers: [stdioServer("echo")] });
  await registry.discover();
  assert.equal(registry.status()[0].state, "ready");
  await registry.close();
  assert.equal(registry.status()[0].state, "unknown", "the client must be released");
});

/** Count live fixture servers, so a pooling bug shows up as a leak. */
function liveEchoServers(): number {
  try {
    const output = execFileSync("ps", ["-eo", "args"], { encoding: "utf8" });
    return output.split("\n").filter((line) => line.includes("echo-mcp-server.mjs")).length;
  } catch {
    return -1;
  }
}

test("closing the registry leaves no stdio child processes behind", async () => {
  const baseline = liveEchoServers();
  if (baseline < 0) {
    return; // ps unavailable; nothing to assert.
  }

  const registries = [0, 1, 2].map(
    (index) => new McpRegistry({ servers: [stdioServer(`pool-${index}`)] })
  );
  await Promise.all(registries.map((registry) => registry.discover()));
  assert.ok(liveEchoServers() > baseline, "the fixture servers should be running");

  await Promise.all(registries.map((registry) => registry.close()));

  // Give the OS a moment to reap the killed children.
  for (let attempt = 0; attempt < 40 && liveEchoServers() > baseline; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(liveEchoServers(), baseline, "stdio servers are child processes and must not leak");
});

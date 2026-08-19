import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { GatewayMcpStdioServerConfig } from "@ccr/core/contracts/app";
import { createMcpClient, HttpMcpClient, SseMcpClient, StdioMcpClient } from "../src/core/mcp/mcp-client.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

function stdioServer(): GatewayMcpStdioServerConfig {
  return {
    args: [path.join(here, "fixtures", "echo-mcp-server.mjs")],
    command: process.execPath,
    env: {},
    name: "echo",
    protocolVersion: "2024-11-05",
    requestTimeoutMs: 10_000,
    startupTimeoutMs: 10_000,
    stdioMessageMode: "newline-json",
    transport: "stdio"
  };
}

test("createMcpClient selects a transport per configuration", () => {
  assert.ok(createMcpClient(stdioServer()) instanceof StdioMcpClient);

  const remote = {
    headers: {},
    name: "remote",
    protocolVersion: "2024-11-05",
    requestTimeoutMs: 1000,
    startupTimeoutMs: 1000,
    url: "https://example.invalid/mcp"
  };
  assert.ok(createMcpClient({ ...remote, transport: "sse" }) instanceof SseMcpClient);
  assert.ok(createMcpClient({ ...remote, transport: "streamable-http" }) instanceof HttpMcpClient);
});

test("vendored stdio transport initializes and lists tools", async () => {
  const client = createMcpClient(stdioServer());
  try {
    const tools = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "echo");
    assert.equal(tools[0].description, "Echo the input back.");
    assert.deepEqual(tools[0].inputSchema, { type: "object", properties: { text: { type: "string" } } });
  } finally {
    await client.close();
  }
});

test("vendored stdio transport calls a tool", async () => {
  const client = createMcpClient(stdioServer());
  try {
    const result = await client.callTool("echo", { text: "vendored" });
    assert.deepEqual(result, { content: [{ text: "vendored", type: "text" }] });
  } finally {
    await client.close();
  }
});

test("closing rejects nothing and is idempotent", async () => {
  const client = createMcpClient(stdioServer());
  await client.listTools();
  await client.close();
  await client.close();
});

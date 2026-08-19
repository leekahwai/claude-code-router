/** Minimal newline-JSON MCP server used to exercise the vendored stdio client. */
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "notifications/initialized") {
    return;
  }
  const reply = { id: message.id, jsonrpc: "2.0", result: resultFor(message) };
  process.stdout.write(`${JSON.stringify(reply)}\n`);
});

function resultFor(message) {
  if (message.method === "initialize") {
    return { capabilities: {}, protocolVersion: "2024-11-05", serverInfo: { name: "echo", version: "1.0.0" } };
  }
  if (message.method === "tools/list") {
    return {
      tools: [
        { description: "Echo the input back.", inputSchema: { type: "object", properties: { text: { type: "string" } } }, name: "echo" }
      ]
    };
  }
  if (message.method === "tools/call") {
    return { content: [{ text: String(message.params?.arguments?.text ?? ""), type: "text" }] };
  }
  return {};
}

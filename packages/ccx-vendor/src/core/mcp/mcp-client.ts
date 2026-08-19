/**
 * MCP client transports — VENDORED FROM UPSTREAM CCR. Do not hand-edit the
 * marked blocks; run `npm run -w @ccx/vendor sync` instead.
 *
 * @vendored-from  packages/core/src/mcp/toolhub-mcp.ts
 * @vendored-at    vendor-baseline (fcf3d85)
 * @vendored-on    2026-08-19
 * @owner          platform-team
 * @regions        sse-transport · http-transport · stdio-transport ·
 *                 normalize-tool-list · parse-http-jsonrpc-response
 * @modifications  Prelude below replaces the ToolHub module scope. The client
 *                 identity constant is renamed via a declared substitution.
 *                 Classes and the factory are exported. No transport logic is
 *                 altered.
 * @why            Extracting these classes would edit a 2,936-line upstream file
 *                 that has a live consumer, conflicting on every upstream
 *                 ToolHub change. A copy leaves that file byte-identical.
 *                 See design/fork-isolation-strategy.md §1.
 *
 * Region hashes live in packages/ccx-vendor/vendor.manifest.json and are
 * verified against upstream by `npm run -w @ccx/vendor check`.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  GatewayMcpRemoteServerConfig,
  GatewayMcpServerConfig,
  GatewayMcpStdioServerConfig
} from "@ccr/core/contracts/app";

/* ── prelude: ours, not vendored ─────────────────────────────────────────── */

export type JsonRpcRequest = {
  error?: {
    code?: number;
    message?: string;
  };
  id?: null | number | string;
  jsonrpc?: string;
  method?: string;
  params?: unknown;
  result?: unknown;
};

export type ToolDefinition = {
  description?: string;
  inputSchema?: Record<string, unknown>;
  name: string;
  outputSchema?: Record<string, unknown>;
  tags?: string[];
  title?: string;
};

export type McpClient = {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
  listTools(): Promise<ToolDefinition[]>;
};

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (message: JsonRpcRequest) => void;
  timer: ReturnType<typeof setTimeout>;
};

const protocolVersion = "2024-11-05";
const defaultRequestTimeoutMs = 60_000;

/** Identity this client reports to servers during `initialize`. */
export const ccxMcpClientName = "ccx-harness";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function normalizeInputSchema(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { type: "object", properties: {} };
}

function normalizeOptionalSchema(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/** Construct the transport matching a configured server. */
export function createMcpClient(server: GatewayMcpServerConfig): McpClient {
  if (server.transport === "stdio") {
    return new StdioMcpClient(server);
  }
  return server.transport === "sse" ? new SseMcpClient(server) : new HttpMcpClient(server);
}

/* ── vendored regions below ──────────────────────────────────────────────── */

// >>> vendored: sse-transport
export class SseMcpClient implements McpClient {
  private endpointUrl = "";
  private initialized = false;
  private nextId = 1;
  private openPromise: Promise<void> | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private streamAbort: AbortController | undefined;
  private streamBuffer = "";

  constructor(private readonly server: GatewayMcpRemoteServerConfig) {}

  async listTools(): Promise<ToolDefinition[]> {
    await this.ensureInitialized();
    const result = await this.request("tools/list", {});
    return normalizeToolList(result);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureInitialized();
    return this.request("tools/call", {
      name,
      arguments: args
    });
  }

  async close(): Promise<void> {
    this.initialized = false;
    this.endpointUrl = "";
    this.streamAbort?.abort();
    this.streamAbort = undefined;
    this.rejectAll(new Error(`MCP SSE client closed: ${this.server.name}`));
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.ensureStream();
    await this.request("initialize", {
      capabilities: {},
      clientInfo: { name: ccxMcpClientName, version: "1.0.0" },
      protocolVersion: this.server.protocolVersion || protocolVersion
    }, this.server.startupTimeoutMs);
    await this.notification("notifications/initialized", {}).catch(() => undefined);
    this.initialized = true;
  }

  private async ensureStream(): Promise<void> {
    if (this.endpointUrl) {
      return;
    }
    if (!this.openPromise) {
      this.openPromise = this.openStream().finally(() => {
        this.openPromise = undefined;
      });
    }
    await this.openPromise;
  }

  private async openStream(): Promise<void> {
    const controller = new AbortController();
    this.streamAbort = controller;
    const response = await fetch(this.server.url, {
      headers: this.headers(false),
      method: "GET",
      signal: controller.signal
    });
    if (!response.ok || !response.body) {
      throw new Error(`MCP SSE stream failed (${this.server.name}): ${response.status}`);
    }

    let resolveEndpoint: () => void = () => {};
    let rejectEndpoint: (error: Error) => void = () => {};
    const endpointReady = new Promise<void>((resolve, reject) => {
      resolveEndpoint = resolve;
      rejectEndpoint = reject;
    });
    const timeout = setTimeout(() => {
      rejectEndpoint(new Error(`MCP SSE endpoint timed out (${this.server.name}).`));
      controller.abort();
    }, this.server.startupTimeoutMs ?? defaultRequestTimeoutMs);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          this.streamBuffer += decoder.decode(value, { stream: true });
          this.streamBuffer = consumeSseEvents(this.streamBuffer, (event) => {
            if (event.event === "endpoint") {
              this.endpointUrl = new URL(event.data.trim(), this.server.url).toString();
              clearTimeout(timeout);
              resolveEndpoint();
              return;
            }
            this.routeSseMessage(event.data);
          });
        }
        this.rejectAll(new Error(`MCP SSE stream closed (${this.server.name}).`));
      } catch (error) {
        clearTimeout(timeout);
        rejectEndpoint(toError(error));
        this.rejectAll(toError(error));
      }
    })();

    await endpointReady;
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = this.server.requestTimeoutMs): Promise<unknown> {
    return this.ensureStream().then(() => {
      const id = this.nextId++;
      const message = {
        id,
        jsonrpc: "2.0",
        method,
        params
      };
      const pending = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(String(id));
          reject(new Error(`MCP SSE request timed out (${this.server.name}): ${method}`));
        }, timeoutMs ?? defaultRequestTimeoutMs);
        this.pending.set(String(id), {
          reject,
          resolve: (response) => {
            if (isRecord(response.error)) {
              reject(new Error(String(response.error.message ?? "MCP request failed.")));
              return;
            }
            resolve(response.result);
          },
          timer
        });
      });
      return this.post(message).then(() => pending);
    });
  }

  private async notification(method: string, params: Record<string, unknown>): Promise<void> {
    await this.ensureStream();
    await this.post({ jsonrpc: "2.0", method, params });
  }

  private async post(message: Record<string, unknown>): Promise<void> {
    const response = await fetch(this.endpointUrl, {
      body: JSON.stringify(message),
      headers: this.headers(true),
      method: "POST"
    });
    if (!response.ok) {
      throw new Error(`MCP SSE post failed (${this.server.name}): ${response.status}`);
    }
  }

  private headers(json: boolean): Headers {
    const headers = new Headers({
      ...(json ? { "content-type": "application/json" } : {}),
      ...(this.server.headers ?? {})
    });
    const apiKey = this.server.apiKey || (this.server.apiKeyEnv ? process.env[this.server.apiKeyEnv] : "");
    if (apiKey && !headers.has("authorization")) {
      headers.set("authorization", `Bearer ${apiKey}`);
    }
    return headers;
  }

  private routeSseMessage(text: string): void {
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(text) as JsonRpcRequest;
    } catch {
      return;
    }
    const key = message.id === undefined || message.id === null ? "" : String(message.id);
    const pending = key ? this.pending.get(key) : undefined;
    if (!pending) {
      return;
    }
    this.pending.delete(key);
    clearTimeout(pending.timer);
    pending.resolve(message);
  }

  private rejectAll(error: Error): void {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
  }
}
// <<< vendored: sse-transport

// >>> vendored: http-transport
export class HttpMcpClient implements McpClient {
  private initialized = false;
  private sessionId = "";

  constructor(private readonly server: GatewayMcpRemoteServerConfig) {}

  async listTools(): Promise<ToolDefinition[]> {
    await this.ensureInitialized();
    const result = await this.request("tools/list", {});
    return normalizeToolList(result);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureInitialized();
    return this.request("tools/call", {
      name,
      arguments: args
    });
  }

  async close(): Promise<void> {
    this.initialized = false;
    this.sessionId = "";
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.request("initialize", {
      capabilities: {},
      clientInfo: { name: ccxMcpClientName, version: "1.0.0" },
      protocolVersion: this.server.protocolVersion || protocolVersion
    }, this.server.startupTimeoutMs);
    await this.notification("notifications/initialized", {}).catch(() => undefined);
    this.initialized = true;
  }

  private async notification(method: string, params: Record<string, unknown>): Promise<void> {
    await this.frame({ jsonrpc: "2.0", method, params }, this.server.requestTimeoutMs, true);
  }

  private async request(method: string, params: Record<string, unknown>, timeoutMs = this.server.requestTimeoutMs): Promise<unknown> {
    const response = await this.frame({
      id: randomUUID(),
      jsonrpc: "2.0",
      method,
      params
    }, timeoutMs, false);
    if (!isRecord(response)) {
      throw new Error(`Invalid MCP response from ${this.server.name}.`);
    }
    if (isRecord(response.error)) {
      throw new Error(`MCP request failed (${this.server.name}): ${String(response.error.message ?? "Unknown error")}`);
    }
    return response.result;
  }

  private async frame(request: Record<string, unknown>, timeoutMs = defaultRequestTimeoutMs, notification: boolean): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = new Headers({
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(this.server.headers ?? {})
      });
      const apiKey = this.server.apiKey || (this.server.apiKeyEnv ? process.env[this.server.apiKeyEnv] : "");
      if (apiKey && !headers.has("authorization")) {
        headers.set("authorization", `Bearer ${apiKey}`);
      }
      if (this.sessionId) {
        headers.set("mcp-session-id", this.sessionId);
      }
      const response = await fetch(this.server.url, {
        body: JSON.stringify(request),
        headers,
        method: "POST",
        signal: controller.signal
      });
      this.sessionId = response.headers.get("mcp-session-id") || response.headers.get("x-mcp-session-id") || this.sessionId;
      if (notification && response.status === 204) {
        return undefined;
      }
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`MCP HTTP request failed (${this.server.name}): ${response.status} ${text.slice(0, 300)}`);
      }
      if (!text.trim()) {
        return undefined;
      }
      return parseHttpJsonRpcResponse(text);
    } finally {
      clearTimeout(timer);
    }
  }
}
// <<< vendored: http-transport

// >>> vendored: stdio-transport
export class StdioMcpClient implements McpClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private initialized = false;
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private stdoutBuffer = Buffer.alloc(0);

  constructor(private readonly server: GatewayMcpStdioServerConfig) {}

  async listTools(): Promise<ToolDefinition[]> {
    await this.ensureInitialized();
    const result = await this.request("tools/list", {}, this.server.requestTimeoutMs);
    return normalizeToolList(result);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureInitialized();
    return this.request("tools/call", {
      name,
      arguments: args
    }, this.server.requestTimeoutMs);
  }

  async close(): Promise<void> {
    this.initialized = false;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(`MCP stdio client closed: ${this.server.name}`));
    }
    this.pending.clear();
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = undefined;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.ensureChild();
    await this.request("initialize", {
      capabilities: {},
      clientInfo: { name: ccxMcpClientName, version: "1.0.0" },
      protocolVersion: this.server.protocolVersion || protocolVersion
    }, this.server.startupTimeoutMs);
    this.notify("notifications/initialized", {});
    this.initialized = true;
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child) {
      return this.child;
    }
    const child = spawn(this.server.command, this.server.args ?? [], {
      cwd: this.server.cwd || undefined,
      env: {
        ...process.env,
        ...(this.server.env ?? {})
      },
      stdio: ["pipe", "pipe", "pipe"]
    }) as ChildProcessWithoutNullStreams;
    child.stdout.on("data", (chunk: Buffer) => this.readStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        console.error(`[ToolHub backend ${this.server.name}] ${text}`);
      }
    });
    child.on("error", (error) => this.rejectAll(error));
    child.on("exit", (code, signal) => {
      this.initialized = false;
      this.child = undefined;
      this.rejectAll(new Error(`MCP server exited (${this.server.name}): ${signal ?? code ?? "unknown"}`));
    });
    this.child = child;
    return child;
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = defaultRequestTimeoutMs): Promise<unknown> {
    const id = this.nextId++;
    const message = {
      id,
      jsonrpc: "2.0",
      method,
      params
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`MCP stdio request timed out (${this.server.name}): ${method}`));
      }, timeoutMs);
      this.pending.set(String(id), {
        reject,
        resolve: (response) => {
          if (isRecord(response.error)) {
            reject(new Error(String(response.error.message ?? "MCP request failed.")));
            return;
          }
          resolve(response.result);
        },
        timer
      });
      this.write(message);
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: Record<string, unknown>): void {
    const child = this.ensureChild();
    const text = JSON.stringify(message);
    if (this.server.stdioMessageMode === "newline-json") {
      child.stdin.write(`${text}\n`);
      return;
    }
    child.stdin.write(`Content-Length: ${Buffer.byteLength(text, "utf8")}\r\n\r\n${text}`);
  }

  private readStdout(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    if (this.server.stdioMessageMode === "newline-json") {
      this.drainNewlineJsonStdout();
    } else {
      this.drainContentLengthStdout();
    }
  }

  private drainContentLengthStdout(): void {
    while (true) {
      const headerEnd = this.stdoutBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const headerText = this.stdoutBuffer.subarray(0, headerEnd).toString("utf8");
      const lengthMatch = headerText.match(/content-length:\s*(\d+)/i);
      if (!lengthMatch) {
        this.stdoutBuffer = this.stdoutBuffer.subarray(headerEnd + 4);
        continue;
      }
      const contentLength = Number(lengthMatch[1]);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (this.stdoutBuffer.length < messageEnd) return;
      const text = this.stdoutBuffer.subarray(messageStart, messageEnd).toString("utf8");
      this.stdoutBuffer = this.stdoutBuffer.subarray(messageEnd);
      this.routeMessage(text);
    }
  }

  private drainNewlineJsonStdout(): void {
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const text = this.stdoutBuffer.subarray(0, newline).toString("utf8").trim();
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (text) {
        this.routeMessage(text);
      }
    }
  }

  private routeMessage(text: string): void {
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(text) as JsonRpcRequest;
    } catch {
      return;
    }
    const key = message.id === undefined || message.id === null ? "" : String(message.id);
    const pending = key ? this.pending.get(key) : undefined;
    if (!pending) {
      return;
    }
    this.pending.delete(key);
    clearTimeout(pending.timer);
    pending.resolve(message);
  }

  private rejectAll(error: Error): void {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
  }
}
// <<< vendored: stdio-transport

// >>> vendored: normalize-tool-list
function normalizeToolList(value: unknown): ToolDefinition[] {
  const tools = isRecord(value) && Array.isArray(value.tools) ? value.tools : [];
  const result: ToolDefinition[] = [];
  for (const tool of tools) {
    if (!isRecord(tool) || typeof tool.name !== "string" || !tool.name.trim()) {
      continue;
    }
    result.push({
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: normalizeInputSchema(tool.inputSchema ?? tool.input_schema),
      name: tool.name.trim(),
      outputSchema: normalizeOptionalSchema(tool.outputSchema ?? tool.output_schema),
      tags: Array.isArray(tool.tags) ? tool.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
      title: typeof tool.title === "string" && tool.title.trim() ? tool.title.trim() : undefined
    });
  }
  return result;
}
// <<< vendored: normalize-tool-list

// >>> vendored: parse-http-jsonrpc-response
function parseHttpJsonRpcResponse(text: string): unknown {
  if (/^event:/m.test(text) || /^data:/m.test(text)) {
    const events = text.split(/\n\n+/);
    for (const event of events) {
      const data = event
        .split(/\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("\n");
      if (!data) continue;
      try {
        return JSON.parse(data) as unknown;
      } catch {
        continue;
      }
    }
  }
  return JSON.parse(text) as unknown;
}
// <<< vendored: parse-http-jsonrpc-response

// >>> vendored: consume-sse-events
function consumeSseEvents(buffer: string, handle: (event: { data: string; event: string }) => void): string {
  let offset = 0;
  for (;;) {
    const nextMatch = /\r?\n\r?\n/.exec(buffer.slice(offset));
    if (!nextMatch || nextMatch.index < 0) {
      return buffer.slice(offset);
    }
    const next = offset + nextMatch.index;
    const raw = buffer.slice(offset, next);
    offset = next + nextMatch[0].length;
    let event = "message";
    const data: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim() || "message";
      } else if (line.startsWith("data:")) {
        data.push(line.slice("data:".length).trimStart());
      }
    }
    if (data.length > 0 || event !== "message") {
      handle({ data: data.join("\n"), event });
    }
  }
}
// <<< vendored: consume-sse-events

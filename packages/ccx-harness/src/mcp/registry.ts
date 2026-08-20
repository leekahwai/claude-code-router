/**
 * MCP server registry: pooled connections, namespaced tools, isolated failures.
 *
 * Transports come from @ccx/vendor — copies of CCR's own, so we do not maintain
 * a second MCP protocol implementation. What this adds on top is lifecycle:
 * stdio servers are child processes, so one client per session would leak
 * processes, and a server that hangs or dies must not take the turn with it.
 */
import { createMcpClient, type McpClient, type ToolDefinition as McpToolDefinition } from "@ccx/vendor/core/mcp/mcp-client";
import type { GatewayMcpServerConfig } from "@ccr/core/contracts/app";
import type { ToolDefinition, ToolOutcome } from "../turn/tools";

/** Matches the convention CCR already scores for when ranking tool names. */
export function namespacedToolName(server: string, tool: string): string {
  return `mcp__${sanitize(server)}__${tool}`;
}

export function parseNamespacedToolName(name: string): { server: string; tool: string } | undefined {
  const match = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  return match ? { server: match[1], tool: match[2] } : undefined;
}

function sanitize(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "server";
}

export type McpServerStatus = {
  error?: string;
  name: string;
  state: "failed" | "ready" | "unknown";
  toolCount: number;
};

export type McpRegistryOptions = {
  /** Only these servers are used; the permission gate narrows the list. */
  allowedServers?: string[];
  callTimeoutMs?: number;
  connectTimeoutMs?: number;
  servers: GatewayMcpServerConfig[];
};

type PooledServer = {
  client?: McpClient;
  config: GatewayMcpServerConfig;
  error?: string;
  tools: McpToolDefinition[];
};

const defaultConnectTimeoutMs = 15_000;
const defaultCallTimeoutMs = 60_000;

export class McpRegistry {
  private discovered = false;
  private readonly pool = new Map<string, PooledServer>();

  constructor(private readonly options: McpRegistryOptions) {
    for (const config of options.servers) {
      if (options.allowedServers && !options.allowedServers.includes(config.name)) {
        continue;
      }
      this.pool.set(config.name, { config, tools: [] });
    }
  }

  /**
   * Connect to every server and list its tools.
   *
   * Servers are probed concurrently and independently: one that is missing,
   * misconfigured or slow leaves the others usable, and is reported as failed
   * rather than throwing.
   */
  async discover(): Promise<McpServerStatus[]> {
    await Promise.all(
      [...this.pool.values()].map(async (entry) => {
        try {
          const client = createMcpClient(entry.config);
          entry.client = client;
          entry.tools = await withTimeout(
            client.listTools(),
            this.options.connectTimeoutMs ?? defaultConnectTimeoutMs,
            `MCP server "${entry.config.name}" did not list tools in time.`
          );
          entry.error = undefined;
        } catch (error) {
          entry.error = formatError(error);
          entry.tools = [];
          await entry.client?.close().catch(() => undefined);
          entry.client = undefined;
        }
      })
    );
    this.discovered = true;
    return this.status();
  }

  status(): McpServerStatus[] {
    return [...this.pool.values()].map((entry) => ({
      ...(entry.error ? { error: entry.error } : {}),
      name: entry.config.name,
      state: entry.error ? "failed" : entry.client ? "ready" : "unknown",
      toolCount: entry.tools.length
    }));
  }

  /** Namespaced definitions for every reachable server. */
  definitions(): ToolDefinition[] {
    const result: ToolDefinition[] = [];
    for (const entry of this.pool.values()) {
      for (const tool of entry.tools) {
        result.push({
          ...(tool.description ? { description: tool.description } : {}),
          input_schema: tool.inputSchema ?? { properties: {}, type: "object" },
          name: namespacedToolName(entry.config.name, tool.name)
        });
      }
    }
    return result;
  }

  handles(name: string): boolean {
    const parsed = parseNamespacedToolName(name);
    if (!parsed) {
      return false;
    }
    return [...this.pool.values()].some(
      (entry) => sanitize(entry.config.name) === parsed.server && entry.tools.some((tool) => tool.name === parsed.tool)
    );
  }

  async call(name: string, input: unknown): Promise<ToolOutcome> {
    const parsed = parseNamespacedToolName(name);
    if (!parsed) {
      return { content: `"${name}" is not an MCP tool name.`, isError: true };
    }
    const entry = [...this.pool.values()].find((candidate) => sanitize(candidate.config.name) === parsed.server);
    if (!entry) {
      return { content: `No MCP server named "${parsed.server}".`, isError: true };
    }
    if (!entry.client) {
      return {
        content: `MCP server "${entry.config.name}" is unavailable${entry.error ? `: ${entry.error}` : "."}`,
        isError: true
      };
    }

    try {
      const result = await withTimeout(
        entry.client.callTool(parsed.tool, (input ?? {}) as Record<string, unknown>),
        this.options.callTimeoutMs ?? defaultCallTimeoutMs,
        `MCP tool "${name}" timed out.`
      );
      return { content: result };
    } catch (error) {
      // A failing server is reported to the model, never thrown: the turn
      // should continue with the other tools available.
      return { content: formatError(error), isError: true };
    }
  }

  isDiscovered(): boolean {
    return this.discovered;
  }

  /** Close every pooled client. Stdio servers are child processes. */
  async close(): Promise<void> {
    await Promise.all(
      [...this.pool.values()].map(async (entry) => {
        await entry.client?.close().catch(() => undefined);
        entry.client = undefined;
      })
    );
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

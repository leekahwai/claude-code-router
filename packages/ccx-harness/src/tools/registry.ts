/**
 * The ToolExecutor the turn loop consumes: builtin tools plus MCP, behind one
 * permission gate.
 *
 * Ordering matters. Builtin names are checked first so an MCP server cannot
 * shadow `bash` or `write_file` by naming a tool the same thing — MCP tools are
 * always namespaced, which makes collision impossible by construction, but the
 * check is explicit rather than relying on that.
 */
import type { McpRegistry } from "../mcp/registry";
import type { ToolDefinition, ToolExecutor, ToolOutcome } from "../turn/tools";
import type { BuiltinTools } from "./builtin";
import { denialMessage, PermissionGate, type ModePolicy } from "./permissions";

export type HarnessToolsOptions = {
  builtin?: BuiltinTools;
  gate: PermissionGate;
  mcp?: McpRegistry;
  policy: ModePolicy;
};

export class HarnessTools implements ToolExecutor {
  constructor(private readonly options: HarnessToolsOptions) {}

  definitions(): ToolDefinition[] {
    return [...(this.options.builtin?.definitions() ?? []), ...(this.options.mcp?.definitions() ?? [])];
  }

  async execute(call: { input: unknown; name: string }, signal?: AbortSignal): Promise<ToolOutcome> {
    const { builtin, mcp } = this.options;

    if (builtin?.handles(call.name)) {
      return builtin.execute(call.name, call.input, signal);
    }

    if (mcp?.handles(call.name)) {
      // MCP calls reach the network or a child process, so they are gated too
      // — as "execute", which is what Work denies.
      const request = { detail: `Call ${call.name}`, risk: "execute" as const, toolName: call.name };
      const outcome = await this.options.gate.check(request);
      if (outcome.decision === "deny") {
        return { content: denialMessage(request, this.options.policy), isError: true };
      }
      return mcp.call(call.name, call.input);
    }

    return { content: `Unknown tool "${call.name}".`, isError: true };
  }
}

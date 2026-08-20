/**
 * Tool surface for the turn loop.
 *
 * H2 supplies the real registry (MCP, skills, builtin file and shell tools).
 * The loop only needs this narrow contract, so it can be developed and tested
 * before any of that exists.
 */
export type ToolDefinition = {
  description?: string;
  input_schema: Record<string, unknown>;
  name: string;
};

export type ToolOutcome = {
  /** Mapped to tool_result.is_error so the model can recover from failures. */
  isError?: boolean;
  content: unknown;
};

export type ToolExecutor = {
  definitions(): ToolDefinition[];
  execute(call: { input: unknown; name: string }, signal?: AbortSignal): Promise<ToolOutcome>;
};

/** A registry over plain functions; the real sources plug in behind it in H2. */
export class FunctionToolExecutor implements ToolExecutor {
  constructor(
    private readonly tools: Array<
      ToolDefinition & { run: (input: unknown, signal?: AbortSignal) => Promise<unknown> | unknown }
    >
  ) {}

  definitions(): ToolDefinition[] {
    return this.tools.map(({ description, input_schema, name }) => ({ description, input_schema, name }));
  }

  async execute(call: { input: unknown; name: string }, signal?: AbortSignal): Promise<ToolOutcome> {
    const tool = this.tools.find((candidate) => candidate.name === call.name);
    if (!tool) {
      // A hallucinated tool name is reported back to the model, not thrown:
      // the turn should recover rather than fail.
      return { content: `Unknown tool "${call.name}".`, isError: true };
    }
    try {
      return { content: await tool.run(call.input, signal) };
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  }
}

/**
 * Builtin file and shell tools.
 *
 * Skills are the reason these exist: most real skills ship scripts and
 * reference files, so a harness without read/write/glob/grep/bash cannot run
 * them. Every path goes through Workspace first, and every call goes through
 * the PermissionGate before it touches anything.
 */
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Workspace, WorkspaceEscapeError } from "./workspace";
import { denialMessage, PermissionGate, type ModePolicy, type ToolRisk } from "./permissions";
import type { ToolDefinition, ToolOutcome } from "../turn/tools";

export type BuiltinToolName = "bash" | "glob" | "grep" | "read_file" | "write_file";

export type BuiltinLimits = {
  bashTimeoutMs: number;
  maxMatches: number;
  maxOutputBytes: number;
  maxReadBytes: number;
};

export const defaultBuiltinLimits: BuiltinLimits = {
  bashTimeoutMs: 30_000,
  maxMatches: 200,
  maxOutputBytes: 64 * 1024,
  maxReadBytes: 512 * 1024
};

const riskByTool: Record<BuiltinToolName, ToolRisk> = {
  bash: "execute",
  glob: "read",
  grep: "read",
  read_file: "read",
  write_file: "write"
};

const definitions: Record<BuiltinToolName, ToolDefinition> = {
  bash: {
    description: "Run a shell command in the workspace root.",
    input_schema: {
      additionalProperties: false,
      properties: { command: { description: "Command to run.", type: "string" } },
      required: ["command"],
      type: "object"
    },
    name: "bash"
  },
  glob: {
    description: "List files under a directory matching a simple pattern.",
    input_schema: {
      additionalProperties: false,
      properties: {
        pattern: { description: "Substring or *.ext suffix to match.", type: "string" },
        path: { description: "Directory to search, relative to the workspace.", type: "string" }
      },
      type: "object"
    },
    name: "glob"
  },
  grep: {
    description: "Search file contents for a regular expression.",
    input_schema: {
      additionalProperties: false,
      properties: {
        pattern: { description: "Regular expression.", type: "string" },
        path: { description: "Directory to search, relative to the workspace.", type: "string" }
      },
      required: ["pattern"],
      type: "object"
    },
    name: "grep"
  },
  read_file: {
    description: "Read a UTF-8 file from the workspace.",
    input_schema: {
      additionalProperties: false,
      properties: { path: { description: "File path relative to the workspace.", type: "string" } },
      required: ["path"],
      type: "object"
    },
    name: "read_file"
  },
  write_file: {
    description: "Write a UTF-8 file in the workspace, creating directories as needed.",
    input_schema: {
      additionalProperties: false,
      properties: {
        content: { description: "File contents.", type: "string" },
        path: { description: "File path relative to the workspace.", type: "string" }
      },
      required: ["content", "path"],
      type: "object"
    },
    name: "write_file"
  }
};

export type BuiltinToolsOptions = {
  gate: PermissionGate;
  limits?: Partial<BuiltinLimits>;
  policy: ModePolicy;
  workspace: Workspace;
};

export class BuiltinTools {
  private readonly limits: BuiltinLimits;

  constructor(private readonly options: BuiltinToolsOptions) {
    this.limits = { ...defaultBuiltinLimits, ...options.limits };
  }

  /** Only tools the mode can actually use are advertised to the model. */
  definitions(): ToolDefinition[] {
    return (Object.keys(definitions) as BuiltinToolName[])
      .filter((name) => this.options.policy.allowed[riskByTool[name]] !== "deny")
      .map((name) => definitions[name]);
  }

  handles(name: string): name is BuiltinToolName {
    return name in definitions;
  }

  async execute(name: BuiltinToolName, input: unknown, signal?: AbortSignal): Promise<ToolOutcome> {
    const args = (input ?? {}) as Record<string, unknown>;
    const request = {
      detail: this.describe(name, args),
      risk: riskByTool[name],
      toolName: name
    };

    const outcome = await this.options.gate.check(request);
    if (outcome.decision === "deny") {
      return { content: denialMessage(request, this.options.policy), isError: true };
    }

    try {
      switch (name) {
        case "read_file":
          return this.readFile(String(args.path ?? ""));
        case "write_file":
          return this.writeFile(String(args.path ?? ""), String(args.content ?? ""));
        case "glob":
          return this.glob(String(args.path ?? "."), String(args.pattern ?? ""));
        case "grep":
          return this.grep(String(args.path ?? "."), String(args.pattern ?? ""));
        case "bash":
          return await this.bash(String(args.command ?? ""), signal);
        default:
          return { content: `Unknown builtin tool "${String(name)}".`, isError: true };
      }
    } catch (error) {
      if (error instanceof WorkspaceEscapeError) {
        return { content: error.message, isError: true };
      }
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  }

  private describe(name: BuiltinToolName, args: Record<string, unknown>): string {
    if (name === "bash") {
      return `Run: ${String(args.command ?? "")}`;
    }
    if (name === "write_file") {
      return `Write ${String(args.path ?? "")}`;
    }
    return `${name} ${String(args.path ?? args.pattern ?? "")}`.trim();
  }

  private readFile(requested: string): ToolOutcome {
    const target = this.options.workspace.resolve(requested, "read");
    const stats = statSync(target);
    if (stats.size > this.limits.maxReadBytes) {
      return {
        content: `File is ${stats.size} bytes; the limit is ${this.limits.maxReadBytes}.`,
        isError: true
      };
    }
    return { content: readFileSync(target, "utf8") };
  }

  private writeFile(requested: string, content: string): ToolOutcome {
    const target = this.options.workspace.resolve(requested);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
    return { content: `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${this.options.workspace.relative(target)}.` };
  }

  private glob(requested: string, pattern: string): ToolOutcome {
    const root = this.options.workspace.resolve(requested, "read");
    const matches: string[] = [];
    const suffix = pattern.startsWith("*.") ? pattern.slice(1) : "";

    const walk = (directory: string): void => {
      if (matches.length >= this.limits.maxMatches) {
        return;
      }
      for (const entry of safeReadDir(directory)) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules" && !entry.name.startsWith(".")) {
            walk(full);
          }
          continue;
        }
        const matched = suffix ? entry.name.endsWith(suffix) : !pattern || entry.name.includes(pattern);
        if (matched && matches.length < this.limits.maxMatches) {
          matches.push(this.options.workspace.relative(full));
        }
      }
    };
    walk(root);
    return { content: matches.length > 0 ? matches.join("\n") : "No files matched." };
  }

  private grep(requested: string, pattern: string): ToolOutcome {
    const root = this.options.workspace.resolve(requested, "read");
    let expression: RegExp;
    try {
      expression = new RegExp(pattern);
    } catch (error) {
      return { content: `Invalid regular expression: ${formatError(error)}`, isError: true };
    }

    const hits: string[] = [];
    const walk = (directory: string): void => {
      if (hits.length >= this.limits.maxMatches) {
        return;
      }
      for (const entry of safeReadDir(directory)) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules" && !entry.name.startsWith(".")) {
            walk(full);
          }
          continue;
        }
        let text: string;
        try {
          if (statSync(full).size > this.limits.maxReadBytes) {
            continue;
          }
          text = readFileSync(full, "utf8");
        } catch {
          continue;
        }
        for (const [index, line] of text.split("\n").entries()) {
          if (expression.test(line) && hits.length < this.limits.maxMatches) {
            hits.push(`${this.options.workspace.relative(full)}:${index + 1}: ${line.trim().slice(0, 200)}`);
          }
        }
      }
    };
    walk(root);
    return { content: hits.length > 0 ? hits.join("\n") : "No matches." };
  }

  private bash(command: string, signal?: AbortSignal): Promise<ToolOutcome> {
    return new Promise((resolve) => {
      const child = spawn(command, {
        cwd: this.options.workspace.root,
        shell: true,
        // A tool-run shell inherits no ambient credentials it was not given.
        env: { ...process.env, CCX_TOOL_SHELL: "1" }
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => finish("timeout"), this.limits.bashTimeoutMs);
      const onAbort = () => finish("cancelled");
      signal?.addEventListener("abort", onAbort, { once: true });

      const truncate = (existing: string, chunk: Buffer): string =>
        `${existing}${chunk.toString("utf8")}`.slice(0, this.limits.maxOutputBytes);

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = truncate(stdout, chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = truncate(stderr, chunk);
      });
      child.on("error", (error) => finish("error", error.message));
      child.on("close", (code) => finish("closed", "", code ?? 0));

      function finish(reason: string, message = "", exitCode = 0): void {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (reason === "timeout" || reason === "cancelled") {
          child.kill("SIGKILL");
          resolve({ content: `Command ${reason}.\n${stdout}${stderr}`, isError: true });
          return;
        }
        if (reason === "error") {
          resolve({ content: message, isError: true });
          return;
        }
        const body = [stdout, stderr].filter(Boolean).join("\n").trim();
        resolve({
          content: body || `(no output, exit code ${exitCode})`,
          ...(exitCode === 0 ? {} : { isError: true })
        });
      }
    });
  }
}

function safeReadDir(directory: string) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

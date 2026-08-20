/**
 * The `company_reference` tool: reads one admin-published reference file.
 *
 * Separate from read_file on purpose. It is bounded to the pack rather than the
 * workspace, it works in Work mode where writes and shells do not, and it is
 * audited under its own name so "which reference material is actually used" is
 * answerable.
 */
import type { ToolDefinition, ToolOutcome } from "../turn/tools";
import type { CompanyPackStore } from "./pack";

export const COMPANY_REFERENCE_TOOL_NAME = "company_reference";

export function companyReferenceToolDefinition(paths: string[]): ToolDefinition {
  return {
    description: "Read one company reference document. Paths are listed in the system prompt.",
    input_schema: {
      additionalProperties: false,
      properties: {
        path: {
          description: "Reference path as listed in the system prompt.",
          type: "string",
          ...(paths.length > 0 && paths.length <= 100 ? { enum: paths } : {})
        }
      },
      required: ["path"],
      type: "object"
    },
    name: COMPANY_REFERENCE_TOOL_NAME
  };
}

export function executeCompanyReferenceTool(store: CompanyPackStore, input: unknown): ToolOutcome {
  const requested = String((input as Record<string, unknown> | undefined)?.path ?? "").trim();
  if (!requested) {
    return { content: "The company_reference tool requires a path.", isError: true };
  }

  const pack = store.load();
  const known = pack.references.find((entry) => entry.path === requested);
  if (!known) {
    const available = pack.references.map((entry) => entry.path).join(", ");
    return {
      content: `No company reference at "${requested}".${available ? ` Available: ${available}.` : ""}`,
      isError: true
    };
  }

  try {
    return { content: store.readReference(requested) };
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), isError: true };
  }
}

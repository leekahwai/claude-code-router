/**
 * The `skill` tool: loads one skill's full instructions on demand.
 *
 * Exposed as a tool rather than pre-injected so every load is a recorded
 * tool_call. That is what makes "which skills do people actually use" a query
 * rather than a guess, and it keeps unused skills out of the context window.
 */
import type { ToolDefinition, ToolOutcome } from "../turn/tools";
import type { SkillRegistry } from "./registry";

export const SKILL_TOOL_NAME = "skill";

export function skillToolDefinition(registry: SkillRegistry): ToolDefinition {
  const names = registry.list().map((skill) => skill.name);
  return {
    description:
      "Load a skill's full instructions before using it. Skills are listed in the system prompt.",
    input_schema: {
      additionalProperties: false,
      properties: {
        name: {
          description: "Name of the skill to load.",
          type: "string",
          ...(names.length > 0 && names.length <= 100 ? { enum: names } : {})
        }
      },
      required: ["name"],
      type: "object"
    },
    name: SKILL_TOOL_NAME
  };
}

export function executeSkillTool(registry: SkillRegistry, input: unknown): ToolOutcome {
  const name = String((input as Record<string, unknown> | undefined)?.name ?? "").trim();
  if (!name) {
    return { content: "The skill tool requires a name.", isError: true };
  }
  const loaded = registry.load(name);
  return loaded.isError ? { content: loaded.content, isError: true } : { content: loaded.content };
}

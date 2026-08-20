/**
 * Skill registry: discover, describe, and load on demand.
 *
 * Skills are a harness feature — no provider knows what one is — so the whole
 * protocol lives here:
 *
 *   1. scan the roots for the selected harness (vendored from CCR, which
 *      already knows where each harness keeps its skills)
 *   2. parse each SKILL.md's frontmatter for a name and description
 *   3. inject ONLY the descriptions as a menu
 *   4. load the body when the model asks for one
 *
 * Step 3 is the whole trick. With fifty skills installed, injecting their
 * contents would consume the context window before the user has typed
 * anything; injecting a menu costs a line each.
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { load as parseYaml } from "js-yaml";
import { discoverSkills, type SkillHarness, type SkillRef } from "@ccx/vendor/core/agents/skill-roots";

export type Skill = SkillRef & {
  /** Directory holding the skill's own files, or the file's directory. */
  directory: string;
  description: string;
  /** Path to the SKILL.md (or the bare .md file). */
  file: string;
  /** Present when the frontmatter could not be parsed. */
  warning?: string;
};

export type SkillRegistryOptions = {
  harness: SkillHarness;
  /** Cap on menu entries; the rest stay loadable but unlisted. */
  maxMenuEntries?: number;
  maxDescriptionChars?: number;
  /** Skills the user enabled for this session; empty means all. */
  enabled?: string[];
  projectDirectory: string;
};

const defaultMaxMenuEntries = 40;
const defaultMaxDescriptionChars = 240;
const maxSkillBodyBytes = 128 * 1024;

export class SkillRegistry {
  private skills: Skill[] = [];

  constructor(private readonly options: SkillRegistryOptions) {}

  /** Scan the harness's roots and read each skill's frontmatter. */
  discover(): Skill[] {
    const refs = discoverSkills(this.options.harness, this.options.projectDirectory);
    const enabled = new Set(this.options.enabled ?? []);
    this.skills = refs
      .filter((ref) => enabled.size === 0 || enabled.has(ref.name))
      .map((ref) => this.describe(ref));
    return this.skills;
  }

  list(): Skill[] {
    return this.skills;
  }

  get(name: string): Skill | undefined {
    return this.skills.find((skill) => skill.name === name);
  }

  /** Directories the file tools may read, so skill assets are reachable. */
  readRoots(): string[] {
    return [...new Set(this.skills.map((skill) => skill.directory))];
  }

  /**
   * The menu injected into the system prompt: names and descriptions only.
   * Byte-stable for a given skill set, so it does not break prompt caching.
   */
  menu(): string {
    if (this.skills.length === 0) {
      return "";
    }
    const limit = this.options.maxMenuEntries ?? defaultMaxMenuEntries;
    const listed = this.skills.slice(0, limit);
    const lines = listed.map((skill) => `- ${skill.name}: ${skill.description || "(no description)"}`);
    const omitted = this.skills.length - listed.length;

    return [
      "Available skills. Call the skill tool with a skill's name to load its full instructions before using it.",
      ...lines,
      // Silent truncation would read as "these are all the skills".
      ...(omitted > 0 ? [`(${omitted} further skill(s) are installed but not listed; load them by name.)`] : [])
    ].join("\n");
  }

  /** Full instructions for one skill, read on demand. */
  load(name: string): { content: string; isError?: boolean } {
    const skill = this.get(name);
    if (!skill) {
      const known = this.skills.map((candidate) => candidate.name).join(", ");
      return {
        content: `No skill named "${name}".${known ? ` Available: ${known}.` : ""}`,
        isError: true
      };
    }
    try {
      if (statSync(skill.file).size > maxSkillBodyBytes) {
        return { content: `Skill "${name}" exceeds ${maxSkillBodyBytes} bytes.`, isError: true };
      }
      const raw = readFileSync(skill.file, "utf8");
      const body = stripFrontmatter(raw).trim();
      return {
        content: [
          `# Skill: ${skill.name}`,
          `Files for this skill are in: ${skill.directory}`,
          "",
          body
        ].join("\n")
      };
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  }

  private describe(ref: SkillRef): Skill {
    const file = skillFile(ref);
    const directory = file === ref.location ? path.dirname(file) : ref.location;
    const maxChars = this.options.maxDescriptionChars ?? defaultMaxDescriptionChars;

    let raw = "";
    try {
      raw = readFileSync(file, "utf8");
    } catch (error) {
      return {
        ...ref,
        description: "",
        directory,
        file,
        warning: `Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`
      };
    }

    const parsed = parseFrontmatter(raw);
    return {
      ...ref,
      // The frontmatter name wins where present; the directory name is the
      // fallback, which is what the vendored discovery already reports.
      name: parsed.fields.name || ref.name,
      description: truncate(parsed.fields.description, maxChars),
      directory,
      file,
      ...(parsed.warning ? { warning: parsed.warning } : {})
    };
  }
}

/** A skill is either a directory containing SKILL.md, or a bare .md file. */
function skillFile(ref: SkillRef): string {
  if (ref.location.endsWith(".md")) {
    return ref.location;
  }
  return path.join(ref.location, "SKILL.md");
}

const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontmatter(raw: string): {
  fields: { description: string; name: string };
  warning?: string;
} {
  const match = frontmatterPattern.exec(raw);
  if (!match) {
    return { fields: { description: "", name: "" }, warning: "No YAML frontmatter." };
  }
  try {
    const parsed = parseYaml(match[1]);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { fields: { description: "", name: "" }, warning: "Frontmatter is not a mapping." };
    }
    const record = parsed as Record<string, unknown>;
    return {
      fields: {
        description: typeof record.description === "string" ? record.description.trim() : "",
        name: typeof record.name === "string" ? record.name.trim() : ""
      }
    };
  } catch (error) {
    // A malformed skill must not break discovery for every other skill.
    return {
      fields: { description: "", name: "" },
      warning: `Invalid frontmatter: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

export function stripFrontmatter(raw: string): string {
  return raw.replace(frontmatterPattern, "");
}

function truncate(value: string, maxChars: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= maxChars ? collapsed : `${collapsed.slice(0, maxChars - 1)}…`;
}

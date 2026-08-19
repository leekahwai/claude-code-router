/**
 * Per-harness skill directory roots — VENDORED FROM UPSTREAM CCR.
 *
 * @vendored-from  packages/core/src/agents/codex/cli-middleware-runtime.ts
 * @vendored-at    vendor-baseline (fcf3d85)
 * @vendored-on    2026-08-19
 * @owner          platform-team
 * @regions        render-agent-skills (root table + directory scan)
 * @modifications  Hand-adapted, not generated. Upstream returns a chat string
 *                 for a slash command; this returns structured entries so the
 *                 skill registry can build a menu from them. Root ORDER and
 *                 PRECEDENCE are preserved exactly. `codexRuntimeHome()` is
 *                 inlined from the same file (L7139-7145) since it is four
 *                 lines and pulling the whole module would be worse.
 * @why            That file is 7,210 lines — the largest in the repository.
 *                 Refactoring it would be the most conflict-prone change
 *                 available. See design/fork-isolation-strategy.md §1.
 *
 * Drift in the upstream region is reported by `npm run -w @ccx/vendor check`;
 * because this file is hand-adapted, drift is never applied automatically.
 */
import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Harnesses whose skill layout upstream knows about. */
export type SkillHarness = "claude" | "codex" | "opencode" | "zcode";

export type SkillSource = "project" | "user";

export type SkillRef = {
  /** Directory or bare `.md` file backing the skill. */
  location: string;
  name: string;
  /** Project roots shadow user roots, matching upstream precedence. */
  source: SkillSource;
};

/** Upstream inlines this; four lines, reproduced rather than imported. */
function harnessRuntimeHome(harness: SkillHarness): string {
  if (harness === "zcode") {
    return process.env.ZCODE_STORAGE_DIR || process.env.ZCODE_HOME || path.join(os.homedir(), ".zcode");
  }
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

/**
 * Skill roots for a harness, highest precedence first.
 *
 * This is the table the whole "detect skills for that particular harness"
 * requirement rests on. Keep it identical to upstream.
 */
export function skillRoots(harness: SkillHarness, projectDirectory: string): string[] {
  if (harness === "opencode") {
    return [
      path.join(projectDirectory, ".opencode", "skills"),
      path.join(os.homedir(), ".config", "opencode", "skills")
    ];
  }
  if (harness === "codex" || harness === "zcode") {
    return [
      path.join(projectDirectory, ".agents", "skills"),
      path.join(harnessRuntimeHome(harness), "skills"),
      path.join(os.homedir(), ".codex", "skills")
    ];
  }
  return [
    path.join(projectDirectory, ".claude", "skills"),
    path.join(os.homedir(), ".claude", "skills")
  ];
}

/**
 * List skills visible to a harness. First root wins on a name collision, which
 * is how upstream's dedupe behaves.
 */
export function discoverSkills(harness: SkillHarness, projectDirectory: string): SkillRef[] {
  const roots = skillRoots(harness, projectDirectory);
  const seen = new Set<string>();
  const skills: SkillRef[] = [];

  for (const [index, root] of roots.entries()) {
    for (const entry of readDirectoryEntries(root)) {
      if (!entry.isDirectory() && !entry.name.endsWith(".md")) {
        continue;
      }
      const name = entry.name.replace(/\.md$/i, "");
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      skills.push({
        location: path.join(root, entry.name),
        name,
        source: index === 0 ? "project" : "user"
      });
    }
  }

  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

/** Missing or unreadable roots are simply absent, as upstream treats them. */
function readDirectoryEntries(root: string) {
  try {
    return readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
}

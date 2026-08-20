import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseFrontmatter, SkillRegistry, stripFrontmatter } from "../src/skills/registry.ts";
import { assembleSystemPrompt, stableSystemPrefix } from "../src/context/assemble.ts";

/** Build a project with skills on disk, with HOME pointed somewhere empty. */
function project(skills: Array<{ body?: string; dir?: boolean; name: string; raw?: string }>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccx-skills-"));
  const previousHome = process.env.HOME;
  process.env.HOME = path.join(root, "home");
  const projectDirectory = path.join(root, "proj");
  const skillsRoot = path.join(projectDirectory, ".claude", "skills");

  for (const skill of skills) {
    if (skill.dir === false) {
      mkdirSync(skillsRoot, { recursive: true });
      writeFileSync(path.join(skillsRoot, `${skill.name}.md`), skill.raw ?? skill.body ?? "");
      continue;
    }
    const directory = path.join(skillsRoot, skill.name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "SKILL.md"), skill.raw ?? skill.body ?? "");
  }

  return {
    cleanup: () => {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { force: true, recursive: true });
    },
    projectDirectory,
    skillsRoot
  };
}

function frontmatter(name: string, description: string, body = "Body text."): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

test("frontmatter parsing extracts name and description", () => {
  const parsed = parseFrontmatter(frontmatter("deploy", "Ship the service to production."));
  assert.equal(parsed.fields.name, "deploy");
  assert.equal(parsed.fields.description, "Ship the service to production.");
  assert.equal(parsed.warning, undefined);
});

test("a file with no frontmatter is reported but not fatal", () => {
  const parsed = parseFrontmatter("# Just a heading\n");
  assert.equal(parsed.fields.name, "");
  assert.match(String(parsed.warning), /No YAML frontmatter/);
});

test("malformed frontmatter yields a warning rather than throwing", () => {
  const parsed = parseFrontmatter("---\nname: [unclosed\n---\nbody\n");
  assert.ok(parsed.warning, "a broken skill must not break discovery");
});

test("stripping frontmatter leaves the body", () => {
  assert.equal(stripFrontmatter(frontmatter("a", "b", "Real content.")).trim(), "Real content.");
});

test("discovery reads descriptions and exposes each skill's directory", () => {
  const p = project([
    { name: "deploy", raw: frontmatter("deploy", "Ship the service.") },
    { name: "audit", raw: frontmatter("audit", "Check the logs.") }
  ]);
  try {
    const registry = new SkillRegistry({ harness: "claude", projectDirectory: p.projectDirectory });
    const skills = registry.discover();
    assert.deepEqual(skills.map((skill) => skill.name), ["audit", "deploy"]);
    assert.equal(registry.get("deploy")?.description, "Ship the service.");
    assert.equal(registry.get("deploy")?.directory, path.join(p.skillsRoot, "deploy"));
    assert.deepEqual(registry.readRoots().sort(), [
      path.join(p.skillsRoot, "audit"),
      path.join(p.skillsRoot, "deploy")
    ]);
  } finally {
    p.cleanup();
  }
});

test("the menu lists descriptions only, never bodies", () => {
  const p = project([{ name: "deploy", raw: frontmatter("deploy", "Ship it.", "SECRET BODY CONTENT") }]);
  try {
    const registry = new SkillRegistry({ harness: "claude", projectDirectory: p.projectDirectory });
    registry.discover();
    const menu = registry.menu();
    assert.match(menu, /- deploy: Ship it\./);
    assert.ok(!menu.includes("SECRET BODY CONTENT"), "bodies must not reach the system prompt");
  } finally {
    p.cleanup();
  }
});

test("the menu is capped and says how many it omitted", () => {
  const many = Array.from({ length: 10 }, (_, index) => ({
    name: `skill-${index}`,
    raw: frontmatter(`skill-${index}`, `Description ${index}.`)
  }));
  const p = project(many);
  try {
    const registry = new SkillRegistry({
      harness: "claude",
      maxMenuEntries: 3,
      projectDirectory: p.projectDirectory
    });
    registry.discover();
    const menu = registry.menu();
    assert.equal(menu.split("\n").filter((line) => line.startsWith("- ")).length, 3);
    assert.match(menu, /7 further skill\(s\)/, "silent truncation would read as the full list");
  } finally {
    p.cleanup();
  }
});

test("long descriptions are truncated so the menu stays cheap", () => {
  const p = project([{ name: "verbose", raw: frontmatter("verbose", "x".repeat(1000)) }]);
  try {
    const registry = new SkillRegistry({
      harness: "claude",
      maxDescriptionChars: 50,
      projectDirectory: p.projectDirectory
    });
    registry.discover();
    assert.ok(registry.get("verbose")!.description.length <= 50);
  } finally {
    p.cleanup();
  }
});

test("loading returns the body and the skill's directory, without frontmatter", () => {
  const p = project([{ name: "deploy", raw: frontmatter("deploy", "Ship it.", "Step one. Step two.") }]);
  try {
    const registry = new SkillRegistry({ harness: "claude", projectDirectory: p.projectDirectory });
    registry.discover();
    const loaded = registry.load("deploy");
    assert.equal(loaded.isError, undefined);
    assert.match(loaded.content, /Step one\. Step two\./);
    assert.match(loaded.content, /Files for this skill are in:/);
    assert.ok(!loaded.content.includes("---\nname:"), "frontmatter is metadata, not instructions");
  } finally {
    p.cleanup();
  }
});

test("loading an unknown skill lists what is available", () => {
  const p = project([{ name: "deploy", raw: frontmatter("deploy", "Ship it.") }]);
  try {
    const registry = new SkillRegistry({ harness: "claude", projectDirectory: p.projectDirectory });
    registry.discover();
    const loaded = registry.load("imaginary");
    assert.equal(loaded.isError, true);
    assert.match(loaded.content, /Available: deploy/);
  } finally {
    p.cleanup();
  }
});

test("a bare .md skill file is supported alongside directories", () => {
  const p = project([{ dir: false, name: "quick", raw: frontmatter("quick", "A one-file skill.") }]);
  try {
    const registry = new SkillRegistry({ harness: "claude", projectDirectory: p.projectDirectory });
    registry.discover();
    assert.equal(registry.get("quick")?.description, "A one-file skill.");
    assert.equal(registry.get("quick")?.directory, p.skillsRoot);
  } finally {
    p.cleanup();
  }
});

test("one broken skill does not stop the others being discovered", () => {
  const p = project([
    { name: "good", raw: frontmatter("good", "Fine.") },
    { name: "broken", raw: "---\nname: [oops\n---\nbody\n" }
  ]);
  try {
    const registry = new SkillRegistry({ harness: "claude", projectDirectory: p.projectDirectory });
    const skills = registry.discover();
    assert.equal(skills.length, 2);
    assert.equal(registry.get("good")?.description, "Fine.");
    assert.ok(registry.list().find((skill) => skill.warning), "the broken one is flagged");
  } finally {
    p.cleanup();
  }
});

test("only enabled skills are discovered when a subset is configured", () => {
  const p = project([
    { name: "deploy", raw: frontmatter("deploy", "Ship it.") },
    { name: "audit", raw: frontmatter("audit", "Check it.") }
  ]);
  try {
    const registry = new SkillRegistry({
      enabled: ["deploy"],
      harness: "claude",
      projectDirectory: p.projectDirectory
    });
    assert.deepEqual(registry.discover().map((skill) => skill.name), ["deploy"]);
  } finally {
    p.cleanup();
  }
});

test("the system prompt keeps its layer order and a stable prefix", () => {
  const layers = {
    base: "You are the harness.",
    policy: "Company policy.",
    skillsMenu: "- deploy: Ship it.",
    session: "cwd: /tmp/a"
  };
  const prompt = assembleSystemPrompt(layers);
  assert.ok(prompt.indexOf("Company policy.") < prompt.indexOf("- deploy"));
  assert.ok(prompt.indexOf("- deploy") < prompt.indexOf("cwd:"));

  // The volatile layer must not disturb the cacheable prefix.
  const first = stableSystemPrefix({ ...layers, session: "cwd: /tmp/a" });
  const second = stableSystemPrefix({ ...layers, session: "cwd: /tmp/b" });
  assert.equal(first, second, "a changing session layer must not break prompt caching");
  assert.ok(!first.includes("cwd:"));
});

test("empty layers are omitted rather than leaving blank gaps", () => {
  assert.equal(assembleSystemPrompt({ base: "A", policy: "", skillsMenu: undefined }), "A");
});

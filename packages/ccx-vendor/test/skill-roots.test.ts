import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverSkills, skillRoots } from "../src/core/agents/skill-roots.ts";

test("claude roots match upstream order", () => {
  const roots = skillRoots("claude", "/proj");
  assert.equal(roots.length, 2);
  assert.equal(roots[0], path.join("/proj", ".claude", "skills"));
  assert.equal(roots[1], path.join(os.homedir(), ".claude", "skills"));
});

test("codex roots match upstream order and honour CODEX_HOME", () => {
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = "/codexhome";
  try {
    const roots = skillRoots("codex", "/proj");
    assert.deepEqual(roots, [
      path.join("/proj", ".agents", "skills"),
      path.join("/codexhome", "skills"),
      path.join(os.homedir(), ".codex", "skills")
    ]);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

test("zcode resolves its own runtime home", () => {
  const previous = process.env.ZCODE_HOME;
  process.env.ZCODE_HOME = "/zhome";
  try {
    assert.equal(skillRoots("zcode", "/proj")[1], path.join("/zhome", "skills"));
  } finally {
    if (previous === undefined) delete process.env.ZCODE_HOME;
    else process.env.ZCODE_HOME = previous;
  }
});

test("opencode roots match upstream order", () => {
  assert.deepEqual(skillRoots("opencode", "/proj"), [
    path.join("/proj", ".opencode", "skills"),
    path.join(os.homedir(), ".config", "opencode", "skills")
  ]);
});

test("discovery reads directories and bare .md files, project shadowing user", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "ccx-skills-"));
  const previousHome = process.env.HOME;
  process.env.HOME = path.join(temporary, "home");
  try {
    const projectRoot = path.join(temporary, "proj", ".claude", "skills");
    mkdirSync(path.join(projectRoot, "deploy"), { recursive: true });
    writeFileSync(path.join(projectRoot, "deploy", "SKILL.md"), "# deploy\n");
    writeFileSync(path.join(projectRoot, "review.md"), "# review\n");

    const skills = discoverSkills("claude", path.join(temporary, "proj"));
    const names = skills.map((skill) => skill.name);
    assert.deepEqual(names, ["deploy", "review"]);
    assert.ok(skills.every((skill) => skill.source === "project"));
    assert.equal(skills[0].location, path.join(projectRoot, "deploy"));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(temporary, { force: true, recursive: true });
  }
});

test("user roots are discovered and shadowed by project roots of the same name", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "ccx-skills-"));
  const previousHome = process.env.HOME;
  process.env.HOME = path.join(temporary, "home");
  try {
    const userRoot = path.join(temporary, "home", ".claude", "skills");
    mkdirSync(path.join(userRoot, "deploy"), { recursive: true });
    mkdirSync(path.join(userRoot, "audit"), { recursive: true });
    const projectRoot = path.join(temporary, "proj", ".claude", "skills");
    mkdirSync(path.join(projectRoot, "deploy"), { recursive: true });

    const skills = discoverSkills("claude", path.join(temporary, "proj"));
    assert.deepEqual(skills.map((skill) => skill.name), ["audit", "deploy"]);
    assert.equal(skills.find((skill) => skill.name === "audit")?.source, "user");
    // The project copy wins, matching upstream's first-root-wins dedupe.
    assert.equal(skills.find((skill) => skill.name === "deploy")?.source, "project");
    assert.equal(skills.find((skill) => skill.name === "deploy")?.location, path.join(projectRoot, "deploy"));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(temporary, { force: true, recursive: true });
  }
});

test("a missing root is absent rather than an error", () => {
  const previousHome = process.env.HOME;
  process.env.HOME = path.join(mkdtempSync(path.join(os.tmpdir(), "ccx-empty-")), "home");
  try {
    assert.deepEqual(discoverSkills("claude", "/nonexistent-project-path-ccx"), []);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

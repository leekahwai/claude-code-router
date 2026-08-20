import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionStore, credentialFingerprint } from "../src/session/store.ts";
import { TurnLoop } from "../src/turn/turn-loop.ts";
import { BuiltinTools } from "../src/tools/builtin.ts";
import { HarnessTools } from "../src/tools/registry.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { assembleSystemPrompt } from "../src/context/assemble.ts";
import { defaultModePolicies, PermissionGate, type ModePolicy } from "../src/tools/permissions.ts";
import { Workspace } from "../src/tools/workspace.ts";
import { FakeUpstream, textTurnFrames, toolTurnFrames, type ScriptedTurn } from "./fixtures/fake-upstream.ts";

async function build(script: ScriptedTurn[], policy: ModePolicy) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ccx-skint-"));
  const previousHome = process.env.HOME;
  process.env.HOME = path.join(directory, "home");

  const projectDirectory = path.join(directory, "proj");
  const workspace0 = path.join(projectDirectory, "work");
  mkdirSync(workspace0, { recursive: true });

  // A skill that ships a script — the case that is inert without file tools.
  const skillDir = path.join(projectDirectory, ".claude", "skills", "report");
  mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: report\ndescription: Produce the weekly report.\n---\n\nRun scripts/build.sh, then summarise.\n"
  );
  writeFileSync(path.join(skillDir, "scripts", "build.sh"), "#!/bin/sh\necho built-the-report\n");
  writeFileSync(path.join(skillDir, "reference.md"), "REFERENCE DATA FOR THE REPORT");

  const skills = new SkillRegistry({ harness: "claude", projectDirectory });
  skills.discover();

  const workspace = new Workspace(workspace0, { readRoots: skills.readRoots() });
  const gate = new PermissionGate({
    policy,
    prompter: async () => ({ approvedBy: "ada", decision: "allow" as const, remember: true })
  });
  const builtin = new BuiltinTools({ gate, policy, workspace });
  const sessions = new SessionStore(path.join(directory, "sessions.sqlite"));
  const upstream = new FakeUpstream(script);
  const baseUrl = await upstream.start();

  sessions.createSession({
    credentialFingerprint: credentialFingerprint("sk"),
    id: "s1",
    mode: "code",
    model: "claude-opus-5",
    provider: "anthropic",
    userId: "ada"
  });

  return {
    cleanup: async () => {
      await upstream.stop();
      sessions.close();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(directory, { force: true, recursive: true });
    },
    loop: new TurnLoop({
      apiKey: "sk",
      baseUrl,
      model: "claude-opus-5",
      sessions,
      system: assembleSystemPrompt({ base: "You are the harness.", skillsMenu: skills.menu() }),
      tools: new HarnessTools({ builtin, gate, policy, skills }),
      userId: "ada"
    }),
    sessions,
    skillDir,
    skills,
    upstream
  };
}

test("the skills menu reaches the system prompt, and the skill tool is offered", async () => {
  const h = await build([{ frames: textTurnFrames("ok") }], defaultModePolicies.code);
  try {
    await h.loop.runExchange({ sessionId: "s1", userText: "hi" });
    const body = h.upstream.requests[0].body;

    assert.match(String(body.system), /- report: Produce the weekly report\./);
    assert.ok(!String(body.system).includes("Run scripts/build.sh"), "the body stays out until loaded");

    const names = (body.tools as Array<{ name: string }>).map((tool) => tool.name);
    assert.ok(names.includes("skill"));
  } finally {
    await h.cleanup();
  }
});

test("loading a skill returns its instructions and is recorded as a tool call", async () => {
  const h = await build(
    [
      { frames: toolTurnFrames([{ id: "t1", input: { name: "report" }, name: "skill" }]) },
      { frames: textTurnFrames("Loaded.") }
    ],
    defaultModePolicies.code
  );
  try {
    await h.loop.runExchange({ sessionId: "s1", userText: "use the report skill" });

    const followUp = h.upstream.requests[1].body.messages as Array<Record<string, unknown>>;
    const block = (followUp[2].content as Array<Record<string, unknown>>)[0];
    assert.equal(block.is_error, undefined);
    assert.match(String(block.content), /Run scripts\/build\.sh/);

    const turn = h.sessions.listTurns("s1")[0];
    const [call] = h.sessions.listToolCalls(turn.id);
    assert.equal(call.name, "skill");
    assert.equal(call.status, "ok");
    assert.deepEqual(call.args, { name: "report" });
  } finally {
    await h.cleanup();
  }
});

test("a skill's own reference file is readable without a shell", async () => {
  const h = await build(
    [
      {
        frames: toolTurnFrames([
          { id: "t1", input: { path: path.join("reference.md") }, name: "read_file" }
        ])
      },
      { frames: textTurnFrames("read") }
    ],
    defaultModePolicies.work
  );
  try {
    // Read it by absolute path inside the skill's directory, which Work allows
    // because skill roots are declared read-only roots.
    const absolute = path.join(h.skillDir, "reference.md");
    const outcome = await h.loop.runExchange({ sessionId: "s1", userText: "read the reference" });
    assert.ok(outcome.iterations >= 1);

    const tools = new HarnessTools({
      gate: new PermissionGate({ policy: defaultModePolicies.work }),
      policy: defaultModePolicies.work,
      builtin: new BuiltinTools({
        gate: new PermissionGate({ policy: defaultModePolicies.work }),
        policy: defaultModePolicies.work,
        workspace: new Workspace(path.dirname(h.skillDir), { readRoots: h.skills.readRoots() })
      })
    });
    const read = await tools.execute({ input: { path: absolute }, name: "read_file" });
    assert.equal(read.content, "REFERENCE DATA FOR THE REPORT");
  } finally {
    await h.cleanup();
  }
});

test("a skill's script runs through bash in Code mode", async () => {
  const h = await build(
    [
      { frames: toolTurnFrames([{ id: "t1", input: { name: "report" }, name: "skill" }]) },
      {
        frames: toolTurnFrames([
          { id: "t2", input: { command: "sh \"$CCX_SKILL_DIR/scripts/build.sh\"" }, name: "bash" }
        ])
      },
      { frames: textTurnFrames("Report built.") }
    ],
    defaultModePolicies.code
  );
  try {
    process.env.CCX_SKILL_DIR = h.skillDir;
    const result = await h.loop.runExchange({ sessionId: "s1", userText: "run the report skill" });
    assert.equal(result.iterations, 3);

    const third = h.upstream.requests[2].body.messages as Array<Record<string, unknown>>;
    const block = (third[4].content as Array<Record<string, unknown>>)[0];
    assert.match(String(block.content), /built-the-report/, "the skill's script must actually run");
  } finally {
    delete process.env.CCX_SKILL_DIR;
    await h.cleanup();
  }
});

test("Work mode offers the skill tool but still refuses the shell a skill asks for", async () => {
  const h = await build(
    [
      { frames: toolTurnFrames([{ id: "t1", input: { name: "report" }, name: "skill" }]) },
      { frames: toolTurnFrames([{ id: "t2", input: { command: "sh scripts/build.sh" }, name: "bash" }]) },
      { frames: textTurnFrames("cannot run it") }
    ],
    defaultModePolicies.work
  );
  try {
    await h.loop.runExchange({ sessionId: "s1", userText: "run the report skill" });

    // The skill loads fine...
    const second = h.upstream.requests[1].body.messages as Array<Record<string, unknown>>;
    assert.equal((second[2].content as Array<Record<string, unknown>>)[0].is_error, undefined);

    // ...but its script does not run.
    const third = h.upstream.requests[2].body.messages as Array<Record<string, unknown>>;
    const shellBlock = (third[4].content as Array<Record<string, unknown>>)[0];
    assert.equal(shellBlock.is_error, true);
    assert.match(String(shellBlock.content), /not available in this mode/);
  } finally {
    await h.cleanup();
  }
});

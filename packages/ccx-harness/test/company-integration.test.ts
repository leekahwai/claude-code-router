import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionStore, credentialFingerprint } from "../src/session/store.ts";
import { TurnMetricsStore } from "../src/metrics/store.ts";
import { TurnLoop } from "../src/turn/turn-loop.ts";
import { BuiltinTools } from "../src/tools/builtin.ts";
import { HarnessTools } from "../src/tools/registry.ts";
import { CompanyPackStore, companyContextLayer, companyPolicyTokens, sixTierFrameworkTemplate } from "../src/company/pack.ts";
import { assembleSystemPrompt } from "../src/context/assemble.ts";
import { defaultModePolicies, PermissionGate, type ModePolicy } from "../src/tools/permissions.ts";
import { Workspace } from "../src/tools/workspace.ts";
import { FakeUpstream, textTurnFrames, toolTurnFrames, type ScriptedTurn } from "./fixtures/fake-upstream.ts";

async function build(script: ScriptedTurn[], policy: ModePolicy, enabled = true) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ccx-company-"));
  const workspaceDir = path.join(directory, "work");
  mkdirSync(workspaceDir, { recursive: true });

  const pack = new CompanyPackStore(path.join(directory, "company"));
  pack.save({ ...pack.load(), enabled, systemText: sixTierFrameworkTemplate });
  pack.putReference("standards/api.md", "Endpoints are plural nouns.", {
    description: "How we shape endpoints.",
    title: "API standards"
  });

  const loaded = pack.load();
  const workspace = new Workspace(workspaceDir);
  const gate = new PermissionGate({ policy });
  const builtin = new BuiltinTools({ gate, policy, workspace });
  const sessions = new SessionStore(path.join(directory, "sessions.sqlite"));
  const metrics = new TurnMetricsStore(path.join(directory, "metrics.sqlite"));
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
      metrics.close();
      rmSync(directory, { force: true, recursive: true });
    },
    loop: new TurnLoop({
      apiKey: "sk",
      baseUrl,
      metrics,
      model: "claude-opus-5",
      policyTokens: companyPolicyTokens(loaded),
      policyVersion: loaded.version,
      sessions,
      system: assembleSystemPrompt({
        base: "You are the harness.",
        companyContext: companyContextLayer(loaded)
      }),
      tools: new HarnessTools({ builtin, companyPack: pack, gate, policy }),
      userId: "ada"
    }),
    metrics,
    pack: loaded,
    upstream
  };
}

test("the pack reaches the system prompt, and the reference tool is offered", async () => {
  const h = await build([{ frames: textTurnFrames("ok") }], defaultModePolicies.code);
  try {
    await h.loop.runExchange({ sessionId: "s1", userText: "hi" });
    const body = h.upstream.requests[0].body;

    assert.match(String(body.system), /Engineering framework/);
    assert.match(String(body.system), /standards\/api\.md — API standards/);
    assert.ok(!String(body.system).includes("Endpoints are plural nouns."), "bodies stay out of the prompt");

    const names = (body.tools as Array<{ name: string }>).map((tool) => tool.name);
    assert.ok(names.includes("company_reference"));
  } finally {
    await h.cleanup();
  }
});

test("the policy version is stamped on the request for correlation", async () => {
  const h = await build([{ frames: textTurnFrames("ok") }], defaultModePolicies.code);
  try {
    await h.loop.runExchange({ sessionId: "s1", userText: "hi" });
    assert.equal(h.upstream.requests[0].headers["x-ccx-company-policy"], h.pack.version);
  } finally {
    await h.cleanup();
  }
});

test("policy cost is recorded per turn, ready to join against billed tokens", async () => {
  const h = await build([{ frames: textTurnFrames("ok") }], defaultModePolicies.code);
  try {
    const result = await h.loop.runExchange({ sessionId: "s1", userText: "hi" });
    const row = h.metrics.get(result.requestIds[0]);
    assert.ok(row);
    assert.ok(row.policyTokens > 0, "what the framework costs must be measurable");
    assert.equal(row.policyVersion, h.pack.version);
  } finally {
    await h.cleanup();
  }
});

test("the model pulls a reference on demand and gets its contents", async () => {
  const h = await build(
    [
      {
        frames: toolTurnFrames([
          { id: "t1", input: { path: "standards/api.md" }, name: "company_reference" }
        ])
      },
      { frames: textTurnFrames("Understood.") }
    ],
    defaultModePolicies.code
  );
  try {
    await h.loop.runExchange({ sessionId: "s1", userText: "what are our api standards" });
    const followUp = h.upstream.requests[1].body.messages as Array<Record<string, unknown>>;
    const block = (followUp[2].content as Array<Record<string, unknown>>)[0];
    assert.equal(block.is_error, undefined);
    assert.match(String(block.content), /Endpoints are plural nouns\./);
  } finally {
    await h.cleanup();
  }
});

test("reference material is readable in Work mode, which has no shell", async () => {
  const h = await build(
    [
      { frames: toolTurnFrames([{ id: "t1", input: { path: "standards/api.md" }, name: "company_reference" }]) },
      { frames: textTurnFrames("ok") }
    ],
    defaultModePolicies.work
  );
  try {
    await h.loop.runExchange({ sessionId: "s1", userText: "read it" });
    const followUp = h.upstream.requests[1].body.messages as Array<Record<string, unknown>>;
    const block = (followUp[2].content as Array<Record<string, unknown>>)[0];
    assert.equal(block.is_error, undefined);
  } finally {
    await h.cleanup();
  }
});

test("a disabled pack contributes neither prompt text nor a tool", async () => {
  const h = await build([{ frames: textTurnFrames("ok") }], defaultModePolicies.code, false);
  try {
    await h.loop.runExchange({ sessionId: "s1", userText: "hi" });
    const body = h.upstream.requests[0].body;
    assert.ok(!String(body.system ?? "").includes("Engineering framework"));
    const names = ((body.tools ?? []) as Array<{ name: string }>).map((tool) => tool.name);
    assert.ok(!names.includes("company_reference"));
  } finally {
    await h.cleanup();
  }
});

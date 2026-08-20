import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultAppConfig } from "@ccr/core/config/default-config";
import type { AppConfig } from "@ccr/core/contracts/app";
import {
  AccessLog,
  CcxConfigStore,
  CompanyPackStore,
  CredentialIdentityResolver,
  IdentityDirectory,
  SessionAuthorizer,
  SessionStore,
  TurnMetricsStore,
  credentialFingerprint,
  sixTierFrameworkTemplate
} from "@ccx/harness";
import { CcxRuntime } from "../src/runtime.ts";
import type { CcxPermissionAsk, CcxTurnEvent } from "../src/contract.ts";
import { FakeUpstream, textTurnFrames, type ScriptedTurn } from "../../ccx-harness/test/fixtures/fake-upstream.ts";

async function build(
  options: {
    mode?: "code" | "work";
    providers?: boolean;
    apiKey?: string;
    script?: ScriptedTurn[];
    /** Skip binding the key to a person, as an unregistered laptop would be. */
    unbound?: boolean;
  } = {}
) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ccx-rt-"));
  const projectDirectory = path.join(directory, "proj");
  mkdirSync(projectDirectory, { recursive: true });

  const upstream = new FakeUpstream(options.script ?? [{ frames: textTurnFrames("hello") }]);
  const baseUrl = await upstream.start();
  const port = Number(new URL(baseUrl).port);

  const appConfig: AppConfig = {
    ...createDefaultAppConfig(),
    HOST: "127.0.0.1",
    PORT: port,
    Providers: options.providers === false ? [] : [{ models: ["claude-opus-5"], name: "anthropic" }]
  };

  const config = new CcxConfigStore(path.join(directory, "cfg"));
  config.save({ ...config.load(), workspaceDir: projectDirectory });

  const companyPack = new CompanyPackStore(path.join(directory, "company"));
  const sessions = new SessionStore(path.join(directory, "sessions.sqlite"));
  const metrics = new TurnMetricsStore(path.join(directory, "metrics.sqlite"));
  const events: CcxTurnEvent[] = [];
  const asks: CcxPermissionAsk[] = [];

  const apiKey = options.apiKey ?? "sk-issued-to-ada";
  const identityDirectory = new IdentityDirectory(path.join(directory, "identity.sqlite"));
  const accessLog = new AccessLog(path.join(directory, "access.sqlite"));
  identityDirectory.upsertUser({
    displayName: "Ada",
    email: "ada@example.com",
    externalId: "",
    id: "ada",
    role: "user",
    status: "active"
  });
  if (!options.unbound) {
    identityDirectory.bindCredential({ boundBy: "root", fingerprint: credentialFingerprint(apiKey), userId: "ada" });
  }
  const authorizer = new SessionAuthorizer({ accessLog, sessions });

  const runtime = new CcxRuntime({
    apiKey,
    ask: (ask) => asks.push(ask),
    authorizer,
    companyPack,
    config,
    emit: (event) => events.push(event),
    loadAppConfig: () => appConfig,
    metrics,
    identityResolver: new CredentialIdentityResolver(identityDirectory),
    mode: options.mode ?? "code",
    projectDirectory,
    sessions
  });

  return {
    accessLog,
    appConfig,
    asks,
    cleanup: async () => {
      await runtime.stop();
      await upstream.stop();
      sessions.close();
      metrics.close();
      identityDirectory.close();
      accessLog.close();
      rmSync(directory, { force: true, recursive: true });
    },
    identityDirectory,
    companyPack,
    config,
    events,
    runtime,
    sessions,
    upstream
  };
}

test("with no provider configured the view reports why it is blocked", async () => {
  const h = await build({ providers: false });
  try {
    const view = h.runtime.viewConfig();
    assert.match(String(view.blockedReason), /No provider is configured/);
  } finally {
    await h.cleanup();
  }
});

test("the gate is enforced in main, not only by disabling the composer", async () => {
  const h = await build({ providers: false });
  try {
    // A renderer bug, or a tampered renderer, must not be able to start an
    // unconfigured session.
    assert.throws(() => h.runtime.createSession("code"), /No provider is configured/);
  } finally {
    await h.cleanup();
  }
});

test("without the issued API key the app blocks with a different message", async () => {
  const h = await build({ apiKey: "  " });
  try {
    assert.match(String(h.runtime.viewConfig().blockedReason), /API key you were issued/);
  } finally {
    await h.cleanup();
  }
});

test("a configured runtime creates a session bound to the mode's profile", async () => {
  const h = await build({ mode: "work" });
  try {
    const created = h.runtime.createSession("work");
    assert.equal(created.mode, "work");
    assert.equal(created.model, "anthropic/claude-opus-5");

    const stored = h.sessions.getSession(created.id);
    assert.equal(stored?.profileId, "ccx-work", "per-mode attribution depends on this");
    assert.equal(stored?.userId, "ada");
    assert.match(String(stored?.credentialFingerprint), /^[0-9a-f]{64}$/, "the key itself is never stored");
  } finally {
    await h.cleanup();
  }
});

test("sessions and transcripts are scoped to the signed-in user", async () => {
  const h = await build();
  try {
    const mine = h.runtime.createSession("code");
    h.identityDirectory.upsertUser({
      displayName: "Grace", email: "g@x", externalId: "", id: "grace", role: "user", status: "active"
    });
    h.sessions.createSession({
      credentialFingerprint: "x".repeat(64),
      id: "someone-else",
      mode: "code",
      model: "m",
      provider: "p",
      userId: "grace"
    });

    assert.deepEqual(h.runtime.listSessions().map((session) => session.id), [mine.id]);
    assert.deepEqual(h.runtime.messages("someone-else"), [], "guessing an id must not reveal a transcript");
    assert.deepEqual(h.accessLog.listForSubject("grace"), [], "a refused read is not an access");
  } finally {
    await h.cleanup();
  }
});

test("a key nobody bound to a person blocks the product", async () => {
  const h = await build({ unbound: true });
  try {
    assert.match(String(h.runtime.viewConfig().blockedReason), /not recognised/);
    assert.throws(() => h.runtime.createSession("code"), /not recognised/);
    assert.deepEqual(h.runtime.listSessions(), []);
  } finally {
    await h.cleanup();
  }
});

test("revoking the key takes effect without restarting the app", async () => {
  const h = await build();
  try {
    h.runtime.createSession("code");
    assert.equal(h.runtime.viewConfig().blockedReason, undefined);

    h.identityDirectory.revokeCredential(credentialFingerprint("sk-issued-to-ada"));

    assert.match(String(h.runtime.viewConfig().blockedReason), /revoked/);
    assert.deepEqual(h.runtime.listSessions(), [], "a revoked key stops seeing anything");
  } finally {
    await h.cleanup();
  }
});

test("the resolved identity, not a passed-in string, owns the session", async () => {
  const h = await build();
  try {
    const created = h.runtime.createSession("code");
    assert.equal(h.sessions.getSession(created.id)?.userId, "ada");
    assert.equal(h.runtime.viewConfig().userId, "ada");
  } finally {
    await h.cleanup();
  }
});

test("Code mode carries the company pack; Work mode does not", async () => {
  const code = await build({ mode: "code" });
  try {
    code.companyPack.save({ ...code.companyPack.load(), enabled: true, systemText: sixTierFrameworkTemplate });
    const session = code.runtime.createSession("code");
    await code.runtime.service.startTurn({ sessionId: session.id, text: "hi" });

    const body = code.upstream.requests[0].body;
    assert.match(String(body.system), /Engineering framework/);
    assert.equal(code.upstream.requests[0].headers["x-ccx-company-policy"], code.companyPack.load().version);
  } finally {
    await code.cleanup();
  }

  const work = await build({ mode: "work" });
  try {
    work.companyPack.save({ ...work.companyPack.load(), enabled: true, systemText: sixTierFrameworkTemplate });
    const session = work.runtime.createSession("work");
    await work.runtime.service.startTurn({ sessionId: session.id, text: "hi" });

    const body = work.upstream.requests[0].body;
    assert.ok(!String(body.system ?? "").includes("Engineering framework"), "Work is not a code context");
    assert.equal(work.upstream.requests[0].headers["x-ccx-company-policy"], undefined);
  } finally {
    await work.cleanup();
  }
});

test("the mode's reasoning preference reaches the request", async () => {
  const h = await build({ mode: "code" });
  try {
    const session = h.runtime.createSession("code");
    await h.runtime.service.startTurn({ sessionId: session.id, text: "hi" });

    const body = h.upstream.requests[0].body;
    // Code defaults to high effort with reasoning shown.
    assert.deepEqual(body.output_config, { effort: "high" });
    assert.deepEqual(body.thinking, { display: "summarized", type: "adaptive" });
  } finally {
    await h.cleanup();
  }
});

test("Work advertises no shell, Code does", async () => {
  const work = await build({ mode: "work" });
  try {
    const session = work.runtime.createSession("work");
    await work.runtime.service.startTurn({ sessionId: session.id, text: "hi" });
    const names = ((work.upstream.requests[0].body.tools ?? []) as Array<{ name: string }>).map((tool) => tool.name);
    assert.ok(!names.includes("bash"));
    assert.ok(names.includes("read_file"));
  } finally {
    await work.cleanup();
  }

  const code = await build({ mode: "code" });
  try {
    const session = code.runtime.createSession("code");
    await code.runtime.service.startTurn({ sessionId: session.id, text: "hi" });
    const names = ((code.upstream.requests[0].body.tools ?? []) as Array<{ name: string }>).map((tool) => tool.name);
    assert.ok(names.includes("bash"));
  } finally {
    await code.cleanup();
  }
});

test("changing the configured model changes the next session", async () => {
  const h = await build();
  try {
    h.appConfig.Providers = [{ models: ["claude-opus-5", "claude-sonnet-5"], name: "anthropic" }];
    h.config.updateMode("code", { model: "anthropic/claude-sonnet-5" });
    assert.equal(h.runtime.createSession("code").model, "anthropic/claude-sonnet-5");
  } finally {
    await h.cleanup();
  }
});

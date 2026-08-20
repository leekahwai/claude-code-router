import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BuiltinTools,
  HarnessTools,
  PermissionGate,
  SessionStore,
  TurnLoop,
  Workspace,
  credentialFingerprint,
  defaultModePolicies
} from "@ccx/harness";
import { SessionService } from "../src/session-service.ts";
import type { CcxPermissionAsk, CcxTurnEvent } from "../src/contract.ts";
import { FakeUpstream, textTurnFrames, toolTurnFrames, type ScriptedTurn } from "../../ccx-harness/test/fixtures/fake-upstream.ts";

async function build(script: ScriptedTurn[], policy = defaultModePolicies.code) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ccx-svc-"));
  const workspaceDir = path.join(directory, "work");
  mkdirSync(workspaceDir, { recursive: true });

  const sessions = new SessionStore(path.join(directory, "sessions.sqlite"));
  const upstream = new FakeUpstream(script);
  const baseUrl = await upstream.start();
  const events: CcxTurnEvent[] = [];
  const asks: CcxPermissionAsk[] = [];

  sessions.createSession({
    credentialFingerprint: credentialFingerprint("sk"),
    id: "s1",
    mode: "code",
    model: "claude-opus-5",
    provider: "anthropic",
    userId: "ada"
  });

  let service!: SessionService;
  service = new SessionService({
    ask: (ask) => asks.push(ask),
    emit: (event) => events.push(event),
    loopFor: (sessionId) => {
      const gate = new PermissionGate({ policy, prompter: service.prompter(sessionId) });
      const workspace = new Workspace(workspaceDir);
      return new TurnLoop({
        apiKey: "sk",
        baseUrl,
        model: "claude-opus-5",
        sessions,
        tools: new HarnessTools({ builtin: new BuiltinTools({ gate, policy, workspace }), gate, policy }),
        userId: "ada"
      });
    },
    sessions
  });

  return {
    asks,
    cleanup: async () => {
      service.shutdown();
      await upstream.stop();
      sessions.close();
      rmSync(directory, { force: true, recursive: true });
    },
    events,
    service,
    workspaceDir
  };
}

test("a turn emits start, text, usage and end in order", async () => {
  const h = await build([{ frames: textTurnFrames("Hello", 9) }]);
  try {
    const result = await h.service.startTurn({ sessionId: "s1", text: "hi" });
    assert.equal(result.cancelled, false);

    const types = h.events.map((event) => event.type);
    assert.equal(types[0], "turn-start");
    assert.ok(types.includes("text"));
    assert.deepEqual(types.slice(-2), ["usage", "turn-end"]);

    const usage = h.events.find((event) => event.type === "usage");
    assert.equal(usage && "outputTokens" in usage ? usage.outputTokens : 0, 9);
    assert.ok(h.events.every((event) => event.sessionId === "s1"));
  } finally {
    await h.cleanup();
  }
});

test("two turns on one session cannot overlap", async () => {
  const h = await build([{ delayMs: 60, frames: textTurnFrames("slow") }]);
  try {
    const first = h.service.startTurn({ sessionId: "s1", text: "one" });
    await assert.rejects(() => h.service.startTurn({ sessionId: "s1", text: "two" }), /already running/);
    await first;
    assert.equal(h.service.isBusy("s1"), false);
  } finally {
    await h.cleanup();
  }
});

test("interrupt cancels the in-flight turn and reports it", async () => {
  const h = await build([{ delayMs: 60, frames: textTurnFrames("interrupted") }]);
  try {
    const running = h.service.startTurn({ sessionId: "s1", text: "go" });
    setTimeout(() => h.service.interrupt("s1"), 30);
    const result = await running;

    assert.equal(result.cancelled, true);
    const last = h.events.at(-1);
    assert.equal(last?.type, "turn-end");
    assert.equal(last && "status" in last ? last.status : "", "cancelled");
  } finally {
    await h.cleanup();
  }
});

test("interrupting an idle session is a no-op, not an error", async () => {
  const h = await build([{ frames: textTurnFrames("x") }]);
  try {
    assert.equal(h.service.interrupt("s1"), false);
  } finally {
    await h.cleanup();
  }
});

test("a permission prompt reaches the renderer and its answer is honoured", async () => {
  const h = await build([
    { frames: toolTurnFrames([{ id: "t1", input: { content: "x", path: "a.txt" }, name: "write_file" }]) },
    { frames: textTurnFrames("written") }
  ]);
  try {
    const running = h.service.startTurn({ sessionId: "s1", text: "write it" });

    // Answer as soon as the ask arrives.
    for (let attempt = 0; attempt < 100 && h.asks.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(h.asks.length, 1);
    assert.equal(h.asks[0].toolName, "write_file");
    assert.equal(h.asks[0].risk, "write");
    assert.equal(h.asks[0].sessionId, "s1");
    assert.equal(h.service.answerPermission({ allow: true, id: h.asks[0].id, remember: false }), true);

    const result = await running;
    assert.equal(result.toolCallCount, 1);
  } finally {
    await h.cleanup();
  }
});

test("a declined prompt lets the turn continue with the refusal", async () => {
  const h = await build([
    { frames: toolTurnFrames([{ id: "t1", input: { command: "rm -rf /" }, name: "bash" }]) },
    { frames: textTurnFrames("understood") }
  ]);
  try {
    const running = h.service.startTurn({ sessionId: "s1", text: "go" });
    for (let attempt = 0; attempt < 100 && h.asks.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    h.service.answerPermission({ allow: false, id: h.asks[0].id, remember: false });

    const result = await running;
    assert.equal(result.iterations, 2, "a refusal is an answer, not a failure");
  } finally {
    await h.cleanup();
  }
});

test("answering an unknown prompt id is ignored rather than throwing", async () => {
  const h = await build([{ frames: textTurnFrames("x") }]);
  try {
    assert.equal(h.service.answerPermission({ allow: true, id: "nope", remember: false }), false);
  } finally {
    await h.cleanup();
  }
});

test("an upstream failure emits an error turn-end and rejects", async () => {
  const h = await build([{ httpError: { body: { error: "nope" }, status: 401 } }]);
  try {
    await assert.rejects(() => h.service.startTurn({ sessionId: "s1", text: "go" }));
    const last = h.events.at(-1);
    assert.equal(last?.type, "turn-end");
    assert.equal(last && "status" in last ? last.status : "", "error");
    assert.equal(h.service.isBusy("s1"), false, "a failed turn must release the session");
  } finally {
    await h.cleanup();
  }
});

test("shutdown cancels everything in flight", async () => {
  const h = await build([{ delayMs: 80, frames: textTurnFrames("long") }]);
  try {
    const running = h.service.startTurn({ sessionId: "s1", text: "go" });
    h.service.shutdown();
    const result = await running;
    assert.equal(result.cancelled, true);
  } finally {
    await h.cleanup();
  }
});

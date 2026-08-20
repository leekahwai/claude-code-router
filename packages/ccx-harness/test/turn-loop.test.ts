import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionStore, credentialFingerprint } from "../src/session/store.ts";
import { TurnMetricsStore } from "../src/metrics/store.ts";
import { TurnLoop } from "../src/turn/turn-loop.ts";
import { FunctionToolExecutor } from "../src/turn/tools.ts";
import { UpstreamHttpError } from "../src/turn/provider-client.ts";
import { FakeUpstream, textTurnFrames, toolTurnFrames, type ScriptedTurn } from "./fixtures/fake-upstream.ts";

type Harness = {
  cleanup: () => Promise<void>;
  loop: (extra?: Partial<ConstructorParameters<typeof TurnLoop>[0]>) => TurnLoop;
  metrics: TurnMetricsStore;
  sessionId: string;
  sessions: SessionStore;
  upstream: FakeUpstream;
};

async function harness(script: ScriptedTurn[], tools?: FunctionToolExecutor): Promise<Harness> {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ccx-loop-"));
  const sessions = new SessionStore(path.join(directory, "sessions.sqlite"));
  const metrics = new TurnMetricsStore(path.join(directory, "metrics.sqlite"));
  const upstream = new FakeUpstream(script);
  const baseUrl = await upstream.start();

  sessions.createSession({
    credentialFingerprint: credentialFingerprint("sk-test"),
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
    loop: (extra = {}) =>
      new TurnLoop({
        apiKey: "sk-test",
        baseUrl,
        metrics,
        model: "claude-opus-5",
        sessions,
        ...(tools ? { tools } : {}),
        userId: "ada",
        ...extra
      }),
    metrics,
    sessionId: "s1",
    sessions,
    upstream
  };
}

test("a plain text exchange streams deltas and persists the transcript", async () => {
  const h = await harness([{ frames: textTurnFrames("Hello there", 7) }]);
  try {
    const deltas: string[] = [];
    const result = await h.loop().runExchange({
      onEvent: (event) => {
        if (event.type === "text_delta") {
          deltas.push(event.text);
        }
      },
      sessionId: h.sessionId,
      userText: "hi"
    });

    assert.equal(result.text, "Hello there");
    assert.equal(result.iterations, 1);
    assert.equal(result.stopReason, "end_turn");
    assert.equal(result.usage.outputTokens, 7);
    assert.deepEqual(deltas, ["Hello there"], "the UI must receive deltas as they arrive");

    const messages = h.sessions.listMessages(h.sessionId);
    assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
    assert.equal(h.sessions.listTurns(h.sessionId)[0].status, "succeeded");
  } finally {
    await h.cleanup();
  }
});

test("the gateway request carries the join key and the turn records it", async () => {
  const h = await harness([{ frames: textTurnFrames("ok") }]);
  try {
    const result = await h.loop().runExchange({ sessionId: h.sessionId, userText: "hi" });
    const sent = h.upstream.requests[0];
    assert.equal(sent.headers["x-client-request-id"], result.requestIds[0]);
    assert.equal(sent.headers["x-api-key"], "sk-test");
    assert.equal(sent.body.stream, true, "the loop must always stream");
    assert.equal(sent.body.model, "claude-opus-5");
    assert.equal(h.sessions.listTurns(h.sessionId)[0].requestId, result.requestIds[0]);
    assert.ok(h.metrics.get(result.requestIds[0]), "a metrics row must exist for the join");
  } finally {
    await h.cleanup();
  }
});

test("a tool_use turn executes the tool and resumes into a second request", async () => {
  const calls: unknown[] = [];
  const tools = new FunctionToolExecutor([
    {
      input_schema: { properties: { path: { type: "string" } }, type: "object" },
      name: "read_file",
      run: (input) => {
        calls.push(input);
        return "file contents";
      }
    }
  ]);
  const h = await harness(
    [
      { frames: toolTurnFrames([{ id: "toolu_1", input: { path: "a.ts" }, name: "read_file" }], "Checking.") },
      { frames: textTurnFrames("It says hello.") }
    ],
    tools
  );
  try {
    const result = await h.loop().runExchange({ sessionId: h.sessionId, userText: "read a.ts" });

    assert.equal(result.iterations, 2, "the loop must resume after the tool");
    assert.equal(result.toolCallCount, 1);
    assert.equal(result.stopReason, "end_turn");
    assert.deepEqual(calls, [{ path: "a.ts" }]);
    assert.match(result.text, /It says hello\./);

    // user, assistant(tool_use), user(tool_result), assistant(text)
    const roles = h.sessions.listMessages(h.sessionId).map((message) => message.role);
    assert.deepEqual(roles, ["user", "assistant", "user", "assistant"]);

    const second = h.upstream.requests[1].body.messages as Array<Record<string, unknown>>;
    const toolResult = (second[2].content as Array<Record<string, unknown>>)[0];
    assert.equal(toolResult.type, "tool_result");
    assert.equal(toolResult.tool_use_id, "toolu_1");
    assert.equal(toolResult.content, "file contents");
    assert.equal(toolResult.is_error, undefined);

    const toolCalls = h.sessions.listToolCalls(h.sessions.listTurns(h.sessionId)[0].id);
    assert.equal(toolCalls[0].status, "ok");
    assert.equal(toolCalls[0].name, "read_file");
  } finally {
    await h.cleanup();
  }
});

test("parallel tool results are returned in a single user message", async () => {
  const tools = new FunctionToolExecutor([
    { input_schema: { type: "object" }, name: "alpha", run: () => "A" },
    { input_schema: { type: "object" }, name: "beta", run: () => "B" }
  ]);
  const h = await harness(
    [
      {
        frames: toolTurnFrames([
          { id: "t1", input: { x: 1 }, name: "alpha" },
          { id: "t2", input: { y: 2 }, name: "beta" }
        ])
      },
      { frames: textTurnFrames("done") }
    ],
    tools
  );
  try {
    const result = await h.loop().runExchange({ sessionId: h.sessionId, userText: "both" });
    assert.equal(result.toolCallCount, 2);

    const followUp = h.upstream.requests[1].body.messages as Array<Record<string, unknown>>;
    const resultMessages = followUp.filter((message) =>
      Array.isArray(message.content) &&
      (message.content as Array<Record<string, unknown>>).some((block) => block.type === "tool_result")
    );
    assert.equal(resultMessages.length, 1, "splitting tool_results across messages suppresses parallel calls");

    const blocks = resultMessages[0].content as Array<Record<string, unknown>>;
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks.map((block) => block.tool_use_id), ["t1", "t2"]);
  } finally {
    await h.cleanup();
  }
});

test("a failing tool returns is_error rather than aborting the exchange", async () => {
  const tools = new FunctionToolExecutor([
    {
      input_schema: { type: "object" },
      name: "explode",
      run: () => {
        throw new Error("disk on fire");
      }
    }
  ]);
  const h = await harness(
    [
      { frames: toolTurnFrames([{ id: "t1", input: {}, name: "explode" }]) },
      { frames: textTurnFrames("I will try something else.") }
    ],
    tools
  );
  try {
    const result = await h.loop().runExchange({ sessionId: h.sessionId, userText: "go" });
    assert.equal(result.iterations, 2, "the model must get a chance to recover");

    const followUp = h.upstream.requests[1].body.messages as Array<Record<string, unknown>>;
    const block = (followUp[2].content as Array<Record<string, unknown>>)[0];
    assert.equal(block.is_error, true);
    assert.match(String(block.content), /disk on fire/);

    const toolCalls = h.sessions.listToolCalls(h.sessions.listTurns(h.sessionId)[0].id);
    assert.equal(toolCalls[0].status, "error");
  } finally {
    await h.cleanup();
  }
});

test("an unknown tool name is reported back instead of throwing", async () => {
  const tools = new FunctionToolExecutor([{ input_schema: { type: "object" }, name: "known", run: () => "ok" }]);
  const h = await harness(
    [
      { frames: toolTurnFrames([{ id: "t1", input: {}, name: "imaginary" }]) },
      { frames: textTurnFrames("sorry") }
    ],
    tools
  );
  try {
    const result = await h.loop().runExchange({ sessionId: h.sessionId, userText: "go" });
    assert.equal(result.iterations, 2);
    const followUp = h.upstream.requests[1].body.messages as Array<Record<string, unknown>>;
    const block = (followUp[2].content as Array<Record<string, unknown>>)[0];
    assert.equal(block.is_error, true);
    assert.match(String(block.content), /Unknown tool "imaginary"/);
  } finally {
    await h.cleanup();
  }
});

test("the loop stops at maxIterations instead of looping forever", async () => {
  const tools = new FunctionToolExecutor([{ input_schema: { type: "object" }, name: "loopy", run: () => "again" }]);
  // Every scripted turn asks for the tool again.
  const h = await harness([{ frames: toolTurnFrames([{ id: "t1", input: {}, name: "loopy" }]) }], tools);
  try {
    const result = await h.loop({ maxIterations: 3 }).runExchange({ sessionId: h.sessionId, userText: "go" });
    assert.equal(result.iterations, 3);
    assert.equal(h.upstream.requests.length, 3);
  } finally {
    await h.cleanup();
  }
});

test("cancellation mid-stream keeps partial content and marks the turn cancelled", async () => {
  const frames = textTurnFrames("this will be interrupted");
  const h = await harness([{ delayMs: 40, frames }]);
  try {
    const controller = new AbortController();
    const loop = h.loop();
    const promise = loop.runExchange({
      onEvent: (event) => {
        if (event.type === "message_start") {
          setTimeout(() => controller.abort(), 10);
        }
      },
      sessionId: h.sessionId,
      signal: controller.signal,
      userText: "go"
    });

    const result = await promise;
    assert.equal(result.cancelled, true);
    const turns = h.sessions.listTurns(h.sessionId);
    assert.equal(turns[0].status, "cancelled");
    assert.equal(turns[0].error, "cancelled by client");
  } finally {
    await h.cleanup();
  }
});

test("a stream cut mid-turn preserves what arrived and does not throw", async () => {
  const h = await harness([{ cutAfterFrames: 3, frames: textTurnFrames("partial text") }]);
  try {
    const result = await h.loop().runExchange({ sessionId: h.sessionId, userText: "go" });
    assert.match(result.text, /partial text/);
    assert.equal(result.stopReason, "", "a cut stream must not look like a clean finish");
    const messages = h.sessions.listMessages(h.sessionId);
    assert.equal(messages.length, 2, "the partial assistant message must be persisted");
  } finally {
    await h.cleanup();
  }
});

test("a connection that dies before any response is an error, not an empty success", async () => {
  // Distinct from a cut mid-stream: nothing arrived, so there is no partial
  // turn to preserve. Reporting success here would hide a real failure.
  const h = await harness([{ cutAfterFrames: 0, frames: textTurnFrames("never sent") }]);
  try {
    await assert.rejects(() => h.loop().runExchange({ sessionId: h.sessionId, userText: "go" }));
    const turn = h.sessions.listTurns(h.sessionId)[0];
    assert.equal(turn.status, "error");
    assert.ok(turn.error.length > 0);
  } finally {
    await h.cleanup();
  }
});

test("an upstream error frame ends the exchange and records the reason", async () => {
  const h = await harness([
    {
      frames: [
        ["message_start", { message: { id: "m", model: "claude-opus-5", usage: {} }, type: "message_start" }],
        ["content_block_start", { content_block: { text: "", type: "text" }, index: 0, type: "content_block_start" }],
        ["content_block_delta", { delta: { text: "before the failure", type: "text_delta" }, index: 0, type: "content_block_delta" }],
        ["error", { error: { message: "Overloaded", type: "overloaded_error" }, type: "error" }]
      ]
    }
  ]);
  try {
    const result = await h.loop().runExchange({ sessionId: h.sessionId, userText: "go" });
    assert.match(result.text, /before the failure/);
    const turn = h.sessions.listTurns(h.sessionId)[0];
    assert.equal(turn.status, "error");
    assert.match(turn.error, /Overloaded/);
  } finally {
    await h.cleanup();
  }
});

test("an HTTP error surfaces as a typed error and marks the turn failed", async () => {
  const h = await harness([{ httpError: { body: { error: { message: "no key" } }, status: 401 } }]);
  try {
    await assert.rejects(
      () => h.loop().runExchange({ sessionId: h.sessionId, userText: "go" }),
      (error: unknown) => error instanceof UpstreamHttpError && error.status === 401
    );
    assert.equal(h.sessions.listTurns(h.sessionId)[0].status, "error");
  } finally {
    await h.cleanup();
  }
});

test("the mapped reasoning preference reaches the gateway request body", async () => {
  const h = await harness([{ frames: textTurnFrames("ok") }]);
  try {
    await h
      .loop({ reasoning: { effort: "xhigh", mode: "on", showReasoning: true } })
      .runExchange({ sessionId: h.sessionId, userText: "hi" });

    const body = h.upstream.requests[0].body;
    assert.deepEqual(body.thinking, { display: "summarized", type: "adaptive" });
    assert.deepEqual(body.output_config, { effort: "xhigh" });
  } finally {
    await h.cleanup();
  }
});

test("reasoning mapping strips fields extraBody carried that the model rejects", async () => {
  const h = await harness([{ frames: textTurnFrames("ok") }]);
  try {
    await h
      .loop({ extraBody: { temperature: 0.4 }, reasoning: { effort: "high", mode: "on", showReasoning: false } })
      .runExchange({ sessionId: h.sessionId, userText: "hi" });

    const body = h.upstream.requests[0].body;
    assert.equal(body.temperature, undefined, "Opus 5 rejects sampling parameters");
    assert.deepEqual(body.output_config, { effort: "high" });
  } finally {
    await h.cleanup();
  }
});

test("no reasoning fields are sent for a model with no capability entry", async () => {
  const h = await harness([{ frames: textTurnFrames("ok") }]);
  try {
    await h
      .loop({ model: "some-vendor/mystery-1", reasoning: { effort: "high", mode: "on", showReasoning: true } })
      .runExchange({ sessionId: h.sessionId, userText: "hi" });

    const body = h.upstream.requests[0].body;
    assert.equal(body.thinking, undefined);
    assert.equal(body.output_config, undefined);
  } finally {
    await h.cleanup();
  }
});

test("full history is resent on the follow-up request", async () => {
  const tools = new FunctionToolExecutor([{ input_schema: { type: "object" }, name: "t", run: () => "r" }]);
  const h = await harness(
    [{ frames: toolTurnFrames([{ id: "t1", input: {}, name: "t" }]) }, { frames: textTurnFrames("end") }],
    tools
  );
  try {
    await h.loop().runExchange({ sessionId: h.sessionId, userText: "start" });
    const first = h.upstream.requests[0].body.messages as unknown[];
    const second = h.upstream.requests[1].body.messages as unknown[];
    assert.equal(first.length, 1);
    assert.equal(second.length, 3, "the API is stateless — history must be resent in full");
  } finally {
    await h.cleanup();
  }
});

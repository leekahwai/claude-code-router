import assert from "node:assert/strict";
import test from "node:test";
import { MessageAssembler, SseDecoder } from "../src/stream/anthropic-stream.ts";

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Feed a whole transcript through both stages. */
function run(transcript: string, chunkSize?: number) {
  const decoder = new SseDecoder();
  const assembler = new MessageAssembler();
  const emitted: unknown[] = [];
  const chunks = chunkSize
    ? transcript.match(new RegExp(`[\\s\\S]{1,${chunkSize}}`, "g")) ?? []
    : [transcript];

  for (const chunk of chunks) {
    for (const sse of decoder.push(chunk)) {
      emitted.push(...assembler.push(sse));
    }
  }
  for (const sse of decoder.finish()) {
    emitted.push(...assembler.push(sse));
  }
  return { emitted, result: assembler.finish() };
}

const textTurn = [
  frame("message_start", { message: { id: "msg_1", model: "claude-opus-5", usage: { input_tokens: 42, cache_read_input_tokens: 10 } }, type: "message_start" }),
  frame("content_block_start", { content_block: { text: "", type: "text" }, index: 0, type: "content_block_start" }),
  frame("content_block_delta", { delta: { text: "Hello", type: "text_delta" }, index: 0, type: "content_block_delta" }),
  frame("content_block_delta", { delta: { text: ", world", type: "text_delta" }, index: 0, type: "content_block_delta" }),
  frame("content_block_stop", { index: 0, type: "content_block_stop" }),
  frame("message_delta", { delta: { stop_reason: "end_turn" }, type: "message_delta", usage: { output_tokens: 7 } }),
  frame("message_stop", { type: "message_stop" })
].join("");

test("assembles a plain text turn with usage and stop reason", () => {
  const { emitted, result } = run(textTurn);
  assert.deepEqual(result.blocks, [{ text: "Hello, world", type: "text" }]);
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.model, "claude-opus-5");
  assert.equal(result.usage.inputTokens, 42);
  assert.equal(result.usage.outputTokens, 7);
  assert.equal(result.usage.cacheReadInputTokens, 10);
  assert.equal(result.malformedFrames, 0);

  const deltas = emitted.filter((event) => (event as { type: string }).type === "text_delta");
  assert.equal(deltas.length, 2, "each token delta must surface for the UI");
});

test("frames split across arbitrary chunk boundaries still parse", () => {
  for (const size of [1, 3, 7, 13, 64]) {
    const { result } = run(textTurn, size);
    assert.deepEqual(result.blocks, [{ text: "Hello, world", type: "text" }], `chunk size ${size}`);
    assert.equal(result.usage.outputTokens, 7, `chunk size ${size}`);
  }
});

test("tool_use input is reassembled from partial_json fragments", () => {
  const transcript = [
    frame("message_start", { message: { id: "m", model: "claude-opus-5", usage: { input_tokens: 5 } }, type: "message_start" }),
    frame("content_block_start", { content_block: { text: "", type: "text" }, index: 0, type: "content_block_start" }),
    frame("content_block_delta", { delta: { text: "Let me check.", type: "text_delta" }, index: 0, type: "content_block_delta" }),
    frame("content_block_stop", { index: 0, type: "content_block_stop" }),
    frame("content_block_start", { content_block: { id: "toolu_1", input: {}, name: "read_file", type: "tool_use" }, index: 1, type: "content_block_start" }),
    frame("content_block_delta", { delta: { partial_json: '{"pa', type: "input_json_delta" }, index: 1, type: "content_block_delta" }),
    frame("content_block_delta", { delta: { partial_json: 'th":"src/', type: "input_json_delta" }, index: 1, type: "content_block_delta" }),
    frame("content_block_delta", { delta: { partial_json: 'a.ts"}', type: "input_json_delta" }, index: 1, type: "content_block_delta" }),
    frame("content_block_stop", { index: 1, type: "content_block_stop" }),
    frame("message_delta", { delta: { stop_reason: "tool_use" }, type: "message_delta", usage: { output_tokens: 20 } }),
    frame("message_stop", { type: "message_stop" })
  ].join("");

  const { emitted, result } = run(transcript);
  assert.equal(result.stopReason, "tool_use");
  assert.equal(result.toolUses.length, 1);
  assert.deepEqual(result.toolUses[0], {
    id: "toolu_1",
    input: { path: "src/a.ts" },
    name: "read_file",
    type: "tool_use"
  });
  assert.deepEqual(result.blocks[0], { text: "Let me check.", type: "text" });
  assert.ok(emitted.some((event) => (event as { type: string }).type === "tool_use_start"));
});

test("parallel tool calls keep their own blocks and arguments", () => {
  const transcript = [
    frame("message_start", { message: { id: "m", model: "claude-opus-5", usage: {} }, type: "message_start" }),
    frame("content_block_start", { content_block: { id: "t1", name: "alpha", type: "tool_use" }, index: 0, type: "content_block_start" }),
    frame("content_block_start", { content_block: { id: "t2", name: "beta", type: "tool_use" }, index: 1, type: "content_block_start" }),
    // Interleaved, as parallel calls arrive in practice.
    frame("content_block_delta", { delta: { partial_json: '{"x":', type: "input_json_delta" }, index: 0, type: "content_block_delta" }),
    frame("content_block_delta", { delta: { partial_json: '{"y":', type: "input_json_delta" }, index: 1, type: "content_block_delta" }),
    frame("content_block_delta", { delta: { partial_json: "1}", type: "input_json_delta" }, index: 0, type: "content_block_delta" }),
    frame("content_block_delta", { delta: { partial_json: "2}", type: "input_json_delta" }, index: 1, type: "content_block_delta" }),
    frame("message_delta", { delta: { stop_reason: "tool_use" }, type: "message_delta", usage: { output_tokens: 9 } }),
    frame("message_stop", { type: "message_stop" })
  ].join("");

  const { result } = run(transcript);
  assert.equal(result.toolUses.length, 2);
  assert.deepEqual(result.toolUses[0].input, { x: 1 });
  assert.deepEqual(result.toolUses[1].input, { y: 2 });
  assert.deepEqual(result.toolUses.map((tool) => tool.name), ["alpha", "beta"]);
});

test("thinking blocks accumulate and signature deltas are ignored", () => {
  const transcript = [
    frame("message_start", { message: { id: "m", model: "claude-opus-5", usage: {} }, type: "message_start" }),
    frame("content_block_start", { content_block: { thinking: "", type: "thinking" }, index: 0, type: "content_block_start" }),
    frame("content_block_delta", { delta: { thinking: "step one ", type: "thinking_delta" }, index: 0, type: "content_block_delta" }),
    frame("content_block_delta", { delta: { thinking: "step two", type: "thinking_delta" }, index: 0, type: "content_block_delta" }),
    frame("content_block_delta", { delta: { signature: "abc", type: "signature_delta" }, index: 0, type: "content_block_delta" }),
    frame("content_block_stop", { index: 0, type: "content_block_stop" }),
    frame("message_stop", { type: "message_stop" })
  ].join("");

  const { result } = run(transcript);
  assert.deepEqual(result.blocks, [{ thinking: "step one step two", type: "thinking" }]);
  assert.equal(result.malformedFrames, 0, "an unknown delta type is not a malformed frame");
});

test("a mid-stream error surfaces without discarding completed content", () => {
  const transcript = [
    frame("message_start", { message: { id: "m", model: "claude-opus-5", usage: { input_tokens: 3 } }, type: "message_start" }),
    frame("content_block_start", { content_block: { text: "", type: "text" }, index: 0, type: "content_block_start" }),
    frame("content_block_delta", { delta: { text: "partial answer", type: "text_delta" }, index: 0, type: "content_block_delta" }),
    frame("error", { error: { message: "Overloaded", type: "overloaded_error" }, type: "error" })
  ].join("");

  const { emitted, result } = run(transcript);
  assert.deepEqual(result.error, { message: "Overloaded", type: "overloaded_error" });
  assert.deepEqual(result.blocks, [{ text: "partial answer", type: "text" }], "partial content must survive");
  assert.ok(emitted.some((event) => (event as { type: string }).type === "error"));
});

test("a malformed frame is counted, not fatal", () => {
  const transcript = [
    frame("message_start", { message: { id: "m", model: "claude-opus-5", usage: {} }, type: "message_start" }),
    "event: content_block_delta\ndata: {not json at all\n\n",
    frame("content_block_start", { content_block: { text: "", type: "text" }, index: 0, type: "content_block_start" }),
    frame("content_block_delta", { delta: { text: "still fine", type: "text_delta" }, index: 0, type: "content_block_delta" }),
    frame("message_stop", { type: "message_stop" })
  ].join("");

  const { result } = run(transcript);
  assert.equal(result.malformedFrames, 1);
  assert.deepEqual(result.blocks, [{ text: "still fine", type: "text" }]);
});

test("a truncated stream yields what arrived, with no stop reason", () => {
  const transcript = [
    frame("message_start", { message: { id: "m", model: "claude-opus-5", usage: { input_tokens: 11 } }, type: "message_start" }),
    frame("content_block_start", { content_block: { text: "", type: "text" }, index: 0, type: "content_block_start" }),
    frame("content_block_delta", { delta: { text: "cut off here", type: "text_delta" }, index: 0, type: "content_block_delta" })
  ].join("");

  const { result } = run(transcript);
  assert.deepEqual(result.blocks, [{ text: "cut off here", type: "text" }]);
  assert.equal(result.stopReason, "", "an interrupted turn must not look complete");
});

test("ping frames and comments are ignored", () => {
  const transcript = [
    ": keep-alive comment\n\n",
    frame("ping", { type: "ping" }),
    frame("message_start", { message: { id: "m", model: "claude-opus-5", usage: {} }, type: "message_start" }),
    frame("content_block_start", { content_block: { text: "", type: "text" }, index: 0, type: "content_block_start" }),
    frame("content_block_delta", { delta: { text: "ok", type: "text_delta" }, index: 0, type: "content_block_delta" }),
    frame("message_stop", { type: "message_stop" })
  ].join("");

  const { result } = run(transcript);
  assert.deepEqual(result.blocks, [{ text: "ok", type: "text" }]);
  assert.equal(result.malformedFrames, 0);
});

test("a late usage frame cannot regress the running counts", () => {
  const transcript = [
    frame("message_start", { message: { id: "m", model: "claude-opus-5", usage: { input_tokens: 100 } }, type: "message_start" }),
    frame("message_delta", { delta: {}, type: "message_delta", usage: { output_tokens: 50 } }),
    frame("message_delta", { delta: { stop_reason: "end_turn" }, type: "message_delta", usage: { output_tokens: 0 } }),
    frame("message_stop", { type: "message_stop" })
  ].join("");

  const { result } = run(transcript);
  assert.equal(result.usage.inputTokens, 100);
  assert.equal(result.usage.outputTokens, 50);
});

test("CRLF line endings parse identically", () => {
  const crlf = textTurn.replace(/\n/g, "\r\n");
  const { result } = run(crlf);
  assert.deepEqual(result.blocks, [{ text: "Hello, world", type: "text" }]);
  assert.equal(result.stopReason, "end_turn");
});

test("multi-line data fields are joined with newlines", () => {
  const decoder = new SseDecoder();
  const events = decoder.push('event: message_stop\ndata: {"type":\ndata: "message_stop"}\n\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].data, '{"type":\n"message_stop"}');
});

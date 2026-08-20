import assert from "node:assert/strict";
import test from "node:test";
import { mapReasoning, type ReasoningPreference } from "../src/reasoning/map.ts";
import { normalizeModelKey, resolveReasoningCapability } from "../src/reasoning/capabilities.ts";

const on: ReasoningPreference = { effort: "high", mode: "on", showReasoning: false };

function map(model: string, preference: Partial<ReasoningPreference> = {}, extra = {}) {
  return mapReasoning({ maxTokens: 64_000, model, preference: { ...on, ...preference }, ...extra });
}

test("model keys normalize across provider and bedrock-style ids", () => {
  assert.equal(normalizeModelKey("claude-opus-5"), "claude-opus-5");
  assert.equal(normalizeModelKey("anthropic/claude-opus-5"), "claude-opus-5");
  assert.equal(normalizeModelKey("amazon-bedrock/anthropic.claude-opus-4-7-v1:0"), "claude-opus-4-7");
  assert.equal(normalizeModelKey("  Anthropic/Claude-Sonnet-5  "), "claude-sonnet-5");
});

test("the longest built-in prefix wins, so 4-8 does not match a shorter family", () => {
  const four8 = resolveReasoningCapability("claude-opus-4-8");
  assert.equal(four8.source, "builtin");
  assert.equal(four8.capability.defaultOn, false, "4.8 does not reason unless asked");

  const five = resolveReasoningCapability("claude-opus-5");
  assert.equal(five.capability.defaultOn, true, "Opus 5 reasons by default");
});

test("current Claude models get adaptive thinking and effort under output_config", () => {
  const result = map("claude-opus-5");
  assert.deepEqual(result.body.thinking, { type: "adaptive" });
  assert.deepEqual(result.body.output_config, { effort: "high" });
  assert.equal(result.thinkingEnabled, true);
  assert.deepEqual(result.diagnostics, []);
});

test("auto mode omits the control on a model that already reasons", () => {
  const result = map("claude-opus-5", { effort: "auto", mode: "auto" });
  assert.equal(result.body.thinking, undefined, "omitting keeps the request minimal and the prefix stable");
  assert.equal(result.thinkingEnabled, true);
});

test("auto mode still sends the control where omitting means no thinking", () => {
  const result = map("claude-opus-4-8", { effort: "auto", mode: "auto" });
  assert.deepEqual(result.body.thinking, { type: "adaptive" }, "4.8 needs adaptive stated explicitly");
});

test("showing reasoning requests a summary, and forces the control to be sent", () => {
  const result = map("claude-opus-5", { effort: "auto", mode: "auto", showReasoning: true });
  assert.deepEqual(result.body.thinking, { display: "summarized", type: "adaptive" });
});

test("a model that returns reasoning by default needs no display field", () => {
  const result = map("claude-sonnet-4-6", { showReasoning: true });
  const thinking = result.body.thinking as Record<string, unknown>;
  assert.equal(thinking.display, undefined);
  assert.equal(thinking.type, "adaptive");
});

test("an unsupported effort degrades to the nearest lower level with a diagnostic", () => {
  const result = map("claude-sonnet-4-6", { effort: "xhigh" });
  assert.deepEqual(result.body.output_config, { effort: "high" });
  assert.equal(result.effectiveEffort, "high");
  assert.equal(result.diagnostics[0].code, "effort-unsupported");
  assert.match(result.diagnostics[0].detail, /using "high"/);
});

test("reasoning cannot be switched off on a model that always reasons", () => {
  const result = map("claude-fable-5", { effort: "auto", mode: "off" });
  assert.equal(result.body.thinking, undefined, "no explicit thinking config is accepted");
  assert.equal(result.thinkingEnabled, true);
  assert.equal(result.diagnostics[0].code, "disabled-unsupported");
});

test("off is honoured where the model allows it", () => {
  const result = map("claude-opus-4-8", { effort: "auto", mode: "off" });
  assert.deepEqual(result.body.thinking, { type: "disabled" });
  assert.equal(result.thinkingEnabled, false);
});

test("off is refused at the efforts where the model rejects it", () => {
  const result = map("claude-opus-5", { effort: "max", mode: "off" });
  assert.equal(result.thinkingEnabled, true);
  assert.deepEqual(result.body.output_config, { effort: "max" });
  assert.notDeepEqual(result.body.thinking, { type: "disabled" });
  assert.equal(result.diagnostics[0].code, "disabled-unsupported");

  // ...but accepted at high or below on the same model.
  const allowed = map("claude-opus-5", { effort: "high", mode: "off" });
  assert.deepEqual(allowed.body.thinking, { type: "disabled" });
});

test("pre-4.6 models get an explicit token budget instead of adaptive", () => {
  const result = map("claude-haiku-4-5", { budgetTokens: 4096, effort: "auto" });
  assert.deepEqual(result.body.thinking, { budget_tokens: 4096, type: "enabled" });
  assert.equal(result.body.output_config, undefined, "effort is rejected on this model");
});

test("a budget below the minimum is raised, and one above max_tokens is clamped", () => {
  const low = map("claude-haiku-4-5", { budgetTokens: 10, effort: "auto" });
  assert.deepEqual(low.body.thinking, { budget_tokens: 1024, type: "enabled" });
  assert.equal(low.diagnostics[0].code, "budget-clamped");

  const high = mapReasoning({
    maxTokens: 2000,
    model: "claude-haiku-4-5",
    preference: { budgetTokens: 5000, effort: "auto", mode: "on", showReasoning: false }
  });
  assert.deepEqual(high.body.thinking, { budget_tokens: 1999, type: "enabled" });
  assert.match(high.diagnostics[0].detail, /below max_tokens/);
});

test("an effort request on a model with no effort support is dropped, not sent", () => {
  const result = map("claude-haiku-4-5", { effort: "max" });
  assert.equal(result.body.output_config, undefined);
  assert.ok(result.diagnostics.some((entry) => entry.code === "effort-unsupported"));
});

test("sampling parameters are stripped for models that reject them", () => {
  const body: Record<string, unknown> = { temperature: 0.7, top_p: 0.9 };
  const result = mapReasoning({ model: "claude-opus-5", preference: on, requestBody: body });
  assert.equal(body.temperature, undefined);
  assert.equal(body.top_p, undefined);
  assert.equal(result.diagnostics.find((entry) => entry.code === "sampling-stripped")?.code, "sampling-stripped");
});

test("sampling is left alone on models that still accept it", () => {
  const body: Record<string, unknown> = { temperature: 0.7 };
  mapReasoning({ model: "claude-sonnet-4-6", preference: on, requestBody: body });
  assert.equal(body.temperature, 0.7);
});

test("an unknown model sends nothing and says reasoning is unsupported", () => {
  const result = map("some-vendor/mystery-model-9");
  assert.deepEqual(result.body, {});
  assert.equal(result.capabilitySource, "none");
  // Both facts are reported: the model takes neither an effort nor a control.
  const codes = result.diagnostics.map((entry) => entry.code).sort();
  assert.deepEqual(codes, ["effort-unsupported", "reasoning-unsupported"]);
});

test("provider metadata supplies capabilities for models with no built-in entry", () => {
  const result = mapReasoning({
    model: "some-vendor/reasoner-1",
    preference: { effort: "medium", mode: "on", showReasoning: false },
    sources: { catalog: { efforts: ["low", "medium", "high"], supportsReasoning: true } }
  });
  assert.equal(result.capabilitySource, "catalog");
  assert.deepEqual(result.body.output_config, { effort: "medium" });
  assert.deepEqual(result.body.thinking, { type: "adaptive" });
});

test("an admin override beats the built-in table without a release", () => {
  const result = mapReasoning({
    model: "claude-opus-5",
    preference: { effort: "max", mode: "on", showReasoning: false },
    sources: { overrides: { "claude-opus-5": { efforts: ["low", "medium"] } } }
  });
  assert.equal(result.capabilitySource, "override");
  assert.deepEqual(result.body.output_config, { effort: "medium" });
});

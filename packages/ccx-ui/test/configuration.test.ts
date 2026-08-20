import assert from "node:assert/strict";
import test from "node:test";
import { mapReasoning } from "@ccx/harness";
import { reasoningEffortOptions, reasoningModeOptions } from "../src/reasoning-config.ts";

/**
 * The toggle rule is the fiddly part of the page: an empty list means "all", so
 * the first untick has to materialise the full set first.
 */
function toggle(current: string[], all: string[], name: string, checked: boolean): string[] {
  const base = current.length === 0 ? [...all] : [...current];
  const next = checked ? [...new Set([...base, name])] : base.filter((entry) => entry !== name);
  return next.length === all.length ? [] : next;
}

const all = ["alpha", "beta", "gamma"];

test("unticking one item from the default keeps the other two", () => {
  assert.deepEqual(toggle([], all, "beta", false), ["alpha", "gamma"]);
});

test("re-ticking everything collapses back to the all-enabled default", () => {
  const afterUntick = toggle([], all, "beta", false);
  assert.deepEqual(toggle(afterUntick, all, "beta", true), []);
});

test("unticking a second item narrows further", () => {
  const one = toggle([], all, "beta", false);
  assert.deepEqual(toggle(one, all, "gamma", false), ["alpha"]);
});

test("the effort options cover every level the mapper can emit", () => {
  const offered = reasoningEffortOptions.map((option) => option.value);
  for (const level of ["auto", "low", "medium", "high", "xhigh", "max"]) {
    assert.ok(offered.includes(level as never), `missing ${level}`);
  }
});

test("every reasoning mode the page offers is one the mapper understands", () => {
  for (const option of reasoningModeOptions) {
    const mapped = mapReasoning({
      model: "claude-opus-5",
      preference: { effort: "high", mode: option.value, showReasoning: false }
    });
    assert.ok(mapped.capabilitySource === "builtin", option.label);
  }
});

test("the page's diagnostics come from the mapper, not from its own rules", () => {
  // Sonnet 4.6 has no xhigh; the page shows what the mapper decided.
  const mapped = mapReasoning({
    model: "claude-sonnet-4-6",
    preference: { effort: "xhigh", mode: "on", showReasoning: false }
  });
  assert.equal(mapped.diagnostics.length, 1);
  assert.match(mapped.diagnostics[0].detail, /using "high"/);
});

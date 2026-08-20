import assert from "node:assert/strict";
import test from "node:test";
import { companyPackNotices, driftSummary, validateCompanyPack } from "../src/company-config.ts";

test("enabling an empty pack is refused", () => {
  const result = validateCompanyPack({ enabled: true, injection: "manifest", systemText: "  " }, 0);
  assert.equal(result.errors.length, 1);
});

test("a pack with only reference documents is allowed", () => {
  const result = validateCompanyPack({ enabled: true, injection: "manifest", systemText: "" }, 2);
  assert.deepEqual(result.errors, []);
});

test("a credential in the instructions blocks saving", () => {
  const result = validateCompanyPack(
    { enabled: true, injection: "manifest", systemText: "use sk-abcdefgh12345678 for the api" },
    0
  );
  assert.match(result.errors.join(" "), /credential/);
});

test("a very large pack warns without blocking", () => {
  const result = validateCompanyPack(
    { enabled: true, injection: "manifest", systemText: "x".repeat(9000) },
    0
  );
  assert.deepEqual(result.errors, []);
  assert.match(result.warnings.join(" "), /sent on every request/);
});

test("inline injection with many documents warns about prompt growth", () => {
  const result = validateCompanyPack({ enabled: true, injection: "inline", systemText: "policy" }, 5);
  assert.match(result.warnings.join(" "), /grows the prompt/);
});

test("drift is summarised for the status line", () => {
  assert.match(driftSummary({ changed: [], missing: [], untracked: [] }), /All reference documents match/);
  assert.match(driftSummary({ changed: ["a"], missing: ["b"], untracked: [] }), /1 edited on disk, 1 missing/);
});

test("the notices state the things that are easy to get wrong", () => {
  assert.match(companyPackNotices.logging, /not from logs/);
  assert.match(companyPackNotices.advisory, /detectable, not preventable/);
});

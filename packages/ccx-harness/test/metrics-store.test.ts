import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TurnMetricsStore } from "../src/metrics/store.ts";

function temporaryDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "ccx-metrics-"));
}

test("records and reads back a turn", () => {
  const directory = temporaryDir();
  const store = new TurnMetricsStore(path.join(directory, "metrics.sqlite"));
  try {
    store.record({
      estimatedInputTokens: 1234,
      mcpCalls: 2,
      mode: "code",
      policyTokens: 310,
      policyVersion: "six-tier@1",
      requestId: "req-1",
      sessionId: "sess-1",
      skillsLoaded: ["deploy"],
      turnId: "turn-1",
      userId: "ada"
    });

    const row = store.get("req-1");
    assert.ok(row);
    assert.equal(row.userId, "ada");
    assert.equal(row.mode, "code");
    assert.equal(row.estimatedInputTokens, 1234);
    assert.equal(row.policyTokens, 310);
    assert.equal(row.policyVersion, "six-tier@1");
    assert.deepEqual(row.skillsLoaded, ["deploy"]);
    assert.equal(row.mcpCalls, 2);
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("recording the same request id updates rather than duplicating", () => {
  const directory = temporaryDir();
  const store = new TurnMetricsStore(path.join(directory, "metrics.sqlite"));
  try {
    const base = { mode: "work" as const, requestId: "req-1", sessionId: "s", turnId: "t", userId: "ada" };
    store.record({ ...base, estimatedInputTokens: 10 });
    store.record({ ...base, estimatedInputTokens: 99, policyTokens: 5 });

    const rows = store.listForUser("ada");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].estimatedInputTokens, 99);
    assert.equal(rows[0].policyTokens, 5);
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("listing without an attached usage database still returns our own metrics", () => {
  const directory = temporaryDir();
  const store = new TurnMetricsStore(path.join(directory, "metrics.sqlite"));
  try {
    store.record({ mode: "work", requestId: "req-1", sessionId: "s", turnId: "t", userId: "ada" });
    const rows = store.listForUser("ada");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].billedInputTokens, undefined);
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a missing usage database degrades instead of throwing", () => {
  const directory = temporaryDir();
  const store = new TurnMetricsStore(path.join(directory, "metrics.sqlite"), {
    usageDbFile: path.join(directory, "does-not-exist.sqlite")
  });
  try {
    store.record({ mode: "code", requestId: "req-1", sessionId: "s", turnId: "t", userId: "ada" });
    assert.equal(store.listForUser("ada").length, 1);
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("user scoping does not leak other users' turns", () => {
  const directory = temporaryDir();
  const store = new TurnMetricsStore(path.join(directory, "metrics.sqlite"));
  try {
    store.record({ mode: "work", requestId: "a", sessionId: "s1", turnId: "t1", userId: "ada" });
    store.record({ mode: "work", requestId: "b", sessionId: "s2", turnId: "t2", userId: "grace" });
    assert.deepEqual(store.listForUser("ada").map((row) => row.requestId), ["a"]);
    assert.deepEqual(store.listForUser("grace").map((row) => row.requestId), ["b"]);
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  companyContextLayer,
  companyPolicyTokens,
  CompanyPackStore,
  safeReferencePath,
  sixTierFrameworkTemplate
} from "../src/company/pack.ts";
import { executeCompanyReferenceTool } from "../src/company/tool.ts";

function store(): { cleanup: () => void; value: CompanyPackStore } {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ccx-pack-"));
  return {
    cleanup: () => rmSync(directory, { force: true, recursive: true }),
    value: new CompanyPackStore(path.join(directory, "company"))
  };
}

test("an absent pack loads as disabled rather than throwing", () => {
  const s = store();
  try {
    const pack = s.value.load();
    assert.equal(pack.enabled, false);
    assert.deepEqual(pack.references, []);
    assert.equal(companyContextLayer(pack), "");
  } finally {
    s.cleanup();
  }
});

test("a disabled pack contributes nothing, even with content", () => {
  const s = store();
  try {
    s.value.save({
      enabled: false,
      injection: "manifest",
      references: [],
      systemText: "SHOULD NOT APPEAR",
      version: "3"
    });
    assert.equal(companyContextLayer(s.value.load()), "");
    assert.equal(companyPolicyTokens(s.value.load()), 0);
  } finally {
    s.cleanup();
  }
});

test("the manifest lists reference paths but never their contents", () => {
  const s = store();
  try {
    s.value.save({ ...s.value.load(), enabled: true, systemText: sixTierFrameworkTemplate });
    s.value.putReference("standards/api.md", "SECRET REFERENCE BODY", {
      description: "How we shape endpoints.",
      title: "API standards"
    });

    const layer = companyContextLayer(s.value.load());
    assert.match(layer, /standards\/api\.md — API standards: How we shape endpoints\./);
    assert.ok(!layer.includes("SECRET REFERENCE BODY"), "inlining would destroy the context budget");
    assert.match(layer, /company_reference tool/);
  } finally {
    s.cleanup();
  }
});

test("adding or removing a reference bumps the pack version", () => {
  const s = store();
  try {
    s.value.save({ ...s.value.load(), enabled: true, version: "7" });
    assert.equal(s.value.putReference("a.md", "one").version, "8");
    assert.equal(s.value.removeReference("a.md").version, "9");
  } finally {
    s.cleanup();
  }
});

test("reference paths cannot climb out of the pack", () => {
  for (const attempt of ["../escape.md", "../../etc/passwd", "/etc/passwd", "a/../../b.md"]) {
    assert.throws(() => safeReferencePath(attempt), /Invalid reference path/, attempt);
  }
  assert.equal(safeReferencePath("standards/api.md"), "standards/api.md");
  assert.equal(safeReferencePath("./notes.md"), "notes.md");
});

test("drift detection reports changed, missing and untracked files", () => {
  const s = store();
  try {
    s.value.save({ ...s.value.load(), enabled: true });
    s.value.putReference("kept.md", "original");
    s.value.putReference("gone.md", "will be deleted");

    // Edit one on disk behind the manifest's back, delete another, add a stray.
    writeFileSync(path.join(s.value.referencesDirectory, "kept.md"), "tampered");
    rmSync(path.join(s.value.referencesDirectory, "gone.md"));
    mkdirSync(s.value.referencesDirectory, { recursive: true });
    writeFileSync(path.join(s.value.referencesDirectory, "stray.md"), "not published");

    const drift = s.value.drift();
    assert.deepEqual(drift.changed, ["kept.md"]);
    assert.deepEqual(drift.missing, ["gone.md"]);
    assert.deepEqual(drift.untracked, ["stray.md"]);
  } finally {
    s.cleanup();
  }
});

test("the reference tool reads a published file and refuses anything else", () => {
  const s = store();
  try {
    s.value.save({ ...s.value.load(), enabled: true });
    s.value.putReference("guide.md", "the guide body");

    const ok = executeCompanyReferenceTool(s.value, { path: "guide.md" });
    assert.equal(ok.content, "the guide body");
    assert.equal(ok.isError, undefined);

    const unknown = executeCompanyReferenceTool(s.value, { path: "not-published.md" });
    assert.equal(unknown.isError, true);
    assert.match(String(unknown.content), /Available: guide\.md/);

    // Even a traversal that resolves to a real file is refused: it is not in
    // the manifest, so it was never published.
    const escape = executeCompanyReferenceTool(s.value, { path: "../pack.json" });
    assert.equal(escape.isError, true);
  } finally {
    s.cleanup();
  }
});

test("policy cost is measured with the estimator CCR itself uses", () => {
  const s = store();
  try {
    s.value.save({ ...s.value.load(), enabled: true, systemText: sixTierFrameworkTemplate });
    const tokens = companyPolicyTokens(s.value.load());
    assert.ok(tokens > 50, "the framework is not free");
    assert.ok(tokens < 1000, "nor should it be enormous");
  } finally {
    s.cleanup();
  }
});

test("the context layer is byte-stable for a fixed pack, so caching holds", () => {
  const s = store();
  try {
    s.value.save({ ...s.value.load(), enabled: true, systemText: "Policy." });
    s.value.putReference("b.md", "b");
    s.value.putReference("a.md", "a");

    const first = companyContextLayer(s.value.load());
    const second = companyContextLayer(s.value.load());
    assert.equal(first, second);
    // Sorted, so publication order cannot reshuffle the cached prefix.
    assert.ok(first.indexOf("a.md") < first.indexOf("b.md"));
  } finally {
    s.cleanup();
  }
});

test("inline injection is available but does not paste bodies either", () => {
  const s = store();
  try {
    s.value.save({ ...s.value.load(), enabled: true, injection: "inline" });
    s.value.putReference("a.md", "BODY");
    const layer = companyContextLayer(s.value.load());
    assert.ok(!layer.includes("BODY"));
  } finally {
    s.cleanup();
  }
});

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const vendorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(vendorRoot, "vendor.manifest.json"), "utf8")) as {
  artifacts: Array<{
    generated?: boolean;
    output: string;
    owner: string;
    regions: Array<{ endPattern: string; id: string; path: string; sha256: string; startPattern: string }>;
    why: string;
  }>;
  baselineCommit?: string;
};

test("every artifact declares provenance and an owner", () => {
  assert.ok(manifest.artifacts.length > 0);
  for (const artifact of manifest.artifacts) {
    assert.ok(artifact.owner, `${artifact.output} has no owner`);
    assert.ok(artifact.why, `${artifact.output} does not say why it is vendored`);
    assert.ok(artifact.regions.length > 0, `${artifact.output} declares no regions`);
  }
});

test("every region has a recorded baseline hash", () => {
  assert.ok(manifest.baselineCommit, "manifest has no baselineCommit — run: npm run -w @ccx/vendor baseline");
  for (const artifact of manifest.artifacts) {
    for (const region of artifact.regions) {
      assert.match(region.sha256, /^[0-9a-f]{64}$/, `${artifact.output}::${region.id} has no baseline hash`);
      assert.ok(region.path.startsWith("packages/"), `${artifact.output}::${region.id} points outside packages/`);
    }
  }
});

test("every vendored source file carries a provenance header", () => {
  for (const artifact of manifest.artifacts) {
    const source = readFileSync(path.join(vendorRoot, artifact.output), "utf8");
    for (const tag of ["@vendored-from", "@vendored-at", "@owner", "@modifications", "@why"]) {
      assert.ok(source.includes(tag), `${artifact.output} is missing ${tag}`);
    }
  }
});

test("generated artifacts have balanced vendor markers for every region", () => {
  for (const artifact of manifest.artifacts.filter((candidate) => candidate.generated)) {
    const source = readFileSync(path.join(vendorRoot, artifact.output), "utf8");
    for (const region of artifact.regions) {
      const open = source.indexOf(`// >>> vendored: ${region.id}`);
      const close = source.indexOf(`// <<< vendored: ${region.id}`);
      assert.ok(open >= 0, `${artifact.output} has no opening marker for ${region.id}`);
      assert.ok(close > open, `${artifact.output} has no closing marker after ${region.id}`);
      assert.ok(close - open > 40, `${artifact.output} region ${region.id} looks empty — run vendor sync`);
    }
  }
});

test("no source file outside the vendor package claims vendored provenance", () => {
  const offenders: string[] = [];
  for (const packageName of readdirSync(path.join(vendorRoot, ".."))) {
    if (!packageName.startsWith("ccx-") || packageName === "ccx-vendor") {
      continue;
    }
    walk(path.join(vendorRoot, "..", packageName, "src"), (file) => {
      if (readFileSync(file, "utf8").includes("@vendored-from")) {
        offenders.push(file);
      }
    });
  }
  assert.deepEqual(offenders, [], "vendored code must live in @ccx/vendor so the drift check covers it");
});

function walk(directory: string, visit: (file: string) => void): void {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(target, visit);
    } else if (entry.name.endsWith(".ts")) {
      visit(target);
    }
  }
}

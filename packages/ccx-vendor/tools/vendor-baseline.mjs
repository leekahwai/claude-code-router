/**
 * Record the current baseline hash for every vendored region.
 *
 * Run this once when first vendoring a region, and again after consciously
 * re-vendoring a drifted one. It never rewrites vendored source; it only
 * records what upstream looked like at the baseline ref.
 */
import { writeFileSync } from "node:fs";
import { inspectArtifact, manifestFile, readManifest, refExists, resolveRef } from "./vendor-lib.mjs";

const manifest = readManifest();
const ref = process.argv[2] || manifest.baselineRef;

if (!refExists(ref)) {
  console.error(`Baseline ref "${ref}" does not exist. Run: git tag vendor-baseline <commit>`);
  process.exit(2);
}

let recorded = 0;
let failed = 0;

for (const artifact of manifest.artifacts) {
  const results = inspectArtifact(artifact, ref);
  for (const result of results) {
    const region = artifact.regions.find((candidate) => candidate.id === result.id);
    if (result.status !== "located") {
      console.error(`  FAIL ${artifact.output} :: ${result.id} — ${result.status}${result.detail ? ` (${result.detail})` : ""}`);
      failed += 1;
      continue;
    }
    region.sha256 = result.sha256;
    region.baselineLines = `${result.startLine}-${result.endLine}`;
    console.log(`  ok   ${artifact.output} :: ${result.id}  L${result.startLine}-${result.endLine}  ${result.sha256.slice(0, 12)}`);
    recorded += 1;
  }
}

manifest.baselineCommit = resolveRef(ref);
writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`\nRecorded ${recorded} region(s) at ${manifest.baselineCommit}${failed ? `, ${failed} failed` : ""}.`);
process.exit(failed ? 1 : 0);

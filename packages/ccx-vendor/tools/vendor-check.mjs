/**
 * Report which vendored regions have drifted upstream.
 *
 * A drifted region is not a failure of this repository — it is a decision to
 * make, surfaced while it is still cheap. CI runs this so the decision cannot
 * be skipped silently.
 *
 *   node tools/vendor-check.mjs [upstreamRef]
 */
import { inspectArtifact, readManifest, refExists, resolveRef } from "./vendor-lib.mjs";

const manifest = readManifest();
const ref = process.argv[2] || process.env.CCX_UPSTREAM_REF || manifest.upstreamRef;

if (!refExists(ref)) {
  console.error(`Upstream ref "${ref}" is not available.`);
  console.error("Run: git remote add upstream https://github.com/musistudio/claude-code-router.git && git fetch upstream");
  process.exit(2);
}

const resolved = resolveRef(ref);
console.log(`Vendor drift check — baseline ${manifest.baselineCommit ?? "(unrecorded)"} vs ${ref} (${resolved})\n`);

const drifted = [];
const broken = [];
let clean = 0;

for (const artifact of manifest.artifacts) {
  console.log(artifact.output);
  for (const result of inspectArtifact(artifact, ref)) {
    const region = artifact.regions.find((candidate) => candidate.id === result.id);
    const label = `  ${result.id.padEnd(30)}`;

    if (!region.sha256) {
      console.log(`${label} UNRECORDED  run: npm run -w @ccx/vendor baseline`);
      broken.push(`${artifact.output}::${result.id} (unrecorded)`);
      continue;
    }
    if (result.status !== "located") {
      console.log(`${label} ${result.status.toUpperCase()}  ${result.detail ?? ""}`);
      broken.push(`${artifact.output}::${result.id} (${result.status})`);
      continue;
    }
    if (result.sha256 === region.sha256) {
      console.log(`${label} clean       L${result.startLine}-${result.endLine}`);
      clean += 1;
      continue;
    }
    console.log(`${label} DRIFTED     L${result.startLine}-${result.endLine}  ${region.sha256.slice(0, 12)} -> ${result.sha256.slice(0, 12)}`);
    drifted.push(`${artifact.output}::${result.id}`);
  }
  console.log("");
}

console.log(`${clean} clean, ${drifted.length} drifted, ${broken.length} unresolved.`);

if (drifted.length > 0) {
  console.log("\nDrifted regions — review each, then re-vendor or consciously accept:");
  for (const item of drifted) {
    console.log(`  - ${item}`);
  }
  console.log(`\n  git diff ${manifest.baselineCommit ?? manifest.baselineRef}..${ref} -- <path>`);
}
if (broken.length > 0) {
  console.log("\nUnresolved regions — anchors no longer match, or never recorded:");
  for (const item of broken) {
    console.log(`  - ${item}`);
  }
}

process.exit(drifted.length + broken.length > 0 ? 1 : 0);

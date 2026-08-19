/**
 * Refill the vendored blocks of generated artifacts from upstream.
 *
 * Vendored source lives between markers:
 *   // >>> vendored: <region-id>
 *   ...replaced verbatim from upstream, then substitutions applied...
 *   // <<< vendored: <region-id>
 *
 * Re-vendoring a drifted region is therefore one command plus a review of the
 * diff, rather than a manual re-copy nobody wants to do.
 *
 *   node tools/vendor-sync.mjs [ref]     # default: manifest.baselineRef
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inspectArtifact, readManifest, refExists, vendorRoot } from "./vendor-lib.mjs";

const manifest = readManifest();
const ref = process.argv[2] || manifest.baselineRef;

if (!refExists(ref)) {
  console.error(`Ref "${ref}" is not available.`);
  process.exit(2);
}

let written = 0;
let failed = 0;

for (const artifact of manifest.artifacts) {
  if (!artifact.generated) {
    console.log(`  skip ${artifact.output} (hand-adapted; drift is reported, not applied)`);
    continue;
  }
  const outputFile = path.join(vendorRoot, artifact.output);
  let source = readFileSync(outputFile, "utf8");

  for (const result of inspectArtifact(artifact, ref)) {
    if (result.status !== "located") {
      console.error(`  FAIL ${artifact.output} :: ${result.id} — ${result.status}`);
      failed += 1;
      continue;
    }
    let body = result.text;
    for (const substitution of artifact.substitutions ?? []) {
      body = body.split(substitution.from).join(substitution.to);
    }
    const open = `// >>> vendored: ${result.id}`;
    const close = `// <<< vendored: ${result.id}`;
    const startIndex = source.indexOf(open);
    const endIndex = source.indexOf(close);
    if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
      console.error(`  FAIL ${artifact.output} :: ${result.id} — markers missing`);
      failed += 1;
      continue;
    }
    source = `${source.slice(0, startIndex + open.length)}\n${body}\n${source.slice(endIndex)}`;
    console.log(`  ok   ${artifact.output} :: ${result.id}  (${body.split("\n").length} lines)`);
  }

  writeFileSync(outputFile, source, "utf8");
  written += 1;
}

console.log(`\nSynced ${written} artifact(s) from ${ref}${failed ? `, ${failed} region(s) failed` : ""}.`);
process.exit(failed ? 1 : 0);

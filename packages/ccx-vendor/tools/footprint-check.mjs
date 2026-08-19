/**
 * Enforce the upstream footprint budget.
 *
 * The fork-isolation strategy claims the product touches one line of upstream
 * source. A claim nobody checks decays within a sprint, so this turns it into a
 * build failure: any upstream file changed outside upstream-footprint.json, or
 * beyond its declared budget, fails CI.
 *
 * Adding an entry to the budget is allowed — it is meant to be a deliberate,
 * reviewable act rather than something that happens by accident.
 *
 *   node tools/footprint-check.mjs [baselineRef]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { manifestFile, refExists, vendorRoot } from "./vendor-lib.mjs";

const budget = JSON.parse(readFileSync(path.join(vendorRoot, "upstream-footprint.json"), "utf8"));
const baselineRef = process.argv[2] || budget.baselineRef;

if (!refExists(baselineRef)) {
  console.error(`Baseline ref "${baselineRef}" is not available. Run: git tag vendor-baseline <commit>`);
  process.exit(2);
}

const numstat = execFileSync("git", ["diff", "--numstat", baselineRef, "--"], {
  cwd: path.resolve(vendorRoot, "..", ".."),
  encoding: "utf8"
});

const changes = numstat
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    const [added, removed, file] = line.split("\t");
    return { added: Number(added) || 0, file, removed: Number(removed) || 0 };
  })
  .filter((change) => !budget.ownedPrefixes.some((prefix) => change.file.startsWith(prefix)))
  .filter((change) => !budget.generatedAllowed.includes(change.file));

const allowedByPath = new Map(budget.allowed.map((entry) => [entry.path, entry]));
const violations = [];
let totalLines = 0;

console.log(`Upstream footprint vs ${baselineRef}\n`);

for (const change of changes) {
  const entry = allowedByPath.get(change.file);
  if (!entry) {
    violations.push(`${change.file} — not in the footprint budget (+${change.added}/-${change.removed})`);
    console.log(`  UNBUDGETED  ${change.file}  +${change.added}/-${change.removed}`);
    continue;
  }
  if (change.added > entry.maxAddedLines || change.removed > entry.maxRemovedLines) {
    violations.push(
      `${change.file} — over budget: +${change.added}/-${change.removed} exceeds +${entry.maxAddedLines}/-${entry.maxRemovedLines}`
    );
    console.log(`  OVER        ${change.file}  +${change.added}/-${change.removed}`);
    continue;
  }
  totalLines += change.added + change.removed;
  console.log(`  ok          ${change.file}  +${change.added}/-${change.removed}  (${entry.reason})`);
}

if (changes.length === 0) {
  console.log("  (no upstream files modified)");
}

console.log(`\n${totalLines} upstream line(s) changed; budget is ${budget.totalLineBudget}.`);

if (totalLines > budget.totalLineBudget) {
  violations.push(`total upstream lines ${totalLines} exceeds budget ${budget.totalLineBudget}`);
}

// The vendor manifest must exist for the drift check to mean anything.
if (!readFileSync(manifestFile, "utf8").includes("baselineCommit")) {
  violations.push("vendor manifest has no baselineCommit — run: npm run -w @ccx/vendor baseline");
}

if (violations.length > 0) {
  console.error("\nFootprint violations:");
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  console.error("\nEither move the change into a packages/ccx-* package, or add a reasoned entry");
  console.error("to packages/ccx-vendor/upstream-footprint.json and say why in review.");
  process.exit(1);
}

console.log("Footprint within budget.");

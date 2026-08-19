/**
 * Compare an upstream suite's failures against the recorded known-failure set.
 *
 * "It was already failing" is only trustworthy if something checks it. This
 * turns that claim into a ratchet:
 *
 *   - a failure NOT in the list  -> we probably caused it        -> fail
 *   - a listed failure that PASSES -> the entry is stale         -> fail
 *   - listed failures still failing -> tolerated, printed        -> pass
 *
 * Usage:
 *   npm run test:core -- --test-reporter=tap > core.tap || true
 *   node tools/upstream-suite-check.mjs core core.tap
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { vendorRoot } from "./vendor-lib.mjs";

const [suite, tapFile] = process.argv.slice(2);

if (!suite || !tapFile) {
  console.error("Usage: node tools/upstream-suite-check.mjs <suite> <tap-file>");
  process.exit(2);
}

const knownFile = path.join(vendorRoot, "upstream-known-failures.json");
const known = JSON.parse(readFileSync(knownFile, "utf8"));

if (!Object.hasOwn(known.suites, suite)) {
  console.error(`Unknown suite "${suite}". Add it to upstream-known-failures.json.`);
  process.exit(2);
}

const tap = readFileSync(tapFile, "utf8");
const failed = new Set();
const passed = new Set();

for (const line of tap.split("\n")) {
  const notOk = /^\s*not ok \d+ - (.+?)\s*$/.exec(line);
  if (notOk) {
    failed.add(notOk[1]);
    continue;
  }
  const ok = /^\s*ok \d+ - (.+?)\s*$/.exec(line);
  if (ok) {
    passed.add(ok[1].replace(/\s+# SKIP.*$/, ""));
  }
}

const expected = new Map(known.suites[suite].map((entry) => [entry.test, entry]));
const unexpected = [...failed].filter((name) => !expected.has(name));
const stale = [...expected.keys()].filter((name) => passed.has(name) && !failed.has(name));
const tolerated = [...failed].filter((name) => expected.has(name));

console.log(`Upstream suite "${suite}": ${passed.size} passed, ${failed.size} failed, ${expected.size} known-failure entr${expected.size === 1 ? "y" : "ies"}.\n`);

for (const name of tolerated) {
  console.log(`  tolerated  ${name}`);
  console.log(`             ${expected.get(name).reason}`);
}
for (const name of unexpected) {
  console.log(`  NEW FAIL   ${name}`);
}
for (const name of stale) {
  console.log(`  STALE      ${name} — now passes; remove the entry`);
}

if (unexpected.length > 0 || stale.length > 0) {
  console.error("");
  if (unexpected.length > 0) {
    console.error(`${unexpected.length} upstream test(s) failing that we did not expect.`);
    console.error("Either fix the cause, or add an entry with a reason to upstream-known-failures.json.");
  }
  if (stale.length > 0) {
    console.error(`${stale.length} known-failure entr${stale.length === 1 ? "y" : "ies"} now pass — delete them so the ratchet stays tight.`);
  }
  process.exit(1);
}

console.log(failed.size === 0 ? "\nSuite is green." : "\nOnly known failures; no regression.");

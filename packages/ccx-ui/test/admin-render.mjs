/**
 * Drive the built admin console in a real browser against a live collector.
 *
 * The reducer tests cover the state rules and the HTTP tests cover the API.
 * This covers the seam neither can: that the bundle boots, that the key the
 * operator types actually authenticates, and that a cross-user read performed
 * through the UI lands in the audit log. Wiring bugs live exactly here.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

function launchOptions() {
  const bundled = "/opt/pw-browsers/chromium";
  if (existsSync(chromium.executablePath())) {
    return {};
  }
  return existsSync(bundled) ? { executablePath: bundled } : {};
}

// The collector is TypeScript source, so load it through the same hook the
// tests use rather than building a second artifact just for this check.
await import(path.join(repoRoot, "packages", "ccx-vendor", "tools", "ccr-alias-hook.mjs"));
const { startCollector } = await import(path.join(repoRoot, "packages", "ccx-collector", "src", "server.ts"));
const { credentialFingerprint } = await import(path.join(repoRoot, "packages", "ccx-harness", "src", "index.ts"));

const dataDir = mkdtempSync(path.join(os.tmpdir(), "ccx-admin-render-"));
const collector = await startCollector({
  consoleDir: path.join(repoRoot, "packages", "ccx-collector", "dist", "console"),
  dataDir
});

for (const person of [
  { id: "alice", role: "user" },
  { id: "root", role: "admin" }
]) {
  collector.directory.upsertUser({
    displayName: person.id === "root" ? "Root Admin" : "Alice Example",
    email: `${person.id}@example.com`,
    externalId: "",
    id: person.id,
    role: person.role,
    status: "active",
    temporary: false
  });
  collector.directory.bindCredential({
    boundBy: "setup",
    fingerprint: credentialFingerprint(`${person.id}-key`),
    userId: person.id
  });
}

collector.sessions.createSession({
  credentialFingerprint: credentialFingerprint("alice-key"),
  id: "alice-1",
  mode: "code",
  model: "opus-5",
  provider: "acme",
  title: "Quarterly migration",
  userId: "alice"
});
collector.sessions.appendMessage("alice-1", "user", [{ text: "plan the quarterly migration", type: "text" }]);
collector.sessions.appendMessage("alice-1", "assistant", [{ text: "here is a migration plan", type: "text" }]);

const browser = await chromium.launch(launchOptions());
const page = await browser.newPage();
const failures = [];
page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") {
    failures.push(`console.error: ${message.text()}`);
  }
});

const base = `http://127.0.0.1:${collector.port}`;

try {
  await page.goto(`${base}/admin/`);

  // 1. The gate renders and asks for a key.
  await page.waitForSelector(".gate");
  assert.equal(await page.locator("h1").innerText(), "Work / Code administration");

  // 2. A non-admin key gets in but sees nothing cross-user.
  await page.fill(".gate input", "alice-key");
  await page.click(".gate button");
  await page.waitForSelector("text=Not an administrator");
  await page.click("text=Use a different key");

  // 3. The admin key reaches the console proper.
  await page.waitForSelector(".gate input");
  await page.fill(".gate input", "root-key");
  await page.click(".gate button");
  await page.waitForSelector(".stats");
  assert.match(await page.locator(".assurance").innerText(), /claimed/);
  assert.match(await page.locator(".stats").innerText(), /Sessions/);

  // 4. Acting on someone else's material is blocked until a reason is given.
  await page.click("text=People");
  await page.waitForSelector(".grid");
  const aliceRow = page.locator("tr", { hasText: "Alice Example" });
  assert.equal(await aliceRow.locator("button", { hasText: "Sessions" }).isDisabled(), true);

  await page.fill(".reason input", "render smoke: ticket 7");
  assert.equal(await aliceRow.locator("button", { hasText: "Sessions" }).isDisabled(), false);

  // 5. Browsing to a transcript and reading it.
  await aliceRow.locator("button", { hasText: "Sessions" }).click();
  await page.waitForSelector(".hits button");
  assert.match(await page.locator(".hits").innerText(), /Quarterly migration/);
  await page.click(".hits button");
  await page.waitForSelector(".messages");
  assert.match(await page.locator(".messages").innerText(), /here is a migration plan/);

  // 6. Searching, which the console warns is itself a cross-user read.
  await page.click("text=Search");
  await page.fill(".search input", "migration");
  await page.click(".search button");
  await page.waitForSelector(".hits button");

  // 7. Everything above landed in the audit trail, with the reason attached.
  await page.click("text=Audit");
  await page.waitForSelector(".grid");
  const audit = await page.locator(".grid").innerText();
  // Browsing one person's sessions and searching across everyone both go
  // through the same scoped-search path, so both log `search` — told apart by
  // the recorded query, which carries `text=` only when one was typed.
  for (const expected of [
    "read-session",
    "search",
    "render smoke: ticket 7",
    'text="migration"'
  ]) {
    assert.ok(audit.includes(expected), `the audit view should show ${expected}\n${audit}`);
  }
  assert.ok(
    audit.split("\n").filter((line) => line.includes("search")).length >= 2,
    "both the scoped browse and the text search must be recorded"
  );

  assert.deepEqual(failures, [], "the console must render without page errors");
  console.log("Admin console render smoke test passed.");
} finally {
  await browser.close();
  await collector.close();
  rmSync(dataDir, { force: true, recursive: true });
}

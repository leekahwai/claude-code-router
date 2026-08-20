/**
 * Render the built Work/Code bundle in a real browser and drive it.
 *
 * The reducer tests cover transcript logic; this covers the half they cannot —
 * that the bundle actually boots, the bridge contract matches what the view
 * calls, and streaming events reach the DOM. A UI that only ever compiled is
 * not a UI that works.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

/**
 * The image ships a Chromium that may not match this Playwright's pinned
 * revision. Prefer the one that is actually installed rather than downloading.
 */
function launchOptions() {
  const bundled = "/opt/pw-browsers/chromium";
  if (existsSync(chromium.executablePath())) {
    return {};
  }
  return existsSync(bundled) ? { executablePath: bundled } : {};
}

const here = path.dirname(fileURLToPath(import.meta.url));
const page404 = path.resolve(here, "..", "..", "electron", "dist", "renderer", "ccx", "pages", "work", "index.html");

const browser = await chromium.launch(launchOptions());
const page = await browser.newPage();
const failures = [];
page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") {
    failures.push(`console.error: ${message.text()}`);
  }
});

// Stub the preload bridge before any script runs.
await page.addInitScript(() => {
  const listeners = { permission: [], turn: [] };
  window.__emit = (event) => listeners.turn.forEach((handler) => handler(event));
  window.__ask = (ask) => listeners.permission.forEach((handler) => handler(ask));
  window.__answers = [];
  window.__sent = [];
  window.ccx = {
    answerPermission: async (answer) => {
      window.__answers.push(answer);
      return true;
    },
    createSession: async (mode) => ({
      createdAt: new Date().toISOString(),
      id: "s2",
      mode,
      model: "claude-opus-5",
      title: "New session",
      updatedAt: new Date().toISOString()
    }),
    interrupt: async () => true,
    listSessions: async () => [
      {
        createdAt: new Date().toISOString(),
        id: "s1",
        mode: "code",
        model: "claude-opus-5",
        title: "Refactor auth",
        updatedAt: new Date().toISOString()
      }
    ],
    messages: async () => [],
    onPermissionAsk: (handler) => {
      listeners.permission.push(handler);
      return () => undefined;
    },
    onTurnEvent: (handler) => {
      listeners.turn.push(handler);
      return () => undefined;
    },
    startTurn: async (request) => {
      window.__sent.push(request);
      return { cancelled: false, iterations: 1, stopReason: "end_turn", toolCallCount: 0 };
    },
    viewConfig: async () => ({
      mode: "code",
      model: "claude-opus-5",
      retentionNotice: "Conversations are saved and may be reviewed by an administrator.",
      skills: [],
      userId: "ada"
    })
  };
});

await page.goto(`file://${page404}`);
await page.waitForSelector(".shell");

// The session list and the retention notice render.
assert.equal(await page.textContent(".session-title"), "Refactor auth");
assert.match(await page.textContent(".retention"), /reviewed by an administrator/);
assert.equal(await page.textContent(".badge.code"), "code");

// Sending a message reaches the bridge and shows the user's bubble.
await page.fill(".composer textarea", "read a.ts");
await page.click(".composer button.primary");
await page.waitForSelector(".bubble.user");
assert.equal(await page.textContent(".bubble.user"), "read a.ts");
assert.deepEqual(await page.evaluate(() => window.__sent), [{ sessionId: "s1", text: "read a.ts" }]);

// While busy, the composer offers Stop rather than Send.
await page.waitForSelector(".composer button.stop");

// Streaming deltas land in one assistant bubble.
await page.evaluate(() => {
  window.__emit({ requestId: "r", sessionId: "s1", turnId: "t", type: "turn-start" });
  window.__emit({ sessionId: "s1", text: "Check", type: "text" });
  window.__emit({ sessionId: "s1", text: "ing it.", type: "text" });
});
await page.waitForFunction(() => document.querySelector(".bubble.assistant .text")?.textContent === "Checking it.");

// A tool call renders a card that closes.
await page.evaluate(() => {
  window.__emit({ callId: "c1", input: {}, name: "read_file", sessionId: "s1", type: "tool-start" });
});
await page.waitForSelector(".tool.running");
await page.evaluate(() => {
  window.__emit({ callId: "c1", isError: false, sessionId: "s1", summary: "120 bytes", type: "tool-end" });
});
await page.waitForSelector(".tool.done");
assert.match(await page.textContent(".tool-summary"), /120 bytes/);

// A skill chip appears once loaded.
await page.evaluate(() => window.__emit({ name: "deploy", sessionId: "s1", type: "skill-loaded" }));
await page.waitForSelector(".chip");
assert.equal(await page.textContent(".chip"), "deploy");

// A permission prompt is modal, and the answer is relayed with the id.
await page.evaluate(() =>
  window.__ask({ detail: "Run: npm test", id: "p1", risk: "execute", sessionId: "s1", toolName: "bash" })
);
await page.waitForSelector(".modal");
assert.match(await page.textContent(".perm-detail"), /npm test/);
await page.check(".remember input");
await page.click(".modal-actions .primary");
await page.waitForSelector(".modal", { state: "detached" });
assert.deepEqual(await page.evaluate(() => window.__answers), [{ allow: true, id: "p1", remember: true }]);

// Ending the turn restores the composer.
await page.evaluate(() => window.__emit({ sessionId: "s1", status: "ok", type: "turn-end" }));
await page.waitForSelector(".composer button.primary");

// Events for another session must not appear.
await page.evaluate(() => window.__emit({ sessionId: "other", text: "LEAKED", type: "text" }));
assert.ok(!(await page.textContent(".transcript")).includes("LEAKED"));

await browser.close();

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("Work/Code renderer smoke test passed.");

/**
 * Headless launch check for the Work/Code window.
 *
 * Enabled only by CCX_SMOKE=1, so the shipped app never carries it. It answers
 * the one question no Node or headless-Chromium test can: does the real
 * Electron window load our renderer, does the sandboxed preload expose the
 * bridge, and does an IPC round-trip reach the runtime and come back.
 *
 * Prints one machine-readable line per check and exits the app.
 */
import { app, type BrowserWindow } from "electron";

const probeTimeoutMs = 30_000;
const settleMs = 750;

type SmokeReport = {
  bridgeKeys: string[];
  hasBridge: boolean;
  pageErrors: string[];
  rootChildren: number;
  title: string;
  viewConfig: { blocked: string; mode: string; ok: true; user: string } | { error: string };
};

/** Runs inside the renderer. Must be self-contained: it is serialised. */
const probeSource = `(async () => {
  const errors = [];
  window.addEventListener("error", (event) => errors.push(String(event.message)));
  const bridge = window.ccx;
  let viewConfig = { error: "bridge missing" };
  if (bridge) {
    try {
      const config = await bridge.viewConfig();
      viewConfig = {
        blocked: config.blockedReason ?? "none",
        mode: String(config.mode),
        ok: true,
        user: config.userId ?? "unresolved"
      };
    } catch (error) {
      viewConfig = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  const root = document.getElementById("root");
  return {
    bridgeKeys: bridge ? Object.keys(bridge).sort() : [],
    hasBridge: Boolean(bridge),
    pageErrors: errors,
    rootChildren: root ? root.childElementCount : -1,
    title: document.title,
    viewConfig
  };
})()`;

export function runCcxSmoke(window: BrowserWindow): void {
  const failures: string[] = [];
  const note = (line: string) => console.log(`[ccx-smoke] ${line}`);

  const finish = (code: number) => {
    note(code === 0 ? "PASS" : "FAIL");
    app.exit(code);
  };

  const timer = setTimeout(() => {
    note("check timeout: window never finished loading");
    finish(1);
  }, probeTimeoutMs);
  timer.unref?.();

  window.webContents.on("did-fail-load", (_event, code, description, url) => {
    note(`check did-fail-load: ${code} ${description} ${url}`);
    clearTimeout(timer);
    finish(1);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    note(`check render-process-gone: ${details.reason}`);
    clearTimeout(timer);
    finish(1);
  });
  window.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) {
      note(`renderer console: ${message}`);
    }
  });

  window.webContents.once("did-finish-load", () => {
    clearTimeout(timer);
    note("check did-finish-load: ok");
    // React renders on a microtask after load; give it a beat before probing.
    setTimeout(() => {
      window.webContents
        .executeJavaScript(probeSource, true)
        .then((report: SmokeReport) => {
          note(`check title: ${report.title}`);
          note(`check bridge: ${report.hasBridge ? report.bridgeKeys.join(",") : "MISSING"}`);
          note(`check rootChildren: ${report.rootChildren}`);
          note(`check viewConfig: ${JSON.stringify(report.viewConfig)}`);
          note(`check pageErrors: ${report.pageErrors.length === 0 ? "none" : report.pageErrors.join(" | ")}`);

          if (!report.hasBridge) {
            failures.push("preload bridge not exposed");
          }
          if (report.rootChildren < 1) {
            failures.push("renderer root is empty");
          }
          if (report.pageErrors.length > 0) {
            failures.push("renderer raised page errors");
          }
          if (!("ok" in report.viewConfig)) {
            failures.push(`viewConfig IPC failed: ${report.viewConfig.error}`);
          }
          for (const failure of failures) {
            note(`failure: ${failure}`);
          }
          finish(failures.length === 0 ? 0 : 1);
        })
        .catch((error: unknown) => {
          note(`check probe: threw ${error instanceof Error ? error.message : String(error)}`);
          finish(1);
        });
    }, settleMs);
  });
}

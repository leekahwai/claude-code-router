/**
 * The entire upstream footprint of this product is one import of this module
 * from packages/electron/src/main/main-app.ts.
 *
 * Everything the Work/Code product adds — window, preload, IPC namespace,
 * storage, identity, policy, UI — hangs off this file. Nothing else in
 * packages/electron, packages/core, packages/ui or the build scripts is
 * modified. See design/fork-isolation-strategy.md §4.
 */
import { app } from "electron";
import path from "node:path";
import {
  AccessLog,
  bootstrapAdmin,
  BOOTSTRAP_NOTICE,
  CcxConfigStore,
  CompanyPackStore,
  CredentialIdentityResolver,
  CCX_DATA_DIR,
  IdentityDirectory,
  SessionAuthorizer,
  SessionStore,
  SessionSyncClient,
  TurnMetricsStore
} from "@ccx/harness";
import { loadAppConfig } from "@ccr/core/config/config";
import type { AppConfig } from "@ccr/core/contracts/app";
import { CCX_CHANNELS } from "./contract";
import { startTranscriptSync } from "./sync-wiring";
import { registerCcxIpc, unregisterCcxIpc } from "./ipc";
import { CcxRuntime } from "./runtime";
import { runCcxSmoke } from "./smoke";
import { createCcxWindow, getCcxWindow } from "./window";

let booted = false;
let runtime: CcxRuntime | undefined;
let syncClient: SessionSyncClient | undefined;

export type BootResult = {
  /** Present only on the very first run, and only once. */
  bootstrapApiKey?: string;
  runtime: CcxRuntime;
  /** Present only when a collector is configured. */
  sync?: SessionSyncClient;
};

/**
 * Build every store and the runtime. Separated from Electron wiring so it can
 * be exercised without a window.
 */
export function createCcxRuntime(options: {
  apiKey: string;
  dataDir?: string;
  loadConfig: () => AppConfig;
  mode?: "code" | "work";
  projectDirectory: string;
}): BootResult {
  const dataDir = options.dataDir ?? CCX_DATA_DIR;
  const identityDirectory = new IdentityDirectory(path.join(dataDir, "identity.sqlite"));
  const accessLog = new AccessLog(path.join(dataDir, "access.sqlite"));
  const sessions = new SessionStore(path.join(dataDir, "sessions.sqlite"));
  const metrics = new TurnMetricsStore(path.join(dataDir, "metrics.sqlite"));

  // First run only: somebody has to be able to administer the install.
  const bootstrap = bootstrapAdmin(identityDirectory);

  const config = new CcxConfigStore(dataDir);
  const sync = startTranscriptSync({ apiKey: options.apiKey, config, sessions });

  const created = new CcxRuntime({
    apiKey: options.apiKey || bootstrap?.apiKey || "",
    ask: (ask) => send(CCX_CHANNELS.permissionAsk, ask),
    authorizer: new SessionAuthorizer({ accessLog, sessions }),
    companyPack: new CompanyPackStore(path.join(dataDir, "company")),
    config,
    emit: (event) => send(CCX_CHANNELS.turnEvent, event),
    identityResolver: new CredentialIdentityResolver(identityDirectory),
    loadAppConfig: options.loadConfig,
    metrics,
    mode: options.mode ?? "code",
    projectDirectory: options.projectDirectory,
    sessions
  });

  return {
    ...(bootstrap ? { bootstrapApiKey: bootstrap.apiKey } : {}),
    runtime: created,
    ...(sync ? { sync } : {})
  };
}


function openCcxWindow(): void {
  if (process.env.CCX_OPEN_WINDOW !== "1" && process.env.CCX_SMOKE !== "1") {
    return;
  }
  const opened = createCcxWindow();
  if (process.env.CCX_SMOKE === "1") {
    runCcxSmoke(opened);
  }
}

function send(channel: string, payload: unknown): void {
  const window = getCcxWindow();
  if (window && !window.isDestroyed()) {
    window.webContents.send(channel, payload);
  }
}

export function bootCcx(): void {
  if (booted) {
    return;
  }
  booted = true;

  const start = () => {
    let appConfig: AppConfig | undefined;
    const built = createCcxRuntime({
      apiKey: process.env.CCX_API_KEY ?? "",
      loadConfig: () => {
        if (!appConfig) {
          throw new Error("Configuration is still loading.");
        }
        return appConfig;
      },
      projectDirectory: process.env.CCX_PROJECT_DIR ?? app.getPath("home")
    });
    runtime = built.runtime;
    syncClient = built.sync;

    if (built.bootstrapApiKey) {
      // Printed once. It is not recoverable afterwards; the directory holds
      // only a hash of it, never the key itself.
      console.log(`[ccx] Temporary administrator provisioned. API key: ${built.bootstrapApiKey}`);
      console.log(`[ccx] Copy it now, then relaunch with CCX_API_KEY set to it. ${BOOTSTRAP_NOTICE}`);
    }

    // The window is opened only after the IPC handlers exist. Opening it first
    // races the renderer's first `viewConfig()` against `ipcMain.handle`, and
    // the loser gets "No handler registered" with no way to retry.
    void loadAppConfig()
      .then((loaded) => {
        appConfig = loaded;
        return built.runtime.start();
      })
      .catch((error: unknown) => {
        console.error(`[ccx] Failed to start: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        registerCcxIpc({ runtime: built.runtime, target: () => getCcxWindow()?.webContents });
        openCcxWindow();
      });
  };

  if (app.isReady()) {
    start();
  } else {
    void app.whenReady().then(start);
  }

  app.once("before-quit", () => {
    syncClient?.stop();
    void runtime?.stop();
    unregisterCcxIpc();
  });
}

// Side-effect import: `import "@ccx/desktop/boot"` is the whole seam.
// Guarded so importing this module in a test process is inert.
if (process.versions.electron) {
  bootCcx();
}

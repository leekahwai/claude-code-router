/**
 * The entire upstream footprint of this product is one import of this module
 * from packages/electron/src/main/main-app.ts.
 *
 * Everything the Work/Code product adds — window, preload, IPC namespace,
 * storage, policy, UI — hangs off this file. Nothing else in packages/electron,
 * packages/core, packages/ui or the build scripts is modified.
 *
 * See design/fork-isolation-strategy.md §4.
 */
import { app } from "electron";
import { registerCcxIpc, unregisterCcxIpc } from "./ipc";

let booted = false;

export function bootCcx(): void {
  if (booted) {
    return;
  }
  booted = true;
  registerCcxIpc();
  app.once("before-quit", () => {
    unregisterCcxIpc();
  });
}

// Side-effect import: `import "@ccx/desktop/boot"` is the whole seam.
// Guarded so importing this module in a test process is inert.
if (process.versions.electron) {
  bootCcx();
}

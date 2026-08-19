/**
 * IPC for the Work/Code product.
 *
 * Registered here, never in packages/electron/src/main/ipc.ts — that file is
 * 1,547 lines and every edit to it is a future merge conflict. Our channels are
 * namespaced `ccx:` so they can never collide with upstream's `ccr:` channels.
 */
import { ipcMain } from "electron";

export const CCX_IPC_CHANNELS = {
  ping: "ccx:app:ping",
  listSkills: "ccx:skills:list",
  turnMetricsForUser: "ccx:metrics:turns-for-user"
} as const;

let registered = false;

export function registerCcxIpc(): void {
  if (registered) {
    return;
  }
  registered = true;

  ipcMain.handle(CCX_IPC_CHANNELS.ping, () => ({ ok: true, surface: "ccx-desktop" }));

  // H2/H3 attach the skill registry and metrics reader here. Kept deliberately
  // empty in H0 so the seam can be verified before there is anything behind it.
}

export function unregisterCcxIpc(): void {
  if (!registered) {
    return;
  }
  for (const channel of Object.values(CCX_IPC_CHANNELS)) {
    ipcMain.removeHandler(channel);
  }
  registered = false;
}

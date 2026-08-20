/**
 * IPC for the Work/Code product.
 *
 * Registered here, never in packages/electron/src/main/ipc.ts — that file is
 * 1,547 lines and every edit to it is a future merge conflict. Our channels are
 * namespaced `ccx:` so they can never collide with upstream's `ccr:` channels.
 *
 * Handlers are thin: every decision lives in CcxRuntime, which has no Electron
 * import and is therefore testable in plain Node.
 */
import { ipcMain, type WebContents } from "electron";
import { CCX_CHANNELS } from "./contract";
import type { CcxPermissionAnswer, CcxStartTurnRequest } from "./contract";
import type { CcxRuntime } from "./runtime";

export { CCX_CHANNELS };

let registered = false;

export type CcxIpcOptions = {
  runtime: CcxRuntime;
  /** Where events are delivered; absent once the window has gone. */
  target: () => WebContents | undefined;
};

export function registerCcxIpc(options?: CcxIpcOptions): void {
  if (registered) {
    return;
  }
  registered = true;

  ipcMain.handle(CCX_CHANNELS.ping, () => ({ ok: true, surface: "ccx-desktop" }));

  if (!options) {
    // H0 registered the seam before there was anything behind it; keep that
    // path working so the window can boot without a configured runtime.
    return;
  }

  const { runtime } = options;
  ipcMain.handle(CCX_CHANNELS.viewConfig, () => runtime.viewConfig());
  ipcMain.handle(CCX_CHANNELS.sessionList, () => runtime.listSessions());
  ipcMain.handle(CCX_CHANNELS.sessionCreate, (_event, mode: "code" | "work") => runtime.createSession(mode));
  ipcMain.handle(CCX_CHANNELS.sessionMessages, (_event, sessionId: string) => runtime.messages(sessionId));
  ipcMain.handle(CCX_CHANNELS.turnStart, (_event, request: CcxStartTurnRequest) =>
    runtime.service.startTurn(request)
  );
  ipcMain.handle(CCX_CHANNELS.turnInterrupt, (_event, sessionId: string) => runtime.service.interrupt(sessionId));
  ipcMain.handle(CCX_CHANNELS.permissionAnswer, (_event, answer: CcxPermissionAnswer) =>
    runtime.service.answerPermission(answer)
  );
}

export function unregisterCcxIpc(): void {
  if (!registered) {
    return;
  }
  for (const channel of Object.values(CCX_CHANNELS)) {
    ipcMain.removeHandler(channel);
  }
  registered = false;
}

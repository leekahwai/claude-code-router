/**
 * Preload for the Work/Code window only.
 *
 * Upstream's packages/electron/src/main/preload.ts is untouched: our window
 * gets this file instead, so the two bridges never interfere and the gateway
 * API key never needs to reach our renderer.
 */
import { contextBridge, ipcRenderer } from "electron";
import { CCX_IPC_CHANNELS } from "./ipc";

const bridge = {
  ping: () => ipcRenderer.invoke(CCX_IPC_CHANNELS.ping) as Promise<{ ok: boolean; surface: string }>
};

export type CcxBridge = typeof bridge;

contextBridge.exposeInMainWorld("ccx", bridge);

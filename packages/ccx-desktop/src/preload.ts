/**
 * Preload for the Work/Code window only.
 *
 * Upstream's packages/electron/src/main/preload.ts is untouched: our window
 * gets this file instead, so the two bridges never interfere.
 *
 * The bridge exposes exactly the contract and nothing else — no credentials,
 * no filesystem, no arbitrary ipcRenderer access.
 */
import { contextBridge, ipcRenderer } from "electron";
import { CCX_CHANNELS } from "./contract";
import type {
  CcxMessage,
  CcxPermissionAnswer,
  CcxPermissionAsk,
  CcxSessionSummary,
  CcxStartTurnRequest,
  CcxStartTurnResult,
  CcxTurnEvent,
  CcxViewConfig
} from "./contract";

const bridge = {
  answerPermission: (answer: CcxPermissionAnswer): Promise<boolean> =>
    ipcRenderer.invoke(CCX_CHANNELS.permissionAnswer, answer) as Promise<boolean>,

  createSession: (mode: "code" | "work"): Promise<CcxSessionSummary> =>
    ipcRenderer.invoke(CCX_CHANNELS.sessionCreate, mode) as Promise<CcxSessionSummary>,

  interrupt: (sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke(CCX_CHANNELS.turnInterrupt, sessionId) as Promise<boolean>,

  listSessions: (): Promise<CcxSessionSummary[]> =>
    ipcRenderer.invoke(CCX_CHANNELS.sessionList) as Promise<CcxSessionSummary[]>,

  messages: (sessionId: string): Promise<CcxMessage[]> =>
    ipcRenderer.invoke(CCX_CHANNELS.sessionMessages, sessionId) as Promise<CcxMessage[]>,

  onPermissionAsk: (handler: (ask: CcxPermissionAsk) => void): (() => void) => {
    const listener = (_event: unknown, ask: CcxPermissionAsk) => handler(ask);
    ipcRenderer.on(CCX_CHANNELS.permissionAsk, listener);
    return () => ipcRenderer.removeListener(CCX_CHANNELS.permissionAsk, listener);
  },

  onTurnEvent: (handler: (event: CcxTurnEvent) => void): (() => void) => {
    const listener = (_event: unknown, payload: CcxTurnEvent) => handler(payload);
    ipcRenderer.on(CCX_CHANNELS.turnEvent, listener);
    return () => ipcRenderer.removeListener(CCX_CHANNELS.turnEvent, listener);
  },

  startTurn: (request: CcxStartTurnRequest): Promise<CcxStartTurnResult> =>
    ipcRenderer.invoke(CCX_CHANNELS.turnStart, request) as Promise<CcxStartTurnResult>,

  viewConfig: (): Promise<CcxViewConfig> => ipcRenderer.invoke(CCX_CHANNELS.viewConfig) as Promise<CcxViewConfig>
};

export type CcxBridge = typeof bridge;

contextBridge.exposeInMainWorld("ccx", bridge);

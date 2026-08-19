/**
 * The Work/Code window.
 *
 * Deliberately our own BrowserWindow rather than a view inside CCR's home
 * window: adding a view there would touch App.tsx (3,483 lines), layout.tsx,
 * shared/types.ts and two i18n dictionaries — four high-traffic upstream files.
 * See design/fork-isolation-strategy.md §4.1.
 */
import { BrowserWindow } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";

const defaultHeight = 800;
const defaultWidth = 1240;
const minHeight = 520;
const minWidth = 760;

let window: BrowserWindow | undefined;

export function createCcxWindow(): BrowserWindow {
  if (window && !window.isDestroyed()) {
    window.show();
    window.focus();
    return window;
  }

  window = new BrowserWindow({
    height: defaultHeight,
    minHeight,
    minWidth,
    show: false,
    title: "Work / Code",
    width: defaultWidth,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "ccx-preload.js"),
      sandbox: true,
      webSecurity: true
    }
  });

  window.once("ready-to-show", () => {
    if (window && !window.isDestroyed()) {
      window.show();
    }
  });
  window.on("closed", () => {
    window = undefined;
  });

  void window.loadURL(ccxRendererUrl("pages/work/index.html"));
  return window;
}

export function getCcxWindow(): BrowserWindow | undefined {
  return window && !window.isDestroyed() ? window : undefined;
}

function ccxRendererUrl(relativeHtmlPath: string): string {
  return pathToFileURL(path.join(__dirname, "../renderer/ccx", relativeHtmlPath)).toString();
}

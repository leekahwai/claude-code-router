/**
 * Build the Work/Code renderer and the window's preload.
 *
 * Our own build script, so build/build.mjs and build/esbuild.config.mjs stay
 * untouched (design/fork-isolation-strategy.md §4, seams 3 and 4). Output lands
 * inside packages/electron/dist, which electron-builder already packages, so
 * electron-builder.json needs no change either.
 */
import esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = path.resolve(uiRoot, "..");
const electronDist = path.join(packagesRoot, "electron", "dist");
const rendererOut = path.join(electronDist, "renderer", "ccx", "pages", "work");
const mainOut = path.join(electronDist, "main");

const production = process.env.NODE_ENV !== "development";

// Resolve @ccx/* to source so the bundle is built from TypeScript directly,
// matching how the workspace resolves at typecheck time.
const ccxAlias = {
  name: "ccx-alias",
  setup(build) {
    build.onResolve({ filter: /^@ccx\/(desktop|harness|ui|vendor)(\/.*)?$/ }, (args) => {
      const [, name, subPath = ""] = /^@ccx\/(desktop|harness|ui|vendor)(\/.*)?$/.exec(args.path);
      const base = path.join(packagesRoot, `ccx-${name}`, "src");
      return { path: subPath ? `${path.join(base, subPath.slice(1))}.ts` : path.join(base, "index.ts") };
    });
  }
};

mkdirSync(rendererOut, { recursive: true });
mkdirSync(mainOut, { recursive: true });

await esbuild.build({
  bundle: true,
  entryPoints: [path.join(uiRoot, "src", "work", "main.tsx")],
  format: "iife",
  jsx: "automatic",
  minify: production,
  outfile: path.join(rendererOut, "main.js"),
  plugins: [ccxAlias],
  sourcemap: !production,
  target: "chrome120"
});

// The preload runs in a privileged context; electron stays external.
await esbuild.build({
  bundle: true,
  entryPoints: [path.join(packagesRoot, "ccx-desktop", "src", "preload.ts")],
  external: ["electron"],
  format: "cjs",
  minify: production,
  outfile: path.join(mainOut, "ccx-preload.js"),
  platform: "node",
  plugins: [ccxAlias],
  target: "node22"
});

copyFileSync(path.join(uiRoot, "src", "work", "index.html"), path.join(rendererOut, "index.html"));
copyFileSync(path.join(uiRoot, "src", "work", "styles.css"), path.join(rendererOut, "styles.css"));

console.log(`Built Work/Code renderer into ${path.relative(packagesRoot, rendererOut)}`);

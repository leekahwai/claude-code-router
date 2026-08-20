/**
 * Build the admin console into the collector's dist.
 *
 * Separate from tools/build.mjs because the two have different destinations and
 * different lifecycles: the Work/Code renderer ships inside the Electron app,
 * the console is served by the collector. Sharing one script would mean the
 * desktop build silently depended on the server package's layout.
 */
import esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = path.resolve(uiRoot, "..");
const out = path.join(packagesRoot, "ccx-collector", "dist", "console");
const production = process.env.NODE_ENV !== "development";

mkdirSync(out, { recursive: true });

// Browser platform with nothing shimmed: the console talks to the collector
// over HTTP and must not be able to reach a node builtin by accident. Its API
// types are declared locally rather than imported from @ccx/harness for the
// same reason.
await esbuild.build({
  bundle: true,
  entryPoints: [path.join(uiRoot, "src", "admin", "main.tsx")],
  format: "iife",
  jsx: "automatic",
  minify: production,
  outfile: path.join(out, "main.js"),
  sourcemap: !production,
  target: "chrome120"
});

copyFileSync(path.join(uiRoot, "src", "admin", "index.html"), path.join(out, "index.html"));
copyFileSync(path.join(uiRoot, "src", "admin", "styles.css"), path.join(out, "styles.css"));

console.log(`Built the admin console into ${path.relative(packagesRoot, out)}`);

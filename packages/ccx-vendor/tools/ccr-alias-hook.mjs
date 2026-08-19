/**
 * Test-time module resolution and TypeScript transform for @ccx packages.
 *
 * Two jobs:
 *   1. Resolve `@ccr/<package>/<path>` to upstream TypeScript source. The
 *      production build does this with the esbuild alias plugin in
 *      build/esbuild.config.mjs — which is upstream's file, so we do not touch
 *      it (design/fork-isolation-strategy.md §4, seam #3). This is the
 *      test-time equivalent, living entirely in our tree.
 *   2. Transform .ts with esbuild rather than Node's strip-only mode. Vendored
 *      upstream code uses TypeScript parameter properties, which strip-only
 *      rejects; rewriting it to suit the test runner would defeat the point of
 *      vendoring verbatim. esbuild is what the real build uses anyway.
 *
 * Usage: node --import ../ccx-vendor/tools/ccr-alias-hook.mjs --test test/
 */
import { transformSync } from "esbuild";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packagesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const aliasPattern = /^@ccr\/(cli|core|electron|ui)\/(.+)$/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const match = aliasPattern.exec(specifier);
    if (match) {
      const [, packageName, subPath] = match;
      return {
        shortCircuit: true,
        url: pathToFileURL(path.join(packagesRoot, packageName, "src", `${subPath}.ts`)).href
      };
    }

    // Extensionless relative imports are this repository's house style; the
    // esbuild build resolves them. Do the same here rather than adding
    // allowImportingTsExtensions to the shared tsconfig.
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      const parentPath = context.parentURL ? fileURLToPath(context.parentURL) : undefined;
      if (parentPath && !path.extname(specifier)) {
        const base = path.resolve(path.dirname(parentPath), specifier);
        for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
          if (existsSync(candidate)) {
            return { shortCircuit: true, url: pathToFileURL(candidate).href };
          }
        }
      }
    }

    return nextResolve(specifier, context);
  },

  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !/\.tsx?$/.test(url)) {
      return nextLoad(url, context);
    }
    const loaded = nextLoad(url, { ...context, format: "module" });
    const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
    const transformed = transformSync(source, {
      format: "esm",
      loader: url.endsWith(".tsx") ? "tsx" : "ts",
      sourcefile: fileURLToPath(url),
      target: "node22"
    });
    return { format: "module", shortCircuit: true, source: `${cjsGlobalsShim(source)}${transformed.code}` };
  }
});

/**
 * Upstream is bundled to CommonJS for the Electron main process, so parts of it
 * use `__filename` / `__dirname` (for example core/storage/sqlite-native.ts
 * resolving the better-sqlite3 native binding). Loading that source as ESM
 * leaves those undefined. Reconstruct them per module rather than editing
 * upstream to suit our test runner.
 */
function cjsGlobalsShim(source) {
  if (!/\b__(?:filename|dirname)\b/.test(source)) {
    return "";
  }
  if (/\b(?:const|let|var)\s+__(?:filename|dirname)\b/.test(source)) {
    return "";
  }
  return [
    'import{fileURLToPath as __ccxToPath}from"node:url";',
    'import{dirname as __ccxDirname}from"node:path";',
    "const __filename=__ccxToPath(import.meta.url);",
    "const __dirname=__ccxDirname(__filename);"
  ].join("");
}

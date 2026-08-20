/**
 * Build the desktop app including the Work/Code surface.
 *
 * Order matters and is easy to get wrong: upstream's `build:assets` clears
 * packages/electron/dist/renderer, which is where the Work/Code renderer
 * lands. Running `build:assets` on its own therefore leaves the window
 * pointing at a deleted index.html (ERR_FILE_NOT_FOUND). This script owns the
 * ordering so nobody has to remember it, and so we never have to edit
 * upstream's build/build.mjs to teach it about us.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const steps = [
  { args: ["run", "build:assets"], label: "upstream assets" },
  { args: ["run", "-w", "@ccx/ui", "build"], label: "Work/Code renderer" }
];

for (const step of steps) {
  process.stdout.write(`[ccx-build] ${step.label}\n`);
  const result = spawnSync("npm", step.args, { cwd: repoRoot, stdio: "inherit" });
  if (result.status !== 0) {
    process.stderr.write(`[ccx-build] failed: ${step.label}\n`);
    process.exit(result.status ?? 1);
  }
}

process.stdout.write("[ccx-build] ok\n");

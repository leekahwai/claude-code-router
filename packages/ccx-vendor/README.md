# @ccx/vendor

Verbatim copies of upstream CCR logic, with provenance and automated drift
detection, plus the tooling that keeps this fork upgradable.

Read `design/fork-isolation-strategy.md` first. The short version: we build the
Work/Code product in `packages/ccx-*` and touch **one line** of upstream source.

## What is vendored, and why

| File | From | Why not just import it? |
|---|---|---|
| `src/core/mcp/mcp-client.ts` | `packages/core/src/mcp/toolhub-mcp.ts` | The transports are private to ToolHub. Extracting them would edit a 2,936-line upstream file with a live consumer, conflicting on every upstream ToolHub change. |
| `src/core/agents/skill-roots.ts` | `packages/core/src/agents/codex/cli-middleware-runtime.ts` | The per-harness skill roots live in a 7,210-line file — the largest in the repository. |

Types are **imported**, not copied: `import type { GatewayMcpServerConfig } from
"@ccr/core/contracts/app"` costs nothing at runtime and gives us a compile error
when upstream changes the shape, which is exactly the signal we want.

## Commands

```bash
npm run -w @ccx/vendor check       # has upstream moved under our copies?
npm run -w @ccx/vendor sync        # refill generated vendored blocks from upstream
npm run -w @ccx/vendor baseline    # re-record hashes after a conscious re-vendor
npm run -w @ccx/vendor footprint   # enforce the upstream line budget
npm run -w @ccx/vendor test
```

`check` and `footprint` both run in CI (`.github/workflows/ccx-guardrails.yml`).

## Adding a vendored region

1. Add a region to `vendor.manifest.json`, anchored by regex on its first and
   last lines — not by line number, so it survives upstream moving code around.
2. For a generated artifact, add `// >>> vendored: <id>` / `// <<< vendored: <id>`
   markers to the output file and run `sync`.
3. Run `baseline` to record the hash.
4. Keep the provenance header honest: what changed, and why it was copied.

**Never edit upstream to make vendoring easier.** If a region is awkward to
extract, copy more of it. Copying too much costs disk; editing upstream costs
every future merge.

## Upgrade runbook

```bash
git fetch upstream
git merge upstream/<tag>                     # should be boring by construction
npm run -w @ccx/vendor check                 # which regions moved?
#   → review each; re-vendor with `sync` + `baseline`, or consciously accept
npm run -w @ccx/harness test                 # contract tests: surfaces we import
npm run -w @ccx/vendor test
npm run typecheck
npm run -w @ccx/vendor footprint
```

A drifted region is not a failure. It is a decision, surfaced while it is still
cheap to make.

## Why the test hook exists

`tools/ccr-alias-hook.mjs` lets tests run directly against TypeScript source:

- resolves `@ccr/*` the way `build/esbuild.config.mjs` does — that file is
  upstream's, so we do not add our scope to its alias regex;
- transforms `.ts` with esbuild rather than Node's strip-only mode, because
  vendored upstream code uses parameter properties that strip-only rejects, and
  rewriting vendored code to suit a test runner would defeat the point;
- reconstructs `__filename` / `__dirname`, which upstream relies on because it
  is bundled to CommonJS for the Electron main process.

All three adaptations live here rather than in upstream files.

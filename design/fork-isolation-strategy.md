# Fork Isolation Strategy

How to build the Work/Code product inside this repository while keeping upstream CCR upgradable.
Read before H0. Baseline: `main` @ `fcf3d85` (v3.0.21).

---

## 0. The thing that is actually missing today

```
$ git remote -v
origin  https://github.com/leekahwai/claude-code-router (fetch)
origin  https://github.com/leekahwai/claude-code-router (push)
```

**There is no `upstream` remote.** Right now this fork has no mechanical relationship to
`musistudio/claude-code-router` at all — you cannot fetch it, diff against it, or measure drift.
Every upgrade strategy below is unmeasurable until this exists.

```
git remote add upstream https://github.com/musistudio/claude-code-router.git
git fetch upstream
git tag vendor-baseline fcf3d85      # the commit every vendored copy is taken from
```

Do this before writing a line of H0.

---

## 1. I am reversing one earlier recommendation

The harness spec said: *"extract the MCP client out of `toolhub-mcp.ts` into a shared module."*
Under your constraint that is the wrong call, and I'd now say the opposite.

**Copy it. Do not extract it.**

Extraction edits a 2,936-line upstream file that has a live consumer, which guarantees a merge
conflict every time upstream touches ToolHub — and ToolHub is actively developed. A vendored copy
leaves `toolhub-mcp.ts` byte-identical forever.

The cost is real and worth naming: upstream fixes to those transports will not reach you. That is
acceptable here because MCP is a stable wire protocol and the code is roughly 700 lines you can
own outright. It would not be acceptable for, say, provider authentication.

Same reasoning, same answer for skill discovery: copy the twelve-line root table out of
`cli-middleware-runtime.ts` rather than refactoring it. That file is 7,210 lines — the largest in
the repository — and refactoring it would be the single most conflict-prone thing you could do.

---

## 2. The rule

Every upstream interaction falls into exactly one of three categories.

| | Meaning | Use for | Upgrade cost |
|---|---|---|---|
| **Vendor** | Copy into our tree with a provenance header | Pure logic with no shared state — MCP transports, skill roots, SSE parsing | Re-vendor when upstream drifts; detected automatically (§5) |
| **Consume** | `import` from `@ccr/*` | Small, stable public surfaces — types, `loadAppConfig`, constants, the gateway HTTP endpoint | Re-verify each upgrade; guarded by contract tests (§7) |
| **Never touch** | Everything else | — | — |

Four hard prohibitions, which are what actually keep the merge clean:

1. **Never `ALTER` an upstream table.** Write to your own database, join on `request_id`.
2. **Never edit an upstream file over 500 lines.** The big files are the ones upstream keeps changing.
3. **Never change a function upstream calls.** Add alongside; never modify in place.
4. **Never add fields to `AppConfig`.** Keep your configuration in your own store.

Prefer *consume* over *vendor* for types — importing a TypeScript type costs nothing at runtime and
gives you a compile error when upstream changes it, which is exactly the signal you want.

---

## 3. Package layout

New workspace packages under `packages/`. The root manifest already globs `"packages/*"`, so
**adding packages requires no edit to `package.json`.**

```
packages/
  acme-harness/     session store · turn loop · context assembler · skills · tools
  acme-desktop/     electron main: own window, own preload, own IPC namespace
  acme-ui/          renderer: Work · Code · Configuration · Admin console
  acme-vendor/      verbatim copies from CCR, with provenance headers
```

**Do not use the `@ccr/` scope.** Both `build/esbuild.config.mjs:548` and `build/test.mjs:173`
resolve imports with a hardcoded regex:

```js
/^@ccr\/(cli|core|electron|ui)\//
```

Adding a fifth name means editing that regex in two build files — small edits, but on high-traffic
lines. Use a different scope (`@acme/*`) and the alias plugin never sees your imports; they fall
through to ordinary node_modules resolution via the workspace symlink.

Point each package's `exports` at its TypeScript source:

```json
{ "name": "@acme/harness", "exports": { ".": "./src/index.ts", "./*": "./src/*.ts" } }
```

esbuild bundles TS from a workspace package without complaint, and the root `tsconfig.json`
already includes `packages/*/src/**/*.ts`. **Net build-config changes: zero.**

---

## 4. Seam inventory

Every capability the product needs, the naive implementation, and the isolated one.

| # | Need | Naive — touches upstream | Isolated | Upstream lines |
|---|---|---|---|---|
| 1 | New packages | root `package.json` | `packages/*` glob already covers it | **0** |
| 2 | Import aliases | `tsconfig.json` paths | package `exports` → `src` | **0** |
| 3 | Bundler resolution | two regexes in `esbuild.config.mjs`, `test.mjs` | don't use the `@ccr/` scope | **0** |
| 4 | Build our bundles | edit `build/build.mjs` | own `build/acme.mjs`, output into `packages/electron/dist` | **0** (+1 npm script) |
| 5 | App entry point | `windows.ts` + `App.tsx` + `layout.tsx` + `types.ts` + i18n | our own `BrowserWindow` in our package | **1** |
| 6 | IPC handlers | `ipc.ts` (1,547 lines) | `ipcMain.handle("acme:*")` in our module | **0** (via #5) |
| 7 | Renderer bridge | `preload.ts` | our window, our preload | **0** |
| 8 | Company policy in Work/Code | `claude-code-router-plugin.ts` | compose it in our harness — we own the client | **0** |
| 9 | Policy for other clients (Claude Code CLI) | core enricher | router rule rewrite or route script — pure config | **0** |
| 10 | Per-user + pre/post token metrics | `ALTER` `usage_events` / `request_logs` | our own SQLite, joined on `request_id` | **0** |
| 11 | Dashboard + admin console | `dashboard.tsx` (5,281 lines) | our own pages in `acme-ui` | **0** |
| 12 | MCP client | extract from `toolhub-mcp.ts` | vendored copy | **0** |
| 13 | Skill roots | refactor `cli-middleware-runtime.ts` | vendored 12-line table | **0** |
| 14 | Transcript sync | modify `raw-trace-sync.ts` | vendored pattern on a plugin-registered gateway route | **0** |
| 15 | Provider / model config | `providers.tsx` | read `AppConfig`; our page only selects | **0** |
| 16 | Our own configuration | add to `AppConfig` in `contracts/app.ts` | our own config store | **0** |
| 17 | Packaging | `electron-builder.json` | our output already lands in `packages/electron/dist` | **0** |

**Residual upstream surface: one line, plus one npm script.**

The one line goes in `packages/electron/src/main/main-app.ts`, immediately beside the existing
`import "./ipc";` at line 8:

```ts
import "./ipc";
import "@acme/desktop/boot";     // ← the entire upstream footprint
```

Everything else — window, preload, IPC namespace, storage, UI, policy — lives behind it.

### 4.1 Make your window the product

Two ways to open Work/Code:

- **Add a view to CCR's main window.** Touches `App.tsx` (3,483 lines), `layout.tsx`,
  `shared/types.ts` and two i18n dictionaries. Four high-traffic upstream files, conflicting on
  every upstream UI change. Don't.
- **Your own window, opened by your boot module.** CCR's home window becomes the settings and
  diagnostics surface, reachable from yours. Zero additional upstream lines.

The second also matches what you're actually building: a company product with a routing engine
inside it, not a router with a chat tab bolted on.

### 4.2 Metrics without schema changes

You need `user`, `estimated_input_tokens` and `policy_tokens` per request. Adding columns to
`usage_events` and `request_logs` means owning two upstream migration paths forever.

Instead: your harness already knows the `request_id` it set as `x-client-request-id`. Write your
own row keyed by it.

```
acme_turn_metrics   request_id (PK) · user_id · mode · session_id · turn_id
                    estimated_input_tokens · policy_tokens · policy_version
                    skills_loaded · mcp_calls · created_at
```

Read-time join against `usage_events.request_id` gives you the full picture, upstream stays
untouched, and if you ever drop the fork the table is still yours.

---

## 5. Vendoring discipline

A copy without provenance is technical debt. A copy with provenance is a managed dependency. The
difference is entirely mechanical.

**Mirror upstream paths** so the origin of every file is obvious:

```
packages/acme-vendor/src/core/mcp/toolhub-mcp-client.ts   ← packages/core/src/mcp/toolhub-mcp.ts
packages/acme-vendor/src/core/agents/skill-roots.ts       ← packages/core/src/agents/codex/cli-middleware-runtime.ts
```

**Every vendored file opens with a provenance header:**

```ts
/**
 * @vendored-from packages/core/src/mcp/toolhub-mcp.ts
 * @vendored-lines 927-1310
 * @vendored-at   fcf3d85
 * @vendored-on   2026-08-19
 * @vendored-sha  b3f1c0a9e2d4...        // sha256 of the source region at that commit
 * @modifications Removed ToolHub-specific scope keys; exported the three transports.
 * @owner         platform-team
 */
```

**A check that fails when upstream moves.** This is the mechanism that turns "we know what to
update" from an aspiration into a fact:

```
npm run vendor:check
  → for each @vendored-from header:
      read the region from `git show <upstream-ref>:<path>`
      hash it, compare to @vendored-sha
      report DRIFTED / CLEAN
  → exit non-zero on drift
```

Wire it into CI. A drifted vendor file is not a failure — it is a decision to make, surfaced at the
moment it becomes cheap to make.

**Never edit upstream files to make vendoring easier.** If a region is awkward to extract, copy
more of it. Copying too much costs disk; editing upstream costs every future merge.

---

## 6. Upgrade runbook

```
1  git fetch upstream
2  git merge upstream/<tag>            # expect zero or near-zero conflicts by construction
3  npm run vendor:check                # which vendored regions moved?
4  re-vendor or consciously accept each drift; bump the headers
5  npm run test:contracts              # our assumptions about their surfaces (§7)
6  npm test                            # upstream's own suite, unmodified
7  npm run build:assets && smoke-test the app
```

Steps 3 and 5 are the ones that matter. Step 2 being boring is the point of everything above.

---

## 7. Contract tests

Vendoring protects you from merge conflicts. It does **not** protect you from behavioural drift in
the surfaces you *consume* — those break silently, at runtime, in production. A small suite closes
that gap:

- `AppConfig` still carries every field we read (`Providers`, `profile.profiles`, `agent.mcpServers`,
  `PORT`, `APIKEYS`).
- The gateway still authenticates a per-profile API key.
- A streaming request still returns SSE in the frame shape our parser expects.
- `x-client-request-id` still arrives as `usage_events.request_id` — this is our entire join key.
- `hasAvailableGatewayModels` still gates as expected.
- The plugin registration API still accepts our registration shape.

Six cheap tests. Each one turns a silent production breakage into a red build during the upgrade.

---

## 8. What this costs — stated plainly

This is not free, and pretending otherwise would set the wrong expectation.

- **Vendored code stops receiving upstream fixes.** Budget a re-vendor review in every upgrade.
- **Two MCP clients now live in one repository.** Without the provenance header a future reader
  will assume one is dead code and delete it.
- **Not touching `dashboard.tsx` means building a second dashboard.** That is genuinely more work
  up front — and it is yours, and it never conflicts.
- **Two configuration stores** means the configuration page has to make clear which setting lives
  where, or users will not find things.
- **Your own window means re-implementing shell chrome** — window state, theme, updates — that CCR's
  main window already handles.

Every one of those is a fixed, known cost paid once. Merge conflicts in a 5,000-line UI file are a
variable, unknown cost paid forever. The trade is worth it, but make it deliberately.

---

## 9. Revised H0

H0 was "session store schema plus extract the MCP client". Under this strategy it becomes:

| Step | Deliverable |
|---|---|
| 0.1 | `upstream` remote, `vendor-baseline` tag, documented merge policy |
| 0.2 | Four workspace packages, non-`@ccr` scope, `exports` → source, zero build edits |
| 0.3 | The one-line seam in `main-app.ts`; our window, preload and IPC namespace booting empty |
| 0.4 | Vendor tooling: header convention, `vendor:check`, wired into CI |
| 0.5 | First vendored files — MCP transports and skill roots — with provenance |
| 0.6 | Contract test suite (§7) green against the current baseline |
| 0.7 | `acme_turn_metrics` schema and the `request_id` join, proven end to end |

Roughly **2 to 2.5 weeks** — up from 1 to 1.5, and it buys down the largest long-term risk in the
programme. Everything after H0 then lands in your own packages by default rather than by discipline,
which is the only version of this that survives contact with a deadline.

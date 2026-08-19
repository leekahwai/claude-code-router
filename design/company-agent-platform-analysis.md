# Feasibility Analysis & Implementation Plan
## Company agent platform on top of Claude Code Router (CCR)

Date: 2026-08-19 · Baseline: `main` @ `fcf3d85` (v3.0.21)

---

## 0. Verdict up front

| # | Requirement | Verdict | Effort | Notes |
|---|---|---|---|---|
| 1 | "Work" + "Code" interface routing to the respective harness | **Possible, but this is the only genuinely large build** | L–XL | CCR is a *gateway/control plane*, not an agent harness. It has never run an agent loop. |
| 2 | Electron app; user keys in API key + provider; blocked without one | **Already ~90% built** | XS | Electron shell, provider onboarding and the hard gate all exist today. |
| 3 | Intercept code prompt, append company 6-tier framework | **Possible today; one route needs zero code** | S–M | Three working injection points already exist in-repo, with a proven precedent. |
| 4 | Token/model stats before *and* after the provider → dashboard; username as UI input | **Possible; "after" is done, "before" and "user" are the gaps** | M | Post-provider metering + a rich dashboard already ship. Pre-provider count is *computed but discarded*. No user identity in the schema. |
| 5 | Guardrails / 6-tier prompt configured by an admin, not in code | **Possible** | S–M | Config is data in SQLite, admin-editable, with a plugin system. Caveat: there is **no role model** — see §5. |

Nothing in the proposal is blocked by the architecture. Requirements 2–5 are extensions of
mechanisms that already exist. Requirement 1 is a new product surface, and its cost swings by
an order of magnitude depending on one decision (§1.3) that has to be made before planning
sprints.

---

## 1. What CCR actually is (and is not)

### 1.1 Shape of the codebase

npm workspace monorepo, ~153k lines of TS/TSX across four packages:

| Package | Role | Size |
|---|---|---|
| `packages/core` | Gateway, router, providers, observability, usage, plugins, MCP, proxy | the bulk |
| `packages/ui` | React 18 control-plane renderer (`pages/home`, `pages/tray`, `pages/browser`) | ~30k |
| `packages/electron` | Electron main process, IPC, windows, tray, updater | ~12.5k |
| `packages/cli` | `ccr` CLI (`start` / `stop` / `ui` / `web`) | ~1k |

Data lives in SQLite under the runtime config/data dirs (`packages/core/src/config/constants.ts`):
`config.sqlite`, `usage.sqlite`, `request-logs.sqlite`, `context-archive.sqlite`.

### 1.2 The critical architectural fact

**CCR proxies HTTP. It does not run agents.**

The request path is:

```
agent client (Claude Code CLI, Codex, …)
  → local gateway HTTP server
  → GatewayRequestPipeline.proxyRequest()      packages/core/src/gateway/request/pipeline.ts:86
      · header normalisation / auth              (pipeline.ts:108-140)
      · protocol compat rewrites                 (pipeline.ts:135-199)
      · ClaudeCodeRouterPlugin.routeRequest()    (pipeline.ts:318) → model + rewrites
      · profile model allow-list enforcement     (pipeline.ts:359-372)
      · feature bridges (web search, codex, …)   (pipeline.ts:375-500)
      → upstream provider
      ← response (streamed or buffered)
      · usage capture                            (pipeline.ts:669 / 773 / 895)
      · request log write                        (pipeline.ts:233)
```

Every stage is a body/header mutation with a route-trace record. This is a *very* good place to
hang policy injection and metering (requirements 3 and 4). It is *not* a place from which you can
run a conversation — there is no session, no tool execution, no workspace.

### 1.3 What "harness" means here — the decision that sizes requirement 1

CCR currently reaches an agent in three different ways, and they are not interchangeable:

**(a) Spawn an external CLI/app.**
`openProfileFromCcr()` — `packages/core/src/profiles/launch-service.ts:121` — spawns the agent
binary with CCR-injected environment (base URL, generated API key, model aliases). The
`ProfileConfig.agent` field (`ProfileClientKind`) *is* the "which harness" discriminator today;
Claude Code env wiring lives in `packages/core/src/agents/claude-code/environment.ts`.
CCR owns the model routing, not the conversation.

**(b) Open a hosted web app in an Electron window, proxied through CCR.**
`openPluginAppWindow()` — `packages/electron/src/main/windows.ts:120` — this is how Claude Design
and Claude Ship work (`packages/electron/bundled-plugins/claude-design/index.cjs`, 16.7k lines of
route interception). The prompt is composed **server-side** by the hosted app.

**(c) Nothing embedded.** There is no in-process agent loop anywhere in the repo.

There is also an unused-looking session relay — `packages/core/src/gateway/remote-control-service.ts`
(`/__ccr/remote/sessions`, SSE event stream, inbound queue, presence, catch-up replay). It is an
in-memory transport a chat UI could ride on, but it is a pipe, not a harness.

> ⚠️ **Option (b) is a trap for requirement 3.** If the harness composes the system prompt on a
> server you don't control, your only interception point is the gateway — you can append to the
> outbound body, but you cannot reason about, replace, or template the harness's own prompt, and
> you cannot show the user what policy was applied. If the 6-tier framework must be *authored and
> owned* by you, pick (a) or an embedded harness.

---

## 2. Requirement 1 — Work / Code interface

### What already helps you

- **Adding a renderer page is routine.** `build/esbuild.config.mjs:60-65,327-362` — each page is an
  html + `main.tsx` + esbuild entry (`home`, `tray`, `browser` today).
- **Adding a view to the main window is a small, well-trodden change.** `ViewId` union at
  `packages/ui/src/pages/home/shared/types.ts:50`, sidebar groups at
  `packages/ui/src/pages/home/components/layout.tsx:32-40`.
- **Harness selection already exists as data.** Profiles carry agent kind, model, model aliases,
  env, config file paths, and a per-profile API key (`packages/core/src/profiles/api-key.ts:17`,
  `profile:<id>`).
- **Per-profile enforcement already exists at the gateway.** `profileForApiKey` +
  `isModelAllowedForProfile` (`pipeline.ts:355-372`) already 403 a request whose model isn't
  allowed for the calling profile. Same hook can enforce Work-vs-Code policy.

### What does not exist at all

- Any chat UI: no message list, no composer, no streaming renderer, no session persistence.
- Any agent loop, tool execution, permission prompting, or workspace management.
- Any concept of a "task" or "run" in the data model.

### Three implementable shapes

| Option | What you build | Effort | Prompt interception | Recommendation |
|---|---|---|---|---|
| **A. Launcher** | Two cards ("New Work" / "New Code") that pick a profile and call `openProfileFromCcr` | days | gateway-only | **Phase 1** — ship this first, it is nearly free and proves the routing model |
| **B. Embedded harness** | Agent loop in the Electron main process, own session store, stream to renderer over IPC; Work and Code = same loop, different tool policy + system prompt | weeks–months | full, in your own code | **Target state** — this is what actually satisfies 1+3+4 cleanly |
| **C. Hosted web app** | Plugin window like Claude Design | medium | weak / gateway-only | avoid for this requirement set |

**Recommendation: A now, B as the real build.** Option A is a genuine deliverable in a sprint and
de-risks the profile/routing plumbing; option B then reuses the same profile model, the same
gateway, and the same metering.

---

## 3. Requirement 2 — Electron app + provider/API-key entry + hard gate

**Already built. Estimate: XS (wiring the new views into the existing gate).**

- Electron app: `packages/electron`, packaged via `electron-builder.json` for macOS
  (arm64 + x64), Windows and Linux AppImage; auto-update via `electron-updater`.
- Provider + key entry: onboarding forces the provider step first
  (`packages/ui/src/pages/home/shared/options.ts:432,441`), and the providers view
  (`components/providers.tsx`, 4.6k lines) covers ~30 presets, credential pools, key rotation,
  connectivity probing, and OAuth-style account connectors.
- **The "cannot use it without a provider" gate is already enforced in three independent places:**
  - gateway refuses to start — `packages/core/src/gateway/application/gateway-service.ts:161`
  - launching any agent throws — `assertAvailableGatewayModels`,
    `packages/core/src/profiles/launch-service.ts:103,122`
  - profile apply refuses — `packages/core/src/profiles/service.ts:162`
  All three funnel through `hasAvailableGatewayModels` (`contracts/app.ts:1082`) and the shared
  message `NO_AVAILABLE_GATEWAY_MODELS_MESSAGE`.

**Work remaining:** call the same predicate from the new Work/Code views to disable the composer
and show the existing message. Trivial.

> ⚠️ **Security caveat worth raising before a company rollout.** Provider API keys are stored in
> plaintext in `config.sqlite` (`APP_CONFIG_DB_FILE`, `config/constants.ts:16`) — not in the OS
> keychain — and `ApiKeyConfig.key` is handed to the renderer. That is acceptable for a personal
> tool and is a review item for a fleet deployment. Mitigations: OS keychain via `safeStorage`,
> or don't distribute provider keys at all (see §6 "central vs local").

---

## 4. Requirement 3 — Intercept the prompt, append the 6-tier framework

**Possible today. There is already a working precedent in the repo, and one route needs no code at all.**

### 4.1 Three injection points, in order of preference

**(i) Agent request enricher — the precedent to copy.**
`ClaudeCodeRouterPlugin.routeRequest` runs an enricher pipeline on every routed request
(`packages/core/src/gateway/claude-code-router-plugin.ts:78-88`,
`packages/core/src/agents/request-enricher.ts`). CCR already ships exactly the feature you're
describing, for ToolHub:

- `injectClaudeCodeToolHubInstructions` — `claude-code-router-plugin.ts:756`
- `appendSystemInstruction` — `claude-code-router-plugin.ts:818` — handles `body.system` as a
  string *and* as a content-block array, creating it when absent
- `systemContainsInstruction` — line 835 — marker-based idempotency so retries and multi-turn
  history don't double-inject

A `company-policy` enricher modelled on this is a contained, low-risk change.

**(ii) Router rule rewrites — zero code, pure configuration.**
`packages/core/src/routing/rewrite.ts` compiles rewrite paths of the form `request.body.<path>`
(line 142) and applies `set | array-append | array-prepend | array-remove | array-replace`
(`applyBodyRewrite`, line 216). So an administrator can add a rule whose rewrite is
`request.body.system` / `array-prepend` / *(the 6-tier text)* entirely from the Routing view.
Header rewrites are protected (auth/`x-ccr-*` blocked, line 133) but body paths are open.

**(iii) Route scripts — dynamic policy.**
Sandboxed worker (`routing/route-script-worker.ts`) receiving `RouteScriptInput`
(`routing/route-script-context.ts:7`) — which already includes `summary.systemText`,
`summary.lastUserText`, `summary.toolNames`, `tokenCount`, `apiKeyId`, `profileId`, `sessionId` —
and returning `{ model, rewrites, fallback }` (`route-script-result.ts`, caps: 32 rewrites /
64 KB result). This is how you'd do *conditional* tiering (different tier by repo, by task type,
by user).

### 4.2 One mechanism to **not** build on

`VirtualModelProfileConfig.instructions.{prepend,append,replace}` exists in the contract
(`contracts/app.ts:983`) and is read into the UI draft
(`ui/pages/home/shared/virtual-models.ts:134-136`) — **but the UI never writes it back**
(no `append:` / `prepend:` / `replace:` in the draft→config direction). Saving a Fusion profile
from the UI therefore silently drops it. It also only applies to Fusion virtual-model matches, and
the actual application happens inside the third-party `@the-next-ai/ai-gateway` dependency. Fix the
round-trip first if you want it; don't make it the primary path.

### 4.3 Caveats to design around

- **Blast radius.** Gateway injection hits *every* client through CCR, not just your Work/Code UI.
  Scope it by API key / profile (`profileForApiKey`, `pipeline.ts:355`) or by an `x-ccr-client`
  header (`gateway/http/io.ts:10`).
- **Protocol shape differs.** Anthropic Messages uses `system`; OpenAI Chat uses
  `messages[0].role === "system"`; OpenAI Responses uses `instructions`. One rewrite path will not
  cover all three — the enricher must branch on `requestProtocolForPath`
  (`routing/protocol-endpoints.ts`). `adaptRouteRequestBody` normalises *model location*, not system.
- **Prompt caching cost.** Appending to `system` invalidates the client's cached prefix. Prefer a
  **stable prepend** (identical bytes every request) over per-request templating, or you pay
  cache-write on every turn. This is directly measurable once §5.1 lands.
- **Don't inject into user turns naively.** Claude Code resends full history each turn; appending
  to "the user prompt" without targeting only the final user message duplicates the policy N times
  and blows out context.
- **Idempotency is mandatory.** Use the marker pattern at `claude-code-router-plugin.ts:835`.

---

## 5. Requirement 4 — Token stats before & after the provider → dashboard, with username

### 5.1 What already exists (the "after provider" half is done)

**Two tables, both already populated on every request:**

`usage_events` — `packages/core/src/usage/store.ts:320`
```
created_at, request_id, client, method, path, model, logical_model, provider,
credential_id, status_code, duration_ms, input_tokens, output_tokens,
cache_read_tokens, cache_write_tokens, total_tokens, cost_usd, cost_source
```

`request_logs` — `packages/core/src/observability/request-log-store.ts:1333` — everything above
plus `reasoning_tokens`, `requested_model` / `resolved_model` / `response_model`, full request and
response bodies, `pricing_json`, and a linked route trace (`request_route_traces`,
`request_route_hops`) recording every mutation stage with timings.

**Capture points**, including the streaming path:
`pipeline.ts:669` (upstream failure), `:773` (non-streamed), `:895` (streamed — usage parsed from
the SSE tail via a body sampler). Usage is merged from **provider billing headers and the response
body**, each normalised under its own convention (`store.ts:220-236`,
`usage/normalization.ts`), with cost estimated from `models/pricing-service.ts`.

**A dashboard already ships.** `packages/ui/src/pages/home/components/dashboard.tsx` (5,281 lines):
drag-and-drop resizable widget grid, usage trend, token mix, model distribution, client/provider
analysis, activity heat-map, ranges today/24h/7d/30d, filters by provider/model/credential, plus a
separate agent-analysis view and a tray mini-dashboard.

### 5.2 The two real gaps

**Gap A — the pre-provider count is computed and then thrown away.**
`calculateTokenCount(body.messages, body.system, body.tools)` runs at
`claude-code-router-plugin.ts:90`, is attached to the route decision as `tokenCount`
(`ClaudeCodeRouteDecision.tokenCount`), is exposed to route scripts — and is then **never
persisted**. The pipeline consumes `routed.decision.{model,reason,source,fallback,diagnostics}`
and drops the count.

Persisting it is a small, contained change (the schema-migration helper already exists at
`request-log-store.ts:3596`), and it is the single highest-value metric in this whole proposal:

> **gateway-estimated input tokens** (before) vs **provider-billed input tokens** (after)
> = exactly what your 6-tier framework costs you, per request, per user, per model.

Note it is an *estimate*, not a tokenizer-exact count, and providers differ in what they count. Use
it for **delta and trend**, not for billing reconciliation — billing comes from the provider-side
number you already store.

**Gap B — there is no user identity anywhere in the data model.**
The schema has `client` (app name) and `credential_id` (which provider key was used), but no user.
Two options:

| Option | How | Schema change | Verdict |
|---|---|---|---|
| **B1** One CCR API key per user, `ApiKeyConfig.name` = username | already flows into `client` via `inferGatewayClient` (`gateway/http/io.ts:19`) | none | fastest, but conflates "which app" with "which person" and breaks the existing client analytics |
| **B2** Add a `user` column + `x-ccr-user` header set from the main-UI username input | new column on `usage_events` + `request_logs`, thread through `UsageEventInput` / `UsageCaptureInput`, add to `UsageStatsFilter` (`contracts/app.ts:2173`), add index | ~6 files | **recommended** — clean, and `UsageStatsFilter` already has the shape for it |

### 5.3 Caveats

- **`request_logs` is lossy by design.** `observability.requestLogSuccessSampleRate` samples
  successes (`pipeline.ts:246`) and `requestLogBodyCapture` can be `none`/`errors`.
  **`usage_events` is the reliable counter; `request_logs` is the forensic detail.** Build the
  dashboard's numbers on `usage_events`.
- **The data is per-machine SQLite.** A company-wide dashboard needs an export/aggregation path.
  Existing patterns to model on: `observability/raw-trace-sync.ts`, `usage/billing-sync.ts`, and the
  RPC surface in `web/management-server.ts` (which already serves the same UI over HTTP with a
  bearer token). Or run CCR centrally — see §6.
- Usage capture is fire-and-forget (`recordGatewayUsageCapture` swallows errors,
  `usage/store.ts:517`); metering will never break a request, and will occasionally miss one.

---

## 6. Requirement 5 — Admin-configured guardrails, not in code

**Possible, and most of the substrate is there.**

- **Config is data.** `config.sqlite` via `config/config.ts` + `config/config-repository.ts`,
  editable from the UI *and* from the web management server RPC (`web/management-server.ts`,
  bearer-token auth, host allow-listing).
- **Router rules + rewrites + route scripts are already admin-editable** from the Routing view,
  with validation and a test harness wired through IPC (`appValidateRouteScript`,
  `appTestRouteScript` — `contracts/ipc-channels.ts`). Route scripts have a 5 MiB source cap and
  run in a worker.
- **The plugin system is the cleanest home for a company guardrail pack.**
  `packages/core/src/plugins/service.ts` — plugins declare `surfaces` (`apps`, `gateway`,
  `provider`) and `permissions` (`trusted-code`, `apps`, `gateway-routes`, `proxy-routes`,
  `http-backends`, `sqlite-store`), can register gateway routes, HTTP backends, their own SQLite
  store, virtual-model profiles and core-gateway config. Working precedent:
  `packages/electron/bundled-plugins/claude-design/`. There is a marketplace loader
  (`plugins/marketplace.ts`) — i.e. a distribution channel for a signed company policy pack.

### ⚠️ The one thing that does not exist: a role model

**Every user of the desktop app is the administrator of their own config.** Nothing prevents a
user from deleting the rewrite that injects your framework, disabling the plugin, or pointing the
profile at a different provider. If "guardrail" means *advisory*, you're done. If it means
*non-bypassable*, you need one of:

1. **Remote policy fetch + local read-only enforcement** — CCR pulls a signed policy document on
   start and on an interval; the UI renders it read-only; tampering is detectable but not fully
   preventable on a machine the user controls.
2. **Run CCR centrally** — a `Dockerfile` and `docker-compose.yml` already exist; users get only a
   CCR API key and point their agents at the shared endpoint. This solves policy enforcement,
   per-user attribution (one key per user, requirement 4 B2 becomes trivial), central metering, and
   keeps provider keys off laptops entirely. **Trade-off:** you lose the local-app value
   proposition and the desktop UI becomes a thin client.
3. **Accept advisory guardrails** and detect drift from the metering data.

Your "currently can hard code" is fine as a starting point — but decide (1)/(2)/(3) before the
config schema is designed, because it changes where policy lives.

---

## 7. Implementation plan

### Phase 0 — Decisions (blocking; ~1 week of discussion, no code)

| Decision | Options | Why it blocks |
|---|---|---|
| **Harness for "Work"/"Code"** | launcher · embedded loop · hosted web app | order-of-magnitude effort swing (§1.3, §2) |
| **Central vs local CCR** | per-laptop desktop app · shared server + thin client | determines enforceability, attribution design, and key custody (§6) |
| **Guardrail strength** | advisory · signed remote policy · server-enforced | determines where the 6-tier config lives (§6) |
| **Username source** | typed in the UI · OS user · SSO/IdP | determines whether attribution is trustworthy (§5.2) |
| **6-tier framework content** | — | can be stubbed; needed before Phase 1 lands |

Recommended defaults if you want to start moving today: **launcher → embedded**, **local now with a
central export path**, **advisory guardrails with drift detection**, **username typed in the UI,
carried in a header**.

### Phase 1 — Company policy engine (requirements 3 + 5) · ~1–2 weeks

Delivers the 6-tier injection end to end, before any new UI exists.

1. Add `companyPolicy` to `AppConfig` (`contracts/app.ts:1752`): `{ enabled, version, tiers[],
   scope: { profileIds?, clients?, agents? }, mode: "prepend" | "append" }`.
2. New module `packages/core/src/gateway/features/company-policy.ts` — a protocol-aware injector
   modelled on `appendSystemInstruction` (`claude-code-router-plugin.ts:818`) with the marker
   idempotency of line 835. Branch on `requestProtocolForPath` for Anthropic `system` /
   OpenAI `messages[0]` / Responses `instructions`.
3. Register it as an `AgentRequestEnricher` in `ClaudeCodeRouterPlugin.routeRequest`
   (`claude-code-router-plugin.ts:78`), scoped by profile/client.
4. Emit a route-trace stage (`kind: "mutation"`, `phase: "enrichment"`) so injection is visible in
   the existing Logs view — this is your audit trail, free.
5. Set `x-ccr-company-policy: <version>` on the outbound request for correlation.
6. Admin surface: a Settings section (config-backed, hard-coded default text is fine for v1).
7. Tests: unit tests for each protocol shape + idempotency across multi-turn history; an
   integration test through the pipeline.

*Fallback if this slips:* the config-only rewrite route (§4.1 ii) delivers the same injection with
**zero code** and can ship on day one as a stopgap.

### Phase 2 — Attribution + pre/post metering (requirement 4, data layer) · ~1–2 weeks

1. **Pre-provider tokens:** thread `routed.decision.tokenCount` from `pipeline.ts:318` into
   `writeRequestLog` and `recordUsage`; add `estimated_input_tokens` to both tables via the
   existing migration helpers (`request-log-store.ts:3596`, `usage/store.ts:463-487`).
2. **Policy cost:** add `policy_tokens` (tokens the injector added) — cheap to compute at
   injection time, and the number your finance/platform owner will actually ask for.
3. **User identity:** `x-ccr-user` header → new `user` column on both tables → `UsageEventInput`,
   `UsageCaptureInput`, `UsageStatsFilter` (`contracts/app.ts:2173`) → index
   `usage_events(user, created_at)`.
4. Populate the header from the main-UI username input, persisted in config; also stamp it into
   the env of agents launched via `openProfileFromCcr`.
5. Extend `getUsageStats` grouping to include `user` and `estimated_input_tokens`.

**Verify with existing tooling:** `npm run test:core`, and the request-log benchmark
(`npm run benchmark:request-logs`) to confirm the extra columns don't regress write throughput.

### Phase 3 — Dashboard (requirement 4, presentation) · ~1–2 weeks

Extend rather than rebuild — `dashboard.tsx` already has the widget framework, chart library
(recharts), range selectors and filters.

1. New widgets: **Prompt inflation** (estimated vs billed input tokens), **Policy cost** (tokens and
   USD attributable to the 6-tier framework), **Per-user leaderboard**, **Per-user × model matrix**.
2. Add `user` to the existing filter row alongside provider/model/credential.
3. Company-wide aggregation: decide export (push to a central store, modelled on
   `usage/billing-sync.ts`) vs central CCR (§6 option 2). If central, the dashboard reads the same
   RPC through `web/management-server.ts` and needs no new transport.

### Phase 4 — Work / Code interface (requirement 1) · ~2 weeks (A) or 2–3 months (B)

**4a — Launcher (ship first).**
1. Add `"work"` and `"code"` to `ViewId` (`ui/pages/home/shared/types.ts:50`) and to the sidebar
   `workspace` group (`components/layout.tsx:36`).
2. Two entry cards; each resolves a profile by agent kind and calls the existing
   `appOpenProfile` IPC → `openProfileFromCcr` (`profiles/launch-service.ts:121`).
3. Gate both on `hasAvailableGatewayModels(config)` — requirement 2, done.
4. Stamp `x-ccr-user` and the Work/Code surface into the launched agent's env so Phase 2/3
   attribution works immediately.

**4b — Embedded harness (the real build).**
1. Session model + SQLite store (`sessions`, `messages`, `runs`) in `packages/core`.
2. Agent loop in the Electron main process; stream to the renderer over IPC (new channels in
   `contracts/ipc-channels.ts`), or over the existing SSE relay
   (`gateway/remote-control-service.ts`) if you want the same surface reachable from the web UI.
3. Chat UI: composer, message list, streaming, tool-call rendering, permission prompts,
   cancellation. **This is the bulk of the work and it is ordinary product engineering, not
   integration.**
4. Work vs Code = one loop, two policies: different tool sets, different working-directory rules,
   different 6-tier tier selection. Reuse `isModelAllowedForProfile` (`pipeline.ts:365`) for model
   scoping.
5. Prompts flow out through the same local gateway, so Phases 1–3 apply unchanged.

### Phase 5 — Hardening · ~1 week

- Move provider keys to OS keychain (`safeStorage`) or remove them from laptops entirely (§6).
- Signed/remote policy document if guardrails must be non-bypassable.
- Drift detection: alert when a user's config no longer carries the current policy version
  (the `x-ccr-company-policy` header from Phase 1 makes this a query).
- Retention/PII policy for `request_logs` — it captures full request and response bodies.

### Rough shape

| Phase | Scope | Estimate |
|---|---|---|
| 0 | Decisions | 1 week (no code) |
| 1 | Policy engine (req 3, 5) | 1–2 weeks |
| 2 | Metering + attribution (req 4 data) | 1–2 weeks |
| 3 | Dashboard (req 4 UI) | 1–2 weeks |
| 4a | Work/Code launcher (req 1, phase 1) | ~2 weeks |
| 4b | Embedded harness (req 1, target) | 2–3 months |
| 5 | Hardening | 1 week |

Requirements **2, 3, 4 and 5 are deliverable in roughly 6 weeks** on the existing architecture.
Requirement 1 is the long pole, and only if you choose the embedded harness.

---

## 8. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Requirement 1 scoped as "integration" when it is a product build | **High** | Phase 0 decision; ship 4a first |
| Provider keys plaintext on laptops | **High** for fleet | keychain, or central CCR |
| Guardrails bypassable — no role model exists | **High** if enforcement is required | central CCR, or signed policy + drift detection |
| Policy injection breaks prompt caching → cost *increase* | Medium | stable prepend, measure with Phase 2 prompt-inflation metric |
| Policy applied to unintended clients (blast radius) | Medium | scope by profile/API key from day one |
| Per-machine SQLite ≠ company-wide dashboard | Medium | export path (Phase 3) or central CCR |
| Protocol drift (Anthropic / OpenAI Chat / Responses system shapes) | Medium | protocol-aware injector + tests per shape |
| `request_logs` sampling misread as ground truth | Low | base metrics on `usage_events` |
| Building on `VirtualModelProfileConfig.instructions` (UI drops it on save) | Low | avoid, or fix the round-trip first |
| Upstream divergence from `musistudio/claude-code-router` | Medium | keep company code in a plugin + a thin set of core hooks, not a scattered fork |

---

## 9. Key file reference

| Concern | File |
|---|---|
| Request pipeline (all interception) | `packages/core/src/gateway/request/pipeline.ts` |
| Router + system-prompt injection precedent | `packages/core/src/gateway/claude-code-router-plugin.ts:756,818,835` |
| Config-only body rewrites | `packages/core/src/routing/rewrite.ts` |
| Route scripts (dynamic policy) | `packages/core/src/routing/route-script-*.ts` |
| Usage metering + schema | `packages/core/src/usage/store.ts:220,320` |
| Request logs + route traces | `packages/core/src/observability/request-log-store.ts:1333` |
| Config contract | `packages/core/src/contracts/app.ts:1752` |
| Agent launching | `packages/core/src/profiles/launch-service.ts:121` |
| Plugin system | `packages/core/src/plugins/service.ts` |
| Electron windows | `packages/electron/src/main/windows.ts:52,120` |
| IPC surface | `packages/core/src/contracts/ipc-channels.ts` |
| Existing dashboard | `packages/ui/src/pages/home/components/dashboard.tsx` |
| Nav / view registration | `packages/ui/src/pages/home/shared/types.ts:50`, `components/layout.tsx:32` |
| Provider gating | `packages/core/src/contracts/app.ts:1076-1084` |
| Web management RPC | `packages/core/src/web/management-server.ts` |

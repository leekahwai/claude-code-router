# Work / Code Harness — Build Specification

Follow-on to `company-agent-platform-analysis.md`. Baseline: `main` @ `fcf3d85` (v3.0.21).

You've chosen the embedded harness (option B). This document specifies it against the
codebase as it actually stands.

---

## 0. Two findings that change the estimate

**A complete MCP client already exists in the repo.**
`packages/core/src/mcp/toolhub-mcp.ts` contains three production transports —
`StdioMcpClient` (:1220), `HttpMcpClient` (:1122), `SseMcpClient` (:927) — all implementing
`McpClient { callTool(name, args), listTools(), close() }` (:100). A second, simpler discovery
client lives in `mcp/tool-discovery.ts` with stdio framing modes, Streamable HTTP and legacy SSE
fallback. **You do not write an MCP client. You extract one.**

MCP servers are already first-class configuration: `GatewayAgentConfig.mcpServers`
(`contracts/app.ts:919`), parsed and persisted (`config/config.ts:803,1020`), merged into the core
gateway (`core-runtime/config-compiler.ts:93`), listable over IPC (`appListMcpServerTools` →
`listMcpServerTools`), and editable in the UI with a JSON-paste importer
(`components/settings.tsx:571-674`).

**Per-harness skill discovery already exists.**
`renderAgentSkills(directory, agent)` — `agents/codex/cli-middleware-runtime.ts:2398` — already
encodes the exact root set per harness:

| Harness | Skill roots |
|---|---|
| `claude` | `<project>/.claude/skills`, `~/.claude/skills` |
| `codex` / `zcode` | `<project>/.agents/skills`, `<codexHome>/skills`, `~/.codex/skills` |
| `opencode` | `<project>/.opencode/skills`, `~/.config/opencode/skills` |

It only lists names for a chat command. But "detect skills for that particular harness" — the hard
part, knowing *where to look per harness* — is solved and needs extracting into a real service.

---

## 1. Three tensions in the spec worth settling now

### 1.1 "Work just routes to the vendor provider" vs "he can use skills and MCP"

These pull in opposite directions. A pure pass-through stream cannot call a tool. The moment
skills or MCP are in play, the shape is:

```
stream ─┬─► text deltas ──────────────► UI, token by token
        └─► tool_use block detected
              └─► pause stream
                  execute MCP tool / load skill
                  append tool_result to messages
                  re-request with stream: true
                  └─► resume streaming into the same turn
```

That is an agent loop, not a route. **Token-by-token rendering survives — "just routes" does not.**
Work and Code are therefore the *same* loop with different configuration, which is good news: one
engine, two policies.

### 1.2 Skills are a harness feature, not a provider feature

No provider knows what a skill is. If you own the harness, you implement the whole protocol:

1. Scan the roots for the selected harness (already known — §0).
2. Parse each `SKILL.md`'s YAML frontmatter for `name` and `description`.
3. Inject **only the descriptions** into the system prompt — a menu, not the contents.
4. When the model picks one, load the body and inject it into the conversation.

That third step is the whole trick: with fifty skills installed, eager loading would consume the
context window before the user typed anything.

> ⚠️ **Most real skills ship executable code and reference files.** A skill that says "run
> `scripts/convert.py`" is inert unless your harness has file and shell tools. So the Code tool
> surface must include read / write / glob / grep / bash — which brings a permission model, an
> approval UI, and a working-directory sandbox with it. Budget for that; it is not a footnote.

### 1.3 "Hidden" company context is hidden from the user, not from anyone else

The context pack will appear verbatim in `request_logs.request_body_text`, in the route trace, and
in whatever the provider retains. Hidden means *not rendered in the transcript*. Say that out loud
in the admin UI, and set the request-log retention policy accordingly.

---

## 2. Architecture

```
┌─ Electron renderer ─────────────────────────────────────────┐
│  Work view          Code view          Configuration view    │
│  ─ composer         ─ composer         ─ provider + model    │
│  ─ token stream     ─ token stream       per mode            │
│  ─ tool cards       ─ tool cards       ─ MCP servers         │
│  ─ skill chips      ─ skill chips      ─ skills detected     │
│                     ─ (context hidden) ─ company pack (admin)│
└───────────────────────────┬─────────────────────────────────┘
                            │ IPC: turn/start · turn/interrupt
                            │      stream/delta (main → renderer)
┌───────────────────────────▼─────────────────────────────────┐
│  Harness runtime — Electron main / core                      │
│   session store (SQLite)                                     │
│   turn loop:  compose → stream → tool_use? → execute → loop  │
│   context assembler:  base + skills menu + company pack      │
│   skill registry  ·  MCP registry  ·  tool executor          │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTP, stream: true, profile API key
┌───────────────────────────▼─────────────────────────────────┐
│  CCR gateway (existing, unchanged)                           │
│   routing · policy injection · metering · request logs       │
└───────────────────────────┬─────────────────────────────────┘
                            ▼  vendor provider
```

**The harness is a client of your own gateway.** That single decision gives you routing, failover,
credential pools, request logs, usage metering and the 6-tier policy injection for free — all of it
already built — and keeps the harness ignorant of providers.

### 2.1 Streaming path: use IPC, not fetch

The renderer loads from `file://` (`electron/src/main/windows.ts:281`, `pathToFileURL`). A direct
`fetch()` to `http://127.0.0.1:<port>` is a null-origin cross-origin request; the gateway does echo
`Access-Control-Allow-Origin` (`core-runtime/supervisor.ts:844`) but null-origin plus credentials is
a fragile foundation and puts the gateway API key in the renderer.

**Main process holds the connection and forwards chunks over IPC.** Keys stay in main, the SSE
parser is testable in Node, and cancellation is a real `AbortController`. For high-frequency deltas
use `MessageChannelMain` rather than `webContents.send` per token.

The gateway is already a true streaming passthrough — `pipeline.ts:790-900` pipes the upstream body
through a chain of Node transform streams to the client, with a body sampler tapping it for logging.
Nothing there needs to change.

### 2.2 Live token counting

Provider-reported usage arrives at the **end** of the stream (`message_delta` / final usage frame).
For a live counter, count deltas as they render and reconcile against the authoritative number when
the stream closes. Show the estimate as an estimate until it settles.

---

## 3. Component specifications

### 3.1 Session store

New SQLite database alongside the existing ones (`config/constants.ts`).

```
sessions  id · mode(work|code) · title · profile_id · model · provider
          workspace_dir · created_at · updated_at · policy_version
messages  id · session_id · seq · role · content_json · created_at
turns     id · session_id · request_id · status · started_at · ended_at
          input_tokens · output_tokens · estimated_input_tokens
          policy_tokens · cost_usd · error
tool_calls id · turn_id · source(mcp|skill|builtin) · server · name
          args_json · result_json · duration_ms · approved_by · status
```

`turns.request_id` is the join key back to `usage_events` and `request_logs` — set it as
`x-client-request-id` on the outbound call and the correlation is exact.

### 3.2 Context assembler

One function, one ordering, applied identically in both modes so behaviour is predictable:

| Layer | Work | Code | Source |
|---|---|---|---|
| 1 · Harness base | ✓ | ✓ | your own prompt |
| 2 · Company 6-tier policy | ✓ | ✓ | gateway injection (P1 of the earlier plan) |
| 3 · Company context pack | — | ✓ | admin config + reference manifest |
| 4 · Skills menu | ✓ | ✓ | skill registry, descriptions only |
| 5 · MCP tool definitions | ✓ | ✓ | MCP registry |
| 6 · Session / workspace context | — | ✓ | cwd, git branch, open files |

Layers 1–4 must be **byte-stable across a session** or you lose prompt caching on every turn. Put
everything volatile (timestamps, cwd state) in layer 6, last.

### 3.3 Skill registry

```
discover(harness, projectDir) → SkillRef[]
  roots per harness — extract from cli-middleware-runtime.ts:2398
  for each dir: read SKILL.md, parse frontmatter → { name, description, path, source }
  dedupe by name, project shadows user

menu(skills) → string          // names + descriptions only, for layer 4
load(name)   → string          // full SKILL.md body, on demand
```

Expose loading as a tool (`skill.load(name)`) rather than pre-injecting. Log every load into
`tool_calls` so the dashboard can answer "which skills are actually used".

**Cap the menu.** Fifty skills at ~40 tokens of description each is 2k tokens on every request.
Sort by relevance or let the user enable a subset per session.

### 3.4 MCP registry

**Vendor** the three transports out of `toolhub-mcp.ts` into `packages/acme-vendor/` with a
provenance header — do not extract them into a shared upstream module. Editing a 2,936-line file
with a live consumer guarantees a merge conflict on every upstream ToolHub change; a copy leaves it
byte-identical. See `fork-isolation-strategy.md` §1.

Then add:

- **Connection pooling with lifecycle** — stdio servers are child processes; one per session is
  wasteful, one global pool needs cancellation and restart-on-crash.
- **Namespacing** — `mcp__<server>__<tool>`, matching the convention the codebase already scores
  for in `claudeCodeToolHubNameScore` (`claude-code-router-plugin.ts:804`).
- **Per-mode server selection** — Work and Code should not necessarily see the same servers.
- **Timeouts and failure isolation** — one dead server must not fail the turn.

### 3.5 Company context pack (Code mode)

```
companyContext: {
  enabled: boolean
  version: string            // stamped on every request, joins to metering
  systemText: string         // admin-authored, hidden from the transcript
  references: [{ path, title, description, bytes, sha256 }]
  injection: "manifest" | "inline"
}
```

**Use `manifest`, not `inline`.** Inline pastes every reference file into the system prompt on every
request — it destroys the context budget and pays cache-write on each new session. Manifest injects
only titles and descriptions and exposes `company_reference.read(path)` as a tool, so the model
pulls the two files it needs out of the forty you published. Same progressive-disclosure pattern as
skills, for the same reason.

Files live in a managed directory under the config dir. The admin page is an editor for
`systemText` plus an add / remove / describe list for reference files. Hash each file so the
dashboard can attribute cost and so drift is detectable.

Enforcement is the open question from the previous analysis: on a local install the user can edit
this config. If the pack must be authoritative, it has to come from a signed remote document or a
central CCR — decide before the schema is fixed.

### 3.6 Configuration page

Most of this exists. The genuinely new part is a **per-mode binding**:

```
Work  → provider · model · MCP servers · skills enabled
Code  → provider · model · MCP servers · skills enabled · company pack
```

**Bind each mode to its own CCR profile** (`ProfileConfig`) rather than inventing a parallel
concept. You inherit: a generated per-profile API key (`profiles/api-key.ts:17`), model allow-list
enforcement already running in the gateway (`pipeline.ts:359-372`), and — because the profile id
reaches the metering layer — per-mode cost attribution in the dashboard **for free**.

Reuse the existing providers view for credentials; the configuration page only picks from what is
already configured, and gates on `hasAvailableGatewayModels` so the composer is disabled when no
provider exists.

### 3.7 Tool execution and permissions

Tool sources: `builtin` (file, shell, workspace), `mcp`, `skill`.

Code mode needs the builtin file and shell tools for skills to function at all (§1.2), which means:

- a per-session workspace root, with path traversal refused outside it;
- an approval model — auto-allow reads, prompt on writes and shell, remember per session;
- an approval UI in the transcript;
- audit rows in `tool_calls` including who approved what.

Work mode should default to **no shell, no writes** — MCP and reads only. That is the actual safety
difference between the two modes, and it is more meaningful than the prompt difference.

---

## 4. Admin retrieval of user history

This requirement changes the shape of the system more than anything else in the spec. Everything
above works on a laptop. **An administrator cannot read what never leaves the laptop.**

### 4.1 A third thing that already exists

The transcript-shipping problem is already solved in this repo, twice.

**`observability/raw-trace-sync.ts`** is a complete ingest pipeline: a durable on-disk spool
(`RAW_TRACE_SPOOL_DIR`), bundling, `POST /__ccr/raw-trace-sync` authenticated by
`x-ccr-raw-trace-token`, an inbox with size caps, retry with cooldown, dead-lettering with its own
retention, and a bounded replay pass. **`usage/billing-sync.ts`** is the same shape with event-id
dedupe over `POST /__ccr/billing-usage-sync`. Both are wired in `gateway/http/request-handler.ts:70,74`.

That is exactly the contract needed to ship session transcripts from N laptops to a central
collector: spool locally, push when reachable, dedupe on arrival, survive restarts. **Copy the
pattern rather than inventing one.**

**A session browser also already exists.** `getAgentAnalysis` groups request logs into sessions
(`request-log-store.ts:2768`, `groupBy(requests, r => \`${r.agent}:${r.sessionId}\`)`), and the
contracts already carry `AgentAnalysisSessionRow` (agent, client, models, providers, top tools,
timings, token totals), `AgentAnalysisRequestRow` per request, and a trace payload fetch
(`appGetAgentTracePayload`). The Agent Analysis view is roughly 80% of an admin session browser.
What it lacks is a **user** dimension and **cross-machine** data.

### 4.2 Two ways to get the data where an admin can read it

| | Central CCR | Local harness + transcript sync |
|---|---|---|
| Where sessions live | centrally, by construction | on laptops, pushed to a collector |
| Admin retrieval | already there — it is one database | needs the sync track below |
| Guardrail enforcement | solved — users never hold the config | still advisory; sync gives you drift *detection* |
| Provider key custody | keys never leave the server | keys still on laptops unless keys are central too |
| Offline use | no | yes |
| Local-app value proposition | lost — the desktop UI becomes a thin client | kept |

**If offline use is not a real requirement, central CCR is materially simpler** and collapses three
open problems into one deployment decision. Choose local-plus-sync only if the desktop experience
is the point.

### 4.3 Sync the harness's session store, not the request logs

On a central deployment it is tempting to treat `request_logs.request_body_text` as the transcript —
it does contain the full conversation, because agents resend history every turn. Don't build on it:

- **Storage grows quadratically.** Turn *k* carries *k* messages, so *n* turns store roughly
  *n²/2* messages. The harness's own `messages` table stores each message once — linear.
- It is request-shaped, not session-shaped; only the last request of a session holds the full
  transcript.
- It is lossy unless you force `requestLogSuccessSampleRate = 1` and `requestLogBodyCapture = "all"`,
  which you would be doing purely to reconstruct data you already hold.

Use request logs for forensics and cost; use the `messages` table for history. Join them on
`turns.request_id`.

### 4.4 Identity: typed usernames stop being adequate here

The earlier plan proposed a username typed into the main UI, carried as `x-ccr-user`. That is fine
for cost attribution. **It is not fine as the basis for an administrator reading someone's
transcripts** — anyone can type anyone's name, so the data cannot support any decision made from it.

Upgrade to authenticated identity:

- **Best:** OIDC / SSO against the company IdP. The harness holds a token; the collector validates it;
  the user id is a claim, not an input.
- **Minimum viable:** centrally issued, per-user CCR API keys — provisioned by an admin, never
  self-service. `ApiKeyConfig` already carries `id`, `name`, `createdAt`, `expiresAt` and limits, and
  the gateway already resolves the calling key on every request (`pipeline.ts:355`), so the identity
  reaches the metering layer with no new plumbing.

### 4.5 You now need a real role model — and there is none

Current auth is a **single shared token**: `x-ccr-web-auth`, constant-time compared, with hostname
allow-listing and the token passed in the URL query string
(`web/management-server.ts:136,647,720`). That is a single-user local admin model. There is no user
table, no roles, no login, no server-side sessions anywhere in the codebase.

Minimum to support this feature safely:

```
users        id · external_id · display_name · email · role(user|admin) · status · created_at
sessions_idx session_id → user_id            // ownership, enforced server-side on every read
access_log   id · actor_user_id · action · subject_user_id · session_id · at · reason
```

Three rules, all enforced on the server and never in the client:

1. A user may read only their own sessions.
2. An admin may read any session — and every such read writes an `access_log` row.
3. The access log is append-only and visible to admins other than the reader.

**That audit log is the feature.** Without it, "admin can read anyone's transcripts" is an
unbounded capability; with it, it is a governed one.

### 4.6 Governance is a design input here, not paperwork

Transcripts are employee-authored content, and in some jurisdictions retaining and reviewing them
carries notice, lawful-basis and retention obligations. This is not a blocker, and it is cheap to
build in now and expensive to retrofit:

- **Notice in the app** — state plainly, where sessions are listed, that history is retained and
  visible to administrators.
- **A defined retention period** with automatic deletion, configured centrally.
- **Secret redaction before storage** — transcripts will contain tokens and keys that users paste.
- **Access logging**, per §4.5.
- **Export and deletion** for a named user, so a request can actually be serviced.

Get whoever owns HR or legal policy to confirm the retention period and the notice wording before
H5 ships a session list.

---

## 5. Build order

Two tracks. The **H track** is the harness; the **A track** is identity and administration. A1 must
land before H0 because the session schema needs a real `user_id` from the first migration.

| Phase | Track | Deliverable | Est. |
|---|---|---|---|
| **A1** Identity + roles ✅ | admin | Users, roles, credential bindings resolved server-side, the three access rules, and a database-enforced append-only access log. An SSO resolver drops in without a migration. | 2 wk |
| **H0** Foundations ✅ | harness | Fork-isolation scaffolding (see `fork-isolation-strategy.md`): upstream remote, own workspace packages, vendor tooling, contract tests, one-line seam. Session store schema with `user_id`. MCP transports **vendored, not extracted** | 2–2.5 wk |
| **H1** Turn loop ✅ | harness | Streaming client through the gateway, SSE parse, tool_use detection, multi-turn loop, cancellation. Test-driven, no UI | 2 wk |
| **H2** MCP + tools ✅ | harness | Registry, pooling, namespacing, timeouts, builtin file/shell tools, permission model | 2 wk |
| **H3** Skills ✅ | harness | Registry, frontmatter parsing, menu injection, on-demand load, per-harness roots | 1–1.5 wk |
| **H4** Company context ✅ | harness | Config schema, admin page, reference store, read tool, version stamping | 1–1.5 wk |
| **A2** Transcript sync ✅ | admin | Spool → push → ingest, modelled on `raw-trace-sync`; skip entirely on a central deployment | 1.5–2 wk |
| **H5** Interface ✅ | harness | Work + Code views, streaming renderer, tool cards, approval prompts, skill chips, session list with retention notice | 3 wk |
| **H6** Configuration page ✅ | harness | Per-mode profile binding, provider/model pickers, MCP and skill enablement, gating | 1 wk |
| **A3** Admin console | admin | Cross-user session browser extending Agent Analysis, transcript reader, search, export, delete-for-user, access-log view | 2–2.5 wk |
| **H7** Metering + hardening | harness | Turn-to-usage correlation, per-mode and per-user widgets, retention enforcement, redaction, error paths | 1.5–2 wk |

**Harness track ≈ 13–14 weeks. Admin track ≈ 5.5–6.5 weeks**, of which A2 disappears on a central
deployment. With A1 serialised in front and the rest overlapped, **≈ 17–19 weeks elapsed for one
engineer**, or roughly 12–14 with two working the tracks in parallel. This still assumes the
gateway-side policy and metering work (~4 weeks) lands first or alongside.

---

## 5.1 First run and launch

### Provisioning the temporary administrator

Somebody has to be able to administer a fresh install before Active Directory
exists. On the very first launch — and only when the identity directory is
completely empty — the app mints one account:

- id `bootstrap-admin`, role `admin`, flagged `temporary`
- a random key (`ccx-` + 192 bits, base64url), printed to the console **once**
- only `sha256(key)` is stored, bound with `boundBy: "bootstrap"`

The key is unrecoverable afterwards. Relaunch with `CCX_API_KEY` set to it to
sign in as that administrator.

Three properties make this a stopgap rather than a back door, and each is a test:

| Property | Enforced by |
|---|---|
| Fires only into an empty directory — it can never mint a second administrator | `bootstrapAdmin` returns `undefined` when `countUsers() > 0` |
| The raw key is never persisted, only its fingerprint | `bootstrap.test.ts` asserts the key string appears nowhere in the directory |
| Revoking the binding locks the account out immediately | `bootstrap.test.ts` |

Its assurance level is `claimed`, the same as any emailed key, so nothing about
admin oversight is weakened relative to the caveat above. Replace it with an AD
account and revoke its binding before rollout; `temporaryAccounts(directory)`
lists what still needs replacing, and the console notice says so on every first
run.

### Building and launching

Upstream's `build:assets` clears `packages/electron/dist/renderer`, which is
where the Work/Code renderer lands. Running it alone leaves the window pointing
at a deleted `index.html`. Rather than teach upstream's `build/build.mjs` about
us — that would cost footprint budget — the ordering lives in our own script:

```
npm run -w @ccx/desktop build:app      # upstream assets, then our renderer
npm run -w @ccx/desktop test:electron  # build:app, then launch and assert
```

`test:electron` launches the real app three times against a throwaway data
directory. It is the only test that exercises the packaged main bundle, the
sandboxed preload and the `file://` renderer load; everything else runs under
plain Node or headless Chromium.

| Run | Key | Must hold |
|---|---|---|
| 1 | none | Window loads, bridge exposed, root renders, `viewConfig` IPC round-trips, administrator provisioned exactly once, identity resolves to `bootstrap-admin` |
| 2 | the provisioned key | Same, and bootstrap does **not** re-fire |
| 3 | an unbound key | Window still loads; identity resolves to nobody |

Two ordering bugs it caught on the first real launch: the renderer was deleted
by a later build step, and the window opened before `ipcMain.handle` ran, so the
first `viewConfig()` could lose the race with no way to retry. Both are the kind
of thing only a real launch finds.

---

## 5.2 Transcript sync

Local-plus-sync means an administrator cannot read what never leaves the laptop.
A2 is the pipe that fixes that, and the whole design turns on one property:
**a device cannot say who it is.**

### Shape

```
laptop                                    collector
──────                                    ─────────
ccx_sessions ─┐
ccx_messages  ├─ triggers ─► ccx_sync_outbox
ccx_turns     │                   │
ccx_tool_calls┘                   │ coalesce by (entity, key)
                                  ▼
                            redact secrets
                                  ▼
                     POST /__ccx/session-sync  ──►  resolve fingerprint → person
                     x-ccx-session-sync: <token>    upsert into the same schema
                                  ◄── 200 ──────────── receipt (bundleId dedupe)
                                  ▼
                          ack, per key
```

### Why it differs from `raw-trace-sync.ts`

The upstream spool writes to disk because its source — an in-flight HTTP trace —
is gone if it is not written down. Ours is already a durable SQLite database, so
a second on-disk copy would double storage and invent a crash-consistency
problem we do not have. The *pattern* is copied (durable queue, bundling,
authenticated POST, dedupe on arrival, retry with cooldown, dead-lettering); the
*mechanism* is a table.

Enqueue is by trigger, not by a call in `store.ts`, for two reasons: it happens
inside the same transaction as the write, so a crash between them is impossible;
and no future write path can forget it. The access log already uses triggers for
its append-only guarantee.

### The properties that carry the oversight claim

| Property | How |
|---|---|
| A laptop cannot file transcripts under another person | The wire format has no `userId` field at all. The collector resolves from `credentialFingerprint` via the binding an administrator recorded at issue time. |
| A session cannot be re-attributed later | `user_id` and `credential_fingerprint` are write-once in `upsertSession`; only metadata updates. |
| A laptop cannot revise history it already sent | Messages ingest `ON CONFLICT DO NOTHING`. Tool calls may update their outcome and nothing else. |
| A revoked key stops depositing immediately | Resolution runs per bundle, not per device enrolment. |
| One stale key does not block everyone | An unresolvable session is dropped with its children; the rest of the bundle still lands. |
| Secrets do not reach the collector | `redactSecrets` runs before the bundle exists, so a collector compromise cannot yield credentials that were never sent. The device's own key is passed as a literal. |
| Nothing is lost on a crash or a dropped ack | Rows leave the outbox only after the collector accepts them. The failure mode is a duplicate bundle, deduped on `bundleId`. |
| One poisoned batch cannot wedge the queue | A permanent rejection (4xx other than 408/429) dead-letters and acks; transient failures retry with a doubling cooldown, forever. |

Two bugs the tests caught, both of the kind that would have shown up as quiet
data loss months later:

- **Acking by a global watermark deleted undelivered rows.** Appending a message
  also bumps its session's `updated_at`, so the session's coalesced entry can
  carry a *higher* outbox id than the message queued just before it. `DELETE
  WHERE id <= max` then retired that message without ever shipping it. Ack is
  now bounded per key.
- **`ccx_tool_calls.id` is a per-machine autoincrement**, so two laptops both
  produce tool call 1 and the collector cannot tell them apart. Tool calls now
  carry `(turn_id, seq)`, the same shape messages already had, with a migration
  that ranks existing rows before the unique index goes on.

### Deliberate non-goals

- **A local delete does not retract the collector's copy.** There is no delete
  trigger. The collector is the record for oversight; retention there governs.
  Deletion-for-a-user is an administrator action and belongs to A3.
- **Assurance stays `claimed`.** Sync does not improve it. An emailed key is
  transferable, so the collector records who the *key* is bound to, not who
  typed. SSO raises this; nothing in the sync path changes when it does.
- **The collector token sits in a plaintext config file**, the same custody
  problem as the provider key. H7 moves both to the OS keychain. The token
  guards the transport only — identity still comes from bindings, so a leaked
  token does not let anyone forge attribution.

### Running it

```
CCX_COLLECTOR_DATA_DIR=/var/lib/ccx CCX_COLLECTOR_TOKEN=... \
  npm run -w @ccx/collector start
```

`@ccx/collector` is a bare `node:http` server so a pilot has something to point
laptops at on day one. A real deployment more likely mounts
`createSessionSyncHandler` behind its own ingress, which is why the handler is
exported separately. Either way the collector stores into the *same* schema the
desktop app uses, so A3 reads it through `SessionAuthorizer` unchanged.

Enabling sync on a laptop is one config block; the first launch after enabling
backfills whatever history is already on disk, once, marked by
`sync.backfilledAt` so a relaunch does not re-ship everything.

---

## 6. Decisions still open

### Settled

| Decision | Answer | Consequence |
|---|---|---|
| Central CCR or local + sync? | **Local + sync.** Users work on their own machines. | A2 transcript sync is in scope. Guardrails stay advisory with drift detection. Provider keys live on laptops, so OS-keychain storage moves from optional to required. |
| Identity source | **Eventually SSO via Active Directory.** | An interim identity is needed. Bind the issued key to a person at issue time; the laptop sends a hash, never a name. `user_id` stays opaque so the AD resolver drops in later without a migration. |
| Provider access | **One shared provider URL; per-user API key issued by email.** | The configuration page asks for a key, not a provider — the base URL is an admin-set default. The key doubles as the interim identity. |

> ⚠️ **An emailed key is transferable.** It is adequate for cost attribution and
> inadequate on its own for admin oversight: a forwarded key attributes one
> person's transcripts to another. Bind key → person in the collector at issue
> time, store only `sha256(key)` on the client, and treat attribution as
> *claimed* until AD lands. Record that caveat wherever admin reads are shown.

### Still open

| Decision | Why it matters now | Recommendation |
|---|---|---|
| Retention period for transcripts | Schema and deletion job depend on it; needs a policy owner | Set before H0 ships the schema |
| Whose skills does the app read? | Sets the root list and portability between modes | Claude roots by default, selectable |
| Does Work get shell access? | The real security boundary between the modes | No. MCP and reads only |
| Context pack: manifest or inline? | Context budget and cache economics | Manifest, with a read tool |
| Is the pack authoritative or advisory? | Changes where config lives; hard to retrofit | Falls out of the central/local decision |
| One turn loop or two? | Divergence is expensive to unwind | One loop, two configurations |

---

## 7. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Admin retrieval bolted on after the schema ships without `user_id` | **High** | A1 lands before H0 |
| Transcripts readable by admins with no audit trail | **High** | Access log is part of A1, not A3 |
| Skills assumed to work without file and shell tools | **High** | Scope the builtin tool surface in H2, before H3 |
| Tool loop plus streaming underestimated — resumption, interruption, partial calls | **High** | H1 is test-driven with no UI |
| Retention and notice retrofitted after launch | **High** | Policy owner confirms before H5 |
| Transcript storage growth underestimated | Medium | Sync the session store, not request logs — linear, not quadratic |
| Secrets pasted into chat get stored forever | Medium | Redaction before write, in H7 |
| Context assembly breaks prompt caching every turn | Medium | Byte-stable layers 1–4; verify with the inflation metric |
| Upstream upgrades blocked by accumulated edits to CCR files | **High** | Fork-isolation strategy; residual upstream surface is one line |
| Stdio MCP child processes leak across sessions | Medium | Pooled lifecycle with explicit close in H2 |
| Renderer holds the gateway API key | Medium | Stream over IPC; keys never leave main |
| Approval fatigue drives auto-approve-everything | Low | Sensible read defaults, per-session memory |

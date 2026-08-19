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

Extract the three transports from `toolhub-mcp.ts` into `packages/core/src/mcp/client.ts` as a
shared module. `toolhub-mcp.ts` and the new harness then share one implementation — this is a
refactor with an existing consumer, so it is verifiable against current behaviour.

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

## 4. Build order

Each phase ends with something demonstrable. Phases 1–3 have no UI; that is deliberate — the loop
should be provably correct before it is pretty.

| Phase | Deliverable | Est. |
|---|---|---|
| **H0** Foundations | Session store schema + migrations; extract MCP client from `toolhub-mcp.ts` into a shared module with the existing ToolHub consumer still green | 1–1.5 wk |
| **H1** Turn loop | Streaming provider client through the gateway; SSE parse; tool_use detection; multi-turn loop; cancellation. Driven by a test script, no UI | 2 wk |
| **H2** MCP + tools | Registry, pooling, namespacing, timeouts, builtin file/shell tools, permission model | 2 wk |
| **H3** Skills | Registry, frontmatter parsing, menu injection, on-demand load, per-harness roots extracted from the CLI middleware | 1–1.5 wk |
| **H4** Company context | Config schema, admin page, reference file store, `company_reference.read` tool, version stamping | 1–1.5 wk |
| **H5** UI | Work + Code views, streaming renderer, tool-call cards, approval prompts, skill chips, session list | 3 wk |
| **H6** Configuration page | Per-mode profile binding, provider/model pickers, MCP + skill enablement, gating | 1 wk |
| **H7** Metering + hardening | Turn-to-usage correlation, per-mode and per-user dashboard widgets, retention policy, error paths | 1.5 wk |

**~13–14 weeks** for one engineer, assuming the gateway-side policy and metering work
(P1–P3 of the earlier plan, ~4 weeks) lands in parallel or first. H1 and H5 are the two that
overrun; everything else is bounded.

Parallelisable: H4 and H6 are independent of H1–H3. H5 can start against a mocked turn loop as
soon as the IPC event contract from H1 is fixed.

---

## 5. Decisions still open

| Decision | Why it matters now | Recommendation |
|---|---|---|
| Which harness's skills does the app read? | Determines the root set and whether skills are portable between modes | Claude roots by default, selectable in config — the mapping already exists |
| Does Work get shell access? | The real security boundary between the modes | No. MCP and reads only |
| Company pack: manifest or inline? | Context budget and cache economics | Manifest, with a read tool |
| Is the pack authoritative or advisory? | Changes where config lives; hard to retrofit | Decide before H4 |
| Session history retention | Transcripts will contain company context and possibly source code | Set a policy before H0 ships the schema |
| One turn loop or two? | Divergence is expensive to unwind later | One loop, two configurations |

---

## 6. Risks specific to this build

| Risk | Severity | Mitigation |
|---|---|---|
| Skills assumed to work without file/shell tools | **High** | Scope the builtin tool surface in H2, before H3 |
| Tool loop + streaming underestimated — resumption, interruption, partial tool calls | **High** | H1 is test-driven with no UI; treat it as the hardest phase |
| Context assembly breaks prompt caching every turn | Medium | Byte-stable layers 1–4; verify with the prompt-inflation metric |
| Extracting the MCP client regresses ToolHub | Medium | Refactor with the existing consumer's tests as the gate |
| Stdio MCP child processes leak across sessions | Medium | Pooled lifecycle with explicit close in H2 |
| Company context leaks into transcripts, exports or logs | Medium | It *will* be in request logs — set retention, and never render it in the UI |
| Renderer holds the gateway API key | Medium | Stream over IPC; keys never leave main |
| Approval fatigue makes users auto-approve everything | Low | Sensible read defaults; per-session memory |

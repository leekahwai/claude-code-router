/**
 * Per-turn metrics the product needs and CCR does not record: which user, which
 * mode, the pre-provider token estimate, and what the company policy cost.
 *
 * These live in our own database and join to CCR's `usage_events` on
 * `request_id` at read time. Adding columns to upstream tables would mean
 * owning an upstream migration path forever — see
 * design/fork-isolation-strategy.md §4.2.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createBetterSqliteDatabase, type BetterSqliteDatabase } from "@ccr/core/storage/sqlite-native";
import { CCX_METRICS_DB_FILE } from "../config/paths";

export type CcxMode = "code" | "work";

export type TurnMetricInput = {
  /** Matches the `x-client-request-id` we set on the outbound gateway call. */
  requestId: string;
  createdAt?: string;
  estimatedInputTokens?: number;
  mcpCalls?: number;
  mode: CcxMode;
  policyTokens?: number;
  policyVersion?: string;
  sessionId: string;
  skillsLoaded?: string[];
  turnId: string;
  userId: string;
};

export type TurnMetricRow = {
  createdAt: string;
  estimatedInputTokens: number;
  mcpCalls: number;
  mode: CcxMode;
  policyTokens: number;
  policyVersion: string;
  requestId: string;
  sessionId: string;
  skillsLoaded: string[];
  turnId: string;
  userId: string;
};

/** A turn joined to whatever CCR metered for the same request. */
export type TurnCostRow = TurnMetricRow & {
  /** Provider-reported. Undefined until the gateway has written its row. */
  billedInputTokens?: number;
  costUsd?: number;
  model?: string;
  outputTokens?: number;
  provider?: string;
};

export type MetricsStoreOptions = {
  /** CCR's usage.sqlite. Attached read-only for joins; never written. */
  usageDbFile?: string;
};

const attachedUsageSchema = "ccr_usage";

export class TurnMetricsStore {
  private readonly database: BetterSqliteDatabase;
  private usageAttached = false;

  constructor(dbFile: string = CCX_METRICS_DB_FILE, private readonly options: MetricsStoreOptions = {}) {
    if (dbFile !== ":memory:") {
      mkdirSync(dirname(dbFile), { mode: 0o700, recursive: true });
    }
    this.database = createBetterSqliteDatabase(dbFile);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("busy_timeout = 5000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS ccx_turn_metrics (
        request_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        estimated_input_tokens INTEGER NOT NULL DEFAULT 0,
        policy_tokens INTEGER NOT NULL DEFAULT 0,
        policy_version TEXT NOT NULL DEFAULT '',
        skills_loaded TEXT NOT NULL DEFAULT '[]',
        mcp_calls INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ccx_turn_metrics_user_created_idx
        ON ccx_turn_metrics(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS ccx_turn_metrics_session_idx
        ON ccx_turn_metrics(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS ccx_turn_metrics_mode_created_idx
        ON ccx_turn_metrics(mode, created_at DESC);
    `);
  }

  record(input: TurnMetricInput): void {
    this.database
      .prepare(`
        INSERT INTO ccx_turn_metrics (
          request_id, turn_id, session_id, user_id, mode,
          estimated_input_tokens, policy_tokens, policy_version,
          skills_loaded, mcp_calls, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(request_id) DO UPDATE SET
          estimated_input_tokens = excluded.estimated_input_tokens,
          policy_tokens = excluded.policy_tokens,
          policy_version = excluded.policy_version,
          skills_loaded = excluded.skills_loaded,
          mcp_calls = excluded.mcp_calls
      `)
      .run(
        input.requestId,
        input.turnId,
        input.sessionId,
        input.userId,
        input.mode,
        input.estimatedInputTokens ?? 0,
        input.policyTokens ?? 0,
        input.policyVersion ?? "",
        JSON.stringify(input.skillsLoaded ?? []),
        input.mcpCalls ?? 0,
        input.createdAt ?? new Date().toISOString()
      );
  }

  get(requestId: string): TurnMetricRow | undefined {
    const row = this.database
      .prepare("SELECT * FROM ccx_turn_metrics WHERE request_id = ?")
      .get(requestId) as Record<string, unknown> | undefined;
    return row ? toMetricRow(row) : undefined;
  }

  /**
   * Turns for a user, each joined to CCR's metered usage for the same request.
   * A LEFT JOIN because usage capture is fire-and-forget upstream and lands
   * slightly after the turn does.
   */
  listForUser(userId: string, limit = 100): TurnCostRow[] {
    if (!this.attachUsage()) {
      return this.listMetricsOnly(userId, limit);
    }
    const rows = this.database
      .prepare(`
        SELECT m.*,
               u.input_tokens  AS billed_input_tokens,
               u.output_tokens AS output_tokens,
               u.cost_usd      AS cost_usd,
               u.model         AS model,
               u.provider      AS provider
        FROM ccx_turn_metrics m
        LEFT JOIN ${attachedUsageSchema}.usage_events u ON u.request_id = m.request_id
        WHERE m.user_id = ?
        ORDER BY m.created_at DESC
        LIMIT ?
      `)
      .all(userId, limit) as Array<Record<string, unknown>>;
    return rows.map(toCostRow);
  }

  close(): void {
    this.database.close();
  }

  private listMetricsOnly(userId: string, limit: number): TurnCostRow[] {
    const rows = this.database
      .prepare("SELECT * FROM ccx_turn_metrics WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(userId, limit) as Array<Record<string, unknown>>;
    return rows.map(toCostRow);
  }

  /** Attach CCR's usage database read-only. Absent or locked is not an error. */
  private attachUsage(): boolean {
    if (this.usageAttached) {
      return true;
    }
    const usageDbFile = this.options.usageDbFile;
    if (!usageDbFile) {
      return false;
    }
    try {
      this.database.prepare(`ATTACH DATABASE ? AS ${attachedUsageSchema}`).run(usageDbFile);
      this.database.prepare(`SELECT 1 FROM ${attachedUsageSchema}.usage_events LIMIT 1`).get();
      this.usageAttached = true;
      return true;
    } catch {
      return false;
    }
  }
}

function toMetricRow(row: Record<string, unknown>): TurnMetricRow {
  return {
    createdAt: String(row.created_at ?? ""),
    estimatedInputTokens: Number(row.estimated_input_tokens ?? 0),
    mcpCalls: Number(row.mcp_calls ?? 0),
    mode: row.mode === "code" ? "code" : "work",
    policyTokens: Number(row.policy_tokens ?? 0),
    policyVersion: String(row.policy_version ?? ""),
    requestId: String(row.request_id ?? ""),
    sessionId: String(row.session_id ?? ""),
    skillsLoaded: parseSkills(row.skills_loaded),
    turnId: String(row.turn_id ?? ""),
    userId: String(row.user_id ?? "")
  };
}

function toCostRow(row: Record<string, unknown>): TurnCostRow {
  return {
    ...toMetricRow(row),
    ...(row.billed_input_tokens === null || row.billed_input_tokens === undefined
      ? {}
      : { billedInputTokens: Number(row.billed_input_tokens) }),
    ...(row.output_tokens === null || row.output_tokens === undefined ? {} : { outputTokens: Number(row.output_tokens) }),
    ...(row.cost_usd === null || row.cost_usd === undefined ? {} : { costUsd: Number(row.cost_usd) }),
    ...(row.model === null || row.model === undefined ? {} : { model: String(row.model) }),
    ...(row.provider === null || row.provider === undefined ? {} : { provider: String(row.provider) })
  };
}

function parseSkills(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

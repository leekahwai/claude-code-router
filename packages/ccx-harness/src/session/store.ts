/**
 * Session, message, turn and tool-call storage for the Work/Code harness.
 *
 * Identity note: `user_id` is opaque and `credential_fingerprint` is
 * sha256(api key). The client never asserts who it is — the collector resolves
 * a person from the fingerprint using the binding recorded when the key was
 * issued. When Active Directory SSO lands, only the resolver changes; nothing
 * here migrates. See design/work-code-harness-spec.md §"Settled".
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createBetterSqliteDatabase, type BetterSqliteDatabase } from "@ccr/core/storage/sqlite-native";
import { CCX_SESSIONS_DB_FILE } from "../config/paths";

export type CcxMode = "code" | "work";
export type TurnStatus = "cancelled" | "error" | "running" | "succeeded";
export type ToolCallSource = "builtin" | "mcp" | "skill";
export type ToolCallStatus = "denied" | "error" | "ok" | "running";

export type MessageRole = "assistant" | "system" | "tool" | "user";

export type SessionRecord = {
  createdAt: string;
  /**
   * sha256 of the API key the session was created with. The collector resolves
   * a person from this using the binding recorded when the key was issued, so
   * it has to be readable — not merely stored.
   */
  credentialFingerprint: string;
  id: string;
  mode: CcxMode;
  model: string;
  policyVersion: string;
  provider: string;
  profileId: string;
  title: string;
  updatedAt: string;
  userId: string;
  workspaceDir: string;
};

export type MessageRecord = {
  content: unknown;
  createdAt: string;
  id: number;
  role: MessageRole;
  seq: number;
  sessionId: string;
};

export type TurnRecord = {
  endedAt: string;
  error: string;
  id: string;
  requestId: string;
  sessionId: string;
  startedAt: string;
  status: TurnStatus;
};

export type ToolCallRecord = {
  args: unknown;
  approvedBy: string;
  durationMs: number;
  id: number;
  name: string;
  result: unknown;
  /** Stable across machines, unlike the local autoincrement `id`. */
  seq: number;
  server: string;
  source: ToolCallSource;
  status: ToolCallStatus;
  turnId: string;
};

/** Identity travels as a hash. The raw key never leaves the credential store. */
export function credentialFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey.trim(), "utf8").digest("hex");
}

export type CreateSessionInput = {
  createdAt?: string;
  credentialFingerprint: string;
  id: string;
  mode: CcxMode;
  model: string;
  policyVersion?: string;
  profileId?: string;
  provider: string;
  title?: string;
  userId: string;
  workspaceDir?: string;
};

export class SessionStore {
  private readonly database: BetterSqliteDatabase;

  constructor(dbFile: string = CCX_SESSIONS_DB_FILE) {
    if (dbFile !== ":memory:") {
      mkdirSync(dirname(dbFile), { mode: 0o700, recursive: true });
    }
    this.database = createBetterSqliteDatabase(dbFile);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("busy_timeout = 5000");
    this.database.pragma("foreign_keys = ON");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS ccx_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        credential_fingerprint TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        profile_id TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        workspace_dir TEXT NOT NULL DEFAULT '',
        policy_version TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ccx_sessions_user_updated_idx
        ON ccx_sessions(user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS ccx_sessions_fingerprint_idx
        ON ccx_sessions(credential_fingerprint);

      CREATE TABLE IF NOT EXISTS ccx_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES ccx_sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        content_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, seq)
      );
      CREATE INDEX IF NOT EXISTS ccx_messages_session_seq_idx
        ON ccx_messages(session_id, seq);

      CREATE TABLE IF NOT EXISTS ccx_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES ccx_sessions(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS ccx_turns_session_started_idx
        ON ccx_turns(session_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS ccx_turns_request_idx
        ON ccx_turns(request_id);

      CREATE TABLE IF NOT EXISTS ccx_tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT NOT NULL REFERENCES ccx_turns(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL,
        server TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL,
        args_json TEXT NOT NULL DEFAULT 'null',
        result_json TEXT NOT NULL DEFAULT 'null',
        duration_ms INTEGER NOT NULL DEFAULT 0,
        approved_by TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'running',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ccx_tool_calls_turn_idx
        ON ccx_tool_calls(turn_id);
      CREATE INDEX IF NOT EXISTS ccx_tool_calls_name_idx
        ON ccx_tool_calls(name);
    `);
    this.migrateToolCallSequence();
  }

  /**
   * `id` is a local AUTOINCREMENT, so two laptops both produce tool call 1 and
   * the collector cannot tell them apart. `(turn_id, seq)` is stable across
   * machines, which is what transcript sync ingests on. Messages already had
   * `(session_id, seq)`; this gives tool calls the same shape.
   */
  private migrateToolCallSequence(): void {
    const columns = this.database.prepare("PRAGMA table_info(ccx_tool_calls)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "seq")) {
      this.database.exec("ALTER TABLE ccx_tool_calls ADD COLUMN seq INTEGER NOT NULL DEFAULT 0");
      // Existing rows all carry seq 0, which would collide on the unique index.
      // Insertion order within a turn is `id` order, so rank on that.
      this.database.exec(`
        UPDATE ccx_tool_calls SET seq = (
          SELECT COUNT(*) FROM ccx_tool_calls older
          WHERE older.turn_id = ccx_tool_calls.turn_id AND older.id < ccx_tool_calls.id
        )
      `);
    }
    this.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS ccx_tool_calls_turn_seq_idx
        ON ccx_tool_calls(turn_id, seq);
    `);
  }

  /**
   * The shared connection, for stores in this package that must see the same
   * transaction — today only the sync outbox, whose triggers have to fire
   * inside the writes they observe. Not part of the surface anything outside
   * `@ccx/harness` should reach for.
   */
  unsafeDatabase(): BetterSqliteDatabase {
    return this.database;
  }

  createSession(input: CreateSessionInput): SessionRecord {
    const now = input.createdAt ?? new Date().toISOString();
    this.database
      .prepare(`
        INSERT INTO ccx_sessions (
          id, user_id, credential_fingerprint, mode, title, profile_id,
          provider, model, workspace_dir, policy_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.id,
        input.userId,
        input.credentialFingerprint,
        input.mode,
        input.title ?? "",
        input.profileId ?? "",
        input.provider,
        input.model,
        input.workspaceDir ?? "",
        input.policyVersion ?? "",
        now,
        now
      );
    return this.getSession(input.id)!;
  }

  getSession(id: string): SessionRecord | undefined {
    const row = this.database.prepare("SELECT * FROM ccx_sessions WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toSession(row) : undefined;
  }

  listSessions(userId: string, limit = 50): SessionRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM ccx_sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?")
      .all(userId, limit) as Array<Record<string, unknown>>;
    return rows.map(toSession);
  }

  /**
   * Append a message. `seq` is assigned inside the write so two concurrent
   * appends cannot collide on the UNIQUE(session_id, seq) index.
   */
  appendMessage(sessionId: string, role: MessageRole, content: unknown, createdAt?: string): MessageRecord {
    const now = createdAt ?? new Date().toISOString();
    const insert = this.database.transaction((): number => {
      const next = this.database
        .prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM ccx_messages WHERE session_id = ?")
        .get(sessionId) as { seq: number };
      const result = this.database
        .prepare("INSERT INTO ccx_messages (session_id, seq, role, content_json, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(sessionId, next.seq, role, JSON.stringify(content ?? null), now);
      this.database.prepare("UPDATE ccx_sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
      return Number(result.lastInsertRowid);
    });
    const id = insert();
    const row = this.database.prepare("SELECT * FROM ccx_messages WHERE id = ?").get(id) as Record<string, unknown>;
    return toMessage(row);
  }

  /** Full conversation in order — what the next request is built from. */
  listMessages(sessionId: string): MessageRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM ccx_messages WHERE session_id = ? ORDER BY seq ASC")
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map(toMessage);
  }

  startTurn(input: { id: string; requestId: string; sessionId: string; startedAt?: string }): TurnRecord {
    this.database
      .prepare("INSERT INTO ccx_turns (id, session_id, request_id, status, started_at) VALUES (?, ?, ?, 'running', ?)")
      .run(input.id, input.sessionId, input.requestId, input.startedAt ?? new Date().toISOString());
    return this.getTurn(input.id)!;
  }

  finishTurn(id: string, status: Exclude<TurnStatus, "running">, error = "", endedAt?: string): void {
    this.database
      .prepare("UPDATE ccx_turns SET status = ?, error = ?, ended_at = ? WHERE id = ?")
      .run(status, error, endedAt ?? new Date().toISOString(), id);
  }

  getTurn(id: string): TurnRecord | undefined {
    const row = this.database.prepare("SELECT * FROM ccx_turns WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toTurn(row) : undefined;
  }

  listTurns(sessionId: string): TurnRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM ccx_turns WHERE session_id = ? ORDER BY started_at ASC")
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map(toTurn);
  }

  recordToolCall(input: {
    approvedBy?: string;
    args: unknown;
    createdAt?: string;
    durationMs?: number;
    name: string;
    result?: unknown;
    server?: string;
    source: ToolCallSource;
    status?: ToolCallStatus;
    turnId: string;
  }): number {
    // `seq` is assigned inside the write, so two concurrent tool calls on one
    // turn cannot collide on UNIQUE(turn_id, seq).
    const insert = this.database.transaction((): number => {
      const next = this.database
        .prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM ccx_tool_calls WHERE turn_id = ?")
        .get(input.turnId) as { seq: number };
      const result = this.database
        .prepare(`
          INSERT INTO ccx_tool_calls (
            turn_id, seq, source, server, name, args_json, result_json,
            duration_ms, approved_by, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.turnId,
          next.seq,
          input.source,
          input.server ?? "",
          input.name,
          JSON.stringify(input.args ?? null),
          JSON.stringify(input.result ?? null),
          input.durationMs ?? 0,
          input.approvedBy ?? "",
          input.status ?? "running",
          input.createdAt ?? new Date().toISOString()
        );
      return Number(result.lastInsertRowid);
    });
    return insert();
  }

  completeToolCall(id: number, status: ToolCallStatus, result: unknown, durationMs: number): void {
    this.database
      .prepare("UPDATE ccx_tool_calls SET status = ?, result_json = ?, duration_ms = ? WHERE id = ?")
      .run(status, JSON.stringify(result ?? null), durationMs, id);
  }

  listToolCalls(turnId: string): ToolCallRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM ccx_tool_calls WHERE turn_id = ? ORDER BY seq ASC")
      .all(turnId) as Array<Record<string, unknown>>;
    return rows.map(toToolCall);
  }

  /**
   * Collector-side ingest of a synced session.
   *
   * `user_id` and `credential_fingerprint` are write-once. A second bundle
   * naming an existing session can update its title or model, but cannot
   * re-attribute it to a different person — otherwise a laptop could hand
   * someone else's transcript a new owner after the fact.
   */
  upsertSession(input: CreateSessionInput & { updatedAt?: string }): void {
    this.database
      .prepare(`
        INSERT INTO ccx_sessions (
          id, user_id, credential_fingerprint, mode, title, profile_id,
          provider, model, workspace_dir, policy_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          profile_id = excluded.profile_id,
          provider = excluded.provider,
          model = excluded.model,
          workspace_dir = excluded.workspace_dir,
          policy_version = excluded.policy_version,
          updated_at = excluded.updated_at
      `)
      .run(
        input.id,
        input.userId,
        input.credentialFingerprint,
        input.mode,
        input.title ?? "",
        input.profileId ?? "",
        input.provider,
        input.model,
        input.workspaceDir ?? "",
        input.policyVersion ?? "",
        input.createdAt ?? new Date().toISOString(),
        input.updatedAt ?? input.createdAt ?? new Date().toISOString()
      );
  }

  /**
   * Collector-side ingest of one message.
   *
   * Write-once on purpose: a laptop cannot revise a transcript the collector
   * already holds. Returns false when the message was already present.
   */
  upsertMessage(input: { content: unknown; createdAt: string; role: MessageRole; seq: number; sessionId: string }): boolean {
    const result = this.database
      .prepare(`
        INSERT INTO ccx_messages (session_id, seq, role, content_json, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id, seq) DO NOTHING
      `)
      .run(input.sessionId, input.seq, input.role, JSON.stringify(input.content ?? null), input.createdAt);
    return Number(result.changes ?? 0) > 0;
  }

  /** Collector-side ingest of one turn. `session_id` is write-once. */
  upsertTurn(input: TurnRecord): void {
    this.database
      .prepare(`
        INSERT INTO ccx_turns (id, session_id, request_id, status, started_at, ended_at, error)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          request_id = excluded.request_id,
          status = excluded.status,
          ended_at = excluded.ended_at,
          error = excluded.error
      `)
      .run(input.id, input.sessionId, input.requestId, input.status, input.startedAt, input.endedAt, input.error);
  }

  /**
   * Collector-side ingest of one tool call, keyed on `(turn_id, seq)` because
   * `id` is a per-machine autoincrement. Name and arguments are write-once;
   * only the outcome may be revised, which is the one thing that legitimately
   * changes after a call is recorded.
   */
  upsertToolCall(input: Omit<ToolCallRecord, "id"> & { createdAt: string }): void {
    this.database
      .prepare(`
        INSERT INTO ccx_tool_calls (
          turn_id, seq, source, server, name, args_json, result_json,
          duration_ms, approved_by, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(turn_id, seq) DO UPDATE SET
          result_json = excluded.result_json,
          duration_ms = excluded.duration_ms,
          approved_by = excluded.approved_by,
          status = excluded.status
      `)
      .run(
        input.turnId,
        input.seq,
        input.source,
        input.server,
        input.name,
        JSON.stringify(input.args ?? null),
        JSON.stringify(input.result ?? null),
        input.durationMs,
        input.approvedBy,
        input.status,
        input.createdAt
      );
  }

  /** One message by its cross-machine key, for hydrating a sync bundle. */
  getMessage(sessionId: string, seq: number): MessageRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM ccx_messages WHERE session_id = ? AND seq = ?")
      .get(sessionId, seq) as Record<string, unknown> | undefined;
    return row ? toMessage(row) : undefined;
  }

  /** One tool call by its cross-machine key, for hydrating a sync bundle. */
  getToolCall(turnId: string, seq: number): ToolCallRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM ccx_tool_calls WHERE turn_id = ? AND seq = ?")
      .get(turnId, seq) as Record<string, unknown> | undefined;
    return row ? toToolCall(row) : undefined;
  }

  hasSession(id: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM ccx_sessions WHERE id = ?").get(id));
  }

  hasTurn(id: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM ccx_turns WHERE id = ?").get(id));
  }

  /** Run `work` in one transaction, so a rejected bundle leaves nothing behind. */
  transaction<T>(work: () => T): T {
    return this.database.transaction(work)();
  }

  /** Deleting a session takes its messages, turns and tool calls with it. */
  deleteSession(id: string): void {
    this.database.prepare("DELETE FROM ccx_sessions WHERE id = ?").run(id);
  }

  close(): void {
    this.database.close();
  }
}

function toSession(row: Record<string, unknown>): SessionRecord {
  return {
    createdAt: String(row.created_at ?? ""),
    credentialFingerprint: String(row.credential_fingerprint ?? ""),
    id: String(row.id ?? ""),
    mode: row.mode === "code" ? "code" : "work",
    model: String(row.model ?? ""),
    policyVersion: String(row.policy_version ?? ""),
    profileId: String(row.profile_id ?? ""),
    provider: String(row.provider ?? ""),
    title: String(row.title ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    userId: String(row.user_id ?? ""),
    workspaceDir: String(row.workspace_dir ?? "")
  };
}

function toMessage(row: Record<string, unknown>): MessageRecord {
  return {
    content: parseJson(row.content_json),
    createdAt: String(row.created_at ?? ""),
    id: Number(row.id ?? 0),
    role: String(row.role ?? "user") as MessageRole,
    seq: Number(row.seq ?? 0),
    sessionId: String(row.session_id ?? "")
  };
}

function toTurn(row: Record<string, unknown>): TurnRecord {
  return {
    endedAt: String(row.ended_at ?? ""),
    error: String(row.error ?? ""),
    id: String(row.id ?? ""),
    requestId: String(row.request_id ?? ""),
    sessionId: String(row.session_id ?? ""),
    startedAt: String(row.started_at ?? ""),
    status: String(row.status ?? "running") as TurnStatus
  };
}

function toToolCall(row: Record<string, unknown>): ToolCallRecord {
  return {
    approvedBy: String(row.approved_by ?? ""),
    args: parseJson(row.args_json),
    durationMs: Number(row.duration_ms ?? 0),
    id: Number(row.id ?? 0),
    name: String(row.name ?? ""),
    result: parseJson(row.result_json),
    seq: Number(row.seq ?? 0),
    server: String(row.server ?? ""),
    source: String(row.source ?? "builtin") as ToolCallSource,
    status: String(row.status ?? "running") as ToolCallStatus,
    turnId: String(row.turn_id ?? "")
  };
}

function parseJson(value: unknown): unknown {
  try {
    return JSON.parse(String(value ?? "null")) as unknown;
  } catch {
    return null;
  }
}

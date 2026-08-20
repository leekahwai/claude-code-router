/**
 * Append-only audit of who read whose conversation.
 *
 * This log is the feature. Without it, "an administrator can read anyone's
 * transcripts" is an unbounded capability; with it, it is a governed one.
 *
 * Append-only is enforced by the database rather than by convention: triggers
 * reject UPDATE and DELETE, so a bug — or someone with a SQLite shell and a
 * motive — cannot quietly edit the record of a read.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createBetterSqliteDatabase, type BetterSqliteDatabase } from "@ccr/core/storage/sqlite-native";

/**
 * Every way an administrator can touch someone else's material.
 *
 * `search` is here because searching transcripts across people *is* a
 * cross-user read — an admin who greps everyone's conversations for a word has
 * read everyone's conversations, whether or not a hit came back. The query text
 * is recorded with it, so the log says what was looked for and not merely that
 * something was.
 */
export type AccessAction =
  | "delete-session"
  | "delete-user"
  | "export-user"
  | "list-sessions"
  | "read-session"
  | "search";

export type AccessLogEntry = {
  action: AccessAction;
  actorUserId: string;
  at: string;
  id: number;
  reason: string;
  sessionId: string;
  subjectUserId: string;
};

export class AccessLog {
  private readonly database: BetterSqliteDatabase;

  constructor(dbFile: string) {
    if (dbFile !== ":memory:") {
      mkdirSync(dirname(dbFile), { mode: 0o700, recursive: true });
    }
    this.database = createBetterSqliteDatabase(dbFile);
    this.database.pragma("journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS ccx_access_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        subject_user_id TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ccx_access_log_subject_idx
        ON ccx_access_log(subject_user_id, at DESC);
      CREATE INDEX IF NOT EXISTS ccx_access_log_actor_idx
        ON ccx_access_log(actor_user_id, at DESC);

      CREATE TRIGGER IF NOT EXISTS ccx_access_log_no_update
        BEFORE UPDATE ON ccx_access_log
        BEGIN SELECT RAISE(ABORT, 'ccx_access_log is append-only'); END;

      CREATE TRIGGER IF NOT EXISTS ccx_access_log_no_delete
        BEFORE DELETE ON ccx_access_log
        BEGIN SELECT RAISE(ABORT, 'ccx_access_log is append-only'); END;
    `);
  }

  record(entry: Omit<AccessLogEntry, "at" | "id"> & { at?: string }): AccessLogEntry {
    const result = this.database
      .prepare(`
        INSERT INTO ccx_access_log (actor_user_id, action, subject_user_id, session_id, reason, at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        entry.actorUserId,
        entry.action,
        entry.subjectUserId,
        entry.sessionId,
        entry.reason,
        entry.at ?? new Date().toISOString()
      );
    return this.get(Number(result.lastInsertRowid))!;
  }

  get(id: number): AccessLogEntry | undefined {
    const row = this.database.prepare("SELECT * FROM ccx_access_log WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toEntry(row) : undefined;
  }

  /** Reads of one person's material — what that person, or an auditor, asks for. */
  listForSubject(subjectUserId: string, limit = 200): AccessLogEntry[] {
    const rows = this.database
      .prepare("SELECT * FROM ccx_access_log WHERE subject_user_id = ? ORDER BY at DESC, id DESC LIMIT ?")
      .all(subjectUserId, limit) as Array<Record<string, unknown>>;
    return rows.map(toEntry);
  }

  /** What one administrator has looked at. Visible to other administrators. */
  listByActor(actorUserId: string, limit = 200): AccessLogEntry[] {
    const rows = this.database
      .prepare("SELECT * FROM ccx_access_log WHERE actor_user_id = ? ORDER BY at DESC, id DESC LIMIT ?")
      .all(actorUserId, limit) as Array<Record<string, unknown>>;
    return rows.map(toEntry);
  }

  listRecent(limit = 200): AccessLogEntry[] {
    const rows = this.database
      .prepare("SELECT * FROM ccx_access_log ORDER BY at DESC, id DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(toEntry);
  }

  close(): void {
    this.database.close();
  }
}

function toEntry(row: Record<string, unknown>): AccessLogEntry {
  return {
    action: String(row.action ?? "read-session") as AccessAction,
    actorUserId: String(row.actor_user_id ?? ""),
    at: String(row.at ?? ""),
    id: Number(row.id ?? 0),
    reason: String(row.reason ?? ""),
    sessionId: String(row.session_id ?? ""),
    subjectUserId: String(row.subject_user_id ?? "")
  };
}

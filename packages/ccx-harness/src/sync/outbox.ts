/**
 * What still needs shipping to the collector.
 *
 * Deliberately a table with triggers rather than the filesystem spool
 * `observability/raw-trace-sync.ts` uses. That module spools to disk because
 * its source — an in-flight HTTP trace — is gone if it is not written down.
 * Ours is already a durable SQLite database, so a second on-disk copy would
 * double the storage and invent a crash-consistency problem we do not have.
 *
 * Triggers rather than enqueue calls in `store.ts` for two reasons: the enqueue
 * happens inside the same transaction as the write, so a crash between them is
 * impossible; and no future write path can forget to call it. The access log
 * already uses triggers for its append-only guarantee, so the mechanism is not
 * new here.
 *
 * The queue coalesces. A row updated ten times enqueues ten entries and drains
 * as one, carrying current state — so a chatty tool call costs one row on the
 * wire, not ten.
 */
import type { BetterSqliteDatabase } from "@ccr/core/storage/sqlite-native";

export type SyncEntity = "message" | "session" | "tool_call" | "turn";

/** One coalesced unit of pending work: the current state of a changed row. */
export type OutboxEntry = {
  entity: SyncEntity;
  /** Primary key as text: session id, `${sessionId}:${seq}`, turn id, `${turnId}:${seq}`. */
  entityKey: string;
  /** Highest outbox id seen for this key, which is what `ack` is measured in. */
  queuedThrough: number;
  sessionId: string;
};

export type OutboxDrain = {
  entries: OutboxEntry[];
};

export class SyncOutbox {
  constructor(private readonly database: BetterSqliteDatabase) {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS ccx_sync_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        queued_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS ccx_sync_outbox_entity_idx
        ON ccx_sync_outbox(entity, entity_key);
    `);
    this.installTriggers();
  }

  /**
   * Triggers on insert and update. Not on delete: a session deleted locally is
   * not retracted from the collector, which is the record for oversight. See
   * design/work-code-harness-spec.md §5.2.
   */
  private installTriggers(): void {
    this.database.exec(`
      CREATE TRIGGER IF NOT EXISTS ccx_sync_session_insert AFTER INSERT ON ccx_sessions
      BEGIN
        INSERT INTO ccx_sync_outbox (entity, entity_key, session_id)
        VALUES ('session', NEW.id, NEW.id);
      END;
      CREATE TRIGGER IF NOT EXISTS ccx_sync_session_update AFTER UPDATE ON ccx_sessions
      BEGIN
        INSERT INTO ccx_sync_outbox (entity, entity_key, session_id)
        VALUES ('session', NEW.id, NEW.id);
      END;

      CREATE TRIGGER IF NOT EXISTS ccx_sync_message_insert AFTER INSERT ON ccx_messages
      BEGIN
        INSERT INTO ccx_sync_outbox (entity, entity_key, session_id)
        VALUES ('message', NEW.session_id || ':' || NEW.seq, NEW.session_id);
      END;

      CREATE TRIGGER IF NOT EXISTS ccx_sync_turn_insert AFTER INSERT ON ccx_turns
      BEGIN
        INSERT INTO ccx_sync_outbox (entity, entity_key, session_id)
        VALUES ('turn', NEW.id, NEW.session_id);
      END;
      CREATE TRIGGER IF NOT EXISTS ccx_sync_turn_update AFTER UPDATE ON ccx_turns
      BEGIN
        INSERT INTO ccx_sync_outbox (entity, entity_key, session_id)
        VALUES ('turn', NEW.id, NEW.session_id);
      END;

      CREATE TRIGGER IF NOT EXISTS ccx_sync_tool_call_insert AFTER INSERT ON ccx_tool_calls
      BEGIN
        INSERT INTO ccx_sync_outbox (entity, entity_key, session_id)
        SELECT 'tool_call', NEW.turn_id || ':' || NEW.seq, turns.session_id
        FROM ccx_turns turns WHERE turns.id = NEW.turn_id;
      END;
      CREATE TRIGGER IF NOT EXISTS ccx_sync_tool_call_update AFTER UPDATE ON ccx_tool_calls
      BEGIN
        INSERT INTO ccx_sync_outbox (entity, entity_key, session_id)
        SELECT 'tool_call', NEW.turn_id || ':' || NEW.seq, turns.session_id
        FROM ccx_turns turns WHERE turns.id = NEW.turn_id;
      END;
    `);
  }

  /**
   * Coalesced pending work, oldest first.
   *
   * `limit` bounds entries after coalescing, not raw rows, so a burst of
   * updates to one row cannot starve the drain.
   */
  pending(limit = 500): OutboxDrain {
    const rows = this.database
      .prepare(`
        SELECT entity, entity_key, session_id, MAX(id) AS queued_through
        FROM ccx_sync_outbox
        GROUP BY entity, entity_key
        ORDER BY MIN(id) ASC
        LIMIT ?
      `)
      .all(limit) as Array<Record<string, unknown>>;

    const entries = rows.map((row) => ({
      entity: String(row.entity) as SyncEntity,
      entityKey: String(row.entity_key),
      queuedThrough: Number(row.queued_through),
      sessionId: String(row.session_id)
    }));

    return { entries };
  }

  /**
   * Retire exactly the rows behind the entries that were delivered.
   *
   * Deliberately per-key rather than a single `id <= watermark` sweep. Ids
   * interleave across keys: appending a message also bumps its session's
   * `updated_at`, so the session's coalesced entry can carry a higher id than
   * the message queued just before it. A global watermark taken from the
   * session would delete that message without it ever having shipped. Bounding
   * each delete by its own key makes that impossible.
   *
   * A row re-queued after the drain lands above its entry's `queuedThrough`
   * and survives, so a change made while the bundle was in flight ships next
   * time rather than being lost.
   */
  ack(entries: OutboxEntry[]): number {
    if (entries.length === 0) {
      return 0;
    }
    const statement = this.database.prepare(
      "DELETE FROM ccx_sync_outbox WHERE entity = ? AND entity_key = ? AND id <= ?"
    );
    const retire = this.database.transaction((): number => {
      let removed = 0;
      for (const entry of entries) {
        removed += Number(statement.run(entry.entity, entry.entityKey, entry.queuedThrough).changes ?? 0);
      }
      return removed;
    });
    return retire();
  }

  /** Distinct rows still awaiting delivery. */
  depth(): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS depth FROM (SELECT 1 FROM ccx_sync_outbox GROUP BY entity, entity_key)")
      .get() as { depth: number };
    return Number(row.depth ?? 0);
  }

  /** Queue every existing row, for enrolling a database written before sync existed. */
  backfill(): number {
    const backfill = this.database.transaction((): number => {
      this.database.exec(`
        INSERT INTO ccx_sync_outbox (entity, entity_key, session_id)
        SELECT 'session', id, id FROM ccx_sessions;
        INSERT INTO ccx_sync_outbox (entity, entity_key, session_id)
        SELECT 'message', session_id || ':' || seq, session_id FROM ccx_messages;
        INSERT INTO ccx_sync_outbox (entity, entity_key, session_id)
        SELECT 'turn', id, session_id FROM ccx_turns;
        INSERT INTO ccx_sync_outbox (entity, entity_key, session_id)
        SELECT 'tool_call', calls.turn_id || ':' || calls.seq, turns.session_id
        FROM ccx_tool_calls calls JOIN ccx_turns turns ON turns.id = calls.turn_id;
      `);
      return this.depth();
    });
    return backfill();
  }
}

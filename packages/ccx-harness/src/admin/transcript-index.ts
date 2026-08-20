/**
 * Full-text index over transcripts, for the admin console's search.
 *
 * Built from the application rather than by SQLite triggers, deliberately. A
 * trigger can only insert the raw `content_json`, so FTS would tokenise the
 * JSON structure too and a search for "text" or "type" would match every
 * message ever stored. Catching up in JS lets `messageText` flatten a message
 * into what a person actually said first.
 *
 * The catch-up is a watermark over `ccx_messages.id`, which works because that
 * column is a monotonic autoincrement and messages are write-once on the
 * collector. A crash mid-catch-up costs a re-scan of one batch, never a gap.
 *
 * Installed only where an admin console runs — the collector — so a laptop does
 * not carry a second copy of every conversation it has ever had.
 */
import type { BetterSqliteDatabase } from "@ccr/core/storage/sqlite-native";
import { messageText } from "./text";

export type IndexedHit = {
  messageId: number;
  seq: number;
  sessionId: string;
};

const catchUpBatch = 2_000;

export class TranscriptIndex {
  constructor(private readonly database: BetterSqliteDatabase) {
    this.database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ccx_message_fts USING fts5(
        body,
        session_id UNINDEXED,
        message_id UNINDEXED,
        seq UNINDEXED,
        tokenize = 'unicode61'
      );
      CREATE TABLE IF NOT EXISTS ccx_message_fts_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        watermark INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO ccx_message_fts_state (id, watermark) VALUES (1, 0);
    `);
  }

  /** Index everything appended since the last pass. Returns rows added. */
  catchUp(): number {
    let indexed = 0;
    for (;;) {
      const added = this.catchUpBatch();
      indexed += added;
      if (added < catchUpBatch) {
        return indexed;
      }
    }
  }

  private catchUpBatch(): number {
    const state = this.database
      .prepare("SELECT watermark FROM ccx_message_fts_state WHERE id = 1")
      .get() as { watermark: number };
    const rows = this.database
      .prepare(`
        SELECT id, session_id, seq, content_json
        FROM ccx_messages WHERE id > ? ORDER BY id ASC LIMIT ?
      `)
      .all(state.watermark, catchUpBatch) as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      return 0;
    }

    const insert = this.database.prepare(
      "INSERT INTO ccx_message_fts (body, session_id, message_id, seq) VALUES (?, ?, ?, ?)"
    );
    const advance = this.database.prepare("UPDATE ccx_message_fts_state SET watermark = ? WHERE id = 1");
    const run = this.database.transaction((): void => {
      for (const row of rows) {
        insert.run(
          messageText(parse(row.content_json)),
          String(row.session_id ?? ""),
          Number(row.id ?? 0),
          Number(row.seq ?? 0)
        );
      }
      advance.run(Number(rows[rows.length - 1]?.id ?? state.watermark));
    });
    run();
    return rows.length;
  }

  /**
   * Matching messages, newest first.
   *
   * The query is escaped into a quoted FTS phrase rather than passed through.
   * Admin search input reaching the FTS parser raw means a stray `"` or `*`
   * either errors or silently changes what was searched for — neither is
   * acceptable when the result is "these are all the conversations mentioning
   * X".
   */
  search(text: string, limit = 200): IndexedHit[] {
    const phrase = ftsPhrase(text);
    if (!phrase) {
      return [];
    }
    const rows = this.database
      .prepare(`
        SELECT session_id, message_id, seq FROM ccx_message_fts
        WHERE ccx_message_fts MATCH ? ORDER BY message_id DESC LIMIT ?
      `)
      .all(phrase, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      messageId: Number(row.message_id ?? 0),
      seq: Number(row.seq ?? 0),
      sessionId: String(row.session_id ?? "")
    }));
  }

  /** Drop index rows for a deleted session, so a delete is a real delete. */
  forgetSession(sessionId: string): void {
    this.database.prepare("DELETE FROM ccx_message_fts WHERE session_id = ?").run(sessionId);
  }

  size(): number {
    const row = this.database.prepare("SELECT COUNT(*) AS total FROM ccx_message_fts").get() as { total: number };
    return Number(row.total ?? 0);
  }
}

/**
 * Turn free text into an FTS5 query of quoted terms, ANDed.
 *
 * Every term is wrapped in double quotes with embedded quotes doubled, which is
 * FTS5's own escape. That makes every character in the user's input a literal:
 * no operators, no column filters, no prefix wildcards.
 */
export function ftsPhrase(text: string): string {
  const terms = text
    .split(/\s+/)
    .map((term) => term.replace(/"/g, '""'))
    .filter((term) => term.length > 0);
  return terms.map((term) => `"${term}"`).join(" AND ");
}

function parse(value: unknown): unknown {
  try {
    return JSON.parse(String(value ?? "null"));
  } catch {
    return value;
  }
}

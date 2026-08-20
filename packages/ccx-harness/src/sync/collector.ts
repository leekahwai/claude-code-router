/**
 * The central end of transcript sync.
 *
 * Modelled on `usage/billing-sync.ts`: shared-secret header, a bounded
 * seen-id cache in front of the authoritative store, and an explicit schema
 * string. The differences are deliberate.
 *
 * **Identity is resolved here, never accepted.** The wire format has no
 * `userId` field. Each session arrives with a credential fingerprint and this
 * class looks up the person an administrator bound it to. A session whose
 * fingerprint resolves to nobody is rejected — along with its messages, turns
 * and tool calls — while the rest of the bundle is still ingested, so one stale
 * key on one laptop does not block everyone else's transcripts.
 *
 * **Ingest is transactional per bundle.** A malformed row rolls back the whole
 * bundle rather than leaving the collector holding half a conversation, and the
 * device re-sends because it never received an ack.
 */
import { createHash } from "node:crypto";
import type { BetterSqliteDatabase } from "@ccr/core/storage/sqlite-native";
import type { FingerprintResolver } from "../identity/resolver";
import type { SessionStore } from "../session/store";
import { parseBundle, type SessionSyncBundle } from "./bundle";

export type IngestOutcome = {
  /** Session ids skipped because their fingerprint resolved to nobody. */
  unresolvedSessions: string[];
  accepted: { messages: number; sessions: number; toolCalls: number; turns: number };
  /** True when this bundle id had already been ingested. */
  duplicate: boolean;
  ok: boolean;
  reason?: string;
};

export type CollectorOptions = {
  database?: BetterSqliteDatabase;
  now?: () => string;
  resolver: FingerprintResolver;
  sessions: SessionStore;
  /** Shared secret a device must present. Empty disables transport auth. */
  token?: string;
};

const maxRememberedBundles = 2_000;

export class SessionSyncCollector {
  private readonly database: BetterSqliteDatabase;
  private readonly now: () => string;
  private readonly recentBundleIds: string[] = [];
  private readonly seenBundleIds = new Set<string>();

  constructor(private readonly options: CollectorOptions) {
    this.database = options.database ?? options.sessions.unsafeDatabase();
    this.now = options.now ?? (() => new Date().toISOString());
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS ccx_sync_receipts (
        bundle_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL DEFAULT '',
        received_at TEXT NOT NULL,
        sessions INTEGER NOT NULL DEFAULT 0,
        messages INTEGER NOT NULL DEFAULT 0,
        turns INTEGER NOT NULL DEFAULT 0,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        unresolved INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS ccx_sync_receipts_received_idx
        ON ccx_sync_receipts(received_at DESC);
    `);
  }

  /** Constant-time comparison so a wrong token cannot be guessed by timing. */
  authorize(presented: string | undefined): boolean {
    const expected = this.options.token ?? "";
    if (!expected) {
      return true;
    }
    const left = createHash("sha256").update(presented ?? "", "utf8").digest("hex");
    const right = createHash("sha256").update(expected, "utf8").digest("hex");
    return left === right;
  }

  ingest(value: unknown): IngestOutcome {
    const parsed = parseBundle(value);
    if (!parsed.ok) {
      return { accepted: empty(), duplicate: false, ok: false, reason: parsed.reason, unresolvedSessions: [] };
    }
    return this.ingestBundle(parsed.bundle);
  }

  ingestBundle(bundle: SessionSyncBundle): IngestOutcome {
    if (this.seenBundleIds.has(bundle.bundleId) || this.hasReceipt(bundle.bundleId)) {
      this.remember(bundle.bundleId);
      return { accepted: empty(), duplicate: true, ok: true, unresolvedSessions: [] };
    }

    const accepted = empty();
    const unresolvedSessions: string[] = [];
    // Sessions this bundle established or that the collector already holds,
    // used to decide whether a message or turn has somewhere to attach.
    const admitted = new Set<string>();

    try {
      this.options.sessions.transaction(() => {
        for (const session of bundle.sessions) {
          const resolution = this.options.resolver.resolveFingerprint(session.credentialFingerprint);
          if (!resolution.ok) {
            unresolvedSessions.push(session.id);
            continue;
          }
          this.options.sessions.upsertSession({
            createdAt: session.createdAt || this.now(),
            credentialFingerprint: session.credentialFingerprint,
            id: session.id,
            mode: session.mode,
            model: session.model,
            policyVersion: session.policyVersion,
            profileId: session.profileId,
            provider: session.provider,
            title: session.title,
            updatedAt: session.updatedAt || session.createdAt || this.now(),
            // Resolved, never taken from the wire.
            userId: resolution.identity.user.id
          });
          admitted.add(session.id);
          accepted.sessions += 1;
        }

        // A session already held by the collector counts as attachable: a
        // later bundle carrying only new messages must not be rejected just
        // because it did not repeat the session row.
        const attachable = (sessionId: string): boolean =>
          admitted.has(sessionId) ||
          (!unresolvedSessions.includes(sessionId) && this.options.sessions.hasSession(sessionId));

        for (const message of bundle.messages) {
          if (!attachable(message.sessionId)) {
            continue;
          }
          if (this.options.sessions.upsertMessage({
            content: message.content,
            createdAt: message.createdAt || this.now(),
            role: message.role,
            seq: message.seq,
            sessionId: message.sessionId
          })) {
            accepted.messages += 1;
          }
        }

        for (const turn of bundle.turns) {
          if (!attachable(turn.sessionId)) {
            continue;
          }
          this.options.sessions.upsertTurn({
            endedAt: turn.endedAt,
            error: turn.error,
            id: turn.id,
            requestId: turn.requestId,
            sessionId: turn.sessionId,
            startedAt: turn.startedAt || this.now(),
            status: turn.status
          });
          accepted.turns += 1;
        }

        for (const call of bundle.toolCalls) {
          if (!this.options.sessions.hasTurn(call.turnId)) {
            continue;
          }
          this.options.sessions.upsertToolCall({
            approvedBy: call.approvedBy,
            args: call.args,
            createdAt: this.now(),
            durationMs: call.durationMs,
            name: call.name,
            result: call.result,
            seq: call.seq,
            server: call.server,
            source: call.source,
            status: call.status,
            turnId: call.turnId
          });
          accepted.toolCalls += 1;
        }

        this.writeReceipt(bundle, accepted, unresolvedSessions.length);
      });
    } catch (error) {
      return {
        accepted: empty(),
        duplicate: false,
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        unresolvedSessions
      };
    }

    this.remember(bundle.bundleId);
    return { accepted, duplicate: false, ok: true, unresolvedSessions };
  }

  receiptCount(): number {
    const row = this.database.prepare("SELECT COUNT(*) AS total FROM ccx_sync_receipts").get() as { total: number };
    return Number(row.total ?? 0);
  }

  private hasReceipt(bundleId: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM ccx_sync_receipts WHERE bundle_id = ?").get(bundleId));
  }

  private writeReceipt(bundle: SessionSyncBundle, accepted: IngestOutcome["accepted"], unresolved: number): void {
    this.database
      .prepare(`
        INSERT INTO ccx_sync_receipts (
          bundle_id, device_id, received_at, sessions, messages, turns, tool_calls, unresolved
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(bundle_id) DO NOTHING
      `)
      .run(
        bundle.bundleId,
        bundle.device.id,
        this.now(),
        accepted.sessions,
        accepted.messages,
        accepted.turns,
        accepted.toolCalls,
        unresolved
      );
  }

  /** Bounded in-memory cache in front of the receipts table, as billing-sync does. */
  private remember(bundleId: string): void {
    if (this.seenBundleIds.has(bundleId)) {
      return;
    }
    this.seenBundleIds.add(bundleId);
    this.recentBundleIds.push(bundleId);
    while (this.recentBundleIds.length > maxRememberedBundles) {
      const evicted = this.recentBundleIds.shift();
      if (evicted) {
        this.seenBundleIds.delete(evicted);
      }
    }
  }
}

function empty(): IngestOutcome["accepted"] {
  return { messages: 0, sessions: 0, toolCalls: 0, turns: 0 };
}

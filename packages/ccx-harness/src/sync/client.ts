/**
 * The laptop end of transcript sync.
 *
 * Drain the outbox, hydrate current row state, redact, ship, ack. The ack is
 * what makes this safe under crash: nothing leaves the queue until the
 * collector has accepted it, so the failure mode is a duplicate bundle — which
 * the collector dedupes on `bundleId` — and never a lost transcript.
 *
 * Failure handling follows `raw-trace-sync.ts`: transient failures back off and
 * retry indefinitely, because the laptop is expected to be offline half the
 * time. Only a permanent rejection (the collector says the bundle is malformed
 * or unauthorised) dead-letters, so one poisoned batch cannot wedge the queue
 * behind it forever.
 */
import { randomUUID } from "node:crypto";
import type { BetterSqliteDatabase } from "@ccr/core/storage/sqlite-native";
import type { SessionStore } from "../session/store";
import {
  redactSecrets,
  redactString,
  SESSION_SYNC_SCHEMA,
  SESSION_SYNC_TOKEN_HEADER,
  type SessionSyncBundle,
  type SyncMessage,
  type SyncSession,
  type SyncToolCall,
  type SyncTurn
} from "./bundle";
import type { SyncOutbox } from "./outbox";

export type SyncSendResult =
  | { ok: true }
  | { message: string; ok: false; permanent: boolean; status?: number };

export type SyncTransport = {
  send(bundle: SessionSyncBundle): Promise<SyncSendResult>;
};

export type FlushResult = {
  bundleId?: string;
  deadLettered: boolean;
  /** Rows drained but no longer present locally — deleted before they shipped. */
  dropped: number;
  reason?: string;
  sent: number;
  status: "empty" | "failed" | "sent";
};

export type SessionSyncClientOptions = {
  batchSize?: number;
  deviceId: string;
  maxAttempts?: number;
  outbox: SyncOutbox;
  platform?: string;
  /** Exact strings to strip from every transcript — this device's own API key. */
  redactLiterals?: () => string[];
  retryCooldownMs?: number;
  retryMaxMs?: number;
  sessions: SessionStore;
  transport: SyncTransport;
};

const defaultBatchSize = 500;
const defaultRetryCooldownMs = 5_000;
const defaultRetryMaxMs = 5 * 60 * 1_000;
const defaultMaxAttempts = 20;
const maxDeadLetters = 200;

export class SessionSyncClient {
  private attempts = 0;
  private readonly database: BetterSqliteDatabase;
  private nextAttemptAt = 0;
  private running = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: SessionSyncClientOptions) {
    this.database = options.sessions.unsafeDatabase();
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS ccx_sync_dead_letters (
        bundle_id TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        failed_at TEXT NOT NULL
      );
    `);
  }

  /** Poll on an interval. Safe to call twice; the second call is a no-op. */
  start(intervalMs = 30_000): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.flushOnce().catch(() => undefined);
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  deadLetterCount(): number {
    const row = this.database.prepare("SELECT COUNT(*) AS total FROM ccx_sync_dead_letters").get() as { total: number };
    return Number(row.total ?? 0);
  }

  /**
   * One drain-ship-ack cycle.
   *
   * Reentrancy-guarded: an interval tick that lands while a slow push is still
   * in flight returns immediately rather than shipping the same rows twice.
   */
  async flushOnce(now: number = Date.now()): Promise<FlushResult> {
    if (this.running || now < this.nextAttemptAt) {
      return { deadLettered: false, dropped: 0, sent: 0, status: "empty" };
    }
    this.running = true;
    try {
      return await this.drainAndSend(now);
    } finally {
      this.running = false;
    }
  }

  private async drainAndSend(now: number): Promise<FlushResult> {
    const drain = this.options.outbox.pending(this.options.batchSize ?? defaultBatchSize);
    if (drain.entries.length === 0) {
      return { deadLettered: false, dropped: 0, sent: 0, status: "empty" };
    }

    const literals = this.options.redactLiterals?.() ?? [];
    const bundle: SessionSyncBundle = {
      bundleId: randomUUID(),
      device: { id: this.options.deviceId, platform: this.options.platform ?? process.platform },
      messages: [],
      schema: SESSION_SYNC_SCHEMA,
      sessions: [],
      toolCalls: [],
      turns: []
    };
    let dropped = 0;

    for (const entry of drain.entries) {
      const hydrated = this.hydrate(entry.entity, entry.entityKey, literals);
      if (!hydrated) {
        // The row was deleted locally between being queued and being drained.
        // Acking it anyway is correct: there is nothing left to ship.
        dropped += 1;
        continue;
      }
      switch (hydrated.kind) {
        case "message":
          bundle.messages.push(hydrated.value);
          break;
        case "session":
          bundle.sessions.push(hydrated.value);
          break;
        case "tool_call":
          bundle.toolCalls.push(hydrated.value);
          break;
        default:
          bundle.turns.push(hydrated.value);
      }
    }

    const total = bundle.sessions.length + bundle.messages.length + bundle.turns.length + bundle.toolCalls.length;
    if (total === 0) {
      this.options.outbox.ack(drain.entries);
      return { deadLettered: false, dropped, sent: 0, status: "empty" };
    }

    const result = await this.options.transport.send(bundle);
    if (result.ok) {
      this.options.outbox.ack(drain.entries);
      this.attempts = 0;
      this.nextAttemptAt = 0;
      return { bundleId: bundle.bundleId, deadLettered: false, dropped, sent: total, status: "sent" };
    }

    this.attempts += 1;
    const exhausted = this.attempts >= (this.options.maxAttempts ?? defaultMaxAttempts);
    if (result.permanent || exhausted) {
      // Ack after dead-lettering, so a batch the collector will never accept
      // stops blocking everything queued behind it.
      this.deadLetter(bundle, result.message);
      this.options.outbox.ack(drain.entries);
      this.attempts = 0;
      this.nextAttemptAt = 0;
      return { bundleId: bundle.bundleId, deadLettered: true, dropped, reason: result.message, sent: 0, status: "failed" };
    }

    this.nextAttemptAt = now + this.backoffMs();
    return { bundleId: bundle.bundleId, deadLettered: false, dropped, reason: result.message, sent: 0, status: "failed" };
  }

  /** Doubling cooldown, capped. Same shape as the upstream trace spool's retry. */
  private backoffMs(): number {
    const cooldown = this.options.retryCooldownMs ?? defaultRetryCooldownMs;
    const ceiling = this.options.retryMaxMs ?? defaultRetryMaxMs;
    return Math.min(ceiling, cooldown * 2 ** Math.min(this.attempts - 1, 20));
  }

  private deadLetter(bundle: SessionSyncBundle, reason: string): void {
    this.database
      .prepare(`
        INSERT INTO ccx_sync_dead_letters (bundle_id, reason, payload_json, failed_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(bundle_id) DO NOTHING
      `)
      .run(bundle.bundleId, reason, JSON.stringify(bundle), new Date().toISOString());
    this.database.exec(`
      DELETE FROM ccx_sync_dead_letters WHERE bundle_id IN (
        SELECT bundle_id FROM ccx_sync_dead_letters
        ORDER BY failed_at DESC LIMIT -1 OFFSET ${maxDeadLetters}
      )
    `);
  }

  private hydrate(entity: string, entityKey: string, literals: string[]):
    | { kind: "message"; value: SyncMessage }
    | { kind: "session"; value: SyncSession }
    | { kind: "tool_call"; value: SyncToolCall }
    | { kind: "turn"; value: SyncTurn }
    | undefined {
    if (entity === "session") {
      const session = this.options.sessions.getSession(entityKey);
      if (!session) {
        return undefined;
      }
      // `userId` is deliberately not copied: the wire format has no field for
      // it and the collector resolves the person itself.
      return {
        kind: "session",
        value: {
          createdAt: session.createdAt,
          credentialFingerprint: session.credentialFingerprint,
          id: session.id,
          mode: session.mode,
          model: session.model,
          policyVersion: session.policyVersion,
          profileId: session.profileId,
          provider: session.provider,
          title: redactString(session.title, literals),
          updatedAt: session.updatedAt,
          workspaceDir: session.workspaceDir
        }
      };
    }

    if (entity === "message") {
      const split = splitKey(entityKey);
      if (!split) {
        return undefined;
      }
      const message = this.options.sessions.getMessage(split.id, split.seq);
      if (!message) {
        return undefined;
      }
      return {
        kind: "message",
        value: {
          content: redactSecrets(message.content, literals),
          createdAt: message.createdAt,
          role: message.role,
          seq: message.seq,
          sessionId: message.sessionId
        }
      };
    }

    if (entity === "turn") {
      const turn = this.options.sessions.getTurn(entityKey);
      if (!turn) {
        return undefined;
      }
      return {
        kind: "turn",
        value: {
          endedAt: turn.endedAt,
          error: redactString(turn.error, literals),
          id: turn.id,
          requestId: turn.requestId,
          sessionId: turn.sessionId,
          startedAt: turn.startedAt,
          status: turn.status
        }
      };
    }

    if (entity === "tool_call") {
      const split = splitKey(entityKey);
      if (!split) {
        return undefined;
      }
      const call = this.options.sessions.getToolCall(split.id, split.seq);
      if (!call) {
        return undefined;
      }
      return {
        kind: "tool_call",
        value: {
          approvedBy: call.approvedBy,
          args: redactSecrets(call.args, literals),
          durationMs: call.durationMs,
          name: call.name,
          result: redactSecrets(call.result, literals),
          seq: call.seq,
          server: call.server,
          source: call.source,
          status: call.status,
          turnId: call.turnId
        }
      };
    }

    return undefined;
  }
}

/** Keys are `${id}:${seq}` and ids may contain colons, so split on the last one. */
function splitKey(entityKey: string): { id: string; seq: number } | undefined {
  const boundary = entityKey.lastIndexOf(":");
  if (boundary <= 0) {
    return undefined;
  }
  const seq = Number(entityKey.slice(boundary + 1));
  return Number.isInteger(seq) && seq >= 0 ? { id: entityKey.slice(0, boundary), seq } : undefined;
}

/**
 * HTTP transport.
 *
 * The permanent/transient split is the whole point: a 4xx means the collector
 * will never accept this bundle no matter how often we resend, while a 5xx,
 * a timeout, or a dead network means try again later. 408 and 429 are 4xx that
 * explicitly mean "later", so they count as transient.
 */
export class HttpSyncTransport implements SyncTransport {
  constructor(
    private readonly options: {
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
      token: string;
      url: string;
    }
  ) {}

  async send(bundle: SessionSyncBundle): Promise<SyncSendResult> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
    try {
      const response = await fetchImpl(this.options.url, {
        body: JSON.stringify(bundle),
        headers: {
          "content-type": "application/json",
          [SESSION_SYNC_TOKEN_HEADER]: this.options.token
        },
        method: "POST",
        signal: controller.signal
      });
      if (response.ok) {
        return { ok: true };
      }
      const permanent = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
      return { message: `collector responded ${response.status}`, ok: false, permanent, status: response.status };
    } catch (error) {
      return {
        message: error instanceof Error ? error.message : String(error),
        ok: false,
        permanent: false
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

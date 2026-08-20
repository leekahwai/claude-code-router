/**
 * The wire format for shipping transcripts to the collector.
 *
 * Two properties are structural rather than checked:
 *
 * 1. **A device cannot say who it is.** There is no `userId` field anywhere in
 *    this format. A session carries `credentialFingerprint` and the collector
 *    resolves the person from the binding an administrator recorded at issue
 *    time. A laptop that wanted to file its transcripts under someone else's
 *    name has nowhere to write the claim. See spec §4.4.
 * 2. **Secrets are removed before the bundle exists**, not before it is stored.
 *    `redactSecrets` runs on the way out of the harness, so a collector
 *    compromise cannot yield credentials that were never sent.
 *
 * Versioned by `schema`, like `ccr.fusion-usage.v1` upstream: a collector that
 * does not recognise the string rejects the bundle instead of guessing.
 */
import type { CcxMode, MessageRole, ToolCallSource, ToolCallStatus, TurnStatus } from "../session/store";

export const SESSION_SYNC_SCHEMA = "ccx.session-sync.v1";

/** Header carrying the collector's shared secret, mirroring `x-ccr-raw-trace-token`. */
export const SESSION_SYNC_TOKEN_HEADER = "x-ccx-session-sync";

/** Longest single string shipped; anything larger is truncated with a marker. */
export const maxSyncStringLength = 64 * 1024;

export type SyncSession = {
  createdAt: string;
  /** sha256 of the API key. The person is resolved from this, never claimed. */
  credentialFingerprint: string;
  id: string;
  mode: CcxMode;
  model: string;
  policyVersion: string;
  profileId: string;
  provider: string;
  title: string;
  updatedAt: string;
  workspaceDir: string;
};

export type SyncMessage = {
  content: unknown;
  createdAt: string;
  role: MessageRole;
  seq: number;
  sessionId: string;
};

export type SyncTurn = {
  endedAt: string;
  error: string;
  id: string;
  requestId: string;
  sessionId: string;
  startedAt: string;
  status: TurnStatus;
};

export type SyncToolCall = {
  approvedBy: string;
  args: unknown;
  durationMs: number;
  name: string;
  result: unknown;
  seq: number;
  server: string;
  source: ToolCallSource;
  status: ToolCallStatus;
  turnId: string;
};

export type SessionSyncBundle = {
  bundleId: string;
  device: { id: string; platform: string };
  messages: SyncMessage[];
  schema: string;
  sessions: SyncSession[];
  toolCalls: SyncToolCall[];
  turns: SyncTurn[];
};

export type BundleParse =
  | { bundle: SessionSyncBundle; ok: true }
  | { ok: false; reason: string };

/**
 * Credential shapes worth removing from a transcript before it leaves the
 * machine. Deliberately conservative: each pattern is anchored to a vendor
 * prefix or a structural marker, so ordinary prose and code are not mangled.
 *
 * This is not a general secret scanner and does not pretend to be — H7 owns
 * that. It covers the cases that actually show up in a transcript: a key echoed
 * by a shell command, pasted into a prompt, or read out of a config file.
 */
const secretPatterns: RegExp[] = [
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bccx-[A-Za-z0-9_-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[posur]_[A-Za-z0-9]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{20,}/g
];

export const redactionMarker = "[redacted]";
export const truncationMarker = "…[truncated]";

/**
 * Walk a JSON value replacing credentials and capping string length.
 *
 * `literals` are exact strings to remove regardless of shape — the caller
 * passes its own API key, which by construction matches nothing above once a
 * provider issues an unprefixed one.
 */
export function redactSecrets(value: unknown, literals: string[] = []): unknown {
  const meaningful = literals.map((literal) => literal.trim()).filter((literal) => literal.length >= 8);
  const seen = new WeakSet<object>();

  const walk = (input: unknown): unknown => {
    if (typeof input === "string") {
      return redactString(input, meaningful);
    }
    if (Array.isArray(input)) {
      return input.map(walk);
    }
    if (input && typeof input === "object") {
      // A cycle would otherwise hang the walk; tool results are usually parsed
      // JSON, but a caller can hand us a live object.
      if (seen.has(input)) {
        return "[circular]";
      }
      seen.add(input);
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([key, item]) => [key, walk(item)]));
    }
    return input;
  };

  return walk(value);
}

export function redactString(input: string, literals: string[] = []): string {
  let output = input;
  for (const literal of literals) {
    if (literal.length >= 8) {
      output = output.split(literal).join(redactionMarker);
    }
  }
  for (const pattern of secretPatterns) {
    output = output.replace(pattern, redactionMarker);
  }
  return output.length > maxSyncStringLength
    ? `${output.slice(0, maxSyncStringLength)}${truncationMarker}`
    : output;
}

/**
 * Validate an incoming bundle. Everything here is untrusted: it arrived over
 * HTTP from a laptop we do not control.
 */
export function parseBundle(value: unknown): BundleParse {
  if (!isRecord(value)) {
    return { ok: false, reason: "not an object" };
  }
  if (value.schema !== SESSION_SYNC_SCHEMA) {
    return { ok: false, reason: `unsupported schema ${JSON.stringify(value.schema)}` };
  }
  const bundleId = text(value.bundleId);
  if (!bundleId) {
    return { ok: false, reason: "missing bundleId" };
  }

  const device = isRecord(value.device) ? value.device : {};
  const sessions: SyncSession[] = [];
  for (const candidate of list(value.sessions)) {
    const id = text(candidate.id);
    const fingerprint = text(candidate.credentialFingerprint);
    const mode = text(candidate.mode);
    if (!id || !fingerprint || (mode !== "code" && mode !== "work")) {
      return { ok: false, reason: "invalid session" };
    }
    sessions.push({
      createdAt: text(candidate.createdAt) ?? "",
      credentialFingerprint: fingerprint,
      id,
      mode,
      model: text(candidate.model) ?? "",
      policyVersion: text(candidate.policyVersion) ?? "",
      profileId: text(candidate.profileId) ?? "",
      provider: text(candidate.provider) ?? "",
      title: text(candidate.title) ?? "",
      updatedAt: text(candidate.updatedAt) ?? "",
      workspaceDir: text(candidate.workspaceDir) ?? ""
    });
  }

  const messages: SyncMessage[] = [];
  for (const candidate of list(value.messages)) {
    const sessionId = text(candidate.sessionId);
    const role = text(candidate.role);
    const seq = integer(candidate.seq);
    if (!sessionId || seq === undefined || !isRole(role)) {
      return { ok: false, reason: "invalid message" };
    }
    messages.push({
      content: candidate.content ?? null,
      createdAt: text(candidate.createdAt) ?? "",
      role,
      seq,
      sessionId
    });
  }

  const turns: SyncTurn[] = [];
  for (const candidate of list(value.turns)) {
    const id = text(candidate.id);
    const sessionId = text(candidate.sessionId);
    const status = text(candidate.status);
    if (!id || !sessionId || !isTurnStatus(status)) {
      return { ok: false, reason: "invalid turn" };
    }
    turns.push({
      endedAt: text(candidate.endedAt) ?? "",
      error: text(candidate.error) ?? "",
      id,
      requestId: text(candidate.requestId) ?? "",
      sessionId,
      startedAt: text(candidate.startedAt) ?? "",
      status
    });
  }

  const toolCalls: SyncToolCall[] = [];
  for (const candidate of list(value.toolCalls)) {
    const turnId = text(candidate.turnId);
    const name = text(candidate.name);
    const seq = integer(candidate.seq);
    const source = text(candidate.source);
    if (!turnId || !name || seq === undefined || !isToolSource(source)) {
      return { ok: false, reason: "invalid tool call" };
    }
    toolCalls.push({
      approvedBy: text(candidate.approvedBy) ?? "",
      args: candidate.args ?? null,
      durationMs: integer(candidate.durationMs) ?? 0,
      name,
      result: candidate.result ?? null,
      seq,
      server: text(candidate.server) ?? "",
      source,
      status: (text(candidate.status) ?? "running") as ToolCallStatus,
      turnId
    });
  }

  return {
    bundle: {
      bundleId,
      device: { id: text(device.id) ?? "", platform: text(device.platform) ?? "" },
      messages,
      schema: SESSION_SYNC_SCHEMA,
      sessions,
      toolCalls,
      turns
    },
    ok: true
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function isRole(value: string | undefined): value is MessageRole {
  return value === "assistant" || value === "system" || value === "tool" || value === "user";
}

function isTurnStatus(value: string | undefined): value is TurnStatus {
  return value === "cancelled" || value === "error" || value === "running" || value === "succeeded";
}

function isToolSource(value: string | undefined): value is ToolCallSource {
  return value === "builtin" || value === "mcp" || value === "skill";
}

/**
 * The admin console's data layer.
 *
 * One rule shapes the whole file: **there is no path here that returns another
 * person's material without writing an access-log row first.** Reads go through
 * `SessionAuthorizer`, which enforces that structurally; the two operations this
 * class adds — search and deletion — log before they act, not after, so a
 * failure mid-way still leaves the attempt recorded.
 *
 * Search is a cross-user read even when it returns nothing. An administrator
 * who searches everyone's transcripts for a word has read everyone's
 * transcripts. The query text goes into the log with it.
 *
 * Deliberately UI-free and transport-free: the same class backs the collector's
 * HTTP API and can back anything else later. See spec §5.3.
 */
import type { AccessLog, AccessLogEntry } from "../identity/access-log";
import type { IdentityDirectory, UserRecord } from "../identity/directory";
import type { Identity } from "../identity/resolver";
import type { Authorized, SessionAuthorizer } from "../identity/authorization";
import type {
  CcxMode,
  MessageRecord,
  SessionRecord,
  SessionStore,
  ToolCallRecord,
  TurnRecord
} from "../session/store";
import { excerpt, messageText } from "./text";
import { TranscriptIndex } from "./transcript-index";

export type AdminOverview = {
  counts: { messages: number; sessions: number; toolCalls: number; turns: number };
  indexedMessages: number;
  recentAccess: AccessLogEntry[];
  /** Accounts still standing in for Active Directory. Empty is the goal. */
  temporaryAccounts: UserRecord[];
  users: number;
};

export type AdminUserRow = {
  bindings: { active: number; revoked: number };
  lastActiveAt: string;
  sessions: number;
  user: UserRecord;
};

export type AdminSearchQuery = {
  from?: string;
  limit?: number;
  mode?: CcxMode;
  /** Why this search is being run. Recorded verbatim in the access log. */
  reason?: string;
  text?: string;
  to?: string;
  userId?: string;
};

export type AdminSearchHit = {
  excerpt: string;
  matchedSeq: number;
  session: SessionRecord;
  user: UserRecord | undefined;
};

export type AdminTranscript = {
  messages: Array<MessageRecord & { text: string }>;
  session: SessionRecord;
  toolCalls: ToolCallRecord[];
  turns: TurnRecord[];
  user: UserRecord | undefined;
};

export type AdminExport = {
  exportedAt: string;
  sessions: Array<{
    messages: MessageRecord[];
    session: SessionRecord;
    toolCalls: ToolCallRecord[];
    turns: TurnRecord[];
  }>;
  user: UserRecord | undefined;
};

export type AdminConsoleOptions = {
  accessLog: AccessLog;
  authorizer: SessionAuthorizer;
  directory: IdentityDirectory;
  /** Absent disables text search; listing and reading still work. */
  index?: TranscriptIndex;
  now?: () => string;
  sessions: SessionStore;
};

const notPermitted = { allowed: false, reason: "Not permitted." } as const;

export class AdminConsole {
  private readonly now: () => string;

  constructor(private readonly options: AdminConsoleOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Bring the search index up to date. Cheap when nothing new arrived. */
  reindex(): number {
    return this.options.index?.catchUp() ?? 0;
  }

  overview(actor: Identity): Authorized<AdminOverview> {
    if (actor.role !== "admin") {
      return notPermitted;
    }
    this.reindex();
    return {
      allowed: true,
      value: {
        counts: this.options.sessions.counts(),
        indexedMessages: this.options.index?.size() ?? 0,
        recentAccess: this.options.accessLog.listRecent(20),
        temporaryAccounts: this.options.directory.listUsers().filter((user) => user.temporary),
        users: this.options.directory.countUsers()
      }
    };
  }

  users(actor: Identity): Authorized<AdminUserRow[]> {
    if (actor.role !== "admin") {
      return notPermitted;
    }
    const activity = new Map(this.options.sessions.activityByUser().map((row) => [row.userId, row]));
    const rows = this.options.directory.listUsers().map((user) => {
      const bindings = this.options.directory.listBindings(user.id);
      return {
        bindings: {
          active: bindings.filter((binding) => !binding.revokedAt).length,
          revoked: bindings.filter((binding) => binding.revokedAt).length
        },
        lastActiveAt: activity.get(user.id)?.lastActiveAt ?? "",
        sessions: activity.get(user.id)?.sessions ?? 0,
        user
      };
    });
    return { allowed: true, value: rows };
  }

  /**
   * Find sessions. Text matches run through the FTS index; without text this is
   * a filtered list.
   *
   * A non-admin may only search their own material, and doing so is not logged
   * — reading your own transcripts is not an event worth auditing. Anything
   * wider is logged before the query runs.
   */
  search(actor: Identity, query: AdminSearchQuery): Authorized<AdminSearchHit[]> {
    const ownScope = query.userId === actor.user.id;
    if (!ownScope && actor.role !== "admin") {
      return notPermitted;
    }
    if (!ownScope) {
      this.options.accessLog.record({
        action: "search",
        actorUserId: actor.user.id,
        at: this.now(),
        // The query, not just the fact of one: the log has to say what was
        // looked for or it cannot answer "was this fishing?".
        reason: describeSearch(query),
        sessionId: "",
        subjectUserId: query.userId ?? "*"
      });
    }

    const text = query.text?.trim() ?? "";
    const terms = text.split(/\s+/).filter(Boolean);
    let matchedSeqBySession: Map<string, number> | undefined;
    let ids: string[] | undefined;

    if (text) {
      this.reindex();
      const hits = this.options.index?.search(text, (query.limit ?? 50) * 10) ?? [];
      matchedSeqBySession = new Map();
      for (const hit of hits) {
        if (!matchedSeqBySession.has(hit.sessionId)) {
          matchedSeqBySession.set(hit.sessionId, hit.seq);
        }
      }
      ids = [...matchedSeqBySession.keys()];
      if (ids.length === 0) {
        return { allowed: true, value: [] };
      }
    }

    const sessions = this.options.sessions.querySessions({
      ...(query.from ? { from: query.from } : {}),
      ...(ids ? { ids } : {}),
      limit: query.limit ?? 50,
      ...(query.mode ? { mode: query.mode } : {}),
      ...(query.to ? { to: query.to } : {}),
      ...(ownScope || query.userId ? { userId: query.userId ?? actor.user.id } : {})
    });

    const hits = sessions.map((session) => {
      const matchedSeq = matchedSeqBySession?.get(session.id) ?? -1;
      const message = matchedSeq >= 0 ? this.options.sessions.getMessage(session.id, matchedSeq) : undefined;
      return {
        excerpt: message ? excerpt(messageText(message.content), terms) : session.title,
        matchedSeq,
        session,
        user: this.options.directory.getUser(session.userId)
      };
    });
    return { allowed: true, value: hits };
  }

  /** One conversation in full. Logged when it is not the reader's own. */
  transcript(actor: Identity, sessionId: string, reason = ""): Authorized<AdminTranscript> {
    const session = this.options.authorizer.readSession(actor, sessionId, reason);
    if (!session.allowed) {
      return session;
    }
    const turns = this.options.sessions.listTurns(sessionId);
    return {
      allowed: true,
      value: {
        messages: this.options.sessions.listMessages(sessionId).map((message) => ({
          ...message,
          text: messageText(message.content)
        })),
        session: session.value,
        toolCalls: turns.flatMap((turn) => this.options.sessions.listToolCalls(turn.id)),
        turns,
        user: this.options.directory.getUser(session.value.userId)
      }
    };
  }

  /** Everything held about one person, for a subject-access or audit request. */
  exportUser(actor: Identity, userId: string, reason = ""): Authorized<AdminExport> {
    const authorized = this.options.authorizer.exportUser(actor, userId, reason);
    if (!authorized.allowed) {
      return authorized;
    }
    return {
      allowed: true,
      value: {
        exportedAt: this.now(),
        sessions: authorized.value.map((session) => {
          const turns = this.options.sessions.listTurns(session.id);
          return {
            messages: this.options.sessions.listMessages(session.id),
            session,
            toolCalls: turns.flatMap((turn) => this.options.sessions.listToolCalls(turn.id)),
            turns
          };
        }),
        user: this.options.directory.getUser(userId)
      }
    };
  }

  /**
   * Delete one session.
   *
   * Logged before the delete, because afterwards there is nothing left to
   * describe. `reason` is required: an unexplained deletion of someone's
   * transcript is exactly what the log exists to make impossible.
   */
  deleteSession(actor: Identity, sessionId: string, reason: string): Authorized<{ deleted: boolean }> {
    if (actor.role !== "admin") {
      return notPermitted;
    }
    if (!reason.trim()) {
      return { allowed: false, reason: "A reason is required to delete a transcript." };
    }
    const session = this.options.sessions.getSession(sessionId);
    if (!session) {
      return { allowed: false, reason: "No such session." };
    }
    this.options.accessLog.record({
      action: "delete-session",
      actorUserId: actor.user.id,
      at: this.now(),
      reason,
      sessionId,
      subjectUserId: session.userId
    });
    this.options.sessions.deleteSession(sessionId);
    this.options.index?.forgetSession(sessionId);
    return { allowed: true, value: { deleted: true } };
  }

  /**
   * Delete every transcript belonging to one person, and revoke their
   * credentials so nothing new arrives.
   *
   * The user row itself stays: removing it would orphan the access-log entries
   * that record what was read of theirs, which is the opposite of what a
   * deletion request should achieve. It is marked suspended instead.
   */
  deleteUserData(actor: Identity, userId: string, reason: string): Authorized<{ sessions: number }> {
    if (actor.role !== "admin") {
      return notPermitted;
    }
    if (!reason.trim()) {
      return { allowed: false, reason: "A reason is required to delete a person's transcripts." };
    }
    const user = this.options.directory.getUser(userId);
    if (!user) {
      return { allowed: false, reason: "No such user." };
    }
    this.options.accessLog.record({
      action: "delete-user",
      actorUserId: actor.user.id,
      at: this.now(),
      reason,
      sessionId: "",
      subjectUserId: userId
    });

    const ids = this.options.sessions.deleteSessionsForUser(userId);
    for (const id of ids) {
      this.options.index?.forgetSession(id);
    }
    for (const binding of this.options.directory.listBindings(userId)) {
      if (!binding.revokedAt) {
        this.options.directory.revokeCredential(binding.fingerprint);
      }
    }
    this.options.directory.upsertUser({ ...user, status: "suspended" });
    return { allowed: true, value: { sessions: ids.length } };
  }

  /**
   * The audit trail.
   *
   * Readable by any administrator, including about other administrators — that
   * is the point of rule 3. Reading it is not itself logged: it would recurse,
   * and the log is append-only anyway, so nobody can read their way out of what
   * it already records.
   */
  accessLog(
    actor: Identity,
    filter: { actorUserId?: string; limit?: number; subjectUserId?: string } = {}
  ): Authorized<AccessLogEntry[]> {
    if (actor.role !== "admin") {
      // A person may see who has read their own material, and nothing else.
      if (filter.subjectUserId && filter.subjectUserId !== actor.user.id) {
        return notPermitted;
      }
      return { allowed: true, value: this.options.accessLog.listForSubject(actor.user.id, filter.limit ?? 200) };
    }
    if (filter.actorUserId) {
      return { allowed: true, value: this.options.accessLog.listByActor(filter.actorUserId, filter.limit ?? 200) };
    }
    if (filter.subjectUserId) {
      return { allowed: true, value: this.options.accessLog.listForSubject(filter.subjectUserId, filter.limit ?? 200) };
    }
    return { allowed: true, value: this.options.accessLog.listRecent(filter.limit ?? 200) };
  }
}

/** A one-line record of what was searched for, for the audit trail. */
function describeSearch(query: AdminSearchQuery): string {
  const parts: string[] = [];
  if (query.text?.trim()) {
    parts.push(`text=${JSON.stringify(query.text.trim())}`);
  }
  if (query.mode) {
    parts.push(`mode=${query.mode}`);
  }
  if (query.from) {
    parts.push(`from=${query.from}`);
  }
  if (query.to) {
    parts.push(`to=${query.to}`);
  }
  if (query.reason?.trim()) {
    parts.push(`reason=${JSON.stringify(query.reason.trim())}`);
  }
  return parts.length > 0 ? parts.join(" ") : "unfiltered search";
}

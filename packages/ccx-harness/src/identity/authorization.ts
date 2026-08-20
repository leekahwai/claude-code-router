/**
 * The three rules, enforced in one place.
 *
 *   1. A user may read only their own sessions.
 *   2. An administrator may read any session — and every such read is logged.
 *   3. The log is append-only and visible to administrators other than the reader.
 *
 * Rule 2 is enforced structurally: there is no code path that returns another
 * person's material without writing the log entry first. A separate "check" and
 * "log" would eventually be called out of order.
 */
import type { AccessLog } from "./access-log";
import type { Identity } from "./resolver";
import type { SessionRecord, SessionStore } from "../session/store";

export type Denied = { allowed: false; reason: string };
export type Granted<T> = { allowed: true; value: T };
export type Authorized<T> = Denied | Granted<T>;

export type AuthorizationOptions = {
  accessLog: AccessLog;
  sessions: SessionStore;
};

export class SessionAuthorizer {
  constructor(private readonly options: AuthorizationOptions) {}

  /**
   * Read one session. Owner reads are unlogged; every cross-user read writes an
   * access-log row before the data is returned.
   */
  readSession(actor: Identity, sessionId: string, reason = ""): Authorized<SessionRecord> {
    const session = this.options.sessions.getSession(sessionId);
    if (!session) {
      // Same answer whether it is missing or someone else's: an id should not
      // be probeable for existence.
      return { allowed: false, reason: "No such session." };
    }
    if (session.userId === actor.user.id) {
      return { allowed: true, value: session };
    }
    if (actor.role !== "admin") {
      return { allowed: false, reason: "No such session." };
    }

    this.options.accessLog.record({
      action: "read-session",
      actorUserId: actor.user.id,
      reason,
      sessionId,
      subjectUserId: session.userId
    });
    return { allowed: true, value: session };
  }

  /** Transcript of one session, under the same rule. */
  readMessages(actor: Identity, sessionId: string, reason = ""): Authorized<ReturnType<SessionStore["listMessages"]>> {
    const session = this.readSession(actor, sessionId, reason);
    if (!session.allowed) {
      return session;
    }
    return { allowed: true, value: this.options.sessions.listMessages(sessionId) };
  }

  /** List sessions for a person. Listing someone else's is itself a read. */
  listSessions(actor: Identity, subjectUserId: string, reason = ""): Authorized<SessionRecord[]> {
    if (subjectUserId !== actor.user.id) {
      if (actor.role !== "admin") {
        return { allowed: false, reason: "Not permitted." };
      }
      this.options.accessLog.record({
        action: "list-sessions",
        actorUserId: actor.user.id,
        reason,
        sessionId: "",
        subjectUserId
      });
    }
    return { allowed: true, value: this.options.sessions.listSessions(subjectUserId) };
  }

  /** Everything for one person, for an export or deletion request. */
  exportUser(actor: Identity, subjectUserId: string, reason = ""): Authorized<SessionRecord[]> {
    if (actor.role !== "admin" && subjectUserId !== actor.user.id) {
      return { allowed: false, reason: "Not permitted." };
    }
    if (subjectUserId !== actor.user.id) {
      this.options.accessLog.record({
        action: "export-user",
        actorUserId: actor.user.id,
        reason,
        sessionId: "",
        subjectUserId
      });
    }
    return { allowed: true, value: this.options.sessions.listSessions(subjectUserId, 10_000) };
  }
}

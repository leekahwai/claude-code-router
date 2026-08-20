/**
 * Typed client for the collector's admin API.
 *
 * The shapes here are declared, not imported from `@ccx/harness`: this bundle
 * is built for the browser platform with no node builtins, and the harness
 * package index pulls in SQLite. Keeping the wire types local means a drift
 * between them is caught by the API tests rather than by a broken page.
 *
 * The key lives in memory and, so a refresh does not lock the operator out, in
 * `sessionStorage` — which dies with the tab. Not `localStorage`: an admin
 * credential should not outlive the browsing session on a shared machine.
 */

export const adminKeyStorageKey = "ccx.admin.key";

export type AdminRole = "admin" | "user";

export type WhoAmI = {
  assurance: "claimed" | "verified";
  displayName: string;
  email: string;
  role: AdminRole;
  userId: string;
};

export type UserRecord = {
  createdAt: string;
  displayName: string;
  email: string;
  externalId: string;
  id: string;
  role: AdminRole;
  status: "active" | "suspended";
  temporary: boolean;
};

export type AccessLogEntry = {
  action: string;
  actorUserId: string;
  at: string;
  id: number;
  reason: string;
  sessionId: string;
  subjectUserId: string;
};

export type Overview = {
  counts: { messages: number; sessions: number; toolCalls: number; turns: number };
  indexedMessages: number;
  recentAccess: AccessLogEntry[];
  temporaryAccounts: UserRecord[];
  users: number;
};

export type UserRow = {
  bindings: { active: number; revoked: number };
  lastActiveAt: string;
  sessions: number;
  user: UserRecord;
};

export type SessionSummary = {
  createdAt: string;
  id: string;
  mode: "code" | "work";
  model: string;
  provider: string;
  title: string;
  updatedAt: string;
  userId: string;
};

export type SearchHit = {
  excerpt: string;
  matchedSeq: number;
  session: SessionSummary;
  user: UserRecord | undefined;
};

export type TranscriptMessage = {
  createdAt: string;
  role: "assistant" | "system" | "tool" | "user";
  seq: number;
  text: string;
};

export type ToolCall = {
  approvedBy: string;
  durationMs: number;
  name: string;
  seq: number;
  server: string;
  source: string;
  status: string;
  turnId: string;
};

export type Transcript = {
  messages: TranscriptMessage[];
  session: SessionSummary;
  toolCalls: ToolCall[];
  turns: Array<{ endedAt: string; error: string; id: string; startedAt: string; status: string }>;
  user: UserRecord | undefined;
};

export class AdminApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "AdminApiError";
  }
}

export type AdminApiOptions = {
  /** Injected in tests; defaults to the page's own origin. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  key: string;
};

export class AdminApi {
  constructor(private readonly options: AdminApiOptions) {}

  whoami(): Promise<WhoAmI> {
    return this.get<WhoAmI>("/whoami");
  }

  overview(): Promise<Overview> {
    return this.get<Overview>("/overview");
  }

  users(): Promise<UserRow[]> {
    return this.get<UserRow[]>("/users");
  }

  accessLog(filter: { actorUserId?: string; subjectUserId?: string } = {}): Promise<AccessLogEntry[]> {
    const params = new URLSearchParams();
    if (filter.actorUserId) {
      params.set("actorUserId", filter.actorUserId);
    }
    if (filter.subjectUserId) {
      params.set("subjectUserId", filter.subjectUserId);
    }
    const query = params.toString();
    return this.get<AccessLogEntry[]>(`/access-log${query ? `?${query}` : ""}`);
  }

  search(query: {
    mode?: "code" | "work";
    reason?: string;
    text?: string;
    userId?: string;
  }): Promise<SearchHit[]> {
    return this.post<SearchHit[]>("/search", query);
  }

  transcript(sessionId: string, reason: string): Promise<Transcript> {
    return this.post<Transcript>("/transcript", { reason, sessionId });
  }

  exportUser(userId: string, reason: string): Promise<unknown> {
    return this.post<unknown>("/export", { reason, userId });
  }

  deleteSession(sessionId: string, reason: string): Promise<{ deleted: boolean }> {
    return this.post<{ deleted: boolean }>("/delete-session", { reason, sessionId });
  }

  deleteUserData(userId: string, reason: string): Promise<{ sessions: number }> {
    return this.post<{ sessions: number }>("/delete-user-data", { reason, userId });
  }

  private get<T>(route: string): Promise<T> {
    return this.request<T>(route, undefined);
  }

  private post<T>(route: string, body: unknown): Promise<T> {
    return this.request<T>(route, body);
  }

  private async request<T>(route: string, body: unknown): Promise<T> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(`${this.options.baseUrl ?? ""}/__ccx/admin${route}`, {
      ...(body === undefined
        ? { method: "GET" }
        : { body: JSON.stringify(body), method: "POST" }),
      headers: {
        "content-type": "application/json",
        "x-ccx-admin-key": this.options.key
      }
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new AdminApiError(
        typeof payload.error === "string" ? payload.error : `Request failed (${response.status}).`,
        response.status
      );
    }
    return payload as T;
  }
}

/**
 * The admin console.
 *
 * Two things are deliberately loud rather than tucked away:
 *
 *   - **Assurance.** Every identity here is `claimed` until SSO lands, because
 *     an emailed key is transferable. A console that presented attribution as
 *     fact would invite decisions the data cannot support, so the banner says
 *     so on every page.
 *   - **The reason field.** Reading, exporting or deleting someone else's
 *     material writes an audit row containing this text. Putting it in the
 *     toolbar, always visible, makes the audit trail feel like part of the
 *     action rather than a surprise afterwards.
 */
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import {
  AdminApi,
  AdminApiError,
  adminKeyStorageKey,
  type AccessLogEntry,
  type Overview,
  type SearchHit,
  type Transcript,
  type UserRow
} from "./api";
import { adminReducer, initialAdminState, reasonRequired, type AdminTab } from "./state";

const tabs: Array<{ id: AdminTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "people", label: "People" },
  { id: "search", label: "Search" },
  { id: "audit", label: "Audit" }
];

export function App(): JSX.Element {
  const [key, setKey] = useState(() => readStoredKey());
  const [state, dispatch] = useReducer(adminReducer, initialAdminState);

  const api = useMemo(() => (key ? new AdminApi({ key }) : undefined), [key]);

  const run = useCallback(
    async <T,>(work: () => Promise<T>, onDone: (value: T) => void): Promise<void> => {
      dispatch({ type: "loading" });
      try {
        onDone(await work());
      } catch (error) {
        dispatch({
          error: error instanceof AdminApiError ? error.message : String(error),
          type: "error"
        });
      }
    },
    []
  );

  useEffect(() => {
    if (!api) {
      return;
    }
    void run(() => api.whoami(), (me) => dispatch({ me, type: "me" }));
  }, [api, run]);

  useEffect(() => {
    if (!api || !state.me || state.me.role !== "admin") {
      return;
    }
    if (state.tab === "overview" && !state.overview) {
      void run(() => api.overview(), (overview) => dispatch({ overview, type: "overview" }));
    }
    if (state.tab === "people" && state.users.length === 0) {
      void run(() => api.users(), (users) => dispatch({ type: "users", users }));
    }
    if (state.tab === "audit" && state.audit.length === 0) {
      void run(() => api.accessLog(), (audit) => dispatch({ audit, type: "audit" }));
    }
  }, [api, run, state.audit.length, state.me, state.overview, state.tab, state.users.length]);

  const signOut = (): void => {
    sessionStorage.removeItem(adminKeyStorageKey);
    setKey("");
    dispatch({ type: "signed-out" });
  };

  if (!api) {
    return <SignIn onKey={(value) => {
      sessionStorage.setItem(adminKeyStorageKey, value);
      setKey(value);
    }} />;
  }

  if (state.me && state.me.role !== "admin") {
    return (
      <main className="gate">
        <h1>Not an administrator</h1>
        <p>
          This key belongs to {state.me.displayName || state.me.userId}, who is not an administrator.
          The console shows nothing beyond your own activity.
        </p>
        <button className="primary" onClick={signOut} type="button">Use a different key</button>
      </main>
    );
  }

  return (
    <div className="shell">
      <header className="bar">
        <nav className="tabs">
          {tabs.map((tab) => (
            <button
              className={tab.id === state.tab ? "tab selected" : "tab"}
              key={tab.id}
              onClick={() => dispatch({ tab: tab.id, type: "tab" })}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <label className="reason">
          <span>Reason</span>
          <input
            onChange={(event) => dispatch({ reason: event.target.value, type: "reason" })}
            placeholder="Recorded in the audit log with every read"
            value={state.reason}
          />
        </label>
        <button className="ghost" onClick={signOut} type="button">Sign out</button>
      </header>

      {state.me ? (
        <p className="assurance" role="note">
          Signed in as <strong>{state.me.displayName || state.me.userId}</strong>. Identity is{" "}
          <strong>{state.me.assurance}</strong> — derived from an issued key, which is transferable.
          Treat attribution as a claim until single sign-on is connected.
        </p>
      ) : null}

      {state.error ? <p className="error" role="alert">{state.error}</p> : null}
      {state.loading ? <p className="loading">Working…</p> : null}

      <main className="content">
        {state.transcript ? (
          <TranscriptView
            onBack={() => dispatch({ transcript: undefined, type: "transcript" })}
            onDelete={(reason) => {
              const sessionId = state.transcript?.session.id;
              if (!sessionId) {
                return;
              }
              void run(
                () => api.deleteSession(sessionId, reason),
                () => {
                  dispatch({ transcript: undefined, type: "transcript" });
                  dispatch({ hits: state.hits.filter((hit) => hit.session.id !== sessionId), type: "hits" });
                }
              );
            }}
            reason={state.reason}
            transcript={state.transcript}
          />
        ) : (
          <>
            {state.tab === "overview" ? <OverviewView overview={state.overview} /> : null}
            {state.tab === "people" ? (
              <PeopleView
                onExport={(userId) => void run(
                  () => api.exportUser(userId, state.reason),
                  (payload) => download(`${userId}-transcripts.json`, payload)
                )}
                onInspect={(userId) => {
                  dispatch({ tab: "search", type: "tab" });
                  dispatch({ type: "scope", userId });
                  void run(
                    () => api.search({ reason: state.reason, userId }),
                    (hits) => dispatch({ hits, type: "hits" })
                  );
                }}
                reasonMissing={(userId) => reasonRequired(state, userId)}
                users={state.users}
              />
            ) : null}
            {state.tab === "search" ? (
              <SearchView
                hits={state.hits}
                onOpen={(sessionId) => void run(
                  () => api.transcript(sessionId, state.reason),
                  (transcript) => dispatch({ transcript, type: "transcript" })
                )}
                onQuery={(query) => dispatch({ query, type: "query" })}
                onSearch={() => void run(
                  () => api.search({
                    ...(state.query.trim() ? { text: state.query.trim() } : {}),
                    ...(state.reason.trim() ? { reason: state.reason.trim() } : {}),
                    ...(state.scopeUserId ? { userId: state.scopeUserId } : {})
                  }),
                  (hits) => dispatch({ hits, type: "hits" })
                )}
                onScope={(userId) => dispatch({ type: "scope", userId })}
                query={state.query}
                scopeUserId={state.scopeUserId}
                searched={state.searched}
              />
            ) : null}
            {state.tab === "audit" ? <AuditView entries={state.audit} /> : null}
          </>
        )}
      </main>
    </div>
  );
}

function SignIn({ onKey }: { onKey: (key: string) => void }): JSX.Element {
  const [value, setValue] = useState("");
  return (
    <main className="gate">
      <h1>Work / Code administration</h1>
      <p>
        Sign in with your issued API key. It is held for this browser tab only and is sent to the
        collector on each request — use this console over TLS.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim()) {
            onKey(value.trim());
          }
        }}
      >
        <input
          autoFocus
          onChange={(event) => setValue(event.target.value)}
          placeholder="API key"
          type="password"
          value={value}
        />
        <button className="primary" disabled={!value.trim()} type="submit">Sign in</button>
      </form>
    </main>
  );
}

function OverviewView({ overview }: { overview: Overview | undefined }): JSX.Element {
  if (!overview) {
    return <p className="empty">Loading the overview…</p>;
  }
  return (
    <section className="panel">
      <div className="stats">
        <Stat label="People" value={overview.users} />
        <Stat label="Sessions" value={overview.counts.sessions} />
        <Stat label="Messages" value={overview.counts.messages} />
        <Stat label="Turns" value={overview.counts.turns} />
        <Stat label="Tool calls" value={overview.counts.toolCalls} />
        <Stat label="Indexed" value={overview.indexedMessages} />
      </div>

      {overview.temporaryAccounts.length > 0 ? (
        <p className="warn" role="note">
          {overview.temporaryAccounts.length} temporary account
          {overview.temporaryAccounts.length === 1 ? "" : "s"} still active
          ({overview.temporaryAccounts.map((user) => user.id).join(", ")}). Replace with directory
          accounts and revoke the provisioning keys before rollout.
        </p>
      ) : null}

      <h2>Recent access</h2>
      <AuditTable entries={overview.recentAccess} />
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="stat">
      <span className="stat-value">{value.toLocaleString()}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function PeopleView({
  onExport,
  onInspect,
  reasonMissing,
  users
}: {
  onExport: (userId: string) => void;
  onInspect: (userId: string) => void;
  reasonMissing: (userId: string) => boolean;
  users: UserRow[];
}): JSX.Element {
  if (users.length === 0) {
    return <p className="empty">No people in the directory yet.</p>;
  }
  return (
    <section className="panel">
      <table className="grid">
        <thead>
          <tr>
            <th>Person</th>
            <th>Role</th>
            <th>Keys</th>
            <th>Sessions</th>
            <th>Last active</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.map((row) => (
            <tr key={row.user.id}>
              <td>
                <strong>{row.user.displayName || row.user.id}</strong>
                <span className="sub">{row.user.email || row.user.id}</span>
                {row.user.temporary ? <span className="pill warn-pill">temporary</span> : null}
                {row.user.status === "suspended" ? <span className="pill">suspended</span> : null}
              </td>
              <td>{row.user.role}</td>
              <td>
                {row.bindings.active} active
                {row.bindings.revoked > 0 ? <span className="sub">{row.bindings.revoked} revoked</span> : null}
              </td>
              <td>{row.sessions}</td>
              <td>{row.lastActiveAt ? row.lastActiveAt.slice(0, 16).replace("T", " ") : "—"}</td>
              <td className="actions">
                <button
                  disabled={reasonMissing(row.user.id)}
                  onClick={() => onInspect(row.user.id)}
                  title={reasonMissing(row.user.id) ? "Enter a reason first" : "Browse this person's sessions"}
                  type="button"
                >
                  Sessions
                </button>
                <button
                  disabled={reasonMissing(row.user.id)}
                  onClick={() => onExport(row.user.id)}
                  title={reasonMissing(row.user.id) ? "Enter a reason first" : "Download everything held"}
                  type="button"
                >
                  Export
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function SearchView({
  hits,
  onOpen,
  onQuery,
  onScope,
  onSearch,
  query,
  scopeUserId,
  searched
}: {
  hits: SearchHit[];
  onOpen: (sessionId: string) => void;
  onQuery: (query: string) => void;
  onScope: (userId: string) => void;
  onSearch: () => void;
  query: string;
  scopeUserId: string;
  searched: boolean;
}): JSX.Element {
  return (
    <section className="panel">
      <form
        className="search"
        onSubmit={(event) => {
          event.preventDefault();
          onSearch();
        }}
      >
        <input
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Search transcripts"
          value={query}
        />
        <input
          onChange={(event) => onScope(event.target.value)}
          placeholder="Limit to one person (optional)"
          value={scopeUserId}
        />
        <button className="primary" type="submit">Search</button>
      </form>
      <p className="note">
        Searching across people is itself a read of their transcripts, and is recorded in the audit
        log with the query text.
      </p>

      {hits.length === 0 ? (
        <p className="empty">{searched ? "Nothing matched." : "Run a search to see sessions."}</p>
      ) : (
        <ul className="hits">
          {hits.map((hit) => (
            <li key={hit.session.id}>
              <button onClick={() => onOpen(hit.session.id)} type="button">
                <span className="hit-title">{hit.session.title || hit.session.id}</span>
                <span className="hit-meta">
                  {hit.user?.displayName || hit.session.userId} · {hit.session.mode} · {hit.session.model} ·{" "}
                  {hit.session.updatedAt.slice(0, 16).replace("T", " ")}
                </span>
                <span className="hit-excerpt">{hit.excerpt}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TranscriptView({
  onBack,
  onDelete,
  reason,
  transcript
}: {
  onBack: () => void;
  onDelete: (reason: string) => void;
  reason: string;
  transcript: Transcript;
}): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  return (
    <section className="panel">
      <div className="transcript-head">
        <button className="ghost" onClick={onBack} type="button">← Back</button>
        <div>
          <h2>{transcript.session.title || transcript.session.id}</h2>
          <p className="sub">
            {transcript.user?.displayName || transcript.session.userId} · {transcript.session.mode} ·{" "}
            {transcript.session.provider}/{transcript.session.model} ·{" "}
            {transcript.turns.length} turn{transcript.turns.length === 1 ? "" : "s"} ·{" "}
            {transcript.toolCalls.length} tool call{transcript.toolCalls.length === 1 ? "" : "s"}
          </p>
        </div>
        {confirming ? (
          <span className="confirm">
            <button
              className="danger"
              disabled={!reason.trim()}
              onClick={() => onDelete(reason)}
              title={reason.trim() ? "" : "A reason is required"}
              type="button"
            >
              Delete permanently
            </button>
            <button className="ghost" onClick={() => setConfirming(false)} type="button">Cancel</button>
          </span>
        ) : (
          <button className="ghost" onClick={() => setConfirming(true)} type="button">Delete…</button>
        )}
      </div>

      <ol className="messages">
        {transcript.messages.map((message) => (
          <li className={`message ${message.role}`} key={message.seq}>
            <span className="role">{message.role}</span>
            <pre>{message.text || "(no text)"}</pre>
          </li>
        ))}
      </ol>

      {transcript.toolCalls.length > 0 ? (
        <>
          <h3>Tool calls</h3>
          <table className="grid">
            <thead>
              <tr><th>Tool</th><th>Source</th><th>Status</th><th>Duration</th><th>Approved by</th></tr>
            </thead>
            <tbody>
              {transcript.toolCalls.map((call) => (
                <tr key={`${call.turnId}:${call.seq}`}>
                  <td>{call.server ? `${call.server}/${call.name}` : call.name}</td>
                  <td>{call.source}</td>
                  <td>{call.status}</td>
                  <td>{call.durationMs} ms</td>
                  <td>{call.approvedBy || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </section>
  );
}

function AuditView({ entries }: { entries: AccessLogEntry[] }): JSX.Element {
  return (
    <section className="panel">
      <p className="note">
        Append-only. Enforced by the database, not by convention, and visible to every
        administrator — including about other administrators.
      </p>
      <AuditTable entries={entries} />
    </section>
  );
}

function AuditTable({ entries }: { entries: AccessLogEntry[] }): JSX.Element {
  if (entries.length === 0) {
    return <p className="empty">Nothing has been read across people yet.</p>;
  }
  return (
    <table className="grid">
      <thead>
        <tr><th>When</th><th>Who</th><th>Did</th><th>To</th><th>Reason</th></tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr key={entry.id}>
            <td>{entry.at.slice(0, 19).replace("T", " ")}</td>
            <td>{entry.actorUserId}</td>
            <td><span className="pill">{entry.action}</span></td>
            <td>{entry.subjectUserId}{entry.sessionId ? <span className="sub">{entry.sessionId}</span> : null}</td>
            <td className="reason-cell">{entry.reason || "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function readStoredKey(): string {
  try {
    return sessionStorage.getItem(adminKeyStorageKey) ?? "";
  } catch {
    return "";
  }
}

/** Hand the operator a file without a server round trip. */
function download(name: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.download = name;
  anchor.href = url;
  anchor.click();
  URL.revokeObjectURL(url);
}

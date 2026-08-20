/**
 * The Work / Code conversation view.
 *
 * All transcript logic lives in the reducer (./state); this file is rendering
 * and IPC wiring only, which is what keeps the streaming behaviour testable.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type {
  CcxMessage,
  CcxPermissionAsk,
  CcxSessionSummary,
  CcxTurnEvent,
  CcxViewConfig
} from "@ccx/desktop/contract";
import { Configuration, type ModeDraft } from "./Configuration";
import {
  conversationReducer,
  initialConversation,
  type ConversationState,
  type ToolCardState,
  type TranscriptEntry
} from "./state";

type Bridge = {
  answerPermission(answer: { allow: boolean; id: string; remember: boolean }): Promise<boolean>;
  createSession(mode: "code" | "work"): Promise<CcxSessionSummary>;
  interrupt(sessionId: string): Promise<boolean>;
  listSessions(): Promise<CcxSessionSummary[]>;
  messages(sessionId: string): Promise<CcxMessage[]>;
  onPermissionAsk(handler: (ask: CcxPermissionAsk) => void): () => void;
  onTurnEvent(handler: (event: CcxTurnEvent) => void): () => void;
  startTurn(request: { sessionId: string; text: string }): Promise<unknown>;
  viewConfig(): Promise<CcxViewConfig>;
};

declare global {
  interface Window {
    ccx: Bridge;
  }
}

export function App() {
  const [config, setConfig] = useState<CcxViewConfig | undefined>();
  const [sessions, setSessions] = useState<CcxSessionSummary[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [state, dispatch] = useReducer(conversationReducer, initialConversation(""));
  const [configuring, setConfiguring] = useState(false);
  const [draft, setDraft] = useState<ModeDraft | undefined>();

  useEffect(() => {
    void window.ccx.viewConfig().then((loaded) => {
      setConfig(loaded);
      setDraft({
        mcpServers: [],
        model: loaded.model,
        reasoning: { effort: "high", mode: "auto", showReasoning: loaded.mode === "code" },
        skills: []
      });
    });
    void window.ccx.listSessions().then((list) => {
      setSessions(list);
      if (list[0]) {
        setSessionId(list[0].id);
      }
    });
  }, []);

  useEffect(() => {
    if (!sessionId) {
      return;
    }
    // Selecting first: the reducer filters events by session id, so it has to
    // know which session this view is showing before any event arrives.
    dispatch({ sessionId, type: "select" });
    void window.ccx.messages(sessionId).then((messages) => dispatch({ messages, type: "load-history" }));
  }, [sessionId]);

  useEffect(() => window.ccx.onTurnEvent((event) => dispatch({ event, type: "event" })), []);
  useEffect(() => window.ccx.onPermissionAsk((ask) => dispatch({ ask, type: "permission-ask" })), []);

  const startSession = useCallback(async (mode: "code" | "work") => {
    const created = await window.ccx.createSession(mode);
    setSessions((current) => [created, ...current]);
    setSessionId(created.id);
  }, []);

  const send = useCallback(
    (text: string) => {
      dispatch({ text, type: "submit" });
      void window.ccx.startTurn({ sessionId, text }).catch(() => undefined);
    },
    [sessionId]
  );

  const answer = useCallback((allow: boolean, remember: boolean) => {
    const id = state.pendingPermission?.id;
    dispatch({ type: "permission-resolved" });
    if (id) {
      void window.ccx.answerPermission({ allow, id, remember });
    }
  }, [state.pendingPermission?.id]);

  // The reducer owns the session id; the view renders exactly what it holds.
  const active = state;

  if (config?.blockedReason) {
    return <Blocked reason={config.blockedReason} />;
  }

  if (configuring && draft && config) {
    return (
      <Configuration
        availableMcpServers={[]}
        availableModels={[{ id: config.model, model: config.model, provider: "" }]}
        availableSkills={config.skills}
        draft={draft}
        mode={config.mode}
        onChange={setDraft}
        onClose={() => setConfiguring(false)}
      />
    );
  }

  return (
    <div className="shell">
      <Sidebar
        mode={config?.mode ?? "code"}
        onNew={startSession}
        onSelect={setSessionId}
        retentionNotice={config?.retentionNotice ?? ""}
        selected={sessionId}
        sessions={sessions}
      />
      <main className="pane">
        <Header
          mode={config?.mode ?? "code"}
          model={config?.model ?? ""}
          onConfigure={() => setConfiguring(true)}
          usage={active.usage}
        />
        <Transcript state={active} />
        {active.skillsLoaded.length > 0 ? <SkillChips names={active.skillsLoaded} /> : null}
        <Composer
          busy={active.busy}
          disabled={!sessionId}
          onSend={send}
          onStop={() => void window.ccx.interrupt(sessionId)}
        />
      </main>
      {active.pendingPermission ? <PermissionDialog ask={active.pendingPermission} onAnswer={answer} /> : null}
    </div>
  );
}

function Blocked({ reason }: { reason: string }) {
  return (
    <div className="blocked">
      <h1>Not ready yet</h1>
      <p>{reason}</p>
    </div>
  );
}

function Sidebar({
  mode,
  onNew,
  onSelect,
  retentionNotice,
  selected,
  sessions
}: {
  mode: "code" | "work";
  onNew: (mode: "code" | "work") => void;
  onSelect: (id: string) => void;
  retentionNotice: string;
  selected: string;
  sessions: CcxSessionSummary[];
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar-actions">
        <button className="primary" onClick={() => onNew(mode)} type="button">
          New {mode === "code" ? "Code" : "Work"} session
        </button>
      </div>
      <nav aria-label="Sessions" className="session-list">
        {sessions.length === 0 ? <p className="empty">No sessions yet.</p> : null}
        {sessions.map((session) => (
          <button
            aria-current={session.id === selected}
            className={session.id === selected ? "session selected" : "session"}
            key={session.id}
            onClick={() => onSelect(session.id)}
            type="button"
          >
            <span className="session-title">{session.title || "Untitled session"}</span>
            <span className="session-meta">
              <span className={`badge ${session.mode}`}>{session.mode}</span>
              {new Date(session.updatedAt).toLocaleDateString()}
            </span>
          </button>
        ))}
      </nav>
      {/* Stated where sessions are listed, not buried in a settings page. */}
      <p className="retention">{retentionNotice}</p>
    </aside>
  );
}

function Header({
  mode,
  model,
  onConfigure,
  usage
}: {
  mode: "code" | "work";
  model: string;
  onConfigure: () => void;
  usage: ConversationState["usage"];
}) {
  return (
    <header className="header">
      <span className={`badge ${mode}`}>{mode}</span>
      <span className="model">{model}</span>
      <span className="usage" title="Provider-reported once the turn completes">
        {usage.inputTokens.toLocaleString()} in · {usage.outputTokens.toLocaleString()} out
      </span>
      <button className="configure" onClick={onConfigure} type="button">
        Configuration
      </button>
    </header>
  );
}

function Transcript({ state }: { state: ConversationState }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [state.entries]);

  return (
    <div className="transcript">
      {state.entries.map((entry, index) => (
        <Entry entry={entry} key={index} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

function Entry({ entry }: { entry: TranscriptEntry }) {
  if (entry.kind === "user") {
    return <div className="bubble user">{entry.text}</div>;
  }
  if (entry.kind === "assistant") {
    return (
      <div className="bubble assistant">
        {entry.thinking ? <details className="thinking"><summary>Reasoning</summary>{entry.thinking}</details> : null}
        <div className="text">{entry.text}</div>
        {entry.streaming ? <span aria-label="Responding" className="caret" /> : null}
      </div>
    );
  }
  if (entry.kind === "tool") {
    return <ToolCard card={entry.card} />;
  }
  return <div className={`notice ${entry.tone}`}>{entry.text}</div>;
}

function ToolCard({ card }: { card: ToolCardState }) {
  return (
    <div className={`tool ${card.status}${card.isError ? " failed" : ""}`}>
      <div className="tool-head">
        <span className="tool-name">{card.name}</span>
        <span className="tool-status">
          {card.status === "running" ? "running…" : card.isError ? "failed" : "done"}
        </span>
      </div>
      {card.summary ? <pre className="tool-summary">{card.summary}</pre> : null}
    </div>
  );
}

function SkillChips({ names }: { names: string[] }) {
  return (
    <div className="chips" aria-label="Skills loaded this session">
      {names.map((name) => (
        <span className="chip" key={name}>
          {name}
        </span>
      ))}
    </div>
  );
}

function Composer({
  busy,
  disabled,
  onSend,
  onStop
}: {
  busy: boolean;
  disabled: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || busy || disabled) {
      return;
    }
    setText("");
    onSend(trimmed);
  };

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        aria-label="Message"
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // Enter sends; Shift+Enter is a newline, as everywhere else.
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={disabled ? "Start a session to begin." : "Ask for something…"}
        rows={3}
        value={text}
      />
      {busy ? (
        <button className="stop" onClick={onStop} type="button">
          Stop
        </button>
      ) : (
        <button className="primary" disabled={disabled || !text.trim()} type="submit">
          Send
        </button>
      )}
    </form>
  );
}

function PermissionDialog({
  ask,
  onAnswer
}: {
  ask: CcxPermissionAsk;
  onAnswer: (allow: boolean, remember: boolean) => void;
}) {
  const [remember, setRemember] = useState(false);
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="perm-title">
      <div className="modal">
        <h2 id="perm-title">Allow {ask.toolName}?</h2>
        <pre className="perm-detail">{ask.detail}</pre>
        <label className="remember">
          <input checked={remember} onChange={(event) => setRemember(event.target.checked)} type="checkbox" />
          Remember for this session
        </label>
        <div className="modal-actions">
          <button onClick={() => onAnswer(false, remember)} type="button">
            Decline
          </button>
          <button className="primary" onClick={() => onAnswer(true, remember)} type="button">
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}

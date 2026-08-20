/**
 * Admin console view state.
 *
 * A reducer rather than scattered `useState`, for the same reason the Work view
 * uses one: the interesting rules — you cannot act on someone's transcript
 * without a reason, a failed request must not leave a stale view on screen —
 * are testable here without a browser.
 */
import type { AccessLogEntry, Overview, SearchHit, Transcript, UserRow, WhoAmI } from "./api";

export type AdminTab = "audit" | "overview" | "people" | "search";

export type AdminState = {
  audit: AccessLogEntry[];
  error: string;
  /** The reason attached to the next cross-user action. Required for reads. */
  reason: string;
  hits: SearchHit[];
  loading: boolean;
  me: WhoAmI | undefined;
  overview: Overview | undefined;
  query: string;
  scopeUserId: string;
  searched: boolean;
  tab: AdminTab;
  transcript: Transcript | undefined;
  users: UserRow[];
};

export const initialAdminState: AdminState = {
  audit: [],
  error: "",
  hits: [],
  loading: false,
  me: undefined,
  overview: undefined,
  query: "",
  reason: "",
  scopeUserId: "",
  searched: false,
  tab: "overview",
  transcript: undefined,
  users: []
};

export type AdminAction =
  | { audit: AccessLogEntry[]; type: "audit" }
  | { error: string; type: "error" }
  | { hits: SearchHit[]; type: "hits" }
  | { me: WhoAmI; type: "me" }
  | { overview: Overview; type: "overview" }
  | { query: string; type: "query" }
  | { reason: string; type: "reason" }
  | { tab: AdminTab; type: "tab" }
  | { transcript: Transcript | undefined; type: "transcript" }
  | { type: "loading" }
  | { type: "signed-out" }
  | { userId: string; type: "scope" }
  | { users: UserRow[]; type: "users" };

export function adminReducer(state: AdminState, action: AdminAction): AdminState {
  switch (action.type) {
    case "loading":
      return { ...state, error: "", loading: true };

    case "error":
      // Clearing `loading` here and nowhere else is what stops a failed request
      // leaving a permanent spinner.
      return { ...state, error: action.error, loading: false };

    case "me":
      return { ...state, error: "", loading: false, me: action.me };

    case "overview":
      return { ...state, error: "", loading: false, overview: action.overview };

    case "users":
      return { ...state, error: "", loading: false, users: action.users };

    case "audit":
      return { ...state, audit: action.audit, error: "", loading: false };

    case "hits":
      return { ...state, error: "", hits: action.hits, loading: false, searched: true };

    case "transcript":
      return { ...state, error: "", loading: false, transcript: action.transcript };

    case "query":
      return { ...state, query: action.query };

    case "reason":
      return { ...state, reason: action.reason };

    case "scope":
      // Changing whose material is in view drops what was on screen: showing
      // one person's hits under another person's name is how an audit trail
      // gets misread.
      return { ...state, hits: [], scopeUserId: action.userId, searched: false, transcript: undefined };

    case "tab":
      return { ...state, error: "", tab: action.tab, transcript: undefined };

    case "signed-out":
      return { ...initialAdminState };

    default:
      return state;
  }
}

/**
 * Whether a cross-user action may proceed.
 *
 * Mirrors the server rule rather than replacing it — the console re-checks so
 * the operator is told before the round trip, and the server checks again
 * because a browser is not a security boundary.
 */
export function reasonRequired(state: AdminState, subjectUserId: string): boolean {
  return Boolean(state.me) && subjectUserId !== state.me?.userId && state.reason.trim().length === 0;
}

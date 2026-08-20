/**
 * Tool permissions.
 *
 * This is where the real difference between Work and Code lives. The prompt
 * difference between the two modes is cosmetic by comparison: what actually
 * separates them is that Work cannot run a shell or write to disk.
 *
 * Decisions are made here and never in the renderer, so a compromised or
 * simply buggy UI cannot grant a capability the mode does not have.
 */
export type ToolRisk = "execute" | "read" | "write";

export type PermissionDecision = "allow" | "ask" | "deny";

export type ModePolicy = {
  /** Risk levels the mode may use at all. Anything absent is denied outright. */
  allowed: Record<ToolRisk, PermissionDecision>;
  /** MCP servers this mode may reach; empty means all configured servers. */
  mcpServers?: string[];
};

/**
 * Defaults. Work is deliberately reads-and-MCP only: it is the mode people
 * will use for non-code tasks, and it has no reason to hold a shell.
 */
export const defaultModePolicies: Record<"code" | "work", ModePolicy> = {
  code: {
    allowed: { execute: "ask", read: "allow", write: "ask" }
  },
  work: {
    allowed: { execute: "deny", read: "allow", write: "deny" }
  }
};

export type PermissionRequest = {
  /** Human-readable summary of what is about to happen, for the prompt. */
  detail: string;
  risk: ToolRisk;
  toolName: string;
};

export type PermissionOutcome = {
  approvedBy: string;
  decision: "allow" | "deny";
  /** Set when the answer should apply to the rest of the session. */
  remember?: boolean;
};

/** Asks a human. Supplied by the desktop layer; absent means non-interactive. */
export type PermissionPrompter = (request: PermissionRequest) => Promise<PermissionOutcome>;

export type PermissionGateOptions = {
  policy: ModePolicy;
  prompter?: PermissionPrompter;
};

export class PermissionGate {
  private readonly remembered = new Map<string, "allow" | "deny">();

  constructor(private readonly options: PermissionGateOptions) {}

  /** Which servers this mode may reach, given everything configured. */
  allowedMcpServers(configured: string[]): string[] {
    const allowList = this.options.policy.mcpServers;
    return allowList && allowList.length > 0
      ? configured.filter((name) => allowList.includes(name))
      : configured;
  }

  async check(request: PermissionRequest): Promise<PermissionOutcome> {
    const policy = this.options.policy.allowed[request.risk];

    if (policy === "deny") {
      return {
        approvedBy: "policy",
        decision: "deny"
      };
    }
    if (policy === "allow") {
      return { approvedBy: "policy", decision: "allow" };
    }

    const remembered = this.remembered.get(this.key(request));
    if (remembered) {
      return { approvedBy: "session", decision: remembered };
    }

    if (!this.options.prompter) {
      // No one to ask. Denying is the only safe answer — a headless run must
      // not silently acquire a capability a human would have been asked about.
      return { approvedBy: "no-prompter", decision: "deny" };
    }

    const outcome = await this.options.prompter(request);
    if (outcome.remember) {
      this.remembered.set(this.key(request), outcome.decision);
    }
    return outcome;
  }

  /** Test and diagnostics hook: what has been remembered this session. */
  rememberedDecisions(): Array<{ decision: "allow" | "deny"; key: string }> {
    return [...this.remembered.entries()].map(([key, decision]) => ({ decision, key }));
  }

  private key(request: PermissionRequest): string {
    return `${request.risk}:${request.toolName}`;
  }
}

export function denialMessage(request: PermissionRequest, policy: ModePolicy): string {
  return policy.allowed[request.risk] === "deny"
    ? `The "${request.toolName}" tool is not available in this mode.`
    : `Permission to use "${request.toolName}" was declined.`;
}

/**
 * Assembles the harness for a mode and answers the contract.
 *
 * Kept free of Electron imports so it can be tested in plain Node; ipc.ts does
 * nothing but bind these methods to channels.
 */
import { randomUUID } from "node:crypto";
import {
  assembleSystemPrompt,
  BuiltinTools,
  CcxConfigStore,
  companyContextLayer,
  companyPolicyTokens,
  CompanyPackStore,
  credentialFingerprint,
  HarnessTools,
  McpRegistry,
  PermissionGate,
  resolveMode,
  resolvedMcpServers,
  SessionStore,
  SkillRegistry,
  TurnLoop,
  TurnMetricsStore,
  Workspace,
  type ResolvedMode
} from "@ccx/harness";
import type { AppConfig } from "@ccr/core/contracts/app";
import { DEFAULT_RETENTION_NOTICE, type CcxMessage, type CcxSessionSummary, type CcxViewConfig } from "./contract";
import { SessionService, type SessionServiceOptions } from "./session-service";

export type CcxRuntimeOptions = {
  /** The API key the user was issued. Never leaves the main process. */
  apiKey: string;
  config: CcxConfigStore;
  companyPack: CompanyPackStore;
  emit: SessionServiceOptions["emit"];
  ask: SessionServiceOptions["ask"];
  loadAppConfig: () => AppConfig;
  metrics: TurnMetricsStore;
  mode: "code" | "work";
  projectDirectory: string;
  sessions: SessionStore;
  userId: string;
};

export class CcxRuntime {
  readonly service: SessionService;
  private mcp?: McpRegistry;

  constructor(private readonly options: CcxRuntimeOptions) {
    this.service = new SessionService({
      ask: options.ask,
      emit: options.emit,
      loopFor: (sessionId) => this.buildLoop(sessionId),
      sessions: options.sessions
    });
  }

  /** Connect MCP once per window rather than per turn. */
  async start(): Promise<void> {
    const appConfig = this.options.loadAppConfig();
    const settings = this.options.config.load().modes[this.options.mode];
    const allowed = resolvedMcpServers(appConfig, settings);
    if (allowed.length === 0) {
      return;
    }
    this.mcp = new McpRegistry({ allowedServers: allowed, servers: appConfig.agent.mcpServers });
    await this.mcp.discover();
  }

  async stop(): Promise<void> {
    this.service.shutdown();
    await this.mcp?.close();
    this.mcp = undefined;
  }

  resolved(): ResolvedMode {
    return resolveMode({
      appConfig: this.options.loadAppConfig(),
      ccxConfig: this.options.config.load(),
      hasCredential: Boolean(this.options.apiKey.trim()),
      mode: this.options.mode
    });
  }

  viewConfig(): CcxViewConfig {
    const resolved = this.resolved();
    const skills = this.skills().list();
    return {
      ...(resolved.blockedReason ? { blockedReason: resolved.blockedReason } : {}),
      mode: this.options.mode,
      model: resolved.model,
      retentionNotice: DEFAULT_RETENTION_NOTICE,
      skills: skills.map((skill) => ({ description: skill.description, name: skill.name })),
      userId: this.options.userId
    };
  }

  listSessions(): CcxSessionSummary[] {
    return this.options.sessions.listSessions(this.options.userId).map((session) => ({
      createdAt: session.createdAt,
      id: session.id,
      mode: session.mode,
      model: session.model,
      title: session.title,
      updatedAt: session.updatedAt
    }));
  }

  createSession(mode: "code" | "work"): CcxSessionSummary {
    const resolved = this.resolved();
    if (resolved.blockedReason) {
      // The gate is enforced here, not only by disabling the composer: a
      // renderer bug must not be able to start an unconfigured session.
      throw new Error(resolved.blockedReason);
    }
    const created = this.options.sessions.createSession({
      credentialFingerprint: credentialFingerprint(this.options.apiKey),
      id: randomUUID(),
      mode,
      model: resolved.model,
      profileId: resolved.settings.profileId,
      provider: resolved.provider,
      title: "",
      userId: this.options.userId,
      workspaceDir: this.options.config.load().workspaceDir
    });
    return {
      createdAt: created.createdAt,
      id: created.id,
      mode: created.mode,
      model: created.model,
      title: created.title,
      updatedAt: created.updatedAt
    };
  }

  messages(sessionId: string): CcxMessage[] {
    const session = this.options.sessions.getSession(sessionId);
    // Session ownership is checked in main; a renderer cannot read another
    // user's transcript by guessing an id.
    if (!session || session.userId !== this.options.userId) {
      return [];
    }
    return this.options.sessions
      .listMessages(sessionId)
      .map((message) => ({ content: message.content, role: message.role, seq: message.seq }));
  }

  private skills(): SkillRegistry {
    const settings = this.options.config.load().modes[this.options.mode];
    const registry = new SkillRegistry({
      enabled: settings.skills,
      harness: "claude",
      projectDirectory: this.options.projectDirectory
    });
    registry.discover();
    return registry;
  }

  private buildLoop(sessionId: string): TurnLoop {
    const resolved = this.resolved();
    if (resolved.blockedReason) {
      throw new Error(resolved.blockedReason);
    }

    const settings = resolved.settings;
    const skills = this.skills();
    const pack = this.options.companyPack.load();
    const workspaceDir = this.options.config.load().workspaceDir || this.options.projectDirectory;
    const workspace = new Workspace(workspaceDir, { readRoots: skills.readRoots() });
    const gate = new PermissionGate({ policy: settings.policy, prompter: this.service.prompter(sessionId) });

    return new TurnLoop({
      apiKey: this.options.apiKey,
      baseUrl: resolved.baseUrl,
      metrics: this.options.metrics,
      model: resolved.model,
      // The company pack is Code-only, matching the context layering.
      ...(this.options.mode === "code" && pack.enabled
        ? { policyTokens: companyPolicyTokens(pack), policyVersion: pack.version }
        : {}),
      reasoning: settings.reasoning,
      sessions: this.options.sessions,
      system: assembleSystemPrompt({
        base: "You are the company Work/Code assistant.",
        ...(this.options.mode === "code" ? { companyContext: companyContextLayer(pack) } : {}),
        skillsMenu: skills.menu()
      }),
      tools: new HarnessTools({
        builtin: new BuiltinTools({ gate, policy: settings.policy, workspace }),
        ...(this.options.mode === "code" && pack.enabled ? { companyPack: this.options.companyPack } : {}),
        gate,
        ...(this.mcp ? { mcp: this.mcp } : {}),
        policy: settings.policy,
        skills
      }),
      userId: this.options.userId
    });
  }
}

/**
 * Our own configuration, kept out of CCR's AppConfig.
 *
 * The isolation strategy forbids adding fields to AppConfig: it would mean
 * owning an upstream migration path forever. We read CCR's config for providers
 * and models, and store our own choices beside it.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defaultReasoningPreference, type ReasoningPreference } from "../reasoning/map";
import { defaultModePolicies, type ModePolicy } from "../tools/permissions";
import { CCX_DATA_DIR } from "./paths";

export type CcxMode = "code" | "work";

export type ModeSettings = {
  /** Empty means "use the first available model". */
  model: string;
  /** MCP server names this mode may reach; empty means all configured. */
  mcpServers: string[];
  /** Skill names enabled for this mode; empty means all discovered. */
  skills: string[];
  policy: ModePolicy;
  provider: string;
  reasoning: ReasoningPreference;
  /** CCR profile this mode binds to, for per-mode cost attribution. */
  profileId: string;
};

/**
 * Where transcripts go for administrator retrieval.
 *
 * `token` is a shared secret sitting in a plaintext config file, which is the
 * same custody problem as the provider key on a laptop. H7 moves both to the OS
 * keychain; until then the secret is worth no more than the transport it
 * guards, and the collector still resolves identity from bindings rather than
 * trusting anything a device presents.
 */
export type SyncSettings = {
  /**
   * When the one-off enrolment of pre-existing sessions ran. Empty means it has
   * not; without this marker every launch would re-queue the whole history.
   */
  backfilledAt: string;
  /** Empty disables sync entirely; nothing is queued and nothing is sent. */
  collectorUrl: string;
  /** Stable per install, generated on first use. Diagnostic, never identity. */
  deviceId: string;
  intervalMs: number;
  token: string;
};

export type CcxConfig = {
  modes: Record<CcxMode, ModeSettings>;
  sync: SyncSettings;
  /** Where Code sessions run. Empty until the user picks one. */
  workspaceDir: string;
  /** Display name only; identity comes from the credential fingerprint. */
  userDisplayName: string;
};

export const defaultCcxConfig: CcxConfig = {
  modes: {
    code: {
      mcpServers: [],
      model: "",
      policy: defaultModePolicies.code,
      profileId: "ccx-code",
      provider: "",
      reasoning: { ...defaultReasoningPreference, effort: "high", showReasoning: true },
      skills: []
    },
    work: {
      mcpServers: [],
      model: "",
      policy: defaultModePolicies.work,
      profileId: "ccx-work",
      provider: "",
      reasoning: { ...defaultReasoningPreference, effort: "medium" },
      skills: []
    }
  },
  sync: { backfilledAt: "", collectorUrl: "", deviceId: "", intervalMs: 30_000, token: "" },
  userDisplayName: "",
  workspaceDir: ""
};

export class CcxConfigStore {
  private readonly file: string;

  constructor(private readonly directory: string = CCX_DATA_DIR) {
    this.file = path.join(directory, "config.json");
  }

  load(): CcxConfig {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<CcxConfig>;
      return {
        modes: {
          code: mergeMode(defaultCcxConfig.modes.code, parsed.modes?.code),
          work: mergeMode(defaultCcxConfig.modes.work, parsed.modes?.work)
        },
        sync: mergeSync(parsed.sync),
        userDisplayName: typeof parsed.userDisplayName === "string" ? parsed.userDisplayName : "",
        workspaceDir: typeof parsed.workspaceDir === "string" ? parsed.workspaceDir : ""
      };
    } catch {
      return structuredClone(defaultCcxConfig);
    }
  }

  save(config: CcxConfig): void {
    mkdirSync(this.directory, { mode: 0o700, recursive: true });
    writeFileSync(this.file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  updateMode(mode: CcxMode, patch: Partial<ModeSettings>): CcxConfig {
    const current = this.load();
    const next: CcxConfig = {
      ...current,
      modes: { ...current.modes, [mode]: { ...current.modes[mode], ...patch } }
    };
    this.save(next);
    return next;
  }
}

/**
 * Ensure the install has a device id, minting one the first time sync is read.
 *
 * Returns the config so the caller can persist it; the id is diagnostic — it
 * says which laptop a bundle came from — and is never used to decide identity.
 */
export function ensureDeviceId(store: CcxConfigStore): CcxConfig {
  const config = store.load();
  if (config.sync.deviceId) {
    return config;
  }
  const next: CcxConfig = { ...config, sync: { ...config.sync, deviceId: randomUUID() } };
  store.save(next);
  return next;
}

function mergeSync(stored: Partial<SyncSettings> | undefined): SyncSettings {
  const base = defaultCcxConfig.sync;
  if (!stored) {
    return { ...base };
  }
  const interval = typeof stored.intervalMs === "number" && stored.intervalMs >= 1_000
    ? stored.intervalMs
    : base.intervalMs;
  return {
    backfilledAt: typeof stored.backfilledAt === "string" ? stored.backfilledAt : base.backfilledAt,
    collectorUrl: typeof stored.collectorUrl === "string" ? stored.collectorUrl : base.collectorUrl,
    deviceId: typeof stored.deviceId === "string" ? stored.deviceId : base.deviceId,
    intervalMs: interval,
    token: typeof stored.token === "string" ? stored.token : base.token
  };
}

/**
 * A stored policy is merged field by field. A config written before a new risk
 * level existed must not silently drop back to a permissive default.
 */
function mergeMode(base: ModeSettings, stored: Partial<ModeSettings> | undefined): ModeSettings {
  if (!stored) {
    return structuredClone(base);
  }
  return {
    mcpServers: Array.isArray(stored.mcpServers) ? stored.mcpServers.filter(isString) : [...base.mcpServers],
    model: typeof stored.model === "string" ? stored.model : base.model,
    policy: {
      allowed: { ...base.policy.allowed, ...(stored.policy?.allowed ?? {}) },
      ...(stored.policy?.mcpServers ? { mcpServers: stored.policy.mcpServers } : {})
    },
    profileId: typeof stored.profileId === "string" && stored.profileId ? stored.profileId : base.profileId,
    provider: typeof stored.provider === "string" ? stored.provider : base.provider,
    reasoning: { ...base.reasoning, ...(stored.reasoning ?? {}) },
    skills: Array.isArray(stored.skills) ? stored.skills.filter(isString) : [...base.skills]
  };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

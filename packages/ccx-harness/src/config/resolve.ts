/**
 * Resolve a runnable configuration for one mode by combining our settings with
 * CCR's providers and models.
 *
 * The configuration page only *selects*; everything selectable comes from CCR.
 * That keeps one source of truth for providers and means a provider added in
 * CCR's own UI appears here without any sync step.
 *
 * This is also where the "no provider, no product" gate lives, using CCR's own
 * predicate rather than a second opinion about what counts as configured.
 */
import {
  availableGatewayModelIds,
  hasAvailableGatewayModels,
  isGatewayProviderEnabled,
  type AppConfig
} from "@ccr/core/contracts/app";
import type { CcxConfig, CcxMode, ModeSettings } from "./app-config";

export type ModelChoice = {
  id: string;
  model: string;
  provider: string;
};

export type ResolvedMode = {
  /** Set when the mode cannot run; the composer stays disabled. */
  blockedReason?: string;
  /** Base URL of the local gateway. */
  baseUrl: string;
  mode: CcxMode;
  model: string;
  provider: string;
  settings: ModeSettings;
};

/** Everything the configuration page can offer, drawn from CCR. */
export function availableModels(config: Pick<AppConfig, "Providers" | "virtualModelProfiles">): ModelChoice[] {
  return availableGatewayModelIds(config).map((id) => {
    const separator = id.indexOf("/");
    return separator === -1
      ? { id, model: id, provider: "" }
      : { id, model: id.slice(separator + 1), provider: id.slice(0, separator) };
  });
}

export function availableProviders(config: Pick<AppConfig, "Providers">): string[] {
  return config.Providers.filter(isGatewayProviderEnabled)
    .map((provider) => provider.name)
    .filter(Boolean);
}

export function gatewayBaseUrl(config: Pick<AppConfig, "HOST" | "PORT">): string {
  // 0.0.0.0 is a bind address, not somewhere a client can connect to.
  const host = !config.HOST || config.HOST === "0.0.0.0" || config.HOST === "::" ? "127.0.0.1" : config.HOST;
  return `http://${host}:${config.PORT}`;
}

export type ResolveModeInput = {
  appConfig: AppConfig;
  ccxConfig: CcxConfig;
  mode: CcxMode;
  /** Absent until the user has pasted the key they were emailed. */
  hasCredential?: boolean;
};

export function resolveMode(input: ResolveModeInput): ResolvedMode {
  const settings = input.ccxConfig.modes[input.mode];
  const baseUrl = gatewayBaseUrl(input.appConfig);
  const base: ResolvedMode = {
    baseUrl,
    mode: input.mode,
    model: settings.model,
    provider: settings.provider,
    settings
  };

  // CCR's own gate: no configured provider means nothing can run.
  if (!hasAvailableGatewayModels(input.appConfig)) {
    return {
      ...base,
      blockedReason:
        "No provider is configured yet. Add your provider API key in Claude Code Router, then come back."
    };
  }

  if (input.hasCredential === false) {
    return {
      ...base,
      blockedReason: "Enter the API key you were issued to start using this app."
    };
  }

  const choices = availableModels(input.appConfig);
  const chosen = settings.model
    ? choices.find((choice) => choice.id === settings.model || choice.model === settings.model)
    : undefined;

  if (settings.model && !chosen) {
    // A model that has gone away should say so rather than fail at request time.
    return {
      ...base,
      blockedReason: `The model "${settings.model}" is no longer available from your providers. Pick another in Configuration.`
    };
  }

  const fallback = choices[0];
  if (!chosen && !fallback) {
    return { ...base, blockedReason: "No models are available from the configured providers." };
  }

  const selected = chosen ?? fallback;
  return {
    ...base,
    model: selected.id,
    provider: settings.provider || selected.provider
  };
}

/**
 * MCP servers this mode may reach, intersected with what CCR has configured.
 * A server removed from CCR disappears here rather than failing on connect.
 */
export function resolvedMcpServers(appConfig: AppConfig, settings: ModeSettings): string[] {
  const configured = appConfig.agent.mcpServers.map((server) => server.name);
  return settings.mcpServers.length === 0
    ? configured
    : configured.filter((name) => settings.mcpServers.includes(name));
}

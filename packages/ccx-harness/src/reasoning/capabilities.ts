/**
 * What a model actually accepts for reasoning control.
 *
 * One UI preference has to become a correct request for whichever model CCR
 * routes to, and the rules differ sharply — the same `thinking` block that is
 * required on one model is a 400 on another. Getting this wrong produces a hard
 * request failure, not a degraded answer, so the constraints are modelled
 * explicitly rather than assumed.
 *
 * Capability resolution, most specific first:
 *   1. an admin override in config      (new models without a release)
 *   2. provider metadata from CCR       (supportedReasoningLevels / reasoningOptions)
 *   3. the built-in table below         (documented model families)
 *   4. "unsupported"                    (send nothing, say so in diagnostics)
 */

export type ReasoningEffort = "high" | "low" | "max" | "medium" | "xhigh";

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

/** How a model expects reasoning to be switched on. */
export type ThinkingControl =
  /** `thinking: {type:"adaptive"}`; the current Claude family. */
  | "adaptive"
  /** `thinking: {type:"enabled", budget_tokens:N}`; pre-4.6 Claude models. */
  | "budget"
  /** No reasoning control accepted. */
  | "none";

export type ModelReasoningCapability = {
  /** Effort values the model accepts, in `output_config.effort`. */
  efforts: readonly ReasoningEffort[];
  /** Whether `thinking: {type:"disabled"}` is accepted at all. */
  allowsDisabled: boolean;
  /**
   * Efforts at which `disabled` is rejected. Claude Opus 5 accepts disabled
   * only at effort `high` or below.
   */
  disabledRejectedAtEfforts?: readonly ReasoningEffort[];
  /** Omitting `thinking` entirely still reasons (thinking is on by default). */
  defaultOn: boolean;
  /** `budget_tokens` is rejected outright rather than merely deprecated. */
  rejectsBudgetTokens: boolean;
  /** temperature / top_p / top_k are rejected by the model. */
  rejectsSampling: boolean;
  /** Reasoning text is hidden unless `display: "summarized"` is requested. */
  summaryDefaultOmitted: boolean;
  control: ThinkingControl;
  /** Minimum for `budget_tokens` when control is "budget". */
  minBudgetTokens?: number;
};

const currentClaude = {
  allowsDisabled: true,
  control: "adaptive" as const,
  defaultOn: false,
  efforts: REASONING_EFFORTS,
  rejectsBudgetTokens: true,
  rejectsSampling: true,
  summaryDefaultOmitted: true
};

/**
 * Built-in table for model families whose rules are documented.
 *
 * Keys are matched as prefixes against the model id after any provider prefix
 * is stripped, so `anthropic/claude-opus-5` and `claude-opus-5` both resolve.
 * Longest match wins, which keeps `claude-opus-4-8` from matching `claude-opus-4`.
 */
const builtInCapabilities: Record<string, ModelReasoningCapability> = {
  // Thinking is always on; any explicit thinking config is rejected.
  "claude-fable-5": {
    ...currentClaude,
    allowsDisabled: false,
    defaultOn: true
  },
  "claude-mythos-5": {
    ...currentClaude,
    allowsDisabled: false,
    defaultOn: true
  },
  // Adaptive by default; disabled accepted only at effort high or below.
  "claude-opus-5": {
    ...currentClaude,
    defaultOn: true,
    disabledRejectedAtEfforts: ["xhigh", "max"]
  },
  // Adaptive is the only on-mode; omitting thinking means no thinking.
  "claude-opus-4-8": { ...currentClaude },
  "claude-opus-4-7": { ...currentClaude },
  "claude-sonnet-5": { ...currentClaude, defaultOn: true },
  // budget_tokens still functional here, and sampling is still allowed.
  "claude-opus-4-6": {
    allowsDisabled: true,
    control: "adaptive",
    defaultOn: false,
    efforts: ["low", "medium", "high", "max"],
    rejectsBudgetTokens: false,
    rejectsSampling: false,
    summaryDefaultOmitted: false
  },
  "claude-sonnet-4-6": {
    allowsDisabled: true,
    control: "adaptive",
    defaultOn: false,
    efforts: ["low", "medium", "high", "max"],
    rejectsBudgetTokens: false,
    rejectsSampling: false,
    summaryDefaultOmitted: false
  },
  // Pre-4.6: thinking needs an explicit token budget, and effort is rejected.
  "claude-haiku-4-5": {
    allowsDisabled: true,
    control: "budget",
    defaultOn: false,
    efforts: [],
    minBudgetTokens: 1024,
    rejectsBudgetTokens: false,
    rejectsSampling: false,
    summaryDefaultOmitted: false
  },
  "claude-sonnet-4-5": {
    allowsDisabled: true,
    control: "budget",
    defaultOn: false,
    efforts: [],
    minBudgetTokens: 1024,
    rejectsBudgetTokens: false,
    rejectsSampling: false,
    summaryDefaultOmitted: false
  }
};

export const unsupportedReasoning: ModelReasoningCapability = {
  allowsDisabled: false,
  control: "none",
  defaultOn: false,
  efforts: [],
  rejectsBudgetTokens: false,
  rejectsSampling: false,
  summaryDefaultOmitted: false
};

/** Reasoning facts CCR derives from provider metadata at runtime. */
export type CatalogReasoning = {
  defaultEffort?: string;
  efforts?: readonly string[];
  supportsReasoning?: boolean;
};

export type CapabilitySources = {
  /** Admin-configured overrides, keyed the same way as the built-in table. */
  overrides?: Record<string, Partial<ModelReasoningCapability>>;
  /** From CCR's modelCatalogReasoningEffortConfig for the routed model. */
  catalog?: CatalogReasoning;
};

/** Strip a `provider/` prefix so catalog ids and bare ids resolve alike. */
export function normalizeModelKey(model: string): string {
  const trimmed = model.trim().toLowerCase();
  const withoutProvider = trimmed.includes("/") ? trimmed.slice(trimmed.lastIndexOf("/") + 1) : trimmed;
  // Bedrock-style ids carry a vendor prefix and a version suffix.
  return withoutProvider.replace(/^anthropic\./, "").replace(/-v\d+:\d+$/, "");
}

function matchBuiltIn(key: string): ModelReasoningCapability | undefined {
  let best: { capability: ModelReasoningCapability; length: number } | undefined;
  for (const [prefix, capability] of Object.entries(builtInCapabilities)) {
    if (key.startsWith(prefix) && (!best || prefix.length > best.length)) {
      best = { capability, length: prefix.length };
    }
  }
  return best?.capability;
}

export function resolveReasoningCapability(
  model: string,
  sources: CapabilitySources = {}
): { capability: ModelReasoningCapability; source: "builtin" | "catalog" | "none" | "override" } {
  const key = normalizeModelKey(model);

  const override = sources.overrides
    ? Object.entries(sources.overrides)
        .filter(([prefix]) => key.startsWith(prefix.toLowerCase()))
        .sort(([left], [right]) => right.length - left.length)[0]?.[1]
    : undefined;

  const builtIn = matchBuiltIn(key);

  if (override) {
    return {
      capability: { ...(builtIn ?? unsupportedReasoning), ...override },
      source: "override"
    };
  }
  if (builtIn) {
    return { capability: builtIn, source: "builtin" };
  }
  // Provider metadata knows effort values for models we have no table for.
  if (sources.catalog?.supportsReasoning) {
    const efforts = (sources.catalog.efforts ?? [])
      .map((effort) => effort.trim().toLowerCase())
      .filter((effort): effort is ReasoningEffort => (REASONING_EFFORTS as readonly string[]).includes(effort));
    return {
      capability: {
        allowsDisabled: true,
        control: efforts.length > 0 ? "adaptive" : "none",
        defaultOn: false,
        efforts,
        rejectsBudgetTokens: false,
        rejectsSampling: false,
        summaryDefaultOmitted: false
      },
      source: "catalog"
    };
  }

  return { capability: unsupportedReasoning, source: "none" };
}

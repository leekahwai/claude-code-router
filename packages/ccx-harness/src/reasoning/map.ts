/**
 * Maps one UI reasoning preference onto whatever the routed model accepts.
 *
 * The mapper never sends a field a model rejects. Where a preference cannot be
 * honoured it degrades to the nearest legal setting and records a diagnostic,
 * so the UI can say "xhigh isn't supported here, using high" instead of the
 * user meeting a 400 from the provider.
 */
import {
  resolveReasoningCapability,
  REASONING_EFFORTS,
  type CapabilitySources,
  type ModelReasoningCapability,
  type ReasoningEffort
} from "./capabilities";

/** What the configuration page stores. Deliberately provider-neutral. */
export type ReasoningPreference = {
  /** "auto" defers to the model's own default. */
  effort: ReasoningEffort | "auto";
  /** "auto" omits the control entirely where that is legal. */
  mode: "auto" | "off" | "on";
  /** Ask for a readable summary of the reasoning, for display in the UI. */
  showReasoning: boolean;
  /** Only meaningful on models whose control is "budget". */
  budgetTokens?: number;
};

export const defaultReasoningPreference: ReasoningPreference = {
  effort: "auto",
  mode: "auto",
  showReasoning: false
};

export type ReasoningDiagnostic = {
  code:
    | "budget-clamped"
    | "budget-unsupported"
    | "disabled-unsupported"
    | "effort-unsupported"
    | "reasoning-unsupported"
    | "sampling-stripped"
    | "summary-unsupported";
  detail: string;
};

export type MappedReasoning = {
  /** Fields to merge into the request body. */
  body: Record<string, unknown>;
  capabilitySource: "builtin" | "catalog" | "none" | "override";
  diagnostics: ReasoningDiagnostic[];
  /** What the user asked for versus what will actually be sent. */
  effectiveEffort: ReasoningEffort | "model-default";
  thinkingEnabled: boolean;
};

export type MapReasoningInput = {
  maxTokens?: number;
  model: string;
  preference?: ReasoningPreference;
  /** Body the caller already intends to send, checked for illegal fields. */
  requestBody?: Record<string, unknown>;
  sources?: CapabilitySources;
};

const samplingFields = ["temperature", "top_k", "top_p"];

export function mapReasoning(input: MapReasoningInput): MappedReasoning {
  const preference = input.preference ?? defaultReasoningPreference;
  const { capability, source } = resolveReasoningCapability(input.model, input.sources);
  const diagnostics: ReasoningDiagnostic[] = [];
  const body: Record<string, unknown> = {};

  const effort = resolveEffort(preference, capability, diagnostics);
  const thinkingEnabled = applyThinking(preference, capability, effort, body, diagnostics, input);
  applyEffort(effort, capability, body);
  stripIllegalSampling(capability, input.requestBody, diagnostics);

  return {
    body,
    capabilitySource: source,
    diagnostics,
    effectiveEffort: effort ?? "model-default",
    thinkingEnabled
  };
}

function resolveEffort(
  preference: ReasoningPreference,
  capability: ModelReasoningCapability,
  diagnostics: ReasoningDiagnostic[]
): ReasoningEffort | undefined {
  if (preference.effort === "auto" || capability.efforts.length === 0) {
    if (preference.effort !== "auto" && capability.efforts.length === 0) {
      diagnostics.push({
        code: "effort-unsupported",
        detail: `Model does not accept an effort setting; "${preference.effort}" was dropped.`
      });
    }
    return undefined;
  }
  if (capability.efforts.includes(preference.effort)) {
    return preference.effort;
  }

  // Degrade to the nearest supported level below the request rather than
  // failing: a user who asked for more thinking should still get thinking.
  const requestedIndex = REASONING_EFFORTS.indexOf(preference.effort);
  const nearest = [...capability.efforts]
    .sort((left, right) => REASONING_EFFORTS.indexOf(right) - REASONING_EFFORTS.indexOf(left))
    .find((candidate) => REASONING_EFFORTS.indexOf(candidate) <= requestedIndex) ?? capability.efforts[0];

  diagnostics.push({
    code: "effort-unsupported",
    detail: `Effort "${preference.effort}" is not supported by this model; using "${nearest}".`
  });
  return nearest;
}

function applyThinking(
  preference: ReasoningPreference,
  capability: ModelReasoningCapability,
  effort: ReasoningEffort | undefined,
  body: Record<string, unknown>,
  diagnostics: ReasoningDiagnostic[],
  input: MapReasoningInput
): boolean {
  if (capability.control === "none") {
    if (preference.mode === "on") {
      diagnostics.push({
        code: "reasoning-unsupported",
        detail: "This model has no reasoning control; the request is sent without one."
      });
    }
    return false;
  }

  if (preference.mode === "off") {
    if (!capability.allowsDisabled) {
      diagnostics.push({
        code: "disabled-unsupported",
        detail: "This model always reasons; reasoning cannot be turned off."
      });
      return true;
    }
    // Disabling is rejected at the highest efforts on some models; the effort
    // setting wins, since the user asked for that much thinking.
    if (effort && capability.disabledRejectedAtEfforts?.includes(effort)) {
      diagnostics.push({
        code: "disabled-unsupported",
        detail: `Reasoning cannot be disabled at effort "${effort}" on this model; leaving it enabled.`
      });
      return true;
    }
    body.thinking = { type: "disabled" };
    return false;
  }

  if (capability.control === "budget") {
    return applyBudgetThinking(preference, capability, body, diagnostics, input);
  }

  // "auto" omits the control where omitting already reasons, which keeps the
  // request minimal and the cached prefix stable.
  if (preference.mode === "auto" && capability.defaultOn) {
    applySummary(preference, capability, body, true);
    return true;
  }

  body.thinking = { type: "adaptive" };
  applySummary(preference, capability, body, false);
  return true;
}

function applyBudgetThinking(
  preference: ReasoningPreference,
  capability: ModelReasoningCapability,
  body: Record<string, unknown>,
  diagnostics: ReasoningDiagnostic[],
  input: MapReasoningInput
): boolean {
  if (preference.mode === "auto" && preference.budgetTokens === undefined) {
    return false;
  }
  const minimum = capability.minBudgetTokens ?? 1024;
  const maxTokens = input.maxTokens ?? 0;
  let budget = preference.budgetTokens ?? minimum;

  if (budget < minimum) {
    diagnostics.push({
      code: "budget-clamped",
      detail: `Thinking budget raised to the ${minimum}-token minimum for this model.`
    });
    budget = minimum;
  }
  // The budget must stay below max_tokens or the request is rejected.
  if (maxTokens > 0 && budget >= maxTokens) {
    const clamped = Math.max(minimum, maxTokens - 1);
    diagnostics.push({
      code: "budget-clamped",
      detail: `Thinking budget must be below max_tokens (${maxTokens}); clamped to ${clamped}.`
    });
    budget = clamped;
  }
  body.thinking = { budget_tokens: budget, type: "enabled" };
  return true;
}

function applySummary(
  preference: ReasoningPreference,
  capability: ModelReasoningCapability,
  body: Record<string, unknown>,
  omittedControl: boolean
): void {
  if (!preference.showReasoning) {
    return;
  }
  if (!capability.summaryDefaultOmitted) {
    // Reasoning text is already returned; no extra field needed.
    return;
  }
  // Asking for a summary requires sending the control explicitly, even when it
  // would otherwise have been omitted.
  body.thinking = omittedControl
    ? { display: "summarized", type: "adaptive" }
    : { ...(body.thinking as Record<string, unknown>), display: "summarized" };
}

function applyEffort(
  effort: ReasoningEffort | undefined,
  capability: ModelReasoningCapability,
  body: Record<string, unknown>
): void {
  if (!effort || capability.efforts.length === 0) {
    return;
  }
  // Effort lives inside output_config, not at the top level.
  const existing = (body.output_config as Record<string, unknown> | undefined) ?? {};
  body.output_config = { ...existing, effort };
}

function stripIllegalSampling(
  capability: ModelReasoningCapability,
  requestBody: Record<string, unknown> | undefined,
  diagnostics: ReasoningDiagnostic[]
): void {
  if (!capability.rejectsSampling || !requestBody) {
    return;
  }
  const present = samplingFields.filter((field) => requestBody[field] !== undefined);
  if (present.length === 0) {
    return;
  }
  for (const field of present) {
    delete requestBody[field];
  }
  diagnostics.push({
    code: "sampling-stripped",
    detail: `This model rejects ${present.join(", ")}; removed from the request.`
  });
}

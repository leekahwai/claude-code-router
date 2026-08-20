/**
 * Configuration-page model for reasoning control.
 *
 * The page stores a provider-neutral preference; the harness maps it per model
 * at request time (@ccx/harness reasoning/map). The UI never encodes what a
 * particular model accepts — that knowledge lives in one place, so adding a
 * model does not mean touching the interface.
 */
import type { ReasoningPreference } from "@ccx/harness/reasoning/map";
import type { ReasoningEffort } from "@ccx/harness/reasoning/capabilities";

export type ReasoningModeOption = {
  description: string;
  label: string;
  value: ReasoningPreference["mode"];
};

export const reasoningModeOptions: ReasoningModeOption[] = [
  {
    description: "Let the model decide how much to reason. Recommended.",
    label: "Automatic",
    value: "auto"
  },
  {
    description: "Always reason before answering.",
    label: "Always on",
    value: "on"
  },
  {
    description: "Answer directly. Ignored by models that always reason.",
    label: "Off",
    value: "off"
  }
];

export type ReasoningEffortOption = {
  description: string;
  label: string;
  value: ReasoningEffort | "auto";
};

export const reasoningEffortOptions: ReasoningEffortOption[] = [
  { description: "Follow the model's own default.", label: "Automatic", value: "auto" },
  { description: "Fastest and cheapest. Good for simple edits.", label: "Low", value: "low" },
  { description: "Balanced.", label: "Medium", value: "medium" },
  { description: "Thorough. A good default for real work.", label: "High", value: "high" },
  { description: "Deeper still. Suits long agentic tasks.", label: "Extra high", value: "xhigh" },
  { description: "Maximum depth, highest cost.", label: "Maximum", value: "max" }
];

/** Per-mode defaults: Work favours speed, Code favours thoroughness. */
export const defaultReasoningByMode: Record<"code" | "work", ReasoningPreference> = {
  code: { effort: "high", mode: "auto", showReasoning: true },
  work: { effort: "medium", mode: "auto", showReasoning: false }
};

export type ReasoningFieldState = {
  /** Human-readable notes from the mapper, e.g. an effort that was degraded. */
  notes: string[];
  /** True when the routed model accepts no reasoning control at all. */
  unsupported: boolean;
};

/**
 * Turn mapper diagnostics into text for the configuration page, so a user sees
 * "not supported here, using high" rather than discovering it via a failure.
 */
export function reasoningFieldState(diagnostics: Array<{ code: string; detail: string }>): ReasoningFieldState {
  return {
    notes: diagnostics.map((diagnostic) => diagnostic.detail),
    unsupported: diagnostics.some((diagnostic) => diagnostic.code === "reasoning-unsupported")
  };
}

/**
 * Renderer surfaces for the Work/Code product — Work, Code, Configuration and
 * the admin console. Built in H5/H6; this package exists from H0 so the
 * boundary is established before there is pressure to put a view in
 * packages/ui/src/pages/home instead.
 */
export const CCX_UI_PAGES = ["work", "code", "configuration", "admin"] as const;
export type CcxUiPage = (typeof CCX_UI_PAGES)[number];

export {
  defaultReasoningByMode, reasoningEffortOptions, reasoningFieldState, reasoningModeOptions
} from "./reasoning-config";
export type { ReasoningEffortOption, ReasoningFieldState, ReasoningModeOption } from "./reasoning-config";

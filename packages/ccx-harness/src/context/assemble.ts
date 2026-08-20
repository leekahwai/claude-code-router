/**
 * System prompt assembly.
 *
 * One ordering, applied identically in both modes, so behaviour is
 * predictable. Layers 1-4 must be byte-stable across a session or prompt
 * caching breaks on every turn; anything volatile belongs in the session layer,
 * last.
 *
 * H4 inserts the company context pack at layer 3.
 */
export type SystemLayers = {
  /** 1. Who the harness is. */
  base?: string;
  /** 2. Company policy (the six-tier framework), injected at the gateway. */
  policy?: string;
  /** 3. Company context pack — Code mode only. */
  companyContext?: string;
  /** 4. Skills menu: names and descriptions only. */
  skillsMenu?: string;
  /** 5. Volatile session facts. Kept last so the prefix above stays stable. */
  session?: string;
};

const separator = "\n\n";

export function assembleSystemPrompt(layers: SystemLayers): string {
  return [layers.base, layers.policy, layers.companyContext, layers.skillsMenu, layers.session]
    .map((layer) => layer?.trim())
    .filter((layer): layer is string => Boolean(layer))
    .join(separator);
}

/**
 * The portion that must not change within a session. Exposed so a caching
 * regression can be asserted in a test rather than discovered on the bill.
 */
export function stableSystemPrefix(layers: SystemLayers): string {
  return assembleSystemPrompt({ ...layers, session: undefined });
}

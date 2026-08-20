/**
 * Token estimation — VENDORED FROM UPSTREAM CCR.
 *
 * @vendored-from  packages/core/src/gateway/claude-code-router-plugin.ts
 * @vendored-at    vendor-baseline (fcf3d85)
 * @vendored-on    2026-08-19
 * @owner          platform-team
 * @regions        estimate-text-tokens
 * @modifications  Hand-adapted, not generated. Exported, and a generalised
 *                 countTokens added for arbitrary JSON values. The
 *                 estimateTextTokens arithmetic itself is byte-identical to
 *                 upstream.
 * @why            CCR computes estimated_input_tokens with this function and
 *                 never persists it. Our policy_tokens sits beside that number
 *                 in the same dashboard, so it has to be measured with the same
 *                 ruler — reimplementing it would silently compare two
 *                 different estimators.
 */

/** Byte-identical to upstream. Do not tune independently. */
export function estimateTextTokens(text: string): number {
  const asciiWords = text.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g)?.length ?? 0;
  const cjkChars = text.match(/[㐀-鿿]/g)?.length ?? 0;
  return Math.max(1, Math.ceil((asciiWords + cjkChars) * 1.15));
}

/** Upstream's countUnknownTokens shape, generalised over any JSON value. */
export function countTokens(value: unknown): number {
  if (typeof value === "string") {
    return estimateTextTokens(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return 1;
  }
  if (Array.isArray(value)) {
    return value.reduce<number>((total, item) => total + countTokens(item), 0);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).reduce<number>((total, item) => total + countTokens(item), 0);
  }
  return 0;
}

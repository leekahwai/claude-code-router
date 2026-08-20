/**
 * Message content as plain text.
 *
 * A transcript row stores whatever the turn loop appended: a text block array
 * for a user prompt, mixed blocks for an assistant reply, tool-result blocks for
 * a tool round. The admin console needs one readable string per message — for
 * the search index, for an excerpt, and for an export a person can actually
 * read — so the shapes are flattened here rather than in four places.
 *
 * Thinking blocks are included. If an administrator is reading a transcript at
 * all, showing them a redacted version of what the model actually did would be
 * worse, not better.
 */

export type TextBlock = { text?: unknown; type?: unknown };

export function messageText(content: unknown): string {
  return collect(content, 0).join("\n").trim();
}

function collect(value: unknown, depth: number): string[] {
  if (depth > 8) {
    return [];
  }
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collect(item, depth + 1));
  }
  if (!value || typeof value !== "object") {
    return [];
  }

  const block = value as Record<string, unknown>;
  const type = typeof block.type === "string" ? block.type : "";

  if (type === "tool_use") {
    // The name plus its arguments: what the model asked to do.
    return [`${String(block.name ?? "tool")}(${compactJson(block.input)})`];
  }
  if (type === "tool_result") {
    return collect(block.content, depth + 1);
  }
  if (typeof block.text === "string") {
    return [block.text];
  }
  if (typeof block.thinking === "string") {
    return [block.thinking];
  }

  // An unrecognised block still has content worth indexing; walk its values
  // rather than dropping the message on the floor.
  return Object.values(block).flatMap((item) => collect(item, depth + 1));
}

function compactJson(value: unknown): string {
  try {
    const json = JSON.stringify(value ?? null);
    return json.length > 400 ? `${json.slice(0, 400)}…` : json;
  } catch {
    return "";
  }
}

/**
 * A window of `text` around the first occurrence of any search term.
 *
 * Falls back to the head of the message when nothing matches, so a hit found by
 * the index but not by this naive scan still shows something.
 */
export function excerpt(text: string, terms: string[], radius = 120): string {
  const haystack = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = haystack.indexOf(term.toLowerCase());
    if (found >= 0 && (at < 0 || found < at)) {
      at = found;
    }
  }
  if (at < 0) {
    return text.length > radius * 2 ? `${text.slice(0, radius * 2)}…` : text;
  }
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

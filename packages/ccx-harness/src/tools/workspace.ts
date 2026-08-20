/**
 * Workspace containment for the builtin file tools.
 *
 * Every path a tool touches is resolved here first. Containment is checked
 * against the *real* path, not the lexical one, so a symlink pointing outside
 * the workspace cannot be used to escape it — resolving lexically only would
 * accept `workspace/link` where `link -> /etc`.
 *
 * For paths that do not exist yet (a file about to be written) the nearest
 * existing ancestor is realpath'd instead, which catches a write through a
 * symlinked directory.
 */
import { realpathSync } from "node:fs";
import path from "node:path";

export class WorkspaceEscapeError extends Error {
  constructor(readonly requested: string) {
    super(`Path "${requested}" is outside the workspace.`);
    this.name = "WorkspaceEscapeError";
  }
}

export class Workspace {
  readonly root: string;

  constructor(root: string) {
    // The root itself is realpath'd once so comparisons are like-for-like on
    // platforms where the temp directory is itself a symlink.
    this.root = safeRealpath(path.resolve(root));
  }

  /**
   * Resolve a tool-supplied path inside the workspace.
   *
   * Absolute paths are permitted only when they already point inside the
   * workspace; relative paths are resolved against the root.
   */
  resolve(requested: string): string {
    const candidate = path.isAbsolute(requested)
      ? path.resolve(requested)
      : path.resolve(this.root, requested);

    const real = safeRealpath(candidate);
    if (!this.contains(real)) {
      throw new WorkspaceEscapeError(requested);
    }
    return candidate;
  }

  contains(target: string): boolean {
    const resolved = path.resolve(target);
    return resolved === this.root || resolved.startsWith(`${this.root}${path.sep}`);
  }

  /** Path relative to the workspace root, for display and logging. */
  relative(target: string): string {
    return path.relative(this.root, target) || ".";
  }
}

/**
 * realpath the deepest existing ancestor, then re-append the missing tail.
 * A plain realpath throws on a path that does not exist yet, which would make
 * writing a new file impossible.
 */
function safeRealpath(target: string): string {
  let current = target;
  const trailing: string[] = [];

  for (;;) {
    try {
      return path.join(realpathSync(current), ...trailing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return target;
      }
      trailing.push(path.basename(current));
      current = parent;
    }
  }
}

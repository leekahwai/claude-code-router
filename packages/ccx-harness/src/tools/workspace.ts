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

export type WorkspaceAccess = "read" | "write";

export type WorkspaceOptions = {
  /**
   * Extra roots that may be READ but never written — skill directories, which
   * live under the user's home rather than the project. Without this a skill
   * that ships a reference file or a script could only be reached by giving
   * the model a shell, which is precisely what Work mode withholds.
   */
  readRoots?: string[];
};

export class Workspace {
  readonly root: string;
  private readonly readRoots: string[];

  constructor(root: string, options: WorkspaceOptions = {}) {
    // The root itself is realpath'd once so comparisons are like-for-like on
    // platforms where the temp directory is itself a symlink.
    this.root = safeRealpath(path.resolve(root));
    this.readRoots = (options.readRoots ?? []).map((entry) => safeRealpath(path.resolve(entry)));
  }

  /**
   * Resolve a tool-supplied path.
   *
   * Writes are confined to the workspace root. Reads may also land in a
   * declared read-only root. Absolute paths are permitted only when they
   * already point somewhere allowed; relative paths resolve against the root.
   */
  resolve(requested: string, access: WorkspaceAccess = "write"): string {
    const candidate = path.isAbsolute(requested)
      ? path.resolve(requested)
      : path.resolve(this.root, requested);

    const real = safeRealpath(candidate);
    const permitted = access === "read" ? this.readable(real) : this.contains(real);
    if (!permitted) {
      throw new WorkspaceEscapeError(requested);
    }
    return candidate;
  }

  contains(target: string): boolean {
    return within(this.root, target);
  }

  /** Inside the workspace, or inside one of the declared read-only roots. */
  readable(target: string): boolean {
    return this.contains(target) || this.readRoots.some((root) => within(root, target));
  }

  /** Path relative to the workspace root, for display and logging. */
  relative(target: string): string {
    const resolved = path.resolve(target);
    if (this.contains(resolved)) {
      return path.relative(this.root, resolved) || ".";
    }
    // Outside the workspace (a skill file); an absolute path is clearer than
    // a relative one full of "..".
    return resolved;
  }
}

function within(root: string, target: string): boolean {
  const resolved = path.resolve(target);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
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

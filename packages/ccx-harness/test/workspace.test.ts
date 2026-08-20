import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Workspace, WorkspaceEscapeError } from "../src/tools/workspace.ts";

function scratch(): string {
  return mkdtempSync(path.join(os.tmpdir(), "ccx-ws-"));
}

test("relative paths resolve inside the workspace", () => {
  const root = scratch();
  try {
    const workspace = new Workspace(path.join(root, "proj"));
    mkdirSync(workspace.root, { recursive: true });
    const resolved = workspace.resolve("src/a.ts");
    assert.ok(workspace.contains(resolved));
    assert.equal(workspace.relative(resolved), path.join("src", "a.ts"));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("traversal out of the workspace is refused", () => {
  const root = scratch();
  try {
    const workspace = new Workspace(root);
    for (const attempt of ["../escape.txt", "../../etc/passwd", "src/../../outside.txt"]) {
      assert.throws(() => workspace.resolve(attempt), WorkspaceEscapeError, attempt);
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("an absolute path outside the workspace is refused", () => {
  const root = scratch();
  try {
    const workspace = new Workspace(root);
    assert.throws(() => workspace.resolve("/etc/passwd"), WorkspaceEscapeError);
    assert.throws(() => workspace.resolve(os.homedir()), WorkspaceEscapeError);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("an absolute path inside the workspace is allowed", () => {
  const root = scratch();
  try {
    const workspace = new Workspace(root);
    const inside = path.join(workspace.root, "notes.md");
    assert.equal(workspace.resolve(inside), inside);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a symlink pointing outside the workspace cannot be used to escape", () => {
  const root = scratch();
  const outside = scratch();
  try {
    writeFileSync(path.join(outside, "secret.txt"), "classified");
    const workspace = new Workspace(root);
    symlinkSync(outside, path.join(workspace.root, "link"), "dir");

    // Lexically this looks contained; only the real path reveals the escape.
    assert.throws(() => workspace.resolve("link/secret.txt"), WorkspaceEscapeError);
    assert.throws(() => workspace.resolve("link"), WorkspaceEscapeError);
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  }
});

test("writing through a symlinked directory to a new file is refused", () => {
  const root = scratch();
  const outside = scratch();
  try {
    const workspace = new Workspace(root);
    symlinkSync(outside, path.join(workspace.root, "out"), "dir");
    // The target does not exist yet — the nearest existing ancestor is checked.
    assert.throws(() => workspace.resolve("out/new-file.txt"), WorkspaceEscapeError);
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  }
});

test("a not-yet-existing path inside the workspace resolves", () => {
  const root = scratch();
  try {
    const workspace = new Workspace(root);
    const resolved = workspace.resolve("deep/nested/new.txt");
    assert.ok(workspace.contains(resolved));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a sibling directory sharing a name prefix is not contained", () => {
  const root = scratch();
  try {
    const workspace = new Workspace(path.join(root, "proj"));
    mkdirSync(workspace.root, { recursive: true });
    mkdirSync(path.join(root, "proj-evil"), { recursive: true });
    assert.equal(workspace.contains(path.join(root, "proj-evil", "x.txt")), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

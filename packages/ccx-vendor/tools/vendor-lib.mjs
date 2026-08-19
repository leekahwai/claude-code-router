/**
 * Shared helpers for the vendor provenance tooling.
 *
 * A "region" is a contiguous run of lines in an upstream file, located by a
 * regex on its first line and a regex on its closing line. Locating by pattern
 * rather than by line number means the check keeps working when upstream shifts
 * code around, which it does constantly.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const vendorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const manifestFile = path.join(vendorRoot, "vendor.manifest.json");

export function readManifest() {
  return JSON.parse(readFileSync(manifestFile, "utf8"));
}

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Read a file as it exists at a git ref. Returns undefined when absent. */
export function readFileAtRef(ref, filePath) {
  try {
    return execFileSync("git", ["show", `${ref}:${filePath}`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024
    });
  } catch {
    return undefined;
  }
}

export function refExists(ref) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function resolveRef(ref) {
  return execFileSync("git", ["rev-parse", "--short", ref], { encoding: "utf8" }).trim();
}

/**
 * Locate one region. Returns { startLine, endLine, text } with 1-based inclusive
 * line numbers, or { error } when the anchors do not match.
 */
export function locateRegion(source, region) {
  const lines = source.split("\n");
  const startPattern = new RegExp(region.startPattern);
  const endPattern = new RegExp(region.endPattern);

  const startIndex = lines.findIndex((line) => startPattern.test(line));
  if (startIndex < 0) {
    return { error: `start pattern did not match: ${region.startPattern}` };
  }

  let endIndex = -1;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (endPattern.test(lines[index])) {
      endIndex = index;
      break;
    }
  }
  if (endIndex < 0) {
    return { error: `end pattern did not match after line ${startIndex + 1}: ${region.endPattern}` };
  }

  return {
    endLine: endIndex + 1,
    startLine: startIndex + 1,
    text: lines.slice(startIndex, endIndex + 1).join("\n")
  };
}

/** Locate every region of an artifact at a ref, hashing each one. */
export function inspectArtifact(artifact, ref) {
  return artifact.regions.map((region) => {
    const source = readFileAtRef(ref, region.path);
    if (source === undefined) {
      return { id: region.id, region, status: "missing-file" };
    }
    const located = locateRegion(source, region);
    if (located.error) {
      return { detail: located.error, id: region.id, region, status: "not-found" };
    }
    return {
      endLine: located.endLine,
      id: region.id,
      region,
      sha256: sha256(located.text),
      startLine: located.startLine,
      status: "located",
      text: located.text
    };
  });
}

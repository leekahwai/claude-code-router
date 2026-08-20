/**
 * The company context pack: hidden instructions plus admin-curated reference
 * files, injected into Code mode.
 *
 * Two things this deliberately does NOT do:
 *
 *   - It does not inline reference files. Pasting every file into the system
 *     prompt on every request destroys the context budget and pays cache-write
 *     on each new session. The manifest lists titles and descriptions; the
 *     model pulls the two files it needs out of the forty you published.
 *   - It does not pretend to be invisible. "Hidden" means not rendered in the
 *     transcript. The text still appears in CCR's request logs and in whatever
 *     the provider retains, and the admin surface says so.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { countTokens } from "@ccx/vendor/core/gateway/token-estimate";
import { CCX_DATA_DIR } from "../config/paths";

export type CompanyReference = {
  description: string;
  /** Path relative to the pack's references directory. */
  path: string;
  sha256: string;
  bytes: number;
  title: string;
};

export type CompanyPack = {
  enabled: boolean;
  /** Inline is supported but discouraged; see the note above. */
  injection: "inline" | "manifest";
  references: CompanyReference[];
  /** Hidden instructions. This is where the six-tier framework lives. */
  systemText: string;
  /** Stamped on every request so a turn can be attributed to a pack version. */
  version: string;
};

export const emptyCompanyPack: CompanyPack = {
  enabled: false,
  injection: "manifest",
  references: [],
  systemText: "",
  version: "0"
};

/**
 * Placeholder for the six-tier framework. Replaced by the administrator; it is
 * shipped filled in only so the pipeline is exercised end to end before the
 * real text exists.
 */
export const sixTierFrameworkTemplate = [
  "# Engineering framework",
  "",
  "Apply these tiers in order. Later tiers never override an earlier one.",
  "",
  "1. Correctness — the change must do what it claims, and be verified.",
  "2. Safety — no data loss, no secret disclosure, no irreversible action unasked.",
  "3. Clarity — a colleague should be able to read it without explanation.",
  "4. Consistency — follow the conventions already present in the codebase.",
  "5. Efficiency — do not pay cost the task does not require.",
  "6. Completeness — leave nothing half-applied, and say what was left out.",
  "",
  "(Placeholder text. Replace with the approved company framework.)"
].join("\n");

const maxReferenceBytes = 1024 * 1024;

export class CompanyPackStore {
  readonly directory: string;
  readonly referencesDirectory: string;
  private readonly file: string;

  constructor(directory: string = path.join(CCX_DATA_DIR, "company")) {
    this.directory = directory;
    this.referencesDirectory = path.join(directory, "references");
    this.file = path.join(directory, "pack.json");
  }

  load(): CompanyPack {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<CompanyPack>;
      return {
        enabled: parsed.enabled === true,
        injection: parsed.injection === "inline" ? "inline" : "manifest",
        references: Array.isArray(parsed.references) ? parsed.references.filter(isReference) : [],
        systemText: typeof parsed.systemText === "string" ? parsed.systemText : "",
        version: typeof parsed.version === "string" && parsed.version ? parsed.version : "0"
      };
    } catch {
      return { ...emptyCompanyPack };
    }
  }

  save(pack: CompanyPack): void {
    mkdirSync(this.directory, { mode: 0o700, recursive: true });
    writeFileSync(this.file, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  }

  /** Add or replace a reference file, recording its hash for drift detection. */
  putReference(relativePath: string, content: string, meta: { description?: string; title?: string } = {}): CompanyPack {
    const safe = safeReferencePath(relativePath);
    const target = path.join(this.referencesDirectory, safe);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");

    const pack = this.load();
    const entry: CompanyReference = {
      bytes: Buffer.byteLength(content, "utf8"),
      description: meta.description ?? "",
      path: safe,
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
      title: meta.title ?? safe
    };
    const references = [...pack.references.filter((existing) => existing.path !== safe), entry].sort((left, right) =>
      left.path.localeCompare(right.path)
    );
    const next = { ...pack, references, version: bumpVersion(pack.version) };
    this.save(next);
    return next;
  }

  removeReference(relativePath: string): CompanyPack {
    const safe = safeReferencePath(relativePath);
    const pack = this.load();
    const next = {
      ...pack,
      references: pack.references.filter((entry) => entry.path !== safe),
      version: bumpVersion(pack.version)
    };
    this.save(next);
    return next;
  }

  /** Read one reference file. Confined to the references directory. */
  readReference(relativePath: string): string {
    const safe = safeReferencePath(relativePath);
    const target = path.join(this.referencesDirectory, safe);
    if (statSync(target).size > maxReferenceBytes) {
      throw new Error(`Reference "${safe}" exceeds ${maxReferenceBytes} bytes.`);
    }
    return readFileSync(target, "utf8");
  }

  /**
   * Files on disk whose hash no longer matches the manifest, or that the
   * manifest lists but which are missing. Drift here means the pack a user is
   * running is not the pack that was published.
   */
  drift(): { changed: string[]; missing: string[]; untracked: string[] } {
    const pack = this.load();
    const changed: string[] = [];
    const missing: string[] = [];

    for (const entry of pack.references) {
      const target = path.join(this.referencesDirectory, entry.path);
      if (!existsSync(target)) {
        missing.push(entry.path);
        continue;
      }
      const actual = createHash("sha256").update(readFileSync(target, "utf8"), "utf8").digest("hex");
      if (actual !== entry.sha256) {
        changed.push(entry.path);
      }
    }

    const tracked = new Set(pack.references.map((entry) => entry.path));
    const untracked = listFiles(this.referencesDirectory).filter((file) => !tracked.has(file));
    return { changed, missing, untracked };
  }
}

/**
 * The layer-3 text. Byte-stable for a given pack version, so it does not break
 * the cached prefix mid-session.
 */
export function companyContextLayer(pack: CompanyPack): string {
  if (!pack.enabled) {
    return "";
  }
  const sections = [pack.systemText.trim()].filter(Boolean);

  if (pack.references.length > 0) {
    if (pack.injection === "inline") {
      // Supported for small packs, but it grows the prefix without bound.
      sections.push("## Company reference material");
      for (const entry of pack.references) {
        sections.push(`### ${entry.title}\n(${entry.path})`);
      }
    } else {
      sections.push(
        [
          "## Company reference material",
          "Call the company_reference tool with a path below to read one. Do not guess at their contents.",
          ...pack.references.map(
            (entry) => `- ${entry.path} — ${entry.title}${entry.description ? `: ${entry.description}` : ""}`
          )
        ].join("\n")
      );
    }
  }

  return sections.join("\n\n");
}

/** What the pack costs, measured with the same estimator CCR uses. */
export function companyPolicyTokens(pack: CompanyPack): number {
  return pack.enabled ? countTokens(companyContextLayer(pack)) : 0;
}

function bumpVersion(current: string): string {
  const numeric = Number.parseInt(current, 10);
  return Number.isFinite(numeric) ? String(numeric + 1) : "1";
}

/**
 * Reference paths are relative and cannot climb out of the pack.
 *
 * Traversal is REJECTED, never stripped. Quietly rewriting "../escape.md" to
 * "escape.md" would hand the caller a different file than the one they named,
 * which is a worse failure than refusing outright.
 */
export function safeReferencePath(relativePath: string): string {
  const trimmed = relativePath.trim();
  if (!trimmed || path.isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed)) {
    throw new Error(`Invalid reference path "${relativePath}".`);
  }

  const normalized = path.normalize(trimmed);
  const segments = normalized.split(/[\\/]/).filter((segment) => segment && segment !== ".");
  if (segments.length === 0 || segments.includes("..") || path.isAbsolute(normalized)) {
    throw new Error(`Invalid reference path "${relativePath}".`);
  }
  return segments.join("/");
}

function isReference(value: unknown): value is CompanyReference {
  return typeof value === "object" && value !== null && typeof (value as CompanyReference).path === "string";
}

function listFiles(root: string, prefix = ""): string[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(path.join(root, entry.name), relative) : [relative];
  });
}

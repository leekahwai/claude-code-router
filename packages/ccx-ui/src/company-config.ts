/**
 * Administrator surface for the company context pack.
 *
 * The page edits hidden instructions and a list of reference documents. Two
 * things it must say out loud, because getting them wrong is a governance
 * problem rather than a bug:
 *
 *   - "Hidden" means hidden from the transcript, not from anyone else. The text
 *     is in CCR's request logs and in whatever the provider retains.
 *   - On a local install this pack is advisory. A user with access to their own
 *     machine can edit or disable it. Making it authoritative needs a signed
 *     remote document or a central deployment.
 */
import type { CompanyPack } from "@ccx/harness";

export const companyPackNotices = {
  advisory:
    "On this deployment the pack is advisory. Users can edit or disable it on their own machine; changes are detectable, not preventable.",
  logging:
    "Hidden means hidden from the conversation, not from logs. This text is recorded in request logs and sent to the model provider.",
  manifest:
    "Reference documents are listed, not pasted. The model reads one only when it needs it, which keeps the context small and the cost predictable."
} as const;

export type CompanyPackDraft = {
  enabled: boolean;
  injection: CompanyPack["injection"];
  systemText: string;
};

export function draftFromPack(pack: CompanyPack): CompanyPackDraft {
  return { enabled: pack.enabled, injection: pack.injection, systemText: pack.systemText };
}

export type CompanyPackValidation = {
  errors: string[];
  warnings: string[];
};

const largePackChars = 8000;

/**
 * Validate before saving. Warnings are shown but do not block: an administrator
 * may knowingly ship a large pack.
 */
export function validateCompanyPack(draft: CompanyPackDraft, referenceCount: number): CompanyPackValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (draft.enabled && !draft.systemText.trim() && referenceCount === 0) {
    errors.push("Enable the pack only once it has instructions or at least one reference document.");
  }
  if (draft.systemText.length > largePackChars) {
    warnings.push(
      `These instructions are ${draft.systemText.length} characters and are sent on every request. Consider moving detail into a reference document.`
    );
  }
  if (draft.injection === "inline" && referenceCount > 3) {
    warnings.push(
      "Inline injection grows the prompt with every document you publish. The manifest option keeps it flat."
    );
  }
  if (/\b(sk-[A-Za-z0-9]{8,}|BEGIN [A-Z ]*PRIVATE KEY)\b/.test(draft.systemText)) {
    errors.push("These instructions look like they contain a credential. Remove it before saving.");
  }
  return { errors, warnings };
}

/** Summary of the drift report, for the admin page's status line. */
export function driftSummary(drift: { changed: string[]; missing: string[]; untracked: string[] }): string {
  const parts: string[] = [];
  if (drift.changed.length > 0) parts.push(`${drift.changed.length} edited on disk`);
  if (drift.missing.length > 0) parts.push(`${drift.missing.length} missing`);
  if (drift.untracked.length > 0) parts.push(`${drift.untracked.length} unpublished`);
  return parts.length === 0 ? "All reference documents match the published pack." : parts.join(", ");
}

/**
 * First-run provisioning of a temporary administrator.
 *
 * Somebody has to be first. That is the one exception to "identity is never
 * self-declared", so it is made narrow and loud rather than convenient:
 *
 *   - it only fires when the directory is completely empty;
 *   - the account is flagged `temporary`, so the admin console can say what
 *     has to be replaced when Active Directory is connected;
 *   - the generated key is returned once and never stored — only its
 *     fingerprint is persisted, exactly as an issued key would be.
 */
import { randomBytes } from "node:crypto";
import { credentialFingerprint } from "../session/store";
import type { IdentityDirectory, UserRecord } from "./directory";

export const BOOTSTRAP_ADMIN_ID = "bootstrap-admin";

export type BootstrapResult = {
  /**
   * The raw key. Shown once, then unrecoverable — the directory holds only a
   * hash of it, so a lost key is reissued rather than looked up.
   */
  apiKey: string;
  created: boolean;
  user: UserRecord;
};

export type BootstrapOptions = {
  displayName?: string;
  email?: string;
  /** Injectable for tests; production uses a CSPRNG. */
  generateKey?: () => string;
};

export function generateProvisioningKey(): string {
  return `ccx-${randomBytes(24).toString("base64url")}`;
}

/**
 * Create the temporary administrator if — and only if — no users exist.
 *
 * Returns `created: false` and no usable key when the directory is already
 * populated, so calling this on every start cannot mint a second back door.
 */
export function bootstrapAdmin(
  directory: IdentityDirectory,
  options: BootstrapOptions = {}
): BootstrapResult | undefined {
  if (directory.countUsers() > 0) {
    return undefined;
  }

  const apiKey = (options.generateKey ?? generateProvisioningKey)();
  const user = directory.upsertUser({
    displayName: options.displayName ?? "Temporary administrator",
    email: options.email ?? "",
    externalId: "",
    id: BOOTSTRAP_ADMIN_ID,
    role: "admin",
    status: "active",
    temporary: true
  });

  directory.bindCredential({
    // Recorded as bootstrap, not as a person: no human vouched for this.
    boundBy: "bootstrap",
    fingerprint: credentialFingerprint(apiKey),
    label: "First-run provisioning key",
    userId: user.id
  });

  return { apiKey, created: true, user };
}

/** Temporary accounts still present, for the admin console to nag about. */
export function temporaryAccounts(directory: IdentityDirectory): UserRecord[] {
  return directory.listUsers().filter((user) => user.temporary);
}

export const BOOTSTRAP_NOTICE =
  "This is a temporary administrator created on first run. Replace it with an Active Directory account and revoke its key before rollout.";

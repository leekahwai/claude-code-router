/**
 * How a request becomes a person.
 *
 * Deliberately an interface with a swappable implementation. Today the only one
 * is credential-based; an Active Directory resolver drops in later and nothing
 * downstream changes, because `user_id` is opaque everywhere it is used.
 */
import { credentialFingerprint } from "../session/store";
import type { IdentityAssurance, IdentityDirectory, UserRecord } from "./directory";

export type Identity = {
  /**
   * "claimed" when derived from a transferable credential, "verified" when an
   * identity provider vouched for it. Recorded, not assumed, so an admin
   * console can show which reads rest on which.
   */
  assurance: IdentityAssurance;
  role: UserRecord["role"];
  user: UserRecord;
};

export type IdentityResolution =
  | { identity: Identity; ok: true }
  | { ok: false; reason: "no-binding" | "revoked" | "suspended" };

export type IdentityResolver = {
  /** Resolve the person behind a raw credential. */
  resolve(apiKey: string): IdentityResolution;
};

/**
 * Resolution from a fingerprint alone.
 *
 * The collector never sees raw keys — a laptop sends sha256(key) and nothing
 * else — so it needs this narrower shape. Kept separate from `IdentityResolver`
 * because an SSO resolver will validate a token instead and has no fingerprint
 * to offer.
 */
export type FingerprintResolver = {
  resolveFingerprint(fingerprint: string): IdentityResolution;
};

/**
 * Interim resolver: a key bound to a person by an administrator at issue time.
 *
 * The key is transferable, so anything it identifies is *claimed*. That is
 * adequate for cost attribution and insufficient on its own for oversight,
 * which is why the assurance travels with the identity rather than being
 * quietly dropped.
 */
export class CredentialIdentityResolver implements IdentityResolver, FingerprintResolver {
  constructor(private readonly directory: IdentityDirectory) {}

  resolve(apiKey: string): IdentityResolution {
    return this.resolveFingerprint(credentialFingerprint(apiKey));
  }

  resolveFingerprint(fingerprint: string): IdentityResolution {
    const binding = this.directory.getBinding(fingerprint);
    if (!binding) {
      return { ok: false, reason: "no-binding" };
    }
    if (binding.revokedAt) {
      return { ok: false, reason: "revoked" };
    }
    const user = this.directory.getUser(binding.userId);
    if (!user || user.status === "suspended") {
      return { ok: false, reason: "suspended" };
    }
    return { identity: { assurance: "claimed", role: user.role, user }, ok: true };
  }
}

/** Message for the blocked view; specific enough to act on, vague on internals. */
export function resolutionMessage(reason: IdentityResolution extends { ok: false } ? never : "no-binding" | "revoked" | "suspended"): string {
  switch (reason) {
    case "revoked":
      return "This API key has been revoked. Ask your administrator to issue a new one.";
    case "suspended":
      return "This account is suspended. Contact your administrator.";
    default:
      return "This API key is not recognised. Ask your administrator to register it against your account.";
  }
}

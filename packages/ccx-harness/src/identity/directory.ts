/**
 * The user directory and the credential bindings that resolve a person.
 *
 * Identity is never asserted by the client. A laptop sends sha256(apiKey); this
 * store maps that fingerprint to the person an administrator bound it to when
 * the key was issued. `user_id` stays opaque so an Active Directory resolver
 * can replace the lookup later without a migration.
 *
 * Assurance is recorded rather than assumed. An emailed key is transferable, so
 * identity derived from one is "claimed": adequate for cost attribution, not
 * sufficient on its own for an administrator reading someone's transcripts.
 * SSO raises it to "verified". The admin console shows the difference.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createBetterSqliteDatabase, type BetterSqliteDatabase } from "@ccr/core/storage/sqlite-native";

export type UserRole = "admin" | "user";
export type UserStatus = "active" | "suspended";
export type IdentityAssurance = "claimed" | "verified";

export type UserRecord = {
  createdAt: string;
  displayName: string;
  email: string;
  /**
   * True for an account created by first-run bootstrap rather than by a person
   * or an identity provider. Surfaced so it is obvious what has to be replaced
   * when Active Directory is connected, instead of quietly becoming permanent.
   */
  temporary: boolean;
  /** Stable id from the identity provider once SSO lands; empty before then. */
  externalId: string;
  id: string;
  role: UserRole;
  status: UserStatus;
};

export type CredentialBinding = {
  boundBy: string;
  createdAt: string;
  fingerprint: string;
  label: string;
  revokedAt: string;
  userId: string;
};

export class IdentityDirectory {
  private readonly database: BetterSqliteDatabase;

  constructor(dbFile: string) {
    if (dbFile !== ":memory:") {
      mkdirSync(dirname(dbFile), { mode: 0o700, recursive: true });
    }
    this.database = createBetterSqliteDatabase(dbFile);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS ccx_users (
        id TEXT PRIMARY KEY,
        external_id TEXT NOT NULL DEFAULT '',
        display_name TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'user',
        status TEXT NOT NULL DEFAULT 'active',
        temporary INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ccx_users_external_idx
        ON ccx_users(external_id) WHERE external_id <> '';

      CREATE TABLE IF NOT EXISTS ccx_credential_bindings (
        fingerprint TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES ccx_users(id) ON DELETE CASCADE,
        label TEXT NOT NULL DEFAULT '',
        bound_by TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        revoked_at TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS ccx_credential_bindings_user_idx
        ON ccx_credential_bindings(user_id);
    `);
  }

  upsertUser(user: Omit<UserRecord, "createdAt"> & { createdAt?: string }): UserRecord {
    this.database
      .prepare(`
        INSERT INTO ccx_users (id, external_id, display_name, email, role, status, temporary, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          external_id = excluded.external_id,
          display_name = excluded.display_name,
          email = excluded.email,
          role = excluded.role,
          status = excluded.status,
          temporary = excluded.temporary
      `)
      .run(
        user.id,
        user.externalId,
        user.displayName,
        user.email,
        user.role,
        user.status,
        user.temporary ? 1 : 0,
        user.createdAt ?? new Date().toISOString()
      );
    return this.getUser(user.id)!;
  }

  getUser(id: string): UserRecord | undefined {
    const row = this.database.prepare("SELECT * FROM ccx_users WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toUser(row) : undefined;
  }

  countUsers(): number {
    const row = this.database.prepare("SELECT COUNT(*) AS total FROM ccx_users").get() as { total: number };
    return Number(row.total ?? 0);
  }

  listUsers(): UserRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM ccx_users ORDER BY display_name, id")
      .all() as Array<Record<string, unknown>>;
    return rows.map(toUser);
  }

  /**
   * Bind an issued key to a person. Done by an administrator at issue time —
   * never self-service, because a self-declared binding is not identity.
   */
  bindCredential(input: { boundBy: string; fingerprint: string; label?: string; userId: string }): CredentialBinding {
    if (!this.getUser(input.userId)) {
      throw new Error(`Cannot bind a credential to unknown user "${input.userId}".`);
    }
    this.database
      .prepare(`
        INSERT INTO ccx_credential_bindings (fingerprint, user_id, label, bound_by, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(fingerprint) DO UPDATE SET
          user_id = excluded.user_id,
          label = excluded.label,
          bound_by = excluded.bound_by,
          revoked_at = ''
      `)
      .run(input.fingerprint, input.userId, input.label ?? "", input.boundBy, new Date().toISOString());
    return this.getBinding(input.fingerprint)!;
  }

  revokeCredential(fingerprint: string): void {
    this.database
      .prepare("UPDATE ccx_credential_bindings SET revoked_at = ? WHERE fingerprint = ? AND revoked_at = ''")
      .run(new Date().toISOString(), fingerprint);
  }

  getBinding(fingerprint: string): CredentialBinding | undefined {
    const row = this.database
      .prepare("SELECT * FROM ccx_credential_bindings WHERE fingerprint = ?")
      .get(fingerprint) as Record<string, unknown> | undefined;
    return row ? toBinding(row) : undefined;
  }

  listBindings(userId: string): CredentialBinding[] {
    const rows = this.database
      .prepare("SELECT * FROM ccx_credential_bindings WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId) as Array<Record<string, unknown>>;
    return rows.map(toBinding);
  }

  close(): void {
    this.database.close();
  }
}

function toUser(row: Record<string, unknown>): UserRecord {
  return {
    createdAt: String(row.created_at ?? ""),
    displayName: String(row.display_name ?? ""),
    email: String(row.email ?? ""),
    externalId: String(row.external_id ?? ""),
    id: String(row.id ?? ""),
    role: row.role === "admin" ? "admin" : "user",
    status: row.status === "suspended" ? "suspended" : "active",
    temporary: row.temporary === 1
  };
}

function toBinding(row: Record<string, unknown>): CredentialBinding {
  return {
    boundBy: String(row.bound_by ?? ""),
    createdAt: String(row.created_at ?? ""),
    fingerprint: String(row.fingerprint ?? ""),
    label: String(row.label ?? ""),
    revokedAt: String(row.revoked_at ?? ""),
    userId: String(row.user_id ?? "")
  };
}

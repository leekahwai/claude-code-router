import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BOOTSTRAP_ADMIN_ID, bootstrapAdmin, generateProvisioningKey, temporaryAccounts } from "../src/identity/bootstrap.ts";
import { IdentityDirectory } from "../src/identity/directory.ts";
import { CredentialIdentityResolver } from "../src/identity/resolver.ts";
import { credentialFingerprint } from "../src/session/store.ts";

function directory(): { close: () => void; value: IdentityDirectory } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ccx-boot-"));
  const value = new IdentityDirectory(path.join(dir, "identity.sqlite"));
  return {
    close: () => {
      value.close();
      rmSync(dir, { force: true, recursive: true });
    },
    value
  };
}

test("first run creates a temporary admin whose key resolves", () => {
  const d = directory();
  try {
    const result = bootstrapAdmin(d.value, { displayName: "Ops", email: "ops@example.com" });
    assert.ok(result);
    assert.equal(result.created, true);
    assert.equal(result.user.role, "admin");
    assert.equal(result.user.temporary, true, "it must be visibly temporary");

    const resolved = new CredentialIdentityResolver(d.value).resolve(result.apiKey);
    assert.ok(resolved.ok);
    assert.equal(resolved.identity.user.id, BOOTSTRAP_ADMIN_ID);
    assert.equal(resolved.identity.role, "admin");
    // Bootstrap does not raise assurance: nobody vouched for this account.
    assert.equal(resolved.identity.assurance, "claimed");
  } finally {
    d.close();
  }
});

test("the raw key is never stored, only its fingerprint", () => {
  const d = directory();
  try {
    const result = bootstrapAdmin(d.value)!;
    const binding = d.value.getBinding(credentialFingerprint(result.apiKey));
    assert.ok(binding);
    assert.equal(binding.boundBy, "bootstrap", "no human vouched for it, and the record says so");
    // Nothing anywhere in the directory equals the key itself.
    const serialized = JSON.stringify({
      bindings: d.value.listBindings(BOOTSTRAP_ADMIN_ID),
      users: d.value.listUsers()
    });
    assert.ok(!serialized.includes(result.apiKey), "a lost key is reissued, never looked up");
  } finally {
    d.close();
  }
});

test("bootstrap only fires on an empty directory, so it cannot mint a back door", () => {
  const d = directory();
  try {
    const first = bootstrapAdmin(d.value);
    assert.ok(first);

    // Calling it again — as an app would on every start — must do nothing.
    assert.equal(bootstrapAdmin(d.value), undefined);
    assert.equal(d.value.listUsers().length, 1);
  } finally {
    d.close();
  }
});

test("bootstrap does not fire when real users already exist", () => {
  const d = directory();
  try {
    d.value.upsertUser({
      displayName: "Ada", email: "ada@x", externalId: "ad-guid-1", id: "ada",
      role: "user", status: "active", temporary: false
    });
    assert.equal(bootstrapAdmin(d.value), undefined);
    assert.deepEqual(temporaryAccounts(d.value), [], "nothing temporary was created");
  } finally {
    d.close();
  }
});

test("the temporary account is listed so it can be chased down before rollout", () => {
  const d = directory();
  try {
    bootstrapAdmin(d.value);
    d.value.upsertUser({
      displayName: "Ada", email: "ada@x", externalId: "ad-guid-1", id: "ada",
      role: "user", status: "active", temporary: false
    });
    assert.deepEqual(temporaryAccounts(d.value).map((user) => user.id), [BOOTSTRAP_ADMIN_ID]);
  } finally {
    d.close();
  }
});

test("revoking the bootstrap key locks the temporary admin out", () => {
  const d = directory();
  try {
    const result = bootstrapAdmin(d.value)!;
    d.value.revokeCredential(credentialFingerprint(result.apiKey));
    const resolved = new CredentialIdentityResolver(d.value).resolve(result.apiKey);
    assert.equal(resolved.ok, false);
  } finally {
    d.close();
  }
});

test("generated keys are distinct and long enough not to be guessable", () => {
  const keys = new Set(Array.from({ length: 200 }, () => generateProvisioningKey()));
  assert.equal(keys.size, 200);
  for (const key of keys) {
    assert.ok(key.startsWith("ccx-"));
    assert.ok(key.length >= 36, key);
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultAppConfig } from "@ccr/core/config/default-config";
import type { AppConfig } from "@ccr/core/contracts/app";
import { CcxConfigStore, defaultCcxConfig } from "../src/config/app-config.ts";
import { availableModels, availableProviders, gatewayBaseUrl, resolvedMcpServers, resolveMode } from "../src/config/resolve.ts";

function appConfigWith(providers: AppConfig["Providers"]): AppConfig {
  return { ...createDefaultAppConfig(), Providers: providers };
}

const twoProviders = appConfigWith([
  { models: ["claude-opus-5", "claude-sonnet-5"], name: "anthropic" },
  { enabled: false, models: ["x"], name: "disabled-one" }
]);

test("models and providers are read from CCR, not stored separately", () => {
  const models = availableModels(twoProviders).map((choice) => choice.id);
  assert.deepEqual(models, ["anthropic/claude-opus-5", "anthropic/claude-sonnet-5"]);
  assert.deepEqual(availableProviders(twoProviders), ["anthropic"]);
});

test("a disabled provider is not offered", () => {
  assert.ok(!availableProviders(twoProviders).includes("disabled-one"));
});

test("the gateway base url avoids bind-only addresses", () => {
  assert.equal(gatewayBaseUrl({ HOST: "0.0.0.0", PORT: 3456 }), "http://127.0.0.1:3456");
  assert.equal(gatewayBaseUrl({ HOST: "", PORT: 3456 }), "http://127.0.0.1:3456");
  assert.equal(gatewayBaseUrl({ HOST: "127.0.0.1", PORT: 8080 }), "http://127.0.0.1:8080");
});

test("no configured provider blocks the mode with CCR's own gate", () => {
  const resolved = resolveMode({
    appConfig: appConfigWith([]),
    ccxConfig: defaultCcxConfig,
    mode: "code"
  });
  assert.match(String(resolved.blockedReason), /No provider is configured/);
});

test("a missing credential blocks with a different message", () => {
  const resolved = resolveMode({
    appConfig: twoProviders,
    ccxConfig: defaultCcxConfig,
    hasCredential: false,
    mode: "code"
  });
  assert.match(String(resolved.blockedReason), /API key you were issued/);
});

test("with a provider configured the first model is chosen by default", () => {
  const resolved = resolveMode({ appConfig: twoProviders, ccxConfig: defaultCcxConfig, mode: "work" });
  assert.equal(resolved.blockedReason, undefined);
  assert.equal(resolved.model, "anthropic/claude-opus-5");
  assert.equal(resolved.provider, "anthropic");
});

test("an explicitly chosen model is honoured", () => {
  const ccxConfig = structuredClone(defaultCcxConfig);
  ccxConfig.modes.code.model = "anthropic/claude-sonnet-5";
  const resolved = resolveMode({ appConfig: twoProviders, ccxConfig, mode: "code" });
  assert.equal(resolved.model, "anthropic/claude-sonnet-5");
});

test("a model that has disappeared blocks with a fixable message", () => {
  const ccxConfig = structuredClone(defaultCcxConfig);
  ccxConfig.modes.code.model = "anthropic/retired-model";
  const resolved = resolveMode({ appConfig: twoProviders, ccxConfig, mode: "code" });
  assert.match(String(resolved.blockedReason), /no longer available/);
});

test("MCP servers are intersected with what CCR has configured", () => {
  const appConfig = { ...twoProviders };
  appConfig.agent = {
    mcpServers: [
      { args: [], command: "a", env: {}, name: "alpha", protocolVersion: "", requestTimeoutMs: 1, startupTimeoutMs: 1, stdioMessageMode: "newline-json", transport: "stdio" },
      { args: [], command: "b", env: {}, name: "beta", protocolVersion: "", requestTimeoutMs: 1, startupTimeoutMs: 1, stdioMessageMode: "newline-json", transport: "stdio" }
    ]
  };
  const settings = structuredClone(defaultCcxConfig.modes.code);

  assert.deepEqual(resolvedMcpServers(appConfig, settings), ["alpha", "beta"], "empty means all");

  settings.mcpServers = ["beta", "removed-from-ccr"];
  assert.deepEqual(resolvedMcpServers(appConfig, settings), ["beta"], "a removed server disappears silently");
});

test("Work and Code keep separate settings and separate profiles", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ccx-cfg-"));
  try {
    const store = new CcxConfigStore(directory);
    store.updateMode("code", { model: "anthropic/claude-opus-5" });
    store.updateMode("work", { model: "anthropic/claude-sonnet-5" });

    const config = store.load();
    assert.equal(config.modes.code.model, "anthropic/claude-opus-5");
    assert.equal(config.modes.work.model, "anthropic/claude-sonnet-5");
    assert.notEqual(config.modes.code.profileId, config.modes.work.profileId);
    assert.equal(config.modes.work.policy.allowed.execute, "deny", "Work keeps its boundary");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a stored config written before a risk level existed does not become permissive", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ccx-cfg-"));
  try {
    const store = new CcxConfigStore(directory);
    // Simulate an older file that only knew about "read".
    store.save({
      ...defaultCcxConfig,
      modes: {
        ...defaultCcxConfig.modes,
        work: {
          ...defaultCcxConfig.modes.work,
          policy: { allowed: { read: "allow" } as never }
        }
      }
    });
    const loaded = store.load();
    assert.equal(loaded.modes.work.policy.allowed.execute, "deny", "the missing field keeps its safe default");
    assert.equal(loaded.modes.work.policy.allowed.write, "deny");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a corrupt config file falls back to defaults rather than failing to start", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ccx-cfg-"));
  try {
    const store = new CcxConfigStore(directory);
    writeFileSync(path.join(directory, "config.json"), "{not json", "utf8");
    assert.deepEqual(store.load().modes.work.policy, defaultCcxConfig.modes.work.policy);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

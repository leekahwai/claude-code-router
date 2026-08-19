/**
 * Contract tests — our assumptions about upstream CCR surfaces we *consume*.
 *
 * Vendoring protects us from merge conflicts. It does not protect us from
 * behavioural drift in the code we import, which breaks silently at runtime.
 * Each test here turns one such breakage into a red build during an upgrade.
 *
 * See design/fork-isolation-strategy.md §7.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hasAvailableGatewayModels } from "@ccr/core/contracts/app";
import { createDefaultAppConfig } from "@ccr/core/config/default-config";
import { profileApiKeyId, profileIdFromApiKeyId } from "@ccr/core/profiles/api-key";
import { listMcpServerTools } from "@ccr/core/mcp/tool-discovery";
import { UsageStore } from "@ccr/core/usage/store";
import { TurnMetricsStore } from "../src/metrics/store.ts";

test("contract: AppConfig still carries every field we read", () => {
  const config = createDefaultAppConfig();
  assert.ok(Array.isArray(config.Providers), "Providers");
  assert.ok(Array.isArray(config.APIKEYS), "APIKEYS");
  assert.ok(Array.isArray(config.profile.profiles), "profile.profiles");
  assert.ok(Array.isArray(config.agent.mcpServers), "agent.mcpServers");
  assert.equal(typeof config.PORT, "number", "PORT");
});

test("contract: the no-provider gate still refuses when nothing is configured", () => {
  assert.equal(hasAvailableGatewayModels({ Providers: [], virtualModelProfiles: [] }), false);
  assert.equal(
    hasAvailableGatewayModels({
      Providers: [{ models: ["m"], name: "p" }],
      virtualModelProfiles: []
    }),
    true
  );
});

test("contract: profile API key ids still round-trip", () => {
  const id = profileApiKeyId({ agent: "claude-code", id: "work", name: "Work" });
  assert.equal(id, "profile:work");
  assert.equal(profileIdFromApiKeyId(id), "work");
});

test("contract: the MCP tool discovery entry point is still exported", () => {
  assert.equal(typeof listMcpServerTools, "function");
});

test("contract: x-client-request-id still reaches usage_events.request_id — our whole join key", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ccx-contract-"));
  const usageDbFile = path.join(directory, "usage.sqlite");
  const usage = new UsageStore(usageDbFile);
  const metrics = new TurnMetricsStore(path.join(directory, "metrics.sqlite"), { usageDbFile });
  try {
    // What the gateway records after a response comes back.
    await usage.record({
      durationMs: 1200,
      method: "POST",
      model: "claude-sonnet-4",
      modelIsRouteSelector: false,
      path: "/v1/messages",
      provider: "anthropic",
      requestId: "req-join-1",
      statusCode: 200,
      usage: { inputTokens: 5000, outputTokens: 900 }
    });

    // What our harness records for the same turn.
    metrics.record({
      estimatedInputTokens: 4700,
      mode: "code",
      policyTokens: 420,
      policyVersion: "six-tier@1",
      requestId: "req-join-1",
      sessionId: "sess-1",
      turnId: "turn-1",
      userId: "ada"
    });

    assert.equal(await usage.hasRequestId("req-join-1"), true, "usage store lost the request id");

    const [row] = metrics.listForUser("ada");
    assert.ok(row, "join returned no rows");
    assert.equal(row.requestId, "req-join-1");
    assert.equal(row.billedInputTokens, 5000, "provider-billed input tokens did not join");
    assert.equal(row.outputTokens, 900);
    assert.equal(row.model, "claude-sonnet-4");
    assert.equal(row.provider, "anthropic");

    // The metric the whole programme rests on: what the policy actually costs.
    assert.equal(row.estimatedInputTokens, 4700);
    assert.equal(row.billedInputTokens! - row.estimatedInputTokens, 300);
  } finally {
    metrics.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

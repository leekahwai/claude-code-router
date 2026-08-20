export { TurnMetricsStore } from "./metrics/store";
export type { CcxMode, MetricsStoreOptions, TurnCostRow, TurnMetricInput, TurnMetricRow } from "./metrics/store";
export { CCX_DATA_DIR, CCX_METRICS_DB_FILE, CCX_SESSIONS_DB_FILE } from "./config/paths";
export { SessionStore, credentialFingerprint } from "./session/store";
export type {
  CreateSessionInput, MessageRecord, MessageRole, SessionRecord,
  ToolCallRecord, ToolCallSource, ToolCallStatus, TurnRecord, TurnStatus
} from "./session/store";
export { MessageAssembler, SseDecoder } from "./stream/anthropic-stream";
export type {
  AssembledBlock, AssemblerEvent, SseEvent, StreamUsage, TextBlock, ThinkingBlock, ToolUseBlock
} from "./stream/anthropic-stream";
export { TurnLoop } from "./turn/turn-loop";
export type { ExchangeResult, TurnLoopOptions } from "./turn/turn-loop";
export { FunctionToolExecutor } from "./turn/tools";
export type { ToolDefinition, ToolExecutor, ToolOutcome } from "./turn/tools";
export { streamMessages, UpstreamHttpError } from "./turn/provider-client";
export type { StreamMessagesRequest, StreamMessagesResult } from "./turn/provider-client";
export { defaultReasoningPreference, mapReasoning } from "./reasoning/map";
export type { MappedReasoning, MapReasoningInput, ReasoningDiagnostic, ReasoningPreference } from "./reasoning/map";
export {
  normalizeModelKey, REASONING_EFFORTS, resolveReasoningCapability, unsupportedReasoning
} from "./reasoning/capabilities";
export type {
  CapabilitySources, CatalogReasoning, ModelReasoningCapability, ReasoningEffort, ThinkingControl
} from "./reasoning/capabilities";
export { Workspace, WorkspaceEscapeError } from "./tools/workspace";
export { defaultModePolicies, denialMessage, PermissionGate } from "./tools/permissions";
export type {
  ModePolicy, PermissionDecision, PermissionOutcome, PermissionPrompter, PermissionRequest, ToolRisk
} from "./tools/permissions";
export { BuiltinTools, defaultBuiltinLimits } from "./tools/builtin";
export type { BuiltinLimits, BuiltinToolName, BuiltinToolsOptions } from "./tools/builtin";
export { HarnessTools } from "./tools/registry";
export type { HarnessToolsOptions } from "./tools/registry";
export { McpRegistry, namespacedToolName, parseNamespacedToolName } from "./mcp/registry";
export type { McpRegistryOptions, McpServerStatus } from "./mcp/registry";
export { parseFrontmatter, SkillRegistry, stripFrontmatter } from "./skills/registry";
export type { Skill, SkillRegistryOptions } from "./skills/registry";
export { executeSkillTool, SKILL_TOOL_NAME, skillToolDefinition } from "./skills/tool";
export { assembleSystemPrompt, stableSystemPrefix } from "./context/assemble";
export type { SystemLayers } from "./context/assemble";
export type { WorkspaceAccess, WorkspaceOptions } from "./tools/workspace";
export {
  companyContextLayer, companyPolicyTokens, CompanyPackStore, emptyCompanyPack,
  safeReferencePath, sixTierFrameworkTemplate
} from "./company/pack";
export type { CompanyPack, CompanyReference } from "./company/pack";
export {
  COMPANY_REFERENCE_TOOL_NAME, companyReferenceToolDefinition, executeCompanyReferenceTool
} from "./company/tool";
export { CcxConfigStore, defaultCcxConfig, ensureDeviceId } from "./config/app-config";
export type { CcxConfig, ModeSettings, SyncSettings } from "./config/app-config";
export {
  availableModels, availableProviders, gatewayBaseUrl, resolvedMcpServers, resolveMode
} from "./config/resolve";
export type { ModelChoice, ResolvedMode, ResolveModeInput } from "./config/resolve";
export { IdentityDirectory } from "./identity/directory";
export type {
  CredentialBinding, IdentityAssurance, UserRecord, UserRole, UserStatus
} from "./identity/directory";
export { AccessLog } from "./identity/access-log";
export type { AccessAction, AccessLogEntry } from "./identity/access-log";
export { CredentialIdentityResolver, resolutionMessage } from "./identity/resolver";
export type { FingerprintResolver, Identity, IdentityResolution, IdentityResolver } from "./identity/resolver";
export { SessionAuthorizer } from "./identity/authorization";
export type { Authorized, AuthorizationOptions } from "./identity/authorization";
export {
  BOOTSTRAP_ADMIN_ID, BOOTSTRAP_NOTICE, bootstrapAdmin, generateProvisioningKey, temporaryAccounts
} from "./identity/bootstrap";
export type { BootstrapOptions, BootstrapResult } from "./identity/bootstrap";

// Transcript sync (A2): laptop → collector.
export { SyncOutbox } from "./sync/outbox";
export type { OutboxDrain, OutboxEntry, SyncEntity } from "./sync/outbox";
export {
  maxSyncStringLength, parseBundle, redactSecrets, redactString, redactionMarker,
  SESSION_SYNC_SCHEMA, SESSION_SYNC_TOKEN_HEADER, truncationMarker
} from "./sync/bundle";
export type {
  BundleParse, SessionSyncBundle, SyncMessage, SyncSession, SyncToolCall, SyncTurn
} from "./sync/bundle";
export { HttpSyncTransport, SessionSyncClient } from "./sync/client";
export type { FlushResult, SessionSyncClientOptions, SyncSendResult, SyncTransport } from "./sync/client";
export { SessionSyncCollector } from "./sync/collector";
export type { CollectorOptions, IngestOutcome } from "./sync/collector";
export { createSessionSyncHandler, maxSyncBodyBytes } from "./sync/http";

// Admin console (A3): cross-user browsing, search, export, deletion, audit.
export { AdminConsole } from "./admin/console";
export type {
  AdminConsoleOptions, AdminExport, AdminOverview, AdminSearchHit, AdminSearchQuery,
  AdminTranscript, AdminUserRow
} from "./admin/console";
export { excerpt, messageText } from "./admin/text";
export { ftsPhrase, TranscriptIndex } from "./admin/transcript-index";
export type { IndexedHit } from "./admin/transcript-index";

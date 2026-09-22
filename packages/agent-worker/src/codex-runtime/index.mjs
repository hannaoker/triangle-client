/**
 * Headless Codex worker runtime surface.
 *
 * Product default: Codex profiles use headless App Server. grok-bot stays on
 * grokBotWake and never enters the Codex pool. Mini-only allowlists are not
 * the product gate. Pool size 1 and desktop handoff remain off until shared
 * CODEX_HOME is proved. Global featureFlags.headlessRuntime stays false in the
 * immutable manifest.
 */

export {
  APP_SERVER_METHODS,
  APP_SERVER_NOTIFICATIONS,
  assertNoSecretMaterial,
  classifyJsonRpcMessage,
  createRequestIdFactory,
  encodeJsonRpcNotification,
  encodeJsonRpcRequest,
  encodeNdjsonLine,
  parseNdjsonLine,
} from "./app-server-protocol.mjs";

export {
  createCodexAppServerProcess,
  createFakeAppServerStdioProgram,
  waitForAppServerTurnCompleted,
} from "./app-server-process.mjs";

export {
  assertAllowedApprovalPolicy,
  assertAllowedSandboxMode,
  assertAllowedSandboxPolicy,
  getFeatureFlags,
  getRuntimeManifestPath,
  loadRuntimeManifest,
  validateHeadlessCodexConfig,
} from "./runtime-manifest.mjs";

export {
  buildSanitizedCodexChildEnv,
  defaultTriangleCodexHome,
  resolveCodexPoolGuards,
  resolveTriangleCodexHome,
} from "./runtime-home.mjs";

export {
  cleanupProbeDirectory,
  runSharedHomeConcurrencyProbe,
  startMaterializedThread,
  writeProbeReport,
} from "./shared-home-concurrency-probe.mjs";

export {
  DEFAULT_THREAD_READ_RECONCILE_WINDOW,
  assertAssistantResultUncontaminated,
  assertCorrelationTag,
  attachCorrelationToTurnStart,
  buildCorrelationPreamble,
  buildCorrelationTag,
  extractAssistantTexts,
  extractCorrelationFromThreadRead,
  selectCorrelationMode,
} from "./correlation.mjs";

export {
  isDesktopHandoffEnabled,
  isHeadlessRuntimeEnabled,
  isHelperConversationStoreEnabled,
  isPhase5MigrationEnabled,
  isShadowHeadlessTestProfile,
  resolveHeadlessRuntimeConfig,
  resolvePhase0RuntimeConfig,
  resolvePhase1ShadowRuntimeConfig,
  resolvePhase5MigrationConfig,
} from "./config-guards.mjs";

export {
  CODEX_EXECUTION_KIND,
  CODEX_PROFILE_SCHEMA_VERSION,
  annotateCodexProfileSchema,
  classifyCodexProfileExecution,
  executionKindForSchemaVersion,
  isDesktopAppServerExecution,
  isHeadlessAppServerExecution,
  isLegacyCommandExecution,
  isMcpInteractiveDesktopProfile,
  schemaVersionForExecutionKind,
} from "./profile-schema.mjs";

export {
  createDefaultCodexProfileConfig,
  wouldNewCodexProfileDefaultToHeadless,
} from "./profile-factory.mjs";

export {
  createMemoryProfileConfigStore,
  createProfileMigrationController,
} from "./profile-migration.mjs";

export {
  EXECUTION_STATES,
  NON_IDLE_EXECUTION_STATES,
  assertExecutionState,
  canTransitionExecutionState,
  createExecutionRecord,
  isNonIdleExecutionState,
  matchesCancellationScope,
  replyBeforeAckStages,
  shouldAcceptExecutionEpochEvent,
  transitionExecutionState,
} from "./execution-state.mjs";

export {
  createDurableConversationRegistry,
  createMemoryConversationRegistry,
} from "./conversation-registry.mjs";

export { createDurableConversationStore } from "./durable-conversation-store.mjs";

export { createExecutionLeaseManager } from "./execution-lease.mjs";

export {
  buildCompletionIdempotencyKey,
  recordOrReplayCompletion,
  reconcileConversationAfterRestart,
  reconcileProfileAfterRestart,
} from "./completion-reconciler.mjs";

export { createCodexWorkerPool } from "./worker-pool.mjs";

export { createHeadlessCodexRuntime } from "./headless-runtime.mjs";

export { createHeadlessCodexDrain } from "./headless-drain.mjs";

export {
  CLIENT_SUPERVISOR_CLAIMER_OWNER,
  DEDICATED_HEADLESS_DRAIN_CLAIMER_OWNER,
  HEADLESS_WAKE_KEYS,
  HEADLESS_WAKE_OPTIONAL_KEYS,
  HEADLESS_WAKE_REQUIRED_KEYS,
  MINI_HEADLESS_CANARY_PROFILE,
  MINI_HEADLESS_CANARY_ROOM_ID,
  PINNED_HEADLESS_DRAIN_PROFILE,
  PINNED_HEADLESS_DRAIN_ROOM_ID,
  assertHeadlessDrainIdentity,
  assertPinnedHeadlessDrainAllowlist,
  createHeadlessClaimerGuard,
  createInstalledHeadlessDrain,
  dedicatedHeadlessDrainLaunchAgentLabel,
  deriveProfileInstanceId,
  hasHeadlessWakeKeys,
  isGrokBotRuntimeAdapter,
  loadHeadlessDrainConfig,
  normalizeHeadlessWakeConfig,
  probeDedicatedHeadlessDrainLoaded,
} from "./headless-drain-service.mjs";

export {
  createDesktopHandoffController,
  createFakeDesktopOwner,
  resolvePhase4DesktopHandoffConfig,
} from "./desktop-handoff.mjs";

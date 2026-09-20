/**
 * Headless Codex worker runtime surface (Phase 0–3).
 *
 * Phase 3 adds a bounded multi-slot pool (preferred 2, cap 4) for shadow test
 * profiles only. Production mcp-interactive / desktop profiles stay unchanged.
 * Global featureFlags.headlessRuntime and helperConversationStore remain false.
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
  isShadowHeadlessTestProfile,
  resolvePhase0RuntimeConfig,
  resolvePhase1ShadowRuntimeConfig,
} from "./config-guards.mjs";

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

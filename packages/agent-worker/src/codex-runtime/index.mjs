/**
 * Headless Codex worker runtime surface (Phase 0 + Phase 1 shadow).
 *
 * Phase 1 adds a single-slot shadow path for isolated test profiles only.
 * Production mcp-interactive / Shared App Server desktop profiles stay
 * unchanged. Feature flags remain inactive unless a shadow test profile opts in.
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
  assertExecutionState,
  canTransitionExecutionState,
  createExecutionRecord,
  replyBeforeAckStages,
  transitionExecutionState,
} from "./execution-state.mjs";

export { createMemoryConversationRegistry } from "./conversation-registry.mjs";

export { createCodexWorkerPool } from "./worker-pool.mjs";

export { createHeadlessCodexRuntime } from "./headless-runtime.mjs";

/**
 * Cursor ACP runtime surface (dedicated lane — out of Codex App Server pool).
 *
 * Shadow/opt-in only in this vertical. Helper transaction proxy settlement.
 * Mini live canary + Swift RuntimeAdapter enrollment are follow-ups.
 */

export {
  ACP_AUTH_METHOD_CURSOR_LOGIN,
  ACP_CLIENT_METHODS,
  ACP_MODES,
  ACP_NOTIFICATIONS,
  ACP_PERMISSION_OPTION_IDS,
  ACP_SERVER_REQUEST_METHODS,
  ACP_STOP_REASONS,
  assertAcpMode,
  assertNoSecretMaterial,
  classifyJsonRpcMessage,
  createRequestIdFactory,
  encodeJsonRpcNotification,
  encodeJsonRpcRequest,
  encodeNdjsonLine,
  extractAcpAssistantText,
  parseNdjsonLine,
  resolveWorkloadMode,
} from "./acp-protocol.mjs";

export {
  createCursorAcpProcess,
  createFakeAcpStdioProgram,
} from "./acp-process.mjs";

export { createUnattendedAcpPolicy } from "./unattended-policy.mjs";

export {
  buildSanitizedCursorChildEnv,
  defaultTriangleCursorHome,
  resolveCursorAcpPoolGuards,
  resolveTriangleCursorHome,
} from "./runtime-home.mjs";

export {
  CURSOR_ACP_DELIVERY_MODE,
  CURSOR_ACP_EXECUTION_KIND,
  CURSOR_ACP_RUNTIME_ADAPTER,
  CURSOR_ACP_RUNTIME_MODE,
  createDefaultCursorAcpShadowProfile,
  isCodexAppServerProfile,
  isCursorAcpProfile,
  isCursorAcpRuntimeAdapter,
  isGrokBotProfile,
  isShadowCursorAcpTestProfile,
  resolveCursorAcpRuntimeConfig,
} from "./config-guards.mjs";

export { createMemoryCursorSessionRegistry } from "./session-registry.mjs";

export { createCursorAcpWorkerPool } from "./worker-pool.mjs";

export { createHeadlessCursorAcpRuntime } from "./headless-runtime.mjs";

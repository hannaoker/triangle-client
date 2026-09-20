/**
 * Phase 5 — Codex profile schema classification.
 *
 * Distinguishes legacy command execution, headless App Server execution, and
 * desktop App Server execution. Does not flip production defaults; classification
 * is pure. Migration / new-profile defaults stay behind Phase 5 enablement.
 */

export const CODEX_EXECUTION_KIND = Object.freeze({
  LEGACY_COMMAND: "legacy-command",
  DESKTOP_APP_SERVER: "desktop-app-server",
  HEADLESS_APP_SERVER: "headless-app-server",
});

/**
 * Profile schema versions map 1:1 to execution kind.
 * Existing ClientInstance.version=1 records without Phase 5 fields classify as
 * legacy or desktop from deliveryMode / runtimeMode (see classify).
 */
export const CODEX_PROFILE_SCHEMA_VERSION = Object.freeze({
  LEGACY_COMMAND: 1,
  DESKTOP_APP_SERVER: 2,
  HEADLESS_APP_SERVER: 3,
});

const KIND_TO_SCHEMA = Object.freeze({
  [CODEX_EXECUTION_KIND.LEGACY_COMMAND]: CODEX_PROFILE_SCHEMA_VERSION.LEGACY_COMMAND,
  [CODEX_EXECUTION_KIND.DESKTOP_APP_SERVER]: CODEX_PROFILE_SCHEMA_VERSION.DESKTOP_APP_SERVER,
  [CODEX_EXECUTION_KIND.HEADLESS_APP_SERVER]: CODEX_PROFILE_SCHEMA_VERSION.HEADLESS_APP_SERVER,
});

const SCHEMA_TO_KIND = Object.freeze({
  [CODEX_PROFILE_SCHEMA_VERSION.LEGACY_COMMAND]: CODEX_EXECUTION_KIND.LEGACY_COMMAND,
  [CODEX_PROFILE_SCHEMA_VERSION.DESKTOP_APP_SERVER]: CODEX_EXECUTION_KIND.DESKTOP_APP_SERVER,
  [CODEX_PROFILE_SCHEMA_VERSION.HEADLESS_APP_SERVER]: CODEX_EXECUTION_KIND.HEADLESS_APP_SERVER,
});

function createCodedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

export function schemaVersionForExecutionKind(kind) {
  const version = KIND_TO_SCHEMA[kind];
  if (version == null) {
    throw createCodedError("profile_schema_unknown_kind", `unknown execution kind: ${kind}`);
  }
  return version;
}

export function executionKindForSchemaVersion(version) {
  const kind = SCHEMA_TO_KIND[version];
  if (kind == null) {
    throw createCodedError(
      "profile_schema_unknown_version",
      `unknown profile schema version: ${version}`,
    );
  }
  return kind;
}

/**
 * Classify a Codex profile config into an execution kind.
 *
 * Precedence:
 * 1. Explicit `executionKind` when valid
 * 2. Explicit `schemaVersion` when valid
 * 3. Shape inference from runtimeAdapter / runtimeMode / deliveryMode
 *
 * mcp-interactive and desktop App Server bindings stay desktop until migrated.
 * event-driven / worker command adapters are legacy-command (not equivalent to
 * persistent headless App Server).
 */
export function classifyCodexProfileExecution(profileConfig = {}) {
  const explicitKind = profileConfig?.executionKind;
  if (
    explicitKind === CODEX_EXECUTION_KIND.LEGACY_COMMAND ||
    explicitKind === CODEX_EXECUTION_KIND.DESKTOP_APP_SERVER ||
    explicitKind === CODEX_EXECUTION_KIND.HEADLESS_APP_SERVER
  ) {
    return explicitKind;
  }

  if (
    profileConfig?.schemaVersion === CODEX_PROFILE_SCHEMA_VERSION.LEGACY_COMMAND ||
    profileConfig?.schemaVersion === CODEX_PROFILE_SCHEMA_VERSION.DESKTOP_APP_SERVER ||
    profileConfig?.schemaVersion === CODEX_PROFILE_SCHEMA_VERSION.HEADLESS_APP_SERVER
  ) {
    return executionKindForSchemaVersion(profileConfig.schemaVersion);
  }

  const runtimeAdapter = profileConfig?.runtimeAdapter ?? null;
  const runtimeMode = profileConfig?.runtimeMode ?? null;
  const deliveryMode = profileConfig?.deliveryMode ?? null;

  if (runtimeAdapter === "codex-app-server" && runtimeMode === "headless") {
    return CODEX_EXECUTION_KIND.HEADLESS_APP_SERVER;
  }

  if (
    deliveryMode === "mcp-interactive" ||
    (runtimeAdapter === "codex-app-server" && runtimeMode === "desktop") ||
    profileConfig?.appServerWake != null ||
    profileConfig?.appServerBinding?.enabled === true
  ) {
    return CODEX_EXECUTION_KIND.DESKTOP_APP_SERVER;
  }

  if (
    deliveryMode === "event-driven" ||
    deliveryMode === "worker" ||
    runtimeAdapter === "codex" ||
    runtimeAdapter === "hermes" ||
    runtimeAdapter === "antigravity"
  ) {
    return CODEX_EXECUTION_KIND.LEGACY_COMMAND;
  }

  // Fail closed for ambiguous Codex shapes — operator must set schema fields.
  throw createCodedError(
    "profile_schema_unclassified",
    "cannot classify Codex profile execution kind; set executionKind or schemaVersion",
    {
      runtimeAdapter,
      runtimeMode,
      deliveryMode,
    },
  );
}

/**
 * Normalize a profile config with schemaVersion + executionKind filled in.
 * Does not mutate production bindings or flip defaults.
 */
export function annotateCodexProfileSchema(profileConfig = {}) {
  const executionKind = classifyCodexProfileExecution(profileConfig);
  const schemaVersion = schemaVersionForExecutionKind(executionKind);
  return Object.freeze({
    ...profileConfig,
    executionKind,
    schemaVersion,
  });
}

export function isLegacyCommandExecution(profileConfig = {}) {
  return classifyCodexProfileExecution(profileConfig) === CODEX_EXECUTION_KIND.LEGACY_COMMAND;
}

export function isDesktopAppServerExecution(profileConfig = {}) {
  return classifyCodexProfileExecution(profileConfig) === CODEX_EXECUTION_KIND.DESKTOP_APP_SERVER;
}

export function isHeadlessAppServerExecution(profileConfig = {}) {
  return classifyCodexProfileExecution(profileConfig) === CODEX_EXECUTION_KIND.HEADLESS_APP_SERVER;
}

/**
 * mcp-interactive keeps current desktop behavior until explicit migrate.
 */
export function isMcpInteractiveDesktopProfile(profileConfig = {}) {
  return (
    profileConfig?.deliveryMode === "mcp-interactive" ||
    classifyCodexProfileExecution(profileConfig) === CODEX_EXECUTION_KIND.DESKTOP_APP_SERVER
  );
}

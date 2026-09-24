/**
 * Cursor ACP profile schema + shadow/opt-in guards.
 *
 * Dedicated runtimeAdapter: "cursor-acp". Never joins Codex App Server pool.
 * Never matches grok-bot. Production enrollment on Mini is out of scope for
 * this vertical — shadow/test profiles only unless operator-enabled.
 */

export const CURSOR_ACP_RUNTIME_ADAPTER = "cursor-acp";
export const CURSOR_ACP_DELIVERY_MODE = "headless-cursor-acp";
export const CURSOR_ACP_RUNTIME_MODE = "headless";

export const CURSOR_ACP_EXECUTION_KIND = Object.freeze({
  HEADLESS_ACP: "headless-cursor-acp",
});

function createCodedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

export function isGrokBotProfile(profileConfig = {}) {
  return (
    profileConfig?.runtimeAdapter === "grok-bot" ||
    profileConfig?.deliveryMode === "grok-bot"
  );
}

export function isCodexAppServerProfile(profileConfig = {}) {
  const adapter = profileConfig?.runtimeAdapter ?? null;
  return (
    adapter === "codex-app-server" ||
    adapter === "codex" ||
    profileConfig?.deliveryMode === "headless-app-server" ||
    profileConfig?.deliveryMode === "mcp-interactive"
  );
}

export function isCursorAcpRuntimeAdapter(runtimeAdapter) {
  return runtimeAdapter === CURSOR_ACP_RUNTIME_ADAPTER;
}

/**
 * Closed shape for the Cursor ACP lane. Explicitly rejects Codex and Bob.
 */
export function isCursorAcpProfile(profileConfig = {}) {
  if (isGrokBotProfile(profileConfig)) return false;
  if (isCodexAppServerProfile(profileConfig) && !isCursorAcpRuntimeAdapter(profileConfig?.runtimeAdapter)) {
    return false;
  }
  return (
    isCursorAcpRuntimeAdapter(profileConfig?.runtimeAdapter) &&
    (profileConfig?.runtimeMode == null ||
      profileConfig?.runtimeMode === CURSOR_ACP_RUNTIME_MODE) &&
    (profileConfig?.deliveryMode == null ||
      profileConfig?.deliveryMode === CURSOR_ACP_DELIVERY_MODE)
  );
}

export function isShadowCursorAcpTestProfile(profileConfig = {}) {
  return (
    isCursorAcpProfile(profileConfig) &&
    profileConfig?.shadowTestProfile === true
  );
}

function shadowEnabled({ env = process.env, enableShadow = false } = {}) {
  if (enableShadow === true) return true;
  if (env.TRIANGLE_CURSOR_ACP_SHADOW_ENABLE === "1") return true;
  const allowlist = String(env.TRIANGLE_CURSOR_ACP_SHADOW_PROFILES ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return allowlist;
}

/**
 * Resolve whether the Cursor ACP runtime may activate for this profile.
 * Fail-closed: Codex / grok-bot / non-shadow production shapes stay inactive.
 */
export function resolveCursorAcpRuntimeConfig(
  profileConfig = {},
  { env = process.env, enableShadow = false, preferredPoolSize = 1 } = {},
) {
  if (isGrokBotProfile(profileConfig)) {
    return Object.freeze({
      active: false,
      inactiveReason: "grok_bot_excluded",
      runtimeAdapter: profileConfig?.runtimeAdapter ?? null,
      pool: Object.freeze({ preferredSize: 1, maxSize: 1 }),
    });
  }
  if (isCodexAppServerProfile(profileConfig) && !isCursorAcpProfile(profileConfig)) {
    return Object.freeze({
      active: false,
      inactiveReason: "codex_pool_excluded",
      runtimeAdapter: profileConfig?.runtimeAdapter ?? null,
      pool: Object.freeze({ preferredSize: 1, maxSize: 1 }),
    });
  }
  if (!isCursorAcpProfile(profileConfig)) {
    return Object.freeze({
      active: false,
      inactiveReason: "not_cursor_acp_profile",
      runtimeAdapter: profileConfig?.runtimeAdapter ?? null,
      pool: Object.freeze({ preferredSize: 1, maxSize: 1 }),
    });
  }

  const shadow = isShadowCursorAcpTestProfile(profileConfig);
  if (!shadow) {
    return Object.freeze({
      active: false,
      inactiveReason: "not_shadow_test_profile",
      runtimeAdapter: CURSOR_ACP_RUNTIME_ADAPTER,
      pool: Object.freeze({ preferredSize: 1, maxSize: 1 }),
      note: "production Cursor ACP enrollment is out of scope for this vertical",
    });
  }

  const enabled = shadowEnabled({ env, enableShadow });
  const profileId = profileConfig?.profileId ?? null;
  const allowlistHit =
    Array.isArray(enabled) &&
    typeof profileId === "string" &&
    enabled.includes(profileId);
  const operatorEnabled = enabled === true || allowlistHit;
  if (!operatorEnabled) {
    return Object.freeze({
      active: false,
      inactiveReason: "shadow_not_operator_enabled",
      runtimeAdapter: CURSOR_ACP_RUNTIME_ADAPTER,
      pool: Object.freeze({ preferredSize: 1, maxSize: 1 }),
    });
  }

  const workload = profileConfig?.workload ?? "conversational";
  const model = typeof profileConfig?.model === "string" ? profileConfig.model : null;

  return Object.freeze({
    active: true,
    inactiveReason: null,
    activationMode: "cursor_acp_shadow",
    runtimeAdapter: CURSOR_ACP_RUNTIME_ADAPTER,
    deliveryMode: CURSOR_ACP_DELIVERY_MODE,
    runtimeMode: CURSOR_ACP_RUNTIME_MODE,
    workload,
    model,
    pool: Object.freeze({
      preferredSize: 1,
      maxSize: 1,
      requestedPreferredSize: preferredPoolSize,
    }),
    profileId,
  });
}

export function createDefaultCursorAcpShadowProfile(overrides = {}) {
  if (overrides.runtimeAdapter === "grok-bot" || overrides.runtimeAdapter === "codex-app-server") {
    throw createCodedError(
      "cursor_acp_profile_conflict",
      "Cursor ACP shadow profile cannot reuse Codex or grok-bot adapters",
    );
  }
  return Object.freeze({
    profileId: overrides.profileId ?? "cursor-acp-shadow-test",
    runtimeAdapter: CURSOR_ACP_RUNTIME_ADAPTER,
    runtimeMode: CURSOR_ACP_RUNTIME_MODE,
    deliveryMode: CURSOR_ACP_DELIVERY_MODE,
    executionKind: CURSOR_ACP_EXECUTION_KIND.HEADLESS_ACP,
    shadowTestProfile: true,
    workload: overrides.workload ?? "conversational",
    model: overrides.model ?? null,
    workingDirectory: overrides.workingDirectory ?? null,
    permissionDefault: overrides.permissionDefault ?? "allow-once",
    ...overrides,
    runtimeAdapter: CURSOR_ACP_RUNTIME_ADAPTER,
    shadowTestProfile: true,
  });
}

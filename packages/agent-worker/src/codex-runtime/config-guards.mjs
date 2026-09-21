/**
 * Headless Codex runtime feature flags and config guards.
 *
 * Phase 0 flags stay inactive for production.
 * Phase 1 adds an explicit shadow test-profile opt-in that never flips
 * production desktop / mcp-interactive profiles by default.
 * Phase 4 desktop handoff stays off unless resolvePhase4DesktopHandoffConfig
 * (or isDesktopHandoffEnabled) is explicitly opted in for shadow experiments.
 *
 * Product default (2026-09-21): Codex profiles use headless App Server. grok-bot
 * never enters this pool. Mini-only profile/room allowlists are not the product
 * gate. Pool size stays 1 until shared CODEX_HOME is proved; desktop handoff
 * stays off. Existing mcp-interactive Codex stays desktop until migrated so
 * desktop + headless never share a mailbox.
 */

import { getFeatureFlags, loadRuntimeManifest } from "./runtime-manifest.mjs";
import { resolveCodexPoolGuards } from "./runtime-home.mjs";

export function isHelperConversationStoreEnabled(manifest = loadRuntimeManifest()) {
  return getFeatureFlags(manifest).helperConversationStore === true;
}

export function isHeadlessRuntimeEnabled(manifest = loadRuntimeManifest()) {
  return getFeatureFlags(manifest).headlessRuntime === true;
}

export function isDesktopHandoffEnabled(manifest = loadRuntimeManifest()) {
  const flags = getFeatureFlags(manifest);
  const guards = resolveCodexPoolGuards({
    desktopHandoffRequested: flags.desktopHandoff === true,
    probeStatus: manifest.sharedHomeConcurrency?.status ?? "unproved",
    manifest,
  });
  return guards.desktopHandoffEnabled === true;
}

/**
 * Isolated Phase 1 shadow test profile shape.
 *
 * Production desktop profiles use Shared App Server / mcp-interactive and must
 * not set `shadowTestProfile: true`.
 */
export function isShadowHeadlessTestProfile(profileConfig = {}) {
  return (
    profileConfig?.runtimeAdapter === "codex-app-server" &&
    profileConfig?.runtimeMode === "headless" &&
    profileConfig?.shadowTestProfile === true
  );
}

function parseAllowlist(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  return new Set(
    raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );
}

/**
 * Operator enablement for the Phase 1–3 shadow path.
 *
 * A profile activates only when:
 * 1. It is an isolated shadow test profile (`shadowTestProfile: true`, …), AND
 * 2. Either:
 *    - `enableShadow: true` (unit/integration injection), OR
 *    - `TRIANGLE_HEADLESS_SHADOW_ENABLE=1`, OR
 *    - the profile id is listed in `TRIANGLE_HEADLESS_SHADOW_PROFILES`.
 *
 * Phase 3 defaults the shadow pool to preferredSize 2 (cap up to 4 via
 * manifest `forcedPoolSize`). Set `codexPool.preferredSize: 1` to keep a
 * shadow profile on a single slot. The global manifest
 * `featureFlags.headlessRuntime` remains false and does not activate
 * production profiles.
 */
export function resolvePhase1ShadowRuntimeConfig(
  profileConfig = {},
  {
    manifest = loadRuntimeManifest(),
    env = process.env,
    enableShadow = false,
  } = {},
) {
  const pool = resolveCodexPoolGuards({
    preferredSize: profileConfig.codexPool?.preferredSize ?? 2,
    maxSize: profileConfig.codexPool?.maxSize ?? 4,
    desktopHandoffRequested: false,
    probeStatus: manifest.sharedHomeConcurrency?.status ?? "unproved",
    manifest,
  });

  const shadowShape = isShadowHeadlessTestProfile(profileConfig);
  const profileId =
    typeof profileConfig.profileId === "string"
      ? profileConfig.profileId
      : typeof profileConfig.actorProfile === "string"
        ? profileConfig.actorProfile
        : null;
  const allowlist = parseAllowlist(env.TRIANGLE_HEADLESS_SHADOW_PROFILES);
  const envEnableAll = env.TRIANGLE_HEADLESS_SHADOW_ENABLE === "1";
  const allowlisted =
    allowlist == null ? false : profileId != null && allowlist.has(profileId);
  const operatorEnabled = enableShadow === true || envEnableAll || allowlisted;

  let inactiveReason = null;
  if (!shadowShape) {
    inactiveReason = "not_shadow_test_profile";
  } else if (!operatorEnabled) {
    inactiveReason = "shadow_not_operator_enabled";
  } else if (pool.preferredSize < 1 || pool.preferredSize > 4) {
    inactiveReason = "pool_size_out_of_bounds";
  }

  return Object.freeze({
    active: inactiveReason == null,
    inactiveReason,
    shadowTestProfile: shadowShape,
    operatorEnabled,
    profileId,
    runtimeMode: profileConfig.runtimeMode ?? null,
    runtimeAdapter: profileConfig.runtimeAdapter ?? null,
    headlessRuntimeEnabled: isHeadlessRuntimeEnabled(manifest),
    helperConversationStoreEnabled: isHelperConversationStoreEnabled(manifest),
    // Phase 4 handoff stays false on the Phase 1–3 shadow path unless the
    // operator uses resolvePhase4DesktopHandoffConfig / TRIANGLE_DESKTOP_HANDOFF_ENABLE.
    desktopHandoffEnabled: false,
    pool,
    featureFlags: getFeatureFlags(manifest),
    manifest,
  });
}

/**
 * Resolve the persistent headless Codex App Server runtime.
 * Product activation: headless App Server shape, not Mini-only allowlist.
 * grok-bot never activates. Desktop mcp-interactive stays inactive so this
 * path cannot silently dual-claim with Shared App Server. Pool size is 1
 * until shared CODEX_HOME is proved; desktop handoff stays off.
 */
export function resolveHeadlessRuntimeConfig(
  profileConfig = {},
  {
    manifest = loadRuntimeManifest(),
    env = process.env,
    enableShadow = false,
    enablePhase5Migration = false,
  } = {},
) {
  const shadow = resolvePhase1ShadowRuntimeConfig(profileConfig, {
    manifest,
    env,
    enableShadow,
  });
  if (shadow.active) {
    return Object.freeze({ ...shadow, activationMode: "shadow" });
  }

  const phase5 = resolvePhase5MigrationConfig(profileConfig, {
    manifest,
    env,
    enablePhase5Migration,
  });
  const profileId = phase5.profileId;
  const runtimeAdapter = profileConfig?.runtimeAdapter ?? null;
  const deliveryMode = profileConfig?.deliveryMode ?? null;
  const grokBotShape =
    runtimeAdapter === "grok-bot" || deliveryMode === "grok-bot";
  const productionShape =
    !grokBotShape &&
    profileConfig?.executionKind === "headless-app-server" &&
    (runtimeAdapter === "codex-app-server" || runtimeAdapter === "codex") &&
    profileConfig?.runtimeMode === "headless" &&
    profileConfig?.shadowTestProfile !== true;
  const pool = resolveCodexPoolGuards({
    preferredSize: 1,
    maxSize: 1,
    desktopHandoffRequested: false,
    probeStatus: manifest.sharedHomeConcurrency?.status ?? "unproved",
    manifest,
  });

  let inactiveReason = null;
  if (grokBotShape) inactiveReason = "grok_bot_not_in_codex_pool";
  else if (!productionShape) inactiveReason = shadow.inactiveReason ?? "not_headless_app_server_profile";

  const forcedPool = Object.freeze({
    ...pool,
    preferredSize: 1,
    maxSize: 1,
    desktopHandoffEnabled: false,
  });

  return Object.freeze({
    active: inactiveReason == null,
    inactiveReason,
    activationMode: inactiveReason == null ? "headless_app_server" : null,
    shadowTestProfile: false,
    operatorEnabled: inactiveReason == null,
    profileId,
    runtimeMode: profileConfig.runtimeMode ?? null,
    runtimeAdapter: profileConfig.runtimeAdapter ?? null,
    headlessRuntimeEnabled: isHeadlessRuntimeEnabled(manifest),
    helperConversationStoreEnabled: isHelperConversationStoreEnabled(manifest),
    desktopHandoffEnabled: false,
    pool: forcedPool,
    featureFlags: getFeatureFlags(manifest),
    manifest,
  });
}

/**
 * Resolve effective runtime config for a Codex profile without activating
 * headless production behavior in Phase 0 / Phase 1 defaults.
 */
export function resolvePhase0RuntimeConfig(profileConfig = {}, { manifest = loadRuntimeManifest() } = {}) {
  const pool = resolveCodexPoolGuards({
    preferredSize: profileConfig.codexPool?.preferredSize ?? 2,
    maxSize: profileConfig.codexPool?.maxSize ?? 4,
    desktopHandoffRequested: false,
    probeStatus: manifest.sharedHomeConcurrency?.status ?? "unproved",
    manifest,
  });

  return Object.freeze({
    // Echo request only; activation gated by Phase 1 shadow opt-in helpers.
    runtimeMode: profileConfig.runtimeMode ?? "unchanged",
    headlessRuntimeEnabled: isHeadlessRuntimeEnabled(manifest),
    helperConversationStoreEnabled: isHelperConversationStoreEnabled(manifest),
    desktopHandoffEnabled: isDesktopHandoffEnabled(manifest),
    pool,
    featureFlags: getFeatureFlags(manifest),
    shadow: resolvePhase1ShadowRuntimeConfig(profileConfig, { manifest }),
  });
}

/**
 * Phase 5 operator enablement for migration machinery and new-profile defaults.
 *
 * Product default: new Codex profiles are headless App Server. Migration
 * operations stay available so existing mcp-interactive Codex can move one
 * profile at a time without dual claimers. Disable with
 * `enablePhase5Migration: false` or `TRIANGLE_PHASE5_MIGRATION_ENABLE=0`.
 *
 * The immutable manifest `featureFlags.headlessRuntime` is recorded for
 * operators and is not required for per-profile headless activation.
 */
export function resolvePhase5MigrationConfig(
  profileConfig = {},
  {
    manifest = loadRuntimeManifest(),
    env = process.env,
    enablePhase5Migration = null,
  } = {},
) {
  const flags = getFeatureFlags(manifest);
  const envDisable = env.TRIANGLE_PHASE5_MIGRATION_ENABLE === "0";
  const envEnable = env.TRIANGLE_PHASE5_MIGRATION_ENABLE === "1";
  const operatorEnabled =
    enablePhase5Migration === true
    || (enablePhase5Migration !== false && !envDisable)
    || envEnable === true;
  const globalHeadlessFlag = flags.headlessRuntime === true;

  let inactiveReason = null;
  if (!operatorEnabled) {
    inactiveReason = "phase5_migration_not_enabled";
  }

  return Object.freeze({
    active: inactiveReason == null,
    inactiveReason,
    operatorEnabled,
    newProfileDefaultHeadless: true,
    migrationOperationsEnabled: operatorEnabled,
    globalHeadlessRuntimeFlag: globalHeadlessFlag,
    manifestHeadlessRuntimeEnabled: globalHeadlessFlag,
    profileId:
      typeof profileConfig.profileId === "string"
        ? profileConfig.profileId
        : typeof profileConfig.actorProfile === "string"
          ? profileConfig.actorProfile
          : null,
    featureFlags: flags,
    manifest,
  });
}

/**
 * True when Codex headless migration machinery is available (product default).
 * Disable with `enablePhase5Migration: false` or `TRIANGLE_PHASE5_MIGRATION_ENABLE=0`.
 */
export function isPhase5MigrationEnabled({
  manifest = loadRuntimeManifest(),
  env = process.env,
  enablePhase5Migration = null,
} = {}) {
  return resolvePhase5MigrationConfig({}, { manifest, env, enablePhase5Migration }).active === true;
}

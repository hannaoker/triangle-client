/**
 * Headless Codex runtime feature flags and config guards.
 *
 * Phase 0 flags stay inactive for production.
 * Phase 1 adds an explicit shadow test-profile opt-in that never flips
 * production desktop / mcp-interactive profiles by default.
 * Phase 4 desktop handoff stays off unless resolvePhase4DesktopHandoffConfig
 * (or isDesktopHandoffEnabled) is explicitly opted in for shadow experiments.
 * Phase 5 migration / new-profile headless defaults stay off unless
 * resolvePhase5MigrationConfig is explicitly opted in. Global
 * featureFlags.headlessRuntime remains false in the immutable manifest.
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
 * Resolve the actual persistent headless runtime, not just migration tooling.
 * Production activation is deliberately stricter than Phase 5 migration:
 * the profile must have the headless App Server execution shape, Phase 5 must
 * be enabled, and its exact profile id must be operator-allowlisted.
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
  const allowlist = parseAllowlist(env.TRIANGLE_HEADLESS_RUNTIME_PROFILES);
  const allowlisted =
    allowlist != null && profileId != null && allowlist.has(profileId);
  const productionShape =
    profileConfig?.executionKind === "headless-app-server" &&
    profileConfig?.runtimeAdapter === "codex-app-server" &&
    profileConfig?.runtimeMode === "headless" &&
    profileConfig?.shadowTestProfile !== true;
  const pool = resolveCodexPoolGuards({
    preferredSize: profileConfig.codexPool?.preferredSize ?? 2,
    maxSize: profileConfig.codexPool?.maxSize ?? 4,
    desktopHandoffRequested: false,
    probeStatus: manifest.sharedHomeConcurrency?.status ?? "unproved",
    manifest,
  });

  let inactiveReason = null;
  if (!productionShape) inactiveReason = shadow.inactiveReason ?? "not_headless_app_server_profile";
  else if (!phase5.active) inactiveReason = phase5.inactiveReason;
  else if (!allowlisted) inactiveReason = "headless_profile_not_allowlisted";

  return Object.freeze({
    active: inactiveReason == null,
    inactiveReason,
    activationMode: inactiveReason == null ? "phase5_profile" : null,
    shadowTestProfile: false,
    operatorEnabled: phase5.active && allowlisted,
    profileId,
    runtimeMode: profileConfig.runtimeMode ?? null,
    runtimeAdapter: profileConfig.runtimeAdapter ?? null,
    headlessRuntimeEnabled: isHeadlessRuntimeEnabled(manifest),
    helperConversationStoreEnabled: isHelperConversationStoreEnabled(manifest),
    desktopHandoffEnabled: false,
    pool,
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
 * Production defaults stay safe. Activation requires an explicit opt-in:
 * - `enablePhase5Migration: true` (unit/integration / profile factory injection), OR
 * - `TRIANGLE_PHASE5_MIGRATION_ENABLE=1`
 *
 * The immutable manifest `featureFlags.headlessRuntime` must remain **false**
 * until the design release-gate checklist (soak, live desktop canary, etc.)
 * is operator-proven. This resolver never flips that flag.
 *
 * When inactive:
 * - new Codex profiles do **not** default to headless;
 * - migrate-to-headless / rollback-to-desktop reject as disabled;
 * - existing mcp-interactive / Shared App Server bindings are untouched.
 */
export function resolvePhase5MigrationConfig(
  profileConfig = {},
  {
    manifest = loadRuntimeManifest(),
    env = process.env,
    enablePhase5Migration = false,
  } = {},
) {
  const flags = getFeatureFlags(manifest);
  const envEnable = env.TRIANGLE_PHASE5_MIGRATION_ENABLE === "1";
  const operatorEnabled = enablePhase5Migration === true || envEnable === true;
  // Manifest global flag is recorded for operators but must not auto-enable
  // Phase 5 in this PR — release gates (soak / live canary) remain open.
  const globalHeadlessFlag = flags.headlessRuntime === true;

  let inactiveReason = null;
  if (!operatorEnabled) {
    inactiveReason = "phase5_migration_not_enabled";
  }

  return Object.freeze({
    active: inactiveReason == null,
    inactiveReason,
    operatorEnabled,
    // New-profile factory defaults to headless only when Phase 5 is explicitly on.
    newProfileDefaultHeadless: operatorEnabled,
    // Migrate / rollback APIs allowed only when explicitly on.
    migrationOperationsEnabled: operatorEnabled,
    globalHeadlessRuntimeFlag: globalHeadlessFlag,
    // Always false for committed defaults in this PR; do not treat as enablement.
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
 * True only when an operator explicitly enabled Phase 5 (env or injection).
 * Never true solely because the committed manifest exists.
 */
export function isPhase5MigrationEnabled({
  manifest = loadRuntimeManifest(),
  env = process.env,
  enablePhase5Migration = false,
} = {}) {
  return resolvePhase5MigrationConfig({}, { manifest, env, enablePhase5Migration }).active === true;
}

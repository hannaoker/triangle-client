/**
 * Headless Codex runtime feature flags and config guards.
 *
 * Phase 0 flags stay inactive for production.
 * Phase 1 adds an explicit shadow test-profile opt-in that never flips
 * production desktop / mcp-interactive profiles by default.
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
    desktopHandoffEnabled: false,
    pool,
    featureFlags: getFeatureFlags(manifest),
    shadow: resolvePhase1ShadowRuntimeConfig(profileConfig, { manifest }),
  });
}

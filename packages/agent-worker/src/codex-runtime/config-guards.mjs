/**
 * Headless Codex runtime feature flags and config guards (Phase 0).
 *
 * All flags default inactive — no production profile behavior changes.
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
 * Resolve effective runtime config for a Codex profile without activating
 * headless production behavior in Phase 0.
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
    // Phase 0: never flip production profiles to headless.
    runtimeMode: profileConfig.runtimeMode ?? "unchanged",
    headlessRuntimeEnabled: isHeadlessRuntimeEnabled(manifest),
    helperConversationStoreEnabled: isHelperConversationStoreEnabled(manifest),
    desktopHandoffEnabled: false,
    pool,
    featureFlags: getFeatureFlags(manifest),
  });
}

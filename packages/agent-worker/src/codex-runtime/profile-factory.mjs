/**
 * Phase 5 — Codex profile factory defaults.
 *
 * New Codex profiles default to headless App Server mode **only** when Phase 5
 * enablement is on (`TRIANGLE_PHASE5_MIGRATION_ENABLE=1` or
 * `enablePhase5Migration: true`). Otherwise defaults stay production-safe
 * desktop / mcp-interactive so Bob / Shared App Server are not flipped.
 */

import {
  isPhase5MigrationEnabled,
  resolvePhase5MigrationConfig,
} from "./config-guards.mjs";
import { loadRuntimeManifest } from "./runtime-manifest.mjs";
import {
  CODEX_EXECUTION_KIND,
  CODEX_PROFILE_SCHEMA_VERSION,
  annotateCodexProfileSchema,
} from "./profile-schema.mjs";

/**
 * Build the default config for a newly created Codex profile.
 *
 * @param {object} options
 * @param {string} options.profileId
 * @param {string} [options.profileInstanceId]
 * @param {boolean} [options.enablePhase5Migration] Explicit Phase 5 factory flag
 * @param {object} [options.env]
 * @param {object} [options.manifest]
 * @param {object} [options.overrides] Merged last (still re-annotated)
 */
export function createDefaultCodexProfileConfig({
  profileId,
  profileInstanceId = null,
  enablePhase5Migration = false,
  env = process.env,
  manifest = loadRuntimeManifest(),
  overrides = {},
} = {}) {
  if (typeof profileId !== "string" || profileId.length === 0) {
    throw new TypeError("profileId is required");
  }

  const phase5 = resolvePhase5MigrationConfig(
    { profileId },
    { manifest, env, enablePhase5Migration },
  );

  const base = phase5.newProfileDefaultHeadless
    ? {
        profileId,
        profileInstanceId,
        schemaVersion: CODEX_PROFILE_SCHEMA_VERSION.HEADLESS_APP_SERVER,
        executionKind: CODEX_EXECUTION_KIND.HEADLESS_APP_SERVER,
        runtimeAdapter: "codex-app-server",
        runtimeMode: "headless",
        // Headless ingress remains helper watch/poll + trusted proxy (design).
        // event-driven delivery is the mailbox membership shape; it is not the
        // legacy command adapter path (executionKind distinguishes them).
        deliveryMode: "event-driven",
        shadowTestProfile: false,
        appServerBinding: null,
        appServerWake: null,
        codexPool: {
          preferredSize: 2,
          maxSize: 4,
        },
        phase5DefaultApplied: true,
      }
    : {
        profileId,
        profileInstanceId,
        schemaVersion: CODEX_PROFILE_SCHEMA_VERSION.DESKTOP_APP_SERVER,
        executionKind: CODEX_EXECUTION_KIND.DESKTOP_APP_SERVER,
        runtimeAdapter: "codex-app-server",
        runtimeMode: "desktop",
        deliveryMode: "mcp-interactive",
        shadowTestProfile: false,
        // Binding is operator-bound separately; installation alone does not write it.
        appServerBinding: null,
        appServerWake: null,
        codexPool: null,
        phase5DefaultApplied: false,
      };

  return annotateCodexProfileSchema({ ...base, ...overrides, profileId });
}

/**
 * Convenience: true when factory would emit headless for a new Codex profile.
 */
export function wouldNewCodexProfileDefaultToHeadless(options = {}) {
  return isPhase5MigrationEnabled(options) === true;
}

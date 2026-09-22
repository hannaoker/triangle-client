/**
 * Codex profile factory defaults.
 *
 * New Codex profiles default to headless App Server
 * (`runtimeAdapter: codex-app-server`, `runtimeMode: headless`,
 * `executionKind: headless-app-server`). Desktop `mcp-interactive` is opt-in.
 * grok-bot is not a Codex factory path. Factory pool size stays 1; raising it
 * requires TRIANGLE_CODEX_POOL_ENABLE=1 at runtime. Desktop handoff stays off.
 */

import {
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
 * @param {boolean|null} [options.enablePhase5Migration] Legacy flag; ignored for defaults
 * @param {object} [options.env]
 * @param {object} [options.manifest]
 * @param {object} [options.overrides] Merged last (still re-annotated)
 */
export function createDefaultCodexProfileConfig({
  profileId,
  profileInstanceId = null,
  enablePhase5Migration = null,
  env = process.env,
  manifest = loadRuntimeManifest(),
  overrides = {},
} = {}) {
  if (typeof profileId !== "string" || profileId.length === 0) {
    throw new TypeError("profileId is required");
  }

  resolvePhase5MigrationConfig(
    { profileId },
    { manifest, env, enablePhase5Migration },
  );

  const runtimeAdapter = overrides.runtimeAdapter ?? "codex-app-server";
  if (runtimeAdapter === "grok-bot") {
    const error = new Error("grok-bot profiles cannot join the Codex headless pool");
    error.code = "grok_bot_not_in_codex_pool";
    throw error;
  }

  const base = {
    profileId,
    profileInstanceId,
    schemaVersion: CODEX_PROFILE_SCHEMA_VERSION.HEADLESS_APP_SERVER,
    executionKind: CODEX_EXECUTION_KIND.HEADLESS_APP_SERVER,
    runtimeAdapter: "codex-app-server",
    runtimeMode: "headless",
    deliveryMode: "headless-app-server",
    conversationKey: "roomId",
    maxInFlightPerProfile: 1,
    shadowTestProfile: false,
    appServerBinding: null,
    appServerWake: null,
    codexPool: {
      preferredSize: 1,
      maxSize: 1,
    },
    phase5DefaultApplied: true,
  };

  return annotateCodexProfileSchema({ ...base, ...overrides, profileId });
}

/**
 * Convenience: true when factory would emit headless for a new Codex profile.
 * Product default is always headless.
 */
export function wouldNewCodexProfileDefaultToHeadless(_options = {}) {
  return true;
}

/**
 * Explicit operator actions. Mutating paths stay behind named commands —
 * no ambient credential files, no invented token channels.
 */

import { resolveTrianglePaths } from "./paths.mjs";
import { parseHelperJson, runHelper } from "./helper-runner.mjs";
import { WATCH_STATUS_ALLOWED_KEYS, pickAllowedKeys, assertSecretFree } from "./secrets.mjs";

const INSTALLATION_ID_RE = /^inst_[A-Za-z0-9_-]{10,75}$/;
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KEY_FILE_RE = /^\/(?:[^\0]*\/)?agents\/agent_[a-f0-9]{32}\/workload-key\.json$/;

/**
 * Bind a helper profile to a `triangle` agent key file (permissions v1).
 * The key file path is not a secret and nothing secret crosses argv or stdin:
 * the helper reads the 0600 key file itself and verifies the identity with
 * MESH before it writes the binding. Without `execute` this only returns the
 * exact helper command.
 *
 * @param {object} options
 * @param {string} options.profile
 * @param {string} options.keyFile Absolute `<TRIANGLE_HOME>/agents/<agent_id>/workload-key.json`
 * @param {string} [options.origin] Optional https origin override (defaults to the agent's authority)
 * @param {string} [options.home]
 * @param {boolean} [options.execute]
 * @param {typeof runHelper} [options.run]
 */
export async function bindAction(options) {
  const { profile, keyFile, origin = null, execute = false, run = runHelper } = options;
  if (!PROFILE_RE.test(profile)) {
    throw Object.assign(new TypeError("profile is invalid"), { code: "invalid_profile" });
  }
  if (typeof keyFile !== "string" || !KEY_FILE_RE.test(keyFile) || Buffer.byteLength(keyFile) > 1024) {
    throw Object.assign(new TypeError("key file must be an absolute .../agents/<agent_id>/workload-key.json path"), { code: "invalid_key_file" });
  }
  if (origin != null && (typeof origin !== "string" || !/^https:\/\//.test(origin))) {
    throw Object.assign(new TypeError("origin must be https URL"), { code: "invalid_origin" });
  }

  const paths = resolveTrianglePaths(options.home);
  const args = ["bind", "--profile", profile, "--key-file", keyFile, ...(origin ? ["--origin", origin] : [])];
  if (!execute) {
    return {
      stub: true,
      command: [paths.helperPath, ...args],
      note: "The helper reads the 0600 key file itself and verifies the agent with MESH before binding; no secret is passed.",
    };
  }
  const result = await run(paths.helperPath, args, { assertFree: true });
  const payload = parseHelperJson(result.stdout, "triangle-mailbox bind");
  return { stub: false, exitCode: result.code, result: payload };
}

/**
 * Safe watch-ensure: the helper reads its stored watch grant; no mesh_watch_ on argv.
 * @param {object} options
 * @param {string} options.installationId
 * @param {string} options.actorProfile
 * @param {string} [options.home]
 * @param {boolean} [options.execute]
 * @param {typeof runHelper} [options.run]
 */
export async function watchEnsureAction(options) {
  const { installationId, actorProfile, execute = false, run = runHelper } = options;
  if (!INSTALLATION_ID_RE.test(installationId)) {
    throw Object.assign(new TypeError("installationId is invalid"), { code: "invalid_installation" });
  }
  if (!PROFILE_RE.test(actorProfile)) {
    throw Object.assign(new TypeError("actorProfile is invalid"), { code: "invalid_profile" });
  }
  const paths = resolveTrianglePaths(options.home);
  const args = ["watch-ensure", "--installation", installationId, "--actor-profile", actorProfile];
  if (!execute) {
    return {
      stub: true,
      command: [paths.helperPath, ...args],
      note: "Re-run with --execute to invoke the signed helper (no watch secret on argv).",
    };
  }
  const result = await run(paths.helperPath, args, { assertFree: true });
  const status = parseHelperJson(result.stdout, "triangle-mailbox watch-ensure");
  return {
    stub: false,
    exitCode: result.code,
    result: pickAllowedKeys(status, WATCH_STATUS_ALLOWED_KEYS),
  };
}

/**
 * Service start/stop/status via the reviewed checkout script.
 * @param {object} options
 * @param {"status"|"start"|"stop"} options.action
 * @param {string} options.serviceScriptPath Absolute path to triangle-client-service.sh
 * @param {boolean} [options.execute]
 * @param {typeof runHelper} [options.run]
 */
export async function serviceAction(options) {
  const { action, serviceScriptPath, execute = false, run = runHelper } = options;
  if (!["status", "start", "stop"].includes(action)) {
    throw Object.assign(new TypeError("action must be status|start|stop"), { code: "invalid_action" });
  }
  if (typeof serviceScriptPath !== "string" || !serviceScriptPath.startsWith("/")) {
    throw Object.assign(new TypeError("serviceScriptPath must be absolute"), { code: "invalid_script" });
  }
  if (!execute && action !== "status") {
    return {
      stub: true,
      command: [serviceScriptPath, action],
      note: "Re-run with --execute to invoke the service script. start/stop are explicit operator actions.",
    };
  }
  const result = await run(serviceScriptPath, [action], { assertFree: true });
  const summary = (result.stdout || "").trim().slice(0, 400);
  assertSecretFree(summary, "service output");
  return {
    stub: false,
    exitCode: result.code,
    summary: summary || `(exit ${result.code})`,
  };
}

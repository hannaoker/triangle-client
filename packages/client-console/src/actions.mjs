/**
 * Explicit operator actions. Mutating paths stay behind named commands —
 * no ambient credential files, no invented token channels.
 */

import { resolveTrianglePaths } from "./paths.mjs";
import { parseHelperJson, runHelper } from "./helper-runner.mjs";
import { WATCH_STATUS_ALLOWED_KEYS, pickAllowedKeys, assertSecretFree } from "./secrets.mjs";

const INSTALLATION_ID_RE = /^inst_[A-Za-z0-9_-]{10,75}$/;
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Enroll stays a documented stdin handoff to the signed helper.
 * This scaffold refuses to invent a new credential channel; it only prints
 * the exact operator recipe unless `execute: true` and stdin JSON are supplied.
 *
 * @param {object} options
 * @param {string} options.profile
 * @param {string} options.origin
 * @param {string} [options.home]
 * @param {string} [options.admissionJson] Full enrollment document (never logged)
 * @param {boolean} [options.execute]
 * @param {typeof runHelper} [options.run]
 */
export async function enrollAction(options) {
  const { profile, origin, execute = false, admissionJson = null, run = runHelper } = options;
  if (!PROFILE_RE.test(profile)) {
    throw Object.assign(new TypeError("profile is invalid"), { code: "invalid_profile" });
  }
  if (typeof origin !== "string" || !/^https:\/\//.test(origin)) {
    throw Object.assign(new TypeError("origin must be https URL"), { code: "invalid_origin" });
  }

  const paths = resolveTrianglePaths(options.home);
  const recipe = {
    stub: !execute,
    command: [paths.helperPath, "enroll", "--profile", profile, "--origin", origin],
    stdin: "<protected enrollment JSON on stdin — never argv or env>",
    note: "Console does not store admission tokens. Pipe a one-shot JSON document into the helper.",
  };

  if (!execute) {
    return recipe;
  }

  if (typeof admissionJson !== "string" || admissionJson.length === 0) {
    throw Object.assign(new Error("execute requires admissionJson on this call only"), {
      code: "missing_admission",
    });
  }
  // Do not assertSecretFree on admission JSON — it is expected to contain secrets.
  // Never include it in returned objects.
  const result = await run(paths.helperPath, ["enroll", "--profile", profile, "--origin", origin], {
    stdin: admissionJson,
    assertFree: true, // helper stdout must remain secret-free
  });
  const payload = parseHelperJson(result.stdout, "triangle-mailbox enroll");
  return {
    stub: false,
    exitCode: result.code,
    result: payload,
    note: "Admission material was passed only on helper stdin and is not retained by the console.",
  };
}

/**
 * Safe watch-ensure: helper reads Keychain; no mesh_watch_ on argv.
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
      note: "Re-run with --execute to invoke the signed helper (Keychain-backed; no watch secret on argv).",
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

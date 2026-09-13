/**
 * Read-only operator dashboard aggregation.
 * Prefers signed helper / triangle-client CLIs over Keychain or credential files.
 */

import { readFile } from "node:fs/promises";
import { resolveTrianglePaths } from "./paths.mjs";
import {
  AGENT_SUMMARY_ALLOWED_KEYS,
  PROFILE_STATUS_ALLOWED_KEYS,
  WATCH_STATUS_ALLOWED_KEYS,
  pickAllowedKeys,
  assertSecretFree,
} from "./secrets.mjs";
import { parseHelperJson, probeHelperPresence, runHelper } from "./helper-runner.mjs";

const INSTALLATION_ID_RE = /^inst_[A-Za-z0-9_-]{10,75}$/;

/**
 * @param {object} options
 * @param {string} [options.home]
 * @param {string} [options.installationId] Explicit installation id for watch-status
 * @param {typeof runHelper} [options.run]
 * @param {(file: string) => Promise<{present:boolean,executable:boolean,reason:string}>} [options.probe]
 * @param {(path: string, encoding: string) => Promise<string>} [options.readText]
 * @param {string} [options.serviceScriptPath] Optional path to triangle-client-service.sh
 * @param {AbortSignal} [options.signal]
 */
export async function collectDashboard(options = {}) {
  const paths = resolveTrianglePaths(options.home);
  const run = options.run ?? runHelper;
  const probe = options.probe ?? probeHelperPresence;
  const readText = options.readText ?? ((file, encoding) => readFile(file, encoding));

  const helper = await probe(paths.helperPath);
  const client = await probe(paths.clientPath);

  const installationId =
    options.installationId ??
    (await readInstallationId(paths.installationIdentityPath, readText).catch(() => null));

  /** @type {object} */
  const dashboard = {
    version: 1,
    generatedAt: new Date().toISOString(),
    paths: {
      applicationRoot: paths.applicationRoot,
      helperPath: paths.helperPath,
      clientPath: paths.clientPath,
    },
    helper: {
      present: helper.present,
      executable: helper.executable,
      reason: helper.reason,
    },
    clientBinary: {
      present: client.present,
      executable: client.executable,
      reason: client.reason,
    },
    installationId: installationId ?? null,
    agents: [],
    profiles: [],
    watch: null,
    service: null,
    stubs: {
      enroll: "stdin handoff to triangle-mailbox enroll (see actions enroll)",
      watchEnsure: "explicit triangle-mailbox watch-ensure (see actions watch-ensure)",
      serviceControl: "explicit scripts/triangle-client-service.sh start|stop",
    },
    errors: [],
  };

  if (client.present && client.executable) {
    try {
      const listed = await run(paths.clientPath, ["agent", "list"], { signal: options.signal });
      const doc = parseHelperJson(listed.stdout, "triangle-client agent list");
      const agents = Array.isArray(doc.agents) ? doc.agents : [];
      dashboard.agents = agents.map((agent) => pickAllowedKeys(agent, AGENT_SUMMARY_ALLOWED_KEYS));
    } catch (error) {
      dashboard.errors.push(summarizeError("agent_list", error));
    }
  } else {
    dashboard.errors.push({
      code: "client_unavailable",
      message: "triangle-client binary missing or not executable",
    });
  }

  if (helper.present && helper.executable && dashboard.agents.length > 0) {
    for (const agent of dashboard.agents) {
      const profile = agent.profile;
      if (typeof profile !== "string" || profile.length === 0) continue;
      try {
        const result = await run(paths.helperPath, ["status", "--profile", profile], {
          signal: options.signal,
        });
        // Helper may exit 1 for non-verified lifecycle while still emitting operator JSON.
        const status = parseHelperJson(result.stdout, `triangle-mailbox status (${profile})`);
        dashboard.profiles.push(pickAllowedKeys(status, PROFILE_STATUS_ALLOWED_KEYS));
      } catch (error) {
        dashboard.errors.push(summarizeError(`profile_status:${profile}`, error));
      }
    }
  } else if (!helper.present || !helper.executable) {
    dashboard.errors.push({
      code: "helper_unavailable",
      message: "triangle-mailbox helper missing or not executable",
    });
  }

  if (installationId) {
    if (!INSTALLATION_ID_RE.test(installationId)) {
      dashboard.errors.push({
        code: "installation_id_invalid",
        message: "installationId failed shape check",
      });
    } else if (helper.present && helper.executable) {
      try {
        const result = await run(
          paths.helperPath,
          ["watch-status", "--installation", installationId],
          { signal: options.signal },
        );
        const status = parseHelperJson(result.stdout, "triangle-mailbox watch-status");
        dashboard.watch = pickAllowedKeys(status, WATCH_STATUS_ALLOWED_KEYS);
      } catch (error) {
        dashboard.errors.push(summarizeError("watch_status", error));
      }
    }
  }

  if (typeof options.serviceScriptPath === "string" && options.serviceScriptPath.length > 0) {
    try {
      const result = await run(options.serviceScriptPath, ["status"], {
        signal: options.signal,
        assertFree: true,
      });
      dashboard.service = {
        available: true,
        exitCode: result.code,
        // Service scripts often emit plain text; keep only a short secret-free summary.
        summary: truncateSecretFree(result.stdout.trim() || `(exit ${result.code})`, 400),
      };
    } catch (error) {
      dashboard.service = {
        available: false,
        exitCode: null,
        summary: null,
      };
      dashboard.errors.push(summarizeError("service_status", error));
    }
  } else {
    dashboard.service = {
      available: false,
      exitCode: null,
      summary: null,
      note: "Pass serviceScriptPath or run `scripts/triangle-client-service.sh status` on macOS.",
    };
  }

  assertSecretFree(dashboard, "dashboard");
  return dashboard;
}

async function readInstallationId(filePath, readText) {
  const raw = await readText(filePath, "utf8");
  assertSecretFree(raw, "installation.json");
  const doc = JSON.parse(raw);
  if (!doc || typeof doc !== "object" || typeof doc.installationId !== "string") {
    throw Object.assign(new Error("installation identity missing"), { code: "installation_missing" });
  }
  assertSecretFree(doc.installationId, "installationId");
  return doc.installationId;
}

function summarizeError(scope, error) {
  return {
    code: error?.code ?? "error",
    scope,
    message: typeof error?.message === "string" ? error.message.slice(0, 200) : "unknown error",
  };
}

function truncateSecretFree(text, max) {
  assertSecretFree(text, "service summary");
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

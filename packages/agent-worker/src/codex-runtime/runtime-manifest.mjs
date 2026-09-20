/**
 * Immutable Codex runtime manifest loader and configuration allowlist checks.
 *
 * Product decisions in the headless design doc are closed. This module only
 * enforces the Phase 0 pinned sandbox / approval enum allowlists.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "manifest",
  "runtime-manifest.json",
);

let cachedManifest = null;

function createCodedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

export function loadRuntimeManifest({ forceReload = false } = {}) {
  if (cachedManifest && !forceReload) return cachedManifest;
  const raw = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  if (!raw || raw.immutable !== true || raw.manifestVersion !== 1) {
    throw createCodedError("runtime_manifest_invalid", "runtime manifest is invalid");
  }
  if (!Array.isArray(raw.approvalPolicy?.stringEnumAllowlist)) {
    throw createCodedError("runtime_manifest_invalid", "approvalPolicy allowlist missing");
  }
  if (!Array.isArray(raw.sandboxMode?.stringEnumAllowlist)) {
    throw createCodedError("runtime_manifest_invalid", "sandboxMode allowlist missing");
  }
  cachedManifest = Object.freeze(structuredClone(raw));
  return cachedManifest;
}

export function getRuntimeManifestPath() {
  return MANIFEST_PATH;
}

/**
 * Validate thread/start-style approvalPolicy against the immutable allowlist.
 * Headless mode additionally restricts to headlessAllowlist.
 */
export function assertAllowedApprovalPolicy(value, { headless = true, manifest = loadRuntimeManifest() } = {}) {
  const allowlist = headless
    ? manifest.approvalPolicy.headlessAllowlist
    : manifest.approvalPolicy.stringEnumAllowlist;
  if (typeof value === "string") {
    if (!allowlist.includes(value)) {
      throw createCodedError(
        "approval_policy_rejected",
        `approvalPolicy ${JSON.stringify(value)} is not in the pinned allowlist`,
        { value, allowlist: [...allowlist] },
      );
    }
    return value;
  }
  if (value && typeof value === "object" && value.granular && typeof value.granular === "object") {
    if (headless) {
      throw createCodedError(
        "approval_policy_rejected",
        "granular approvalPolicy is not allowed for headless workers",
        { value },
      );
    }
    if (!manifest.approvalPolicy.objectFormsAllowed?.includes("granular")) {
      throw createCodedError(
        "approval_policy_rejected",
        "granular approvalPolicy is not in the pinned allowlist",
        { value },
      );
    }
    return value;
  }
  throw createCodedError(
    "approval_policy_rejected",
    "approvalPolicy must be a pinned string enum (or allowed object form)",
    { value },
  );
}

/**
 * Validate thread/start sandbox (SandboxMode string enum).
 */
export function assertAllowedSandboxMode(value, { headless = true, manifest = loadRuntimeManifest() } = {}) {
  const allowlist = headless
    ? manifest.sandboxMode.headlessAllowlist
    : manifest.sandboxMode.stringEnumAllowlist;
  if (typeof value !== "string" || !allowlist.includes(value)) {
    throw createCodedError(
      "sandbox_mode_rejected",
      `sandbox ${JSON.stringify(value)} is not in the pinned allowlist`,
      { value, allowlist: [...allowlist] },
    );
  }
  return value;
}

/**
 * Validate turn/start sandboxPolicy.type against pinned SandboxPolicy types.
 */
export function assertAllowedSandboxPolicy(value, { headless = true, manifest = loadRuntimeManifest() } = {}) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || typeof value.type !== "string") {
    throw createCodedError(
      "sandbox_policy_rejected",
      "sandboxPolicy must be an object with a pinned type",
      { value },
    );
  }
  const allowlist = headless
    ? manifest.sandboxPolicy.headlessTypeAllowlist
    : manifest.sandboxPolicy.typeAllowlist;
  if (!allowlist.includes(value.type)) {
    throw createCodedError(
      "sandbox_policy_rejected",
      `sandboxPolicy.type ${JSON.stringify(value.type)} is not in the pinned allowlist`,
      { value: value.type, allowlist: [...allowlist] },
    );
  }
  return value;
}

/**
 * Validate a headless profile configuration fragment against the manifest.
 */
export function validateHeadlessCodexConfig(config, { manifest = loadRuntimeManifest() } = {}) {
  if (!config || typeof config !== "object") {
    throw createCodedError("config_invalid", "codex runtime config must be an object");
  }
  const approvalPolicy = config.approvalPolicy ?? manifest.approvalPolicy.headlessDefault;
  const sandboxClass = config.sandboxClass ?? config.sandbox ?? manifest.sandboxMode.headlessDefault;
  assertAllowedApprovalPolicy(approvalPolicy, { headless: true, manifest });
  assertAllowedSandboxMode(sandboxClass, { headless: true, manifest });
  if (config.sandboxPolicy != null) {
    assertAllowedSandboxPolicy(config.sandboxPolicy, { headless: true, manifest });
  }
  return Object.freeze({
    approvalPolicy,
    sandboxClass,
    sandboxPolicy: config.sandboxPolicy ?? null,
  });
}

export function getFeatureFlags(manifest = loadRuntimeManifest()) {
  return Object.freeze({ ...(manifest.featureFlags ?? {}) });
}

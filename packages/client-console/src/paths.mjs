/**
 * Canonical Triangle Client host paths under Application Support.
 * These are layout constants only — never credential stores.
 */

import path from "node:path";

export const APPLICATION_SUPPORT_SEGMENT = path.join(
  "Library",
  "Application Support",
  "The Triangle",
);

/**
 * @param {string} [home] Absolute home directory (defaults to process.env.HOME)
 */
export function resolveApplicationRoot(home = process.env.HOME) {
  if (typeof home !== "string" || home.length === 0 || !path.isAbsolute(home)) {
    throw new TypeError("home must be an absolute path");
  }
  return path.join(home, APPLICATION_SUPPORT_SEGMENT);
}

/**
 * @param {string} [home]
 */
export function resolveTrianglePaths(home = process.env.HOME) {
  const applicationRoot = resolveApplicationRoot(home);
  return Object.freeze({
    home,
    applicationRoot,
    helperPath: path.join(applicationRoot, "bin", "triangle-mailbox"),
    clientPath: path.join(applicationRoot, "bin", "triangle-client"),
    helperHashPath: path.join(applicationRoot, "install-manifest", "triangle-mailbox.sha256"),
    clientHashPath: path.join(applicationRoot, "install-manifest", "triangle-client.sha256"),
    instancesRoot: path.join(applicationRoot, "client", "instances"),
    installationIdentityPath: path.join(applicationRoot, "client", "installation.json"),
    readyMarkerPath: path.join(applicationRoot, "client", "ready.json"),
    activationMarkerPath: path.join(applicationRoot, "client", "activate.json"),
    workerRuntimeRoot: path.join(applicationRoot, "worker-runtime"),
  });
}

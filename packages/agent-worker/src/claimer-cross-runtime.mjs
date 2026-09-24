/**
 * Cross-runtime mailbox claimer helpers.
 *
 * Cursor ACP (`cursor-acp-claimer.*`) and Codex headless (`headless-claimer.*`)
 * must not dual-claim the same profile. Both runtimes acquire both lock
 * families in a fixed order (Codex lock, then Cursor ACP lock) so ownership is
 * exclusive and deadlock-free.
 */

import path from "node:path";

export const CLAIMER_LOCK_ORDER = Object.freeze(["codex", "cursor-acp"]);

/**
 * Resolve the peer claimer lock path for the other runtime family.
 * Canonical `*-claimer.<profile>.json` names map to each other; custom paths
 * (tests) get a unique peer suffix next to the primary lock.
 */
export function peerClaimerLockPath(lockPath, profile, peerFamily) {
  if (typeof lockPath !== "string" || !path.isAbsolute(lockPath) || lockPath.includes("\0")) {
    throw new TypeError("lockPath must be an absolute path");
  }
  if (typeof profile !== "string" || profile.length === 0 || profile.includes("\0") || profile.includes("/")) {
    throw new TypeError("profile is invalid");
  }
  if (peerFamily !== "codex" && peerFamily !== "cursor-acp") {
    throw new TypeError("peerFamily must be codex or cursor-acp");
  }
  const directory = path.dirname(lockPath);
  const base = path.basename(lockPath);
  const codexName = `headless-claimer.${profile}.json`;
  const cursorName = `cursor-acp-claimer.${profile}.json`;
  if (base === codexName || base === cursorName) {
    return path.join(directory, peerFamily === "codex" ? codexName : cursorName);
  }
  return `${lockPath}.${peerFamily}-peer`;
}

/**
 * Ordered lock paths for exclusive acquire: Codex family first, Cursor ACP second.
 */
export function orderedClaimerLockPaths({ lockPath, profile, primaryFamily }) {
  if (primaryFamily !== "codex" && primaryFamily !== "cursor-acp") {
    throw new TypeError("primaryFamily must be codex or cursor-acp");
  }
  const peerFamily = primaryFamily === "codex" ? "cursor-acp" : "codex";
  const peerPath = peerClaimerLockPath(lockPath, profile, peerFamily);
  if (primaryFamily === "codex") {
    return Object.freeze([lockPath, peerPath]);
  }
  return Object.freeze([peerPath, lockPath]);
}

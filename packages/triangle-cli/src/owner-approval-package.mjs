// Guarded packaged provider selector for owner-approved CLI commands.
// Release directory, manifest custody, binary hash, and exact command capability
// are all verified locally before selecting the macOS approval provider.
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUnavailableOwnerApprovalProvider } from './owner-approval.mjs';
import { createMacOSOwnerApprovalProvider } from './owner-approval-macos.mjs';

export const SUPPORTED_OWNER_APPROVAL_COMMANDS = Object.freeze([
  'identity.revoke',
  'identity.destination',
  'identity.chat-map',
]);

const DEFAULT_RELEASE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Loads the packaged macOS owner-approval provider iff the signed release manifest
 * satisfies file-custody invariants and explicitly authorizes `command`.
 */
export function loadPackagedOwnerApprovalProvider({
  command,
  releaseRoot = DEFAULT_RELEASE_ROOT,
  platform = process.platform,
} = {}) {
  const unavailable = () => createUnavailableOwnerApprovalProvider();
  try {
    if (
      typeof command !== 'string' ||
      !SUPPORTED_OWNER_APPROVAL_COMMANDS.includes(command) ||
      platform !== 'darwin' ||
      typeof releaseRoot !== 'string' ||
      !path.isAbsolute(releaseRoot) ||
      realpathSync(releaseRoot) !== releaseRoot
    ) {
      return unavailable();
    }
    const dir = lstatSync(releaseRoot);
    const file = path.join(releaseRoot, 'package-manifest.json');
    const stat = lstatSync(file);
    if (
      !dir.isDirectory() ||
      dir.uid !== process.getuid() ||
      (dir.mode & 0o077) !== 0 ||
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 1024 * 1024
    ) {
      return unavailable();
    }
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    const policy = manifest?.ownerApproval;
    if (
      manifest?.schema !== 1 ||
      manifest.platform !== 'darwin' ||
      manifest.arch !== process.arch ||
      manifest.testOnly !== false ||
      manifest.ownerApprovalCandidate !== undefined ||
      manifest.signingMode !== 'public_ad_hoc' ||
      manifest.credentialCustody !== 'file' ||
      !policy ||
      typeof policy !== 'object' ||
      Array.isArray(policy) ||
      policy.version !== 1 ||
      policy.binary !== 'bin/triangle-owner-approval' ||
      !Array.isArray(policy.commands) ||
      policy.commands.length === 0
    ) {
      return unavailable();
    }
    const uniqueCommands = new Set(policy.commands);
    if (
      uniqueCommands.size !== policy.commands.length ||
      policy.commands.some((item) => typeof item !== 'string' || !SUPPORTED_OWNER_APPROVAL_COMMANDS.includes(item)) ||
      !uniqueCommands.has(command)
    ) {
      return unavailable();
    }
    const entries = manifest.files?.filter((entry) => entry?.path === policy.binary);
    if (
      entries?.length !== 1 ||
      entries[0].mode !== 0o700 ||
      typeof entries[0].sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entries[0].sha256) ||
      entries[0].sha256.length !== 64
    ) {
      return unavailable();
    }
    return createMacOSOwnerApprovalProvider({
      executable: path.join(releaseRoot, policy.binary),
      sha256: entries[0].sha256,
      platform,
    });
  } catch {
    return unavailable();
  }
}

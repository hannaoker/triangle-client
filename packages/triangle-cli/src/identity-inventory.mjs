import path from "node:path";

/**
 * Invokes the read-only identity inventory projection.
 *
 * Contract:
 * - Read-only: accepts absolute `clientRoot` and queries on-disk installation
 *   inventory via `readInstallationInventory` and projects it via
 *   `buildIdentityInventory`.
 * - No process launches or lock probes: `pidAlive` and `advisoryHeldAt` default
 *   to returning "unknown" when no read-only supported check is supplied.
 * - No custody mutations, Keychain access, or network calls.
 *
 * @param {object} options
 * @param {string} options.clientRoot - Absolute path to client root.
 * @param {Function} [options.readInstallationInventory]
 * @param {Function} [options.buildIdentityInventory]
 * @param {Function} [options.pidAlive]
 * @param {Function} [options.advisoryHeldAt]
 * @param {number} [options.now]
 * @returns {Promise<object>} Projected identity inventory report.
 */
export async function identityInventory({
  clientRoot,
  readInstallationInventory: customReadInstallationInventory,
  buildIdentityInventory: customBuildIdentityInventory,
  pidAlive = () => "unknown",
  advisoryHeldAt = () => "unknown",
  now,
} = {}) {
  if (typeof clientRoot !== "string" || !path.isAbsolute(clientRoot)) {
    throw new TypeError("clientRoot must be an absolute path");
  }

  let readInstallationInventory = customReadInstallationInventory;
  let buildIdentityInventory = customBuildIdentityInventory;

  if (!readInstallationInventory || !buildIdentityInventory) {
    let workerInstallation;
    let workerIdentity;
    try {
      workerInstallation = await import("../../agent-worker/src/installation-inventory.mjs");
      workerIdentity = await import("../../agent-worker/src/identity-inventory.mjs");
    } catch (error) {
      const err = new Error(
        "Installation inventory foundation (@the-triangle/agent-worker) is not available in this installation."
      );
      err.cause = error;
      throw err;
    }
    readInstallationInventory ??= workerInstallation.readInstallationInventory;
    buildIdentityInventory ??= workerIdentity.buildIdentityInventory;
  }

  const rawInventory = readInstallationInventory({
    clientRoot,
    pidAlive,
    advisoryHeldAt,
    ...(now !== undefined ? { now } : {}),
  });

  return buildIdentityInventory(rawInventory);
}

/**
 * Renders the identity inventory report into concise human-readable output.
 * Indicates that disk observations are not live authority verification and
 * highlights faults, warnings, and ambiguities while preserving exact IDs.
 *
 * @param {object} report - Identity inventory report from buildIdentityInventory.
 * @returns {string} Human-readable report text.
 */
export function renderIdentityInventory(report) {
  const lines = [];
  lines.push("Identity Inventory (host-local; disk observations only, not live authority verification)");

  if (!report || typeof report !== "object") {
    lines.push("No report available.");
    return lines.join("\n");
  }

  const summary = report.summary ?? {};
  lines.push(
    `Summary: ${summary.identityCount ?? 0} identity(ies), ` +
    `${summary.unmappedProfileCount ?? 0} unmapped profile(s), ` +
    `${summary.faultCount ?? 0} fault(s), ` +
    `${summary.warningCount ?? 0} warning(s)`
  );

  if (Array.isArray(report.identities) && report.identities.length > 0) {
    lines.push("Identities:");
    for (const ident of report.identities) {
      const handleLabel = ident.handle
        ? ident.handle
        : ident.handles?.length
          ? `(ambiguous: ${ident.handles.join(", ")})`
          : "(no handle)";
      lines.push(`  - ${handleLabel} (${ident.principalId})`);
      lines.push(`      Authority: ${ident.authorityOrigin} (observed on disk; not live verified)`);
      if (Array.isArray(ident.profiles) && ident.profiles.length > 0) {
        lines.push("      Profiles:");
        for (const p of ident.profiles) {
          const statusNote = !p.enabled
            ? "disabled"
            : p.status && p.status !== "ok"
              ? `status: ${p.status}`
              : "active";
          lines.push(
            `        - ${p.profile} (${p.lane ?? "unknown-lane"}, ${p.runtimeAdapter ?? "unknown-adapter"}, ${p.deliveryMode ?? "unknown-delivery"}, ${statusNote}) [instance: ${p.instanceId}]`
          );
        }
      }
      if (Array.isArray(ident.diagnostics) && ident.diagnostics.length > 0) {
        for (const d of ident.diagnostics) {
          lines.push(`      ! [${d.severity ?? "warning"}] (${d.code}) ${d.message}`);
        }
      }
    }
  } else {
    lines.push("Identities: none");
  }

  if (Array.isArray(report.unmappedProfiles) && report.unmappedProfiles.length > 0) {
    lines.push("Unmapped Profiles:");
    for (const u of report.unmappedProfiles) {
      const statusNote = !u.enabled ? "disabled" : u.status ?? "unmapped";
      lines.push(
        `  - ${u.profile ?? "(unnamed)"} [instance: ${u.instanceId ?? "none"}] (${u.reason ?? statusNote})`
      );
      if (Array.isArray(u.diagnostics) && u.diagnostics.length > 0) {
        for (const d of u.diagnostics) {
          const msg = typeof d === "string" ? d : d.message ?? d.code;
          lines.push(`      ! ${msg}`);
        }
      }
    }
  }

  if (Array.isArray(report.sessions) && report.sessions.length > 0) {
    lines.push("Local Sessions:");
    for (const s of report.sessions) {
      lines.push(`  - ${s.sessionId} (profile: ${s.profile ?? "none"}, not principal)`);
    }
  }

  if (Array.isArray(report.diagnostics) && report.diagnostics.length > 0) {
    lines.push("Diagnostics:");
    for (const d of report.diagnostics) {
      lines.push(`  ! [${d.severity ?? "info"}] (${d.code}) ${d.message}`);
    }
  }

  return lines.join("\n");
}

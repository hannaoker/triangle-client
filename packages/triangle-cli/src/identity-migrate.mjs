import path from "node:path";

/**
 * Invokes the identity migration planning or confirmed apply workflow.
 *
 * @param {object} options
 * @param {string} options.clientRoot - Absolute path to client root.
 * @param {string} options.registryRoot - Absolute path to registry root.
 * @param {string|null} [options.confirm] - Optional 64-hex plan ID to confirm and apply.
 * @param {Function} [options.readInstallationInventory]
 * @param {Function} [options.buildIdentityInventory]
 * @param {Function} [options.readIdentityRegistry]
 * @param {Function} [options.planIdentityMapping]
 * @param {Function} [options.applyIdentityMapping]
 * @param {Function} [options.pidAlive]
 * @param {Function} [options.advisoryHeldAt]
 * @param {Function|string|number|Date} [options.now]
 * @returns {Promise<object>} Mapping plan or apply result.
 */
export async function identityMigrate({
  clientRoot,
  registryRoot,
  confirm = null,
  readInstallationInventory: customReadInstallationInventory,
  buildIdentityInventory: customBuildIdentityInventory,
  readIdentityRegistry: customReadIdentityRegistry,
  planIdentityMapping: customPlanIdentityMapping,
  applyIdentityMapping: customApplyIdentityMapping,
  pidAlive = () => "unknown",
  advisoryHeldAt = () => "unknown",
  now,
  faultHook = null,
} = {}) {
  if (typeof clientRoot !== "string" || !path.isAbsolute(clientRoot)) {
    throw new TypeError("clientRoot must be an absolute path");
  }
  if (typeof registryRoot !== "string" || !path.isAbsolute(registryRoot)) {
    throw new TypeError("registryRoot must be an absolute path");
  }

  let readInstallationInventory = customReadInstallationInventory;
  let buildIdentityInventory = customBuildIdentityInventory;
  let readIdentityRegistry = customReadIdentityRegistry;
  let planIdentityMapping = customPlanIdentityMapping;
  let applyIdentityMapping = customApplyIdentityMapping;

  if (
    !readInstallationInventory ||
    !buildIdentityInventory ||
    !readIdentityRegistry ||
    !planIdentityMapping ||
    !applyIdentityMapping
  ) {
    let workerInstallation;
    let workerIdentity;
    let workerRegistry;
    let workerMapping;
    try {
      workerInstallation = await import("../../agent-worker/src/installation-inventory.mjs");
      workerIdentity = await import("../../agent-worker/src/identity-inventory.mjs");
      const regUrl = new URL("../../agent-worker/src/identity-" + "registry.mjs", import.meta.url).href;
      workerRegistry = await import(regUrl);
      workerMapping = await import("../../agent-worker/src/identity-mapping.mjs");
    } catch (error) {
      const err = new Error(
        "Identity mapping foundation (@the-triangle/agent-worker) is not available in this installation."
      );
      err.cause = error;
      throw err;
    }
    readInstallationInventory ??= workerInstallation.readInstallationInventory;
    buildIdentityInventory ??= workerIdentity.buildIdentityInventory;
    readIdentityRegistry ??= workerRegistry.readIdentityRegistry;
    planIdentityMapping ??= workerMapping.planIdentityMapping;
    applyIdentityMapping ??= workerMapping.applyIdentityMapping;
  }

  const readInv = () => {
    const raw = readInstallationInventory({
      clientRoot,
      pidAlive,
      advisoryHeldAt,
      ...(now !== undefined ? { now } : {}),
    });
    return buildIdentityInventory(raw);
  };

  if (!confirm) {
    // Read-only plan mode: must not create registry-root
    const inventory = readInv();
    const registryResult = readIdentityRegistry({ root: registryRoot });
    return planIdentityMapping({ inventory, registry: registryResult });
  }

  // Apply mode
  return applyIdentityMapping({
    root: registryRoot,
    confirmation: confirm,
    readInventory: readInv,
    now,
    faultHook,
  });
}

/**
 * Renders the identity mapping plan into human-readable output.
 */
export function renderIdentityMigratePlan(plan, { clientRoot, registryRoot } = {}) {
  const lines = [];
  lines.push("Identity Migration Plan (host-local disk observations)");

  if (!plan || typeof plan !== "object") {
    lines.push("No plan available.");
    return lines.join("\n");
  }

  const s = plan.summary ?? {};
  lines.push(
    `Summary: ${s.proposalCount ?? s.proposals ?? 0} proposal(s), ` +
    `${s.unchangedCount ?? s.unchanged ?? 0} unchanged, ` +
    `${s.blockedCount ?? s.blocked ?? 0} blocked, ` +
    `${s.localOnlyCount ?? s.localOnly ?? 0} local-only`
  );

  if (Array.isArray(plan.proposals) && plan.proposals.length > 0) {
    lines.push("Proposals:");
    for (const p of plan.proposals) {
      lines.push(`  - Profile: ${p.profile_name}, Agent: ${p.principal_id}, Origin: ${p.authority_origin}`);
    }
  }

  if (Array.isArray(plan.unchanged) && plan.unchanged.length > 0) {
    lines.push("Unchanged:");
    for (const u of plan.unchanged) {
      lines.push(`  - Profile: ${u.profile ?? u.profile_name}, Agent: ${u.principalId ?? u.principal_id}`);
    }
  }

  if (Array.isArray(plan.blocked) && plan.blocked.length > 0) {
    lines.push("Blocked:");
    for (const b of plan.blocked) {
      const idStr = b.profileInstanceId ? ` (${b.profileInstanceId})` : "";
      lines.push(`  - Profile: ${b.profile}${idStr}: ${b.reason}`);
    }
  }

  if (Array.isArray(plan.localOnly) && plan.localOnly.length > 0) {
    lines.push("Local-only profiles:");
    for (const l of plan.localOnly) {
      lines.push(`  - Profile: ${l.profile ?? l}`);
    }
  }

  lines.push(`Plan ID: ${plan.planId}`);
  if (clientRoot && registryRoot) {
    lines.push("");
    lines.push("To confirm and apply this plan, run:");
    lines.push(`  triangle identity migrate --client-root ${clientRoot} --registry-root ${registryRoot} --confirm ${plan.planId}`);
  }
  return lines.join("\n");
}

/**
 * Renders confirmed apply result into human-readable output.
 */
export function renderIdentityMigrateApply(result) {
  const lines = [];
  const count = result.applied?.length ?? 0;
  lines.push(`Recorded ${count} identity binding(s) to registry (sequence ${result.registrySequence}):`);
  if (Array.isArray(result.applied)) {
    for (const b of result.applied) {
      lines.push(`  - Profile: ${b.profile_name}, Agent: ${b.principal_id}, Binding ID: ${b.binding_id}`);
    }
  }
  return lines.join("\n");
}

/**
 * Renders partial failure into human-readable output.
 */
export function renderIdentityMigratePartial(partial) {
  const lines = [];
  lines.push("Identity Migration Partial Failure:");
  const appliedCount = partial.applied?.length ?? 0;
  lines.push(`Applied (${appliedCount}):`);
  if (Array.isArray(partial.applied)) {
    for (const b of partial.applied) {
      lines.push(`  - Profile: ${b.profile_name}, Agent: ${b.principal_id}, Binding ID: ${b.binding_id}`);
    }
  }
  if (partial.failed) {
    const p = partial.failed.proposal ?? partial.failed;
    lines.push("Failed:");
    lines.push(`  - Profile: ${p.profile_name ?? p.profile}, Error: ${partial.failed.code ?? partial.failed.reason ?? "failed"}`);
  }
  if (partial.remaining) {
    const rem = partial.remaining.proposals?.length ?? 0;
    lines.push(`Remaining proposals: ${rem}`);
  }
  return lines.join("\n");
}

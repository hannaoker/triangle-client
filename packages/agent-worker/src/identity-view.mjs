import { planIdentityMapping } from "./identity-mapping.mjs";

function compareCodeUnits(a, b) {
  const sa = String(a ?? "");
  const sb = String(b ?? "");
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function deepFreeze(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  for (const val of Object.values(obj)) {
    if (val !== null && typeof val === "object") {
      deepFreeze(val);
    }
  }
  return obj;
}

const FAULT_BLOCKED_REASONS = new Set([
  "conflicts_with_recorded",
  "duplicate_profile",
  "duplicate_instance_id",
  "malformed_record",
  "custody_fault",
]);

const EXCLUDED_INVENTORY_CODES = new Set([
  "malformed_record",
  "duplicate_profile",
  "duplicate_instance_id",
  "ambiguous_mapping",
  "origin_mismatch",
  "custody_fault",
]);

/**
 * Builds a secret-free, deterministic identity view from an identity inventory report
 * and an identity registry read result.
 *
 * @param {object} options
 * @param {object} options.inventory - Output of buildIdentityInventory.
 * @param {object} [options.registry] - Output of readIdentityRegistry or { state: "unreadable", code }.
 * @returns {object} Deep-frozen identity view.
 */
export function buildIdentityView({ inventory, registry } = {}) {
  if (!inventory || typeof inventory !== "object") {
    throw new TypeError("inventory must be a non-null object");
  }

  let registryState = "absent";
  let registrySequence = 0;
  let auditVerifiedThrough = 0;
  let auditUncommittedTail = 0;
  let errorCode = null;

  if (registry && typeof registry === "object") {
    if (registry.state === "ok") {
      registryState = "ok";
      registrySequence = typeof registry.registry?.sequence === "number" ? registry.registry.sequence : 0;
      auditVerifiedThrough = typeof registry.audit?.verifiedThrough === "number" ? registry.audit.verifiedThrough : 0;
      auditUncommittedTail = typeof registry.audit?.uncommittedTail === "number" ? registry.audit.uncommittedTail : 0;
    } else if (registry.state === "unreadable") {
      registryState = "unreadable";
      errorCode = typeof registry.code === "string" ? registry.code : (registry.code != null ? String(registry.code) : "unknown");
    } else if (registry.state === "absent") {
      registryState = "absent";
    }
  }

  const viewRegistry = {
    state: registryState,
    sequence: registrySequence,
    auditVerifiedThrough,
    auditUncommittedTail,
    errorCode,
  };

  const effectiveRegistryForPlan = registryState === "unreadable"
    ? { state: "absent" }
    : (registry ?? { state: "absent" });

  const plan = planIdentityMapping({ inventory, registry: effectiveRegistryForPlan });

  const existingBindings = (registryState === "ok" && registry?.registry?.bindings && typeof registry.registry.bindings === "object")
    ? registry.registry.bindings
    : {};

  // Index inventory profiles for quick lookup
  const inventoryInstanceIdsSet = new Set();
  const inventoryIdentitiesByProfile = new Map();

  if (Array.isArray(inventory.identities)) {
    for (const ident of inventory.identities) {
      if (!ident || typeof ident !== "object") continue;
      const principalId = typeof ident.principalId === "string" ? ident.principalId : null;
      const authorityOrigin = typeof ident.authorityOrigin === "string" ? ident.authorityOrigin : null;
      if (Array.isArray(ident.profiles)) {
        for (const p of ident.profiles) {
          if (!p || typeof p !== "object") continue;
          if (typeof p.instanceId === "string") {
            inventoryInstanceIdsSet.add(p.instanceId);
          }
          if (typeof p.profile === "string") {
            inventoryIdentitiesByProfile.set(p.profile, { principalId, authorityOrigin });
          }
        }
      }
    }
  }

  if (Array.isArray(inventory.unmappedProfiles)) {
    for (const u of inventory.unmappedProfiles) {
      if (!u || typeof u !== "object") continue;
      if (typeof u.instanceId === "string") {
        inventoryInstanceIdsSet.add(u.instanceId);
      }
    }
  }

  const profileRows = [];

  // 1. recorded = plan unchanged
  if (Array.isArray(plan.unchanged)) {
    for (const u of plan.unchanged) {
      const regBinding = u.profileInstanceId ? existingBindings[u.profileInstanceId] : null;
      profileRows.push({
        profile: u.profile,
        profileInstanceId: u.profileInstanceId,
        state: "recorded",
        principalId: u.principalId,
        authorityOrigin: u.authorityOrigin,
        bindingId: u.bindingId,
        generation: regBinding?.binding_generation ?? null,
        reason: null,
      });
    }
  }

  // 2. not_recorded = plan proposals
  if (Array.isArray(plan.proposals)) {
    for (const p of plan.proposals) {
      profileRows.push({
        profile: p.profile_name,
        profileInstanceId: p.profile_instance_id,
        state: "not_recorded",
        principalId: p.principal_id,
        authorityOrigin: p.authority_origin,
        bindingId: null,
        generation: null,
        reason: null,
      });
    }
  }

  // 3. blocked = plan blocked
  if (Array.isArray(plan.blocked)) {
    for (const b of plan.blocked) {
      const identInfo = inventoryIdentitiesByProfile.get(b.profile);
      const regBinding = b.profileInstanceId ? existingBindings[b.profileInstanceId] : null;
      profileRows.push({
        profile: b.profile,
        profileInstanceId: b.profileInstanceId,
        state: "blocked",
        principalId: identInfo?.principalId ?? null,
        authorityOrigin: identInfo?.authorityOrigin ?? null,
        bindingId: regBinding?.binding_id ?? null,
        generation: regBinding?.binding_generation ?? null,
        reason: b.reason,
      });
    }
  }

  // 4. local_only = plan localOnly
  if (Array.isArray(plan.localOnly)) {
    for (const l of plan.localOnly) {
      profileRows.push({
        profile: l.profile,
        profileInstanceId: l.profileInstanceId,
        state: "local_only",
        principalId: null,
        authorityOrigin: null,
        bindingId: null,
        generation: null,
        reason: null,
      });
    }
  }

  // 5. recorded_only = registry binding matching no profile in inventory
  if (registryState === "ok") {
    for (const binding of Object.values(existingBindings)) {
      if (!binding || typeof binding !== "object") continue;
      if (!inventoryInstanceIdsSet.has(binding.profile_instance_id)) {
        profileRows.push({
          profile: binding.profile_name,
          profileInstanceId: binding.profile_instance_id,
          state: "recorded_only",
          principalId: binding.principal_id,
          authorityOrigin: binding.authority_origin,
          bindingId: binding.binding_id,
          generation: binding.binding_generation,
          reason: null,
        });
      }
    }
  }

  // Sort profile rows by profile, then profileInstanceId
  profileRows.sort((a, b) => {
    const cmpProf = compareCodeUnits(a.profile, b.profile);
    if (cmpProf !== 0) return cmpProf;
    return compareCodeUnits(a.profileInstanceId, b.profileInstanceId);
  });

  const summary = {
    profiles: profileRows.length,
    recorded: profileRows.filter((p) => p.state === "recorded").length,
    notRecorded: profileRows.filter((p) => p.state === "not_recorded").length,
    blocked: profileRows.filter((p) => p.state === "blocked").length,
    localOnly: profileRows.filter((p) => p.state === "local_only").length,
    recordedOnly: profileRows.filter((p) => p.state === "recorded_only").length,
    faults: 0,
    warnings: 0,
  };

  const diagnostics = [];

  // Diagnostics:
  // - registry_unreadable (fault)
  if (registryState === "unreadable") {
    diagnostics.push({
      severity: "fault",
      code: "registry_unreadable",
      profile: null,
      message: `The identity registry could not be read (${errorCode}).`,
      action: "Do not edit the files by hand. Restore the registry directory from a backup.",
    });
  }

  // - registry_unfinished_write (warning) when auditUncommittedTail is 1
  if (auditUncommittedTail === 1) {
    diagnostics.push({
      severity: "warning",
      code: "registry_unfinished_write",
      profile: null,
      message: "An interrupted write left an unfinished audit line.",
      action: "The next registry update repairs it.",
    });
  }

  // - identity_not_recorded (warning) when notRecorded > 0
  if (summary.notRecorded > 0) {
    diagnostics.push({
      severity: "warning",
      code: "identity_not_recorded",
      profile: null,
      message: `${summary.notRecorded} profile(s) have a valid MESH binding on disk and no recorded identity binding.`,
      action: "Run triangle identity migrate and review the plan.",
    });
  }

  // - one identity_blocked per blocked row, profile set
  for (const b of profileRows.filter((p) => p.state === "blocked")) {
    const isFault = FAULT_BLOCKED_REASONS.has(b.reason);
    diagnostics.push({
      severity: isFault ? "fault" : "warning",
      code: "identity_blocked",
      profile: b.profile || null,
      message: `Profile ${b.profile} is blocked: ${b.reason}.`,
      action: null,
    });
  }

  // - one recorded_profile_missing (warning) per recorded_only row
  for (const r of profileRows.filter((p) => p.state === "recorded_only")) {
    diagnostics.push({
      severity: "warning",
      code: "recorded_profile_missing",
      profile: r.profile || null,
      message: "A recorded binding has no local profile.",
      action: null,
    });
  }

  // - inventory diagnostics passthrough (excluding covered codes)
  if (Array.isArray(inventory.diagnostics)) {
    for (const d of inventory.diagnostics) {
      if (!d || typeof d !== "object") continue;
      if (EXCLUDED_INVENTORY_CODES.has(d.code)) continue;
      diagnostics.push({
        severity: d.severity === "fault" ? "fault" : "warning",
        code: d.code,
        profile: typeof d.profile === "string" ? d.profile : null,
        message: d.message,
        action: null,
      });
    }
  }

  // Sort diagnostics by severity (faults first), then code, then profile, then message
  diagnostics.sort((a, b) => {
    const sevA = a.severity === "fault" ? 0 : 1;
    const sevB = b.severity === "fault" ? 0 : 1;
    if (sevA !== sevB) return sevA - sevB;

    const cmpCode = compareCodeUnits(a.code, b.code);
    if (cmpCode !== 0) return cmpCode;

    const cmpProf = compareCodeUnits(a.profile, b.profile);
    if (cmpProf !== 0) return cmpProf;

    return compareCodeUnits(a.message, b.message);
  });

  summary.faults = diagnostics.filter((d) => d.severity === "fault").length;
  summary.warnings = diagnostics.filter((d) => d.severity === "warning").length;

  const view = {
    schema: "identity_view_v1",
    registry: viewRegistry,
    summary,
    profiles: profileRows,
    diagnostics,
  };

  return deepFreeze(view);
}

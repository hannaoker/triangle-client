/**
 * Owner-confirmed Identity Mapping (Slice 1b first cut).
 *
 * Provides:
 * - `planIdentityMapping`: Pure planner turning an identity inventory report into
 *   a deterministic, deep-frozen mapping plan against registry sequence.
 * - `applyIdentityMapping`: Confirmed apply step writing `local_profile_binding_v1`
 *   records to the identity registry when confirmed by the exact seen plan ID.
 */

import { createHash } from "node:crypto";
import {
  AGENT_ID_PATTERN,
  deriveClientInstanceId,
  INSTANCE_ID_PATTERN,
  isValidBareHttpsOrigin,
  isValidProfileName,
} from "./identity-primitives.mjs";
import {
  canonicalJson,
  readIdentityRegistry,
  updateIdentityRegistry,
} from "./identity-registry.mjs";

export const IDENTITY_MAPPING_PLAN_SCHEMA = "identity_mapping_plan_v1";

export const BLOCKED_REASONS = Object.freeze({
  AMBIGUOUS_MAPPING: "ambiguous_mapping",
  DUPLICATE_PROFILE: "duplicate_profile",
  DUPLICATE_INSTANCE_ID: "duplicate_instance_id",
  ORIGIN_MISMATCH: "origin_mismatch",
  MALFORMED_RECORD: "malformed_record",
  CUSTODY_FAULT: "custody_fault",
  CONFLICTS_WITH_RECORDED: "conflicts_with_recorded",
  RECORDED_REVOKED: "recorded_revoked",
});

function codedError(code, reason) {
  const err = new Error(`${code}: ${reason}`);
  err.code = code;
  err.reason = reason;
  return err;
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

function computeBindingId(profileInstanceId, principalId, authorityOrigin, generation = 1) {
  const preimage = `triangle-binding-v1\0${profileInstanceId}\0${principalId}\0${authorityOrigin}\0${generation}`;
  const hash = createHash("sha256").update(preimage, "utf8").digest("hex");
  return `bind_${hash.slice(0, 32)}`;
}

function compareStrings(a, b) {
  const sa = a == null ? "" : String(a);
  const sb = b == null ? "" : String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Accepts null/undefined (no registry), a `readIdentityRegistry` result, or a raw
 * registry object. Anything else fails closed instead of being read as an empty registry.
 */
function registryView(registry) {
  if (registry === null || registry === undefined) return { sequence: 0, bindings: {} };
  if (isPlainObject(registry)) {
    if (registry.state === "absent") return { sequence: 0, bindings: {} };
    const body = registry.state === "ok" ? registry.registry : registry.state === undefined ? registry : null;
    if (isPlainObject(body) && Number.isSafeInteger(body.sequence) && body.sequence >= 0 && isPlainObject(body.bindings)) {
      return { sequence: body.sequence, bindings: body.bindings };
    }
  }
  throw codedError("invalid_registry", "unrecognized_registry_shape");
}

/**
 * Pure planning step for identity mapping.
 *
 * @param {object} options
 * @param {object} options.inventory - Identity inventory report (from buildIdentityInventory).
 * @param {object|null} [options.registry] - Identity registry or readIdentityRegistry result.
 * @returns {object} Deep-frozen identity mapping plan.
 */
export function planIdentityMapping({ inventory, registry = null } = {}) {
  if (!inventory || typeof inventory !== "object") {
    throw codedError("invalid_inventory", "inventory_must_be_object");
  }

  const { sequence: registrySequence, bindings: existingBindings } = registryView(registry);

  const rawBlocked = [];
  const rawLocalOnly = [];
  const rawProposals = [];
  const rawUnchanged = [];

  // Track globally blocked profiles by name and instanceId
  const globallyBlockedByName = new Map(); // profileName -> reason
  const globallyBlockedByInstanceId = new Map(); // instanceId -> reason
  const agentsWithOriginMismatch = new Set();

  // Scan global diagnostics
  if (Array.isArray(inventory.diagnostics)) {
    for (const d of inventory.diagnostics) {
      if (!d || typeof d !== "object") continue;
      const code = typeof d.code === "string" ? d.code.toLowerCase() : "";
      const profile = typeof d.profile === "string" ? d.profile : "";
      const instanceId = profile && isValidProfileName(profile) ? deriveClientInstanceId(profile) : null;

      if (code === "origin_mismatch") {
        if (typeof d.principalId === "string") {
          agentsWithOriginMismatch.add(d.principalId);
        }
        if (profile) {
          globallyBlockedByName.set(profile, BLOCKED_REASONS.ORIGIN_MISMATCH);
          rawBlocked.push({
            profile,
            profileInstanceId: instanceId,
            reason: BLOCKED_REASONS.ORIGIN_MISMATCH,
          });
        }
      } else if (code === "duplicate_profile") {
        if (profile) {
          globallyBlockedByName.set(profile, BLOCKED_REASONS.DUPLICATE_PROFILE);
          rawBlocked.push({
            profile,
            profileInstanceId: instanceId,
            reason: BLOCKED_REASONS.DUPLICATE_PROFILE,
          });
        }
      } else if (code === "duplicate_instance_id") {
        if (profile) {
          globallyBlockedByName.set(profile, BLOCKED_REASONS.DUPLICATE_INSTANCE_ID);
          rawBlocked.push({
            profile,
            profileInstanceId: instanceId,
            reason: BLOCKED_REASONS.DUPLICATE_INSTANCE_ID,
          });
        }
      } else if (code === "ambiguous_mapping") {
        if (profile) {
          globallyBlockedByName.set(profile, BLOCKED_REASONS.AMBIGUOUS_MAPPING);
          rawBlocked.push({
            profile,
            profileInstanceId: instanceId,
            reason: BLOCKED_REASONS.AMBIGUOUS_MAPPING,
          });
        }
      } else if (code === "custody_fault") {
        if (profile) {
          globallyBlockedByName.set(profile, BLOCKED_REASONS.CUSTODY_FAULT);
          rawBlocked.push({
            profile,
            profileInstanceId: instanceId,
            reason: BLOCKED_REASONS.CUSTODY_FAULT,
          });
        }
      } else if (code === "malformed_record" || code === "underlying_blocker") {
        if (profile) {
          globallyBlockedByName.set(profile, BLOCKED_REASONS.MALFORMED_RECORD);
          rawBlocked.push({
            profile,
            profileInstanceId: instanceId,
            reason: BLOCKED_REASONS.MALFORMED_RECORD,
          });
        }
      }
      // Other faults (for example lane health such as binding_missing) say nothing about the
      // identity evidence and do not block a mapping; `identity inventory` lists them.
    }
  }

  // Scan unmapped profiles
  if (Array.isArray(inventory.unmappedProfiles)) {
    for (const u of inventory.unmappedProfiles) {
      if (!u || typeof u !== "object") continue;
      const profileName = typeof u.profile === "string" ? u.profile : "";
      const instanceId = typeof u.instanceId === "string" && INSTANCE_ID_PATTERN.test(u.instanceId)
        ? u.instanceId
        : (profileName && isValidProfileName(profileName) ? deriveClientInstanceId(profileName) : null);

      const hasGlobalFault = profileName && globallyBlockedByName.has(profileName);
      if (hasGlobalFault) {
        rawBlocked.push({
          profile: profileName,
          profileInstanceId: instanceId,
          reason: globallyBlockedByName.get(profileName),
        });
        continue;
      }

      const reasonStr = typeof u.reason === "string" ? u.reason : "";
      const bindingState = typeof u.bindingState === "string" ? u.bindingState : "";

      if (reasonStr === "unbound_local_profile" || (bindingState === "unbound" && u.status !== "fault")) {
        rawLocalOnly.push({
          profile: profileName,
          profileInstanceId: instanceId,
        });
        continue;
      }

      // Blocked unmapped profiles
      let blockedReason = BLOCKED_REASONS.MALFORMED_RECORD;
      if (reasonStr.startsWith("custody_") || bindingState.startsWith("custody_") || u.status === "custody_fault") {
        blockedReason = BLOCKED_REASONS.CUSTODY_FAULT;
      } else if (reasonStr.includes("duplicate_profile")) {
        blockedReason = BLOCKED_REASONS.DUPLICATE_PROFILE;
      } else if (reasonStr.includes("duplicate_instance")) {
        blockedReason = BLOCKED_REASONS.DUPLICATE_INSTANCE_ID;
      } else if (reasonStr.includes("origin_mismatch")) {
        blockedReason = BLOCKED_REASONS.ORIGIN_MISMATCH;
      } else if (reasonStr.includes("ambiguous")) {
        blockedReason = BLOCKED_REASONS.AMBIGUOUS_MAPPING;
      }

      rawBlocked.push({
        profile: profileName,
        profileInstanceId: instanceId,
        reason: blockedReason,
      });
    }
  }

  // Scan identities
  if (Array.isArray(inventory.identities)) {
    for (const ident of inventory.identities) {
      if (!ident || typeof ident !== "object") continue;
      const principalId = typeof ident.principalId === "string" ? ident.principalId : "";
      const authorityOrigin = typeof ident.authorityOrigin === "string" ? ident.authorityOrigin : "";
      const kind = typeof ident.kind === "string" ? ident.kind : "";
      const profiles = Array.isArray(ident.profiles) ? ident.profiles : [];

      const identDiagnostics = Array.isArray(ident.diagnostics) ? ident.diagnostics : [];
      const hasAmbiguousDiagnostic = identDiagnostics.some((d) => d?.code === "ambiguous_mapping");
      const hasFaultDiagnostic = identDiagnostics.some((d) => d?.severity === "fault");

      const isMeshManaged = kind === "mesh-managed";
      const isMultiProfile = profiles.length > 1;
      const hasOriginMismatch = agentsWithOriginMismatch.has(principalId);

      for (const p of profiles) {
        if (!p || typeof p !== "object") continue;
        const profileName = typeof p.profile === "string" ? p.profile : "";
        const instanceId = typeof p.instanceId === "string" && INSTANCE_ID_PATTERN.test(p.instanceId)
          ? p.instanceId
          : (profileName && isValidProfileName(profileName) ? deriveClientInstanceId(profileName) : null);

        // Check if blocked by global diagnostic
        if (profileName && globallyBlockedByName.has(profileName)) {
          rawBlocked.push({
            profile: profileName,
            profileInstanceId: instanceId,
            reason: globallyBlockedByName.get(profileName),
          });
          continue;
        }

        // Check if agent has origin mismatch
        if (hasOriginMismatch) {
          rawBlocked.push({
            profile: profileName,
            profileInstanceId: instanceId,
            reason: BLOCKED_REASONS.ORIGIN_MISMATCH,
          });
          continue;
        }

        // Check if multiple profiles bind same agent under one origin (ambiguous mapping)
        if (isMultiProfile || hasAmbiguousDiagnostic) {
          rawBlocked.push({
            profile: profileName,
            profileInstanceId: instanceId,
            reason: BLOCKED_REASONS.AMBIGUOUS_MAPPING,
          });
          continue;
        }

        // Check fault diagnostic or non-mesh-managed
        if (hasFaultDiagnostic || !isMeshManaged) {
          rawBlocked.push({
            profile: profileName,
            profileInstanceId: instanceId,
            reason: BLOCKED_REASONS.MALFORMED_RECORD,
          });
          continue;
        }

        // Validate bound evidence
        const validProfileName = isValidProfileName(profileName);
        const validDerivedInstanceId = validProfileName && deriveClientInstanceId(profileName) === instanceId;
        const validPrincipal = AGENT_ID_PATTERN.test(principalId);
        const validOrigin = isValidBareHttpsOrigin(authorityOrigin);

        if (!validProfileName || !validDerivedInstanceId || !validPrincipal || !validOrigin) {
          rawBlocked.push({
            profile: profileName,
            profileInstanceId: instanceId,
            reason: BLOCKED_REASONS.MALFORMED_RECORD,
          });
          continue;
        }

        // Single valid profile for mesh-managed identity.
        // Check against registry bindings for this instance ID.
        const existing = existingBindings[instanceId];
        if (existing) {
          if (existing.revoked_at !== null) {
            rawBlocked.push({
              profile: profileName,
              profileInstanceId: instanceId,
              reason: BLOCKED_REASONS.RECORDED_REVOKED,
            });
            continue;
          }

          if (existing.principal_id !== principalId || existing.authority_origin !== authorityOrigin) {
            rawBlocked.push({
              profile: profileName,
              profileInstanceId: instanceId,
              reason: BLOCKED_REASONS.CONFLICTS_WITH_RECORDED,
            });
            continue;
          }

          // Identical, unrevoked binding
          rawUnchanged.push({
            profile: existing.profile_name,
            profileInstanceId: existing.profile_instance_id,
            principalId: existing.principal_id,
            authorityOrigin: existing.authority_origin,
            bindingId: existing.binding_id,
          });
          continue;
        }

        // No existing binding: propose candidate binding record
        const bindingId = computeBindingId(instanceId, principalId, authorityOrigin, 1);
        rawProposals.push({
          schema: "local_profile_binding_v1",
          binding_id: bindingId,
          trust_mode: "mesh-managed",
          principal_id: principalId,
          profile_name: profileName,
          profile_instance_id: instanceId,
          authority_origin: authorityOrigin,
          binding_generation: 1,
          revoked_at: null,
          proof: {
            kind: "disk_observation",
            observed_on_disk: true,
            verified_live_authority: false,
          },
        });
      }
    }
  }

  // Deduplicate and sort blocked
  const seenBlocked = new Set();
  const blocked = [];
  for (const b of rawBlocked) {
    const key = `${b.profile}\0${b.profileInstanceId}\0${b.reason}`;
    if (!seenBlocked.has(key)) {
      seenBlocked.add(key);
      blocked.push(b);
    }
  }
  blocked.sort((a, b) => {
    const cmpP = compareStrings(a.profile, b.profile);
    if (cmpP !== 0) return cmpP;
    const cmpI = compareStrings(a.profileInstanceId, b.profileInstanceId);
    if (cmpI !== 0) return cmpI;
    return compareStrings(a.reason, b.reason);
  });

  // Deduplicate and sort localOnly
  const seenLocal = new Set();
  const localOnly = [];
  for (const l of rawLocalOnly) {
    const key = `${l.profile}\0${l.profileInstanceId}`;
    if (!seenLocal.has(key)) {
      seenLocal.add(key);
      localOnly.push(l);
    }
  }
  localOnly.sort((a, b) => {
    const cmpP = compareStrings(a.profile, b.profile);
    if (cmpP !== 0) return cmpP;
    return compareStrings(a.profileInstanceId, b.profileInstanceId);
  });

  // Deduplicate and sort unchanged
  const seenUnchanged = new Set();
  const unchanged = [];
  for (const u of rawUnchanged) {
    const key = `${u.profile}\0${u.profileInstanceId}\0${u.principalId}\0${u.authorityOrigin}`;
    if (!seenUnchanged.has(key)) {
      seenUnchanged.add(key);
      unchanged.push(u);
    }
  }
  unchanged.sort((a, b) => {
    const cmpP = compareStrings(a.profile, b.profile);
    if (cmpP !== 0) return cmpP;
    const cmpI = compareStrings(a.profileInstanceId, b.profileInstanceId);
    if (cmpI !== 0) return cmpI;
    const cmpPr = compareStrings(a.principalId, b.principalId);
    if (cmpPr !== 0) return cmpPr;
    return compareStrings(a.authorityOrigin, b.authorityOrigin);
  });

  // Deduplicate and sort proposals
  const seenProposals = new Set();
  const proposals = [];
  for (const p of rawProposals) {
    const key = `${p.profile_name}\0${p.profile_instance_id}\0${p.principal_id}\0${p.authority_origin}`;
    if (!seenProposals.has(key)) {
      seenProposals.add(key);
      proposals.push(p);
    }
  }
  proposals.sort((a, b) => {
    const cmpP = compareStrings(a.profile_name, b.profile_name);
    if (cmpP !== 0) return cmpP;
    const cmpI = compareStrings(a.profile_instance_id, b.profile_instance_id);
    if (cmpI !== 0) return cmpI;
    const cmpPr = compareStrings(a.principal_id, b.principal_id);
    if (cmpPr !== 0) return cmpPr;
    return compareStrings(a.authority_origin, b.authority_origin);
  });

  const summary = {
    proposals: proposals.length,
    unchanged: unchanged.length,
    blocked: blocked.length,
    localOnly: localOnly.length,
    proposalCount: proposals.length,
    unchangedCount: unchanged.length,
    blockedCount: blocked.length,
    localOnlyCount: localOnly.length,
  };

  const unhashedPlan = {
    schema: IDENTITY_MAPPING_PLAN_SCHEMA,
    registrySequence,
    proposals,
    unchanged,
    blocked,
    localOnly,
    summary,
  };

  const planId = createHash("sha256").update(canonicalJson(unhashedPlan), "utf8").digest("hex");

  const plan = {
    schema: IDENTITY_MAPPING_PLAN_SCHEMA,
    planId,
    registrySequence,
    proposals,
    unchanged,
    blocked,
    localOnly,
    summary,
  };

  return deepFreeze(plan);
}

function resolveNowIso(nowInput) {
  const value = typeof nowInput === "function" ? nowInput() : nowInput;
  if (value === undefined) return new Date().toISOString();
  let ms = Number.NaN;
  if (value instanceof Date) ms = value.getTime();
  else if (typeof value === "number") ms = value;
  else if (typeof value === "string") ms = Date.parse(value);
  const date = new Date(ms);
  if (!Number.isFinite(ms) || Number.isNaN(date.getTime())) {
    throw codedError("invalid_now", "now_must_be_a_valid_time");
  }
  return date.toISOString();
}

/**
 * Confirmed apply step for identity mapping.
 *
 * @param {object} options
 * @param {string} options.root - Absolute path to registry root.
 * @param {string} options.confirmation - Plan ID confirmed by owner.
 * @param {Function} options.readInventory - Injected inventory reader.
 * @param {Function|string|number|Date} [options.now] - Optional timestamp provider.
 * @param {object} [options.plan] - Optional seen plan (for mismatch verification).
 * @param {string} [options.expectedPlanId] - Optional seen plan ID (for mismatch verification).
 * @returns {Promise<object>|object} Applied results `{ applied, registrySequence }`.
 */
export function applyIdentityMapping({
  root,
  confirmation,
  readInventory,
  now,
  plan = null,
  expectedPlanId = null,
  faultHook = null,
} = {}) {
  if (typeof confirmation !== "string" || !/^[a-f0-9]{64}$/.test(confirmation)) {
    throw codedError("confirmation_mismatch", "confirmation_must_be_64_hex");
  }

  const seenPlanId = plan?.planId ?? expectedPlanId;
  if (seenPlanId !== null && seenPlanId !== undefined && confirmation !== seenPlanId) {
    throw codedError("confirmation_mismatch", "confirmation_does_not_match_plan_id");
  }

  if (typeof readInventory !== "function") {
    throw codedError("invalid_inventory_reader", "read_inventory_must_be_function");
  }

  // Reject an unusable clock before anything is read or written
  resolveNowIso(now);

  // Re-read inventory and registry
  const freshInventory = readInventory();
  const freshRegistryResult = readIdentityRegistry({ root });
  const freshPlan = planIdentityMapping({
    inventory: freshInventory,
    registry: freshRegistryResult,
  });

  if (freshPlan.planId !== confirmation) {
    throw codedError("plan_stale", "recomputed_plan_does_not_match_confirmation");
  }

  let currentSeq = freshPlan.registrySequence;
  const applied = [];
  const proposals = freshPlan.proposals;

  for (let i = 0; i < proposals.length; i++) {
    const proposal = proposals[i];
    try {
      const stepNowIso = resolveNowIso(now);
      const updateResult = updateIdentityRegistry({
        root,
        expectedSequence: currentSeq,
        now: stepNowIso,
        action: "bind",
        subject: proposal.profile_instance_id,
        faultHook,
        mutate: (draft) => {
          draft.bindings[proposal.profile_instance_id] = {
            ...proposal,
            issued_at: stepNowIso,
          };
          return draft;
        },
      });

      currentSeq = updateResult.registry.sequence;
      applied.push(updateResult.registry.bindings[proposal.profile_instance_id]);
    } catch (error) {
      // Re-read current state to compute remaining plan
      let remainingPlan = null;
      try {
        const afterRegistry = readIdentityRegistry({ root });
        const afterInventory = readInventory();
        remainingPlan = planIdentityMapping({
          inventory: afterInventory,
          registry: afterRegistry,
        });
      } catch {}

      const err = codedError(error.code ?? "apply_failed", error.reason ?? error.message);
      err.applied = deepFreeze(applied);
      err.failed = deepFreeze({
        proposal,
        code: error.code ?? "apply_failed",
        reason: error.reason ?? error.message,
      });
      err.remaining = deepFreeze(remainingPlan);
      throw err;
    }
  }

  return deepFreeze({
    applied,
    registrySequence: currentSeq,
  });
}

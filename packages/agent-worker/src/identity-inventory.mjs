/**
 * Identity Inventory Projection (Slice 1a Read-Only Foundation).
 *
 * Implements a secret-free identity inventory projection building on the existing
 * validated installation inventory (`readInstallationInventory` in installation-inventory.mjs).
 *
 * Invariants:
 * - READ-ONLY: Pure projection function; performs zero filesystem, process, network,
 *   or keychain operations.
 * - SECRET-FREE: Uses strict output allowlists and defensive secret-key stripping so
 *   credentials, private keys, or tokens cannot leak from caller-supplied objects.
 * - IMMUTABLE IDENTITIES: Preserves existing profile IDs, agent IDs, and addresses as-is.
 *   Does not create principals, infer authority from labels/display names, or enroll.
 * - SCOPED MESH AUTHORITY: MESH identity is strictly scoped to its authority origin.
 *   Identities under different authority origins are never silently unified across servers.
 * - LOCAL-ONLY ISOLATION: Unbound profiles and local sessions are never converted into
 *   peer principals (`isPrincipal: false`). No serverless identities (`peer_*`) are fabricated.
 * - CONFLICT & AMBIGUITY DIAGNOSIS: Duplicate profile-to-instance mappings, ambiguous
 *   multi-profile bindings to the same agent, handle collisions, and malformed records
 *   are explicitly diagnosed rather than auto-merged.
 * - AUTHORITY BOUNDARY: Clearly distinguishes observed on-disk bindings (`observedOnDisk: true`)
 *   from verified live authority (`verifiedLiveAuthority: false`).
 */

import {
  deriveClientInstanceId,
  isValidProfileName,
  stripSecretKeys,
  UNAVAILABLE,
  UNSUPPORTED,
} from "./installation-inventory.mjs";

export { UNAVAILABLE, UNSUPPORTED };

export const AGENT_ID_PATTERN = /^agent_[a-f0-9]{32}$/;
export const INSTANCE_ID_PATTERN = /^[a-f0-9]{64}$/;
export const SESSION_ID_PATTERN = /^session-[a-f0-9]{64}$/;

export const DIAGNOSTIC_CODES = Object.freeze({
  MALFORMED_RECORD: "malformed_record",
  DUPLICATE_PROFILE: "duplicate_profile",
  DUPLICATE_INSTANCE: "duplicate_instance_id",
  AMBIGUOUS_MAPPING: "ambiguous_mapping",
  HANDLE_COLLISION: "handle_collision",
  ORIGIN_MISMATCH: "origin_mismatch",
  CUSTODY_FAULT: "custody_fault",
  UNREGISTERED_BINDING: "unregistered_binding",
  ORPHAN_BINDING: "orphan_binding",
});

function deepFreeze(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  Object.freeze(obj);
  for (const val of Object.values(obj)) {
    if (val !== null && typeof val === "object" && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

/**
 * Builds a secret-free, deterministic identity inventory report from an
 * installation inventory result.
 *
 * @param {object} installationInventory - Output of readInstallationInventory.
 * @param {object} [options]
 * @param {Array<object>} [options.sessions] - Optional validated local session observations.
 * @returns {object} Frozen plain object representing the identity inventory.
 */
export function buildIdentityInventory(installationInventory, options = {}) {
  if (!installationInventory || typeof installationInventory !== "object") {
    throw new TypeError("installationInventory must be a non-null object");
  }

  const diagnostics = [];

  // Pass through underlying blockers and warnings using strict allowlists
  if (Array.isArray(installationInventory.blockers)) {
    for (const b of installationInventory.blockers) {
      if (!b || typeof b !== "object") continue;
      diagnostics.push({
        code: String(b.code ?? "blocker"),
        severity: "fault",
        message: String(b.message ?? "Underlying installation blocker"),
        ...(typeof b.profile === "string" ? { profile: b.profile } : {}),
      });
    }
  }

  if (Array.isArray(installationInventory.warnings)) {
    for (const w of installationInventory.warnings) {
      if (!w || typeof w !== "object") continue;
      diagnostics.push({
        code: String(w.code ?? "warning"),
        severity: "warning",
        message: String(w.message ?? "Underlying installation warning"),
        ...(typeof w.profile === "string" ? { profile: w.profile } : {}),
      });
    }
  }

  // Pass through bound unregistered profiles (on-disk bindings not in registry)
  if (Array.isArray(installationInventory.boundUnregistered)) {
    for (const prof of installationInventory.boundUnregistered) {
      if (typeof prof === "string") {
        diagnostics.push({
          code: DIAGNOSTIC_CODES.UNREGISTERED_BINDING,
          severity: "warning",
          message: `Profile "${prof}" has on-disk custody binding but is not registered in client instances`,
          profile: prof,
        });
      }
    }
  }

  // Pass through orphan lane bindings
  if (Array.isArray(installationInventory.orphanBindings)) {
    for (const orphan of installationInventory.orphanBindings) {
      if (orphan && typeof orphan === "object" && typeof orphan.profile === "string") {
        diagnostics.push({
          code: DIAGNOSTIC_CODES.ORPHAN_BINDING,
          severity: "warning",
          message: `${orphan.kind ?? "lane"} binding lists profile "${orphan.profile}" which is not in the installation registry`,
          profile: orphan.profile,
        });
      }
    }
  }

  const seenProfiles = new Map();
  const seenInstanceIds = new Map();
  const identitiesMap = new Map(); // key: `${authorityOrigin}\0${agentId}`
  const unmappedProfiles = [];
  const handleToAgentIds = new Map(); // key: handle -> Set of agentIds
  const agentIdToOrigins = new Map(); // key: agentId -> Set of origins

  const inputProfiles = Array.isArray(installationInventory.profiles)
    ? installationInventory.profiles
    : [];

  for (const entry of inputProfiles) {
    if (!entry || typeof entry !== "object") {
      diagnostics.push({
        code: DIAGNOSTIC_CODES.MALFORMED_RECORD,
        severity: "fault",
        message: "Malformed profile entry: entry is not an object",
      });
      continue;
    }

    const rawProfile = entry.profile;
    const rawInstanceId = entry.instanceId;
    let isMalformed = false;
    const problems = [];

    if (typeof rawProfile !== "string" || !isValidProfileName(rawProfile)) {
      isMalformed = true;
      problems.push("invalid_profile_name");
    }

    if (rawInstanceId != null) {
      if (typeof rawInstanceId !== "string" || !INSTANCE_ID_PATTERN.test(rawInstanceId)) {
        isMalformed = true;
        problems.push("invalid_instance_id_format");
      } else if (typeof rawProfile === "string" && isValidProfileName(rawProfile)) {
        const expectedInstanceId = deriveClientInstanceId(rawProfile);
        if (rawInstanceId !== expectedInstanceId) {
          isMalformed = true;
          problems.push("instance_id_mismatch");
        }
      }
    }

    if (entry.registry && entry.registry.valid === false) {
      isMalformed = true;
      problems.push("invalid_registry_record");
    }

    // Check for duplicate profile names across registry entries
    if (typeof rawProfile === "string") {
      if (seenProfiles.has(rawProfile)) {
        diagnostics.push({
          code: DIAGNOSTIC_CODES.DUPLICATE_PROFILE,
          severity: "fault",
          message: `Duplicate profile record observed for profile "${rawProfile}"`,
          profile: rawProfile,
        });
      } else {
        seenProfiles.set(rawProfile, entry);
      }
    }

    // Check for duplicate instance IDs mapped to different profiles
    if (typeof rawInstanceId === "string" && INSTANCE_ID_PATTERN.test(rawInstanceId)) {
      if (seenInstanceIds.has(rawInstanceId)) {
        const prev = seenInstanceIds.get(rawInstanceId);
        if (prev.profile !== rawProfile) {
          diagnostics.push({
            code: DIAGNOSTIC_CODES.DUPLICATE_INSTANCE,
            severity: "fault",
            message: `Duplicate instanceId "${rawInstanceId}" claimed by distinct profiles "${prev.profile}" and "${rawProfile}"`,
            profile: rawProfile,
          });
        }
      } else {
        seenInstanceIds.set(rawInstanceId, entry);
      }
    }

    if (isMalformed) {
      const profName = typeof rawProfile === "string" ? rawProfile : "(invalid)";
      diagnostics.push({
        code: DIAGNOSTIC_CODES.MALFORMED_RECORD,
        severity: "fault",
        message: `Profile entry "${profName}" is malformed: ${problems.join(", ")}`,
        ...(typeof rawProfile === "string" ? { profile: rawProfile } : {}),
      });

      unmappedProfiles.push({
        profile: profName,
        instanceId: typeof rawInstanceId === "string" ? rawInstanceId : null,
        lane: typeof entry.lane === "string" ? entry.lane : UNAVAILABLE,
        runtimeAdapter: typeof entry.runtimeAdapter === "string" ? entry.runtimeAdapter : UNAVAILABLE,
        deliveryMode: typeof entry.deliveryMode === "string" ? entry.deliveryMode : UNAVAILABLE,
        enabled: Boolean(entry.enabled),
        status: "fault",
        bindingState: "malformed",
        isPrincipal: false,
        reason: "malformed_record",
        diagnostics: problems,
      });
      continue;
    }

    const identityObs = entry.identity;
    const isBound = identityObs
      && identityObs.state === "bound"
      && typeof identityObs.agentId === "string";

    if (!isBound) {
      // Unmapped profile: unbound, disabled, or custody failure
      const bindingState = typeof identityObs?.state === "string" ? identityObs.state : "unbound";
      const profileDiagnostics = [];

      if (bindingState !== "unbound" && bindingState !== "bound") {
        profileDiagnostics.push(`custody_${bindingState}`);
        diagnostics.push({
          code: DIAGNOSTIC_CODES.CUSTODY_FAULT,
          severity: "fault",
          message: `Profile "${rawProfile}" binding custody check failed with state: ${bindingState}`,
          profile: rawProfile,
        });
      }

      unmappedProfiles.push({
        profile: rawProfile,
        instanceId: typeof rawInstanceId === "string" ? rawInstanceId : null,
        lane: typeof entry.lane === "string" ? entry.lane : UNAVAILABLE,
        runtimeAdapter: typeof entry.runtimeAdapter === "string" ? entry.runtimeAdapter : UNAVAILABLE,
        deliveryMode: typeof entry.deliveryMode === "string" ? entry.deliveryMode : UNAVAILABLE,
        enabled: Boolean(entry.enabled),
        status: typeof entry.status === "string" ? entry.status : (entry.enabled ? "ok" : "disabled"),
        bindingState,
        isPrincipal: false,
        reason: bindingState === "unbound" ? "unbound_local_profile" : `custody_${bindingState}`,
        diagnostics: profileDiagnostics,
      });
      continue;
    }

    // Process bound identity
    const agentId = identityObs.agentId;
    if (!AGENT_ID_PATTERN.test(agentId)) {
      diagnostics.push({
        code: DIAGNOSTIC_CODES.MALFORMED_RECORD,
        severity: "fault",
        message: `Profile "${rawProfile}" bound agent ID does not match agent_<32-hex> pattern: "${agentId}"`,
        profile: rawProfile,
      });
      unmappedProfiles.push({
        profile: rawProfile,
        instanceId: typeof rawInstanceId === "string" ? rawInstanceId : null,
        lane: typeof entry.lane === "string" ? entry.lane : UNAVAILABLE,
        runtimeAdapter: typeof entry.runtimeAdapter === "string" ? entry.runtimeAdapter : UNAVAILABLE,
        deliveryMode: typeof entry.deliveryMode === "string" ? entry.deliveryMode : UNAVAILABLE,
        enabled: Boolean(entry.enabled),
        status: "fault",
        bindingState: "invalid_agent_id",
        isPrincipal: false,
        reason: "invalid_agent_id",
        diagnostics: ["invalid_agent_id"],
      });
      continue;
    }

    const authorityOrigin = typeof identityObs.origin === "string" && identityObs.origin.length > 0
      ? identityObs.origin
      : UNAVAILABLE;

    // Track origin distribution per agentId to detect different origins for the same agentId
    if (!agentIdToOrigins.has(agentId)) {
      agentIdToOrigins.set(agentId, new Set());
    }
    agentIdToOrigins.get(agentId).add(authorityOrigin);

    const handle = typeof identityObs.handle === "string" ? identityObs.handle : null;
    if (handle) {
      if (!handleToAgentIds.has(handle)) {
        handleToAgentIds.set(handle, new Set());
      }
      handleToAgentIds.get(handle).add(agentId);
    }

    const allowlistedProfileBinding = {
      profile: rawProfile,
      instanceId: rawInstanceId,
      lane: typeof entry.lane === "string" ? entry.lane : UNAVAILABLE,
      runtimeAdapter: typeof entry.runtimeAdapter === "string" ? entry.runtimeAdapter : UNAVAILABLE,
      deliveryMode: typeof entry.deliveryMode === "string" ? entry.deliveryMode : UNAVAILABLE,
      enabled: Boolean(entry.enabled),
      status: typeof entry.status === "string" ? entry.status : (entry.enabled ? "ok" : "disabled"),
      bindingState: identityObs.state,
      ...(typeof identityObs.workloadId === "string" ? { workloadId: identityObs.workloadId } : {}),
    };

    // Scoped strictly by (authorityOrigin, agentId)
    const identityKey = `${authorityOrigin}\0${agentId}`;

    if (identitiesMap.has(identityKey)) {
      const existing = identitiesMap.get(identityKey);
      existing.profiles.push(allowlistedProfileBinding);
      existing.diagnostics.push({
        code: DIAGNOSTIC_CODES.AMBIGUOUS_MAPPING,
        severity: "warning",
        message: `Multiple local profiles ("${existing.profiles[0].profile}" and "${rawProfile}") map to agent "${agentId}" under origin "${authorityOrigin}"`,
        profile: rawProfile,
      });
      diagnostics.push({
        code: DIAGNOSTIC_CODES.AMBIGUOUS_MAPPING,
        severity: "warning",
        message: `Ambiguous profile mapping: profile "${rawProfile}" and profile "${existing.profiles[0].profile}" both bind to principal "${agentId}"`,
        profile: rawProfile,
        principalId: agentId,
      });
    } else {
      identitiesMap.set(identityKey, {
        principalId: agentId,
        kind: "mesh-managed",
        authorityOrigin,
        handle,
        profiles: [allowlistedProfileBinding],
        authority: {
          observedOnDisk: true,
          verifiedLiveAuthority: false,
          source: "profiles-v1",
        },
        diagnostics: [],
      });
    }
  }

  // Cross-identity checks: detect display name collisions across distinct agent IDs
  for (const [handle, agentIds] of handleToAgentIds.entries()) {
    if (agentIds.size > 1) {
      const idList = [...agentIds].sort().join(", ");
      diagnostics.push({
        code: DIAGNOSTIC_CODES.HANDLE_COLLISION,
        severity: "warning",
        message: `Handle collision: handle "${handle}" is shared across distinct agent IDs (${idList}); identities remain separated and are not merged`,
      });
      for (const identity of identitiesMap.values()) {
        if (identity.handle === handle) {
          identity.diagnostics.push({
            code: DIAGNOSTIC_CODES.HANDLE_COLLISION,
            severity: "warning",
            message: `Handle "${handle}" is also claimed by other distinct agent IDs (${idList})`,
          });
        }
      }
    }
  }

  // Cross-origin checks: same agentId under multiple distinct authority origins
  for (const [agentId, origins] of agentIdToOrigins.entries()) {
    if (origins.size > 1) {
      const originList = [...origins].sort().join(", ");
      diagnostics.push({
        code: DIAGNOSTIC_CODES.ORIGIN_MISMATCH,
        severity: "warning",
        message: `Agent ID "${agentId}" observed under multiple distinct authority origins (${originList}); origins are not unified`,
        principalId: agentId,
      });
    }
  }

  // Process optional local session observations
  const projectedSessions = [];
  if (Array.isArray(options.sessions)) {
    for (const sess of options.sessions) {
      if (!sess || typeof sess !== "object") continue;
      const rawSessionId = sess.sessionId;
      const validSessionId = typeof rawSessionId === "string" && SESSION_ID_PATTERN.test(rawSessionId);

      if (!validSessionId) {
        diagnostics.push({
          code: DIAGNOSTIC_CODES.MALFORMED_RECORD,
          severity: "warning",
          message: `Invalid session ID format: "${rawSessionId}"`,
        });
      }

      projectedSessions.push({
        sessionId: typeof rawSessionId === "string" ? rawSessionId : "(invalid)",
        profile: typeof sess.profile === "string" ? sess.profile : null,
        isPrincipal: false,
        scope: "host-local",
        principalId: null,
        observedOnDisk: Boolean(sess.observedOnDisk ?? false),
      });
    }
  }

  // Sort identities deterministically by principalId, then authorityOrigin
  const identities = [...identitiesMap.values()].sort((a, b) => {
    const cmpId = String(a.principalId).localeCompare(String(b.principalId));
    if (cmpId !== 0) return cmpId;
    return String(a.authorityOrigin).localeCompare(String(b.authorityOrigin));
  });

  // Sort profiles within each identity deterministically
  for (const ident of identities) {
    ident.profiles.sort((a, b) => String(a.profile).localeCompare(String(b.profile)));
    ident.diagnostics.sort((a, b) => String(a.code).localeCompare(String(b.code))
      || String(a.message).localeCompare(String(b.message)));
  }

  // Sort unmapped profiles deterministically by profile
  unmappedProfiles.sort((a, b) => String(a.profile).localeCompare(String(b.profile)));

  // Sort sessions deterministically by sessionId
  projectedSessions.sort((a, b) => String(a.sessionId).localeCompare(String(b.sessionId)));

  // Sort diagnostics deterministically
  diagnostics.sort((a, b) => {
    const cmpCode = String(a.code).localeCompare(String(b.code));
    if (cmpCode !== 0) return cmpCode;
    const cmpMsg = String(a.message).localeCompare(String(b.message));
    if (cmpMsg !== 0) return cmpMsg;
    return String(a.profile ?? "").localeCompare(String(b.profile ?? ""));
  });

  const faultCount = diagnostics.filter((d) => d.severity === "fault").length;
  const warningCount = diagnostics.filter((d) => d.severity === "warning").length;

  const rawReport = {
    schema: "identity_inventory_v1",
    scope: "host-local",
    summary: {
      identityCount: identities.length,
      unmappedProfileCount: unmappedProfiles.length,
      sessionCount: projectedSessions.length,
      faultCount,
      warningCount,
    },
    identities,
    unmappedProfiles,
    sessions: projectedSessions,
    diagnostics,
  };

  // Defense-in-depth: strip any accidental secret-like keys
  const sanitizedReport = stripSecretKeys(rawReport);

  return deepFreeze(sanitizedReport);
}

export const projectIdentityInventory = buildIdentityInventory;

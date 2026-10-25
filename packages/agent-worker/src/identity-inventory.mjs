/**
 * Identity Inventory Projection (Slice 1a Read-Only Foundation).
 *
 * Implements a secret-free identity inventory projection building on the existing
 * validated installation inventory (`readInstallationInventory` in installation-inventory.mjs).
 *
 * Invariants:
 * - READ-ONLY: Pure projection function; performs zero filesystem, process, network,
 *   or keychain operations.
 * - SECRET PREVENTION & BOUNDARY SAFETY: Enforces strict output allowlists, fixed
 *   diagnostic text for underlying warnings/blockers, and masks/rejects malformed string
 *   payloads so credentials, tokens, or arbitrary injected data cannot leak into reports.
 *   Bounded display labels (profile names, handles) are preserved as metadata when valid;
 *   no speculative regex secret detection is performed over legitimate user metadata.
 * - IMMUTABLE IDENTITIES: Preserves existing profile IDs, agent IDs, and addresses as-is.
 *   Does not create principals, infer authority from labels/display names, or enroll.
 * - SCOPED MESH AUTHORITY: MESH identity is strictly scoped to its authority origin.
 *   Only bare HTTPS origins (without userinfo, path, query, or fragment) with matching
 *   derived instance IDs are accepted as managed identities. Invalid bound evidence remains
 *   unmapped/fault. Identities under different authority origins are never unified.
 * - LOCAL-ONLY ISOLATION: Unbound profiles and local sessions are never converted into
 *   peer principals (`isPrincipal: false`). No serverless identities (`peer_*`) are fabricated.
 * - CONFLICT & AMBIGUITY PRESERVATION: Duplicate profile records, duplicate instance claims,
 *   ambiguous multi-profile bindings to the same agent, handle collisions, and malformed records
 *   are explicitly diagnosed. Conflicting observations (such as multiple handles for the same
 *   agent) are preserved in metadata without arbitrarily selecting a winner, ensuring 100%
 *   deterministic output under reordered inputs.
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
const DIAGNOSTIC_CODE_PATTERN = /^[a-z0-9_.-]{1,64}$/i;
const HANDLE_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/;

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
 * Validates that an origin is a bare HTTPS origin:
 * - Scheme must be https://
 * - Non-empty hostname
 * - No userinfo (@)
 * - No path (not even trailing slash '/')
 * - No query (?)
 * - No fragment (#)
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidBareHttpsOrigin(value) {
  if (typeof value !== "string" || !value.startsWith("https://")) return false;
  // Raw path check: origin cannot have path, trailing slash, query, or hash
  const rawPath = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*(.*)$/s.exec(value);
  if (rawPath == null || rawPath[1] !== "") return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:"
    && url.hostname.length > 0
    && url.username === ""
    && url.password === ""
    && !value.includes("@")
    && !value.includes("?")
    && !value.includes("#")
    && url.origin === value;
}

/**
 * Deterministic tie-breaker for raw profile entry comparison.
 */
function compareRawProfileEntries(a, b) {
  if (a === b) return 0;
  if (!a || typeof a !== "object") return -1;
  if (!b || typeof b !== "object") return 1;

  const profA = typeof a.profile === "string" ? a.profile : "";
  const profB = typeof b.profile === "string" ? b.profile : "";
  const cmpProf = profA.localeCompare(profB);
  if (cmpProf !== 0) return cmpProf;

  const instA = typeof a.instanceId === "string" ? a.instanceId : "";
  const instB = typeof b.instanceId === "string" ? b.instanceId : "";
  const cmpInst = instA.localeCompare(instB);
  if (cmpInst !== 0) return cmpInst;

  const laneA = typeof a.lane === "string" ? a.lane : "";
  const laneB = typeof b.lane === "string" ? b.lane : "";
  const cmpLane = laneA.localeCompare(laneB);
  if (cmpLane !== 0) return cmpLane;

  const raA = typeof a.runtimeAdapter === "string" ? a.runtimeAdapter : "";
  const raB = typeof b.runtimeAdapter === "string" ? b.runtimeAdapter : "";
  const cmpRa = raA.localeCompare(raB);
  if (cmpRa !== 0) return cmpRa;

  const dmA = typeof a.deliveryMode === "string" ? a.deliveryMode : "";
  const dmB = typeof b.deliveryMode === "string" ? b.deliveryMode : "";
  const cmpDm = dmA.localeCompare(dmB);
  if (cmpDm !== 0) return cmpDm;

  const enA = a.enabled ? 1 : 0;
  const enB = b.enabled ? 1 : 0;
  if (enA !== enB) return enA - enB;

  const stA = typeof a.status === "string" ? a.status : "";
  const stB = typeof b.status === "string" ? b.status : "";
  const cmpSt = stA.localeCompare(stB);
  if (cmpSt !== 0) return cmpSt;

  return JSON.stringify(a).localeCompare(JSON.stringify(b));
}

function compareDiagnostics(a, b) {
  const cmpCode = String(a?.code ?? "").localeCompare(String(b?.code ?? ""));
  if (cmpCode !== 0) return cmpCode;
  const cmpMsg = String(a?.message ?? "").localeCompare(String(b?.message ?? ""));
  if (cmpMsg !== 0) return cmpMsg;
  const cmpProf = String(a?.profile ?? "").localeCompare(String(b?.profile ?? ""));
  if (cmpProf !== 0) return cmpProf;
  const cmpSev = String(a?.severity ?? "").localeCompare(String(b?.severity ?? ""));
  if (cmpSev !== 0) return cmpSev;
  const cmpPrin = String(a?.principalId ?? "").localeCompare(String(b?.principalId ?? ""));
  if (cmpPrin !== 0) return cmpPrin;
  return JSON.stringify(a).localeCompare(JSON.stringify(b));
}

function compareSessions(a, b) {
  const cmpId = String(a?.sessionId ?? "").localeCompare(String(b?.sessionId ?? ""));
  if (cmpId !== 0) return cmpId;
  const cmpProf = String(a?.profile ?? "").localeCompare(String(b?.profile ?? ""));
  if (cmpProf !== 0) return cmpProf;
  const cmpScope = String(a?.scope ?? "").localeCompare(String(b?.scope ?? ""));
  if (cmpScope !== 0) return cmpScope;
  const diskA = a?.observedOnDisk ? 1 : 0;
  const diskB = b?.observedOnDisk ? 1 : 0;
  if (diskA !== diskB) return diskA - diskB;
  return JSON.stringify(a).localeCompare(JSON.stringify(b));
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

  // Retain validated bounded code/profile plus fixed diagnostic text (never copy arbitrary messages)
  if (Array.isArray(installationInventory.blockers)) {
    for (const b of installationInventory.blockers) {
      if (!b || typeof b !== "object") continue;
      const safeCode = typeof b.code === "string" && DIAGNOSTIC_CODE_PATTERN.test(b.code)
        ? b.code
        : "underlying_blocker";
      const hasValidProfile = typeof b.profile === "string" && isValidProfileName(b.profile);
      diagnostics.push({
        code: safeCode,
        severity: "fault",
        message: hasValidProfile
          ? `Underlying installation blocker (${safeCode}) for profile "${b.profile}"`
          : `Underlying installation blocker (${safeCode})`,
        ...(hasValidProfile ? { profile: b.profile } : {}),
      });
    }
  }

  if (Array.isArray(installationInventory.warnings)) {
    for (const w of installationInventory.warnings) {
      if (!w || typeof w !== "object") continue;
      const safeCode = typeof w.code === "string" && DIAGNOSTIC_CODE_PATTERN.test(w.code)
        ? w.code
        : "underlying_warning";
      const hasValidProfile = typeof w.profile === "string" && isValidProfileName(w.profile);
      diagnostics.push({
        code: safeCode,
        severity: "warning",
        message: hasValidProfile
          ? `Underlying installation warning (${safeCode}) for profile "${w.profile}"`
          : `Underlying installation warning (${safeCode})`,
        ...(hasValidProfile ? { profile: w.profile } : {}),
      });
    }
  }

  // Pass through bound unregistered profiles (on-disk bindings not in registry)
  if (Array.isArray(installationInventory.boundUnregistered)) {
    for (const prof of installationInventory.boundUnregistered) {
      if (typeof prof === "string" && isValidProfileName(prof)) {
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
      if (orphan && typeof orphan === "object" && typeof orphan.profile === "string" && isValidProfileName(orphan.profile)) {
        const safeKind = typeof orphan.kind === "string" && /^[a-z0-9_-]{1,32}$/i.test(orphan.kind)
          ? orphan.kind
          : "lane";
        diagnostics.push({
          code: DIAGNOSTIC_CODES.ORPHAN_BINDING,
          severity: "warning",
          message: `${safeKind} binding lists profile "${orphan.profile}" which is not in the installation registry`,
          profile: orphan.profile,
        });
      }
    }
  }

  const rawInputProfiles = Array.isArray(installationInventory.profiles)
    ? installationInventory.profiles
    : [];
  // Sort input profiles deterministically to guarantee order-independence across reordered inputs
  const inputProfiles = [...rawInputProfiles].sort(compareRawProfileEntries);

  // Track profile occurrences and instance claims for duplicate detection
  const profileCounts = new Map();
  const instanceClaims = new Map(); // instanceId -> Set of profile names

  for (const entry of inputProfiles) {
    if (entry && typeof entry === "object") {
      const p = entry.profile;
      if (typeof p === "string" && isValidProfileName(p)) {
        profileCounts.set(p, (profileCounts.get(p) ?? 0) + 1);
      }
      const inst = entry.instanceId;
      if (typeof inst === "string" && INSTANCE_ID_PATTERN.test(inst) && typeof p === "string" && isValidProfileName(p)) {
        if (!instanceClaims.has(inst)) {
          instanceClaims.set(inst, new Set());
        }
        instanceClaims.get(inst).add(p);
      }
    }
  }

  // Emit duplicate profile diagnostics deterministically
  for (const [prof, count] of [...profileCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (count > 1) {
      diagnostics.push({
        code: DIAGNOSTIC_CODES.DUPLICATE_PROFILE,
        severity: "fault",
        message: `Duplicate profile record observed for profile "${prof}"`,
        profile: prof,
      });
    }
  }

  // Emit duplicate instance ID diagnostics deterministically
  for (const [instId, claimingProfilesSet] of [...instanceClaims.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (claimingProfilesSet.size > 1) {
      const sortedClaimants = [...claimingProfilesSet].sort();
      for (const claimant of sortedClaimants) {
        diagnostics.push({
          code: DIAGNOSTIC_CODES.DUPLICATE_INSTANCE,
          severity: "fault",
          message: `Duplicate instanceId claimed by distinct profiles: ${sortedClaimants.map((p) => `"${p}"`).join(", ")}`,
          profile: claimant,
        });
      }
    }
  }

  const identitiesMap = new Map(); // key: `${authorityOrigin}\0${agentId}`
  const unmappedProfiles = [];

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
    const validProfile = typeof rawProfile === "string" && isValidProfileName(rawProfile);
    let isMalformed = false;
    const problems = [];

    if (!validProfile) {
      isMalformed = true;
      problems.push("invalid_profile_name");
    }

    if (rawInstanceId != null) {
      if (typeof rawInstanceId !== "string" || !INSTANCE_ID_PATTERN.test(rawInstanceId)) {
        isMalformed = true;
        problems.push("invalid_instance_id_format");
      } else if (validProfile) {
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

    if (isMalformed) {
      diagnostics.push({
        code: DIAGNOSTIC_CODES.MALFORMED_RECORD,
        severity: "fault",
        message: validProfile
          ? `Profile entry "${rawProfile}" is malformed: ${problems.join(", ")}`
          : `Profile entry has invalid profile name: ${problems.join(", ")}`,
        ...(validProfile ? { profile: rawProfile } : {}),
      });

      unmappedProfiles.push({
        profile: validProfile ? rawProfile : "(invalid)",
        instanceId: typeof rawInstanceId === "string" && INSTANCE_ID_PATTERN.test(rawInstanceId) ? rawInstanceId : null,
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

    // Valid profile. Inspect identity state.
    const identityObs = entry.identity;
    const isBoundState = identityObs && identityObs.state === "bound";

    if (!isBoundState) {
      // Unmapped profile: unbound or custody failure
      const bindingState = typeof identityObs?.state === "string" && /^[a-z0-9_]{1,32}$/.test(identityObs.state)
        ? identityObs.state
        : "unbound";
      const profileDiagnostics = [];

      if (bindingState !== "unbound") {
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
        instanceId: typeof rawInstanceId === "string" && INSTANCE_ID_PATTERN.test(rawInstanceId) ? rawInstanceId : null,
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

    // State is "bound". Strictly validate all bound evidence.
    // 1. Matching instanceId is required for mapped profiles
    const expectedInstanceId = deriveClientInstanceId(rawProfile);
    if (typeof rawInstanceId !== "string" || !INSTANCE_ID_PATTERN.test(rawInstanceId) || rawInstanceId !== expectedInstanceId) {
      diagnostics.push({
        code: DIAGNOSTIC_CODES.MALFORMED_RECORD,
        severity: "fault",
        message: rawInstanceId == null
          ? `Profile "${rawProfile}" bound identity requires a valid derived instance ID`
          : `Profile "${rawProfile}" instance ID is invalid or does not match derived profile instance ID`,
        profile: rawProfile,
      });

      unmappedProfiles.push({
        profile: rawProfile,
        instanceId: typeof rawInstanceId === "string" && INSTANCE_ID_PATTERN.test(rawInstanceId) ? rawInstanceId : null,
        lane: typeof entry.lane === "string" ? entry.lane : UNAVAILABLE,
        runtimeAdapter: typeof entry.runtimeAdapter === "string" ? entry.runtimeAdapter : UNAVAILABLE,
        deliveryMode: typeof entry.deliveryMode === "string" ? entry.deliveryMode : UNAVAILABLE,
        enabled: Boolean(entry.enabled),
        status: "fault",
        bindingState: "invalid_bound_evidence",
        isPrincipal: false,
        reason: rawInstanceId == null ? "missing_instance_id" : "instance_id_mismatch",
        diagnostics: [rawInstanceId == null ? "missing_instance_id" : "instance_id_mismatch"],
      });
      continue;
    }

    // 2. Bound agentId format check (do not echo invalid agent ID)
    const agentId = identityObs.agentId;
    if (typeof agentId !== "string" || !AGENT_ID_PATTERN.test(agentId)) {
      diagnostics.push({
        code: DIAGNOSTIC_CODES.MALFORMED_RECORD,
        severity: "fault",
        message: `Profile "${rawProfile}" bound agent ID does not match agent_<32-hex> pattern`,
        profile: rawProfile,
      });

      unmappedProfiles.push({
        profile: rawProfile,
        instanceId: rawInstanceId,
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

    // 3. Authority origin check (bare HTTPS origin required; reject credential-bearing / invalid origins without echoing)
    const rawOrigin = identityObs.origin;
    if (!isValidBareHttpsOrigin(rawOrigin)) {
      const isMissing = rawOrigin == null || rawOrigin === "";
      const hasCreds = typeof rawOrigin === "string" && (rawOrigin.includes("@") || rawOrigin.includes("?") || rawOrigin.includes("#"));
      const msg = isMissing
        ? `Profile "${rawProfile}" bound identity is missing required authority origin`
        : (hasCreds
          ? `Profile "${rawProfile}" authority origin is invalid or contains credentials; bare HTTPS origin required`
          : `Profile "${rawProfile}" authority origin is invalid or not a bare HTTPS origin`);

      diagnostics.push({
        code: DIAGNOSTIC_CODES.MALFORMED_RECORD,
        severity: "fault",
        message: msg,
        profile: rawProfile,
      });

      unmappedProfiles.push({
        profile: rawProfile,
        instanceId: rawInstanceId,
        lane: typeof entry.lane === "string" ? entry.lane : UNAVAILABLE,
        runtimeAdapter: typeof entry.runtimeAdapter === "string" ? entry.runtimeAdapter : UNAVAILABLE,
        deliveryMode: typeof entry.deliveryMode === "string" ? entry.deliveryMode : UNAVAILABLE,
        enabled: Boolean(entry.enabled),
        status: "fault",
        bindingState: "invalid_bound_evidence",
        isPrincipal: false,
        reason: isMissing ? "missing_authority_origin" : "invalid_authority_origin",
        diagnostics: [isMissing ? "missing_authority_origin" : "invalid_authority_origin"],
      });
      continue;
    }

    const authorityOrigin = rawOrigin;

    // Normal display labels (handles) are metadata; validate format and preserve when valid
    const handle = typeof identityObs.handle === "string" && HANDLE_PATTERN.test(identityObs.handle)
      ? identityObs.handle
      : null;

    const allowlistedProfileBinding = {
      profile: rawProfile,
      instanceId: rawInstanceId,
      lane: typeof entry.lane === "string" ? entry.lane : UNAVAILABLE,
      runtimeAdapter: typeof entry.runtimeAdapter === "string" ? entry.runtimeAdapter : UNAVAILABLE,
      deliveryMode: typeof entry.deliveryMode === "string" ? entry.deliveryMode : UNAVAILABLE,
      enabled: Boolean(entry.enabled),
      status: typeof entry.status === "string" ? entry.status : (entry.enabled ? "ok" : "disabled"),
      bindingState: identityObs.state,
      ...(handle ? { handle } : {}),
      ...(typeof identityObs.workloadId === "string" && /^workload_[a-f0-9]{32}$/.test(identityObs.workloadId)
        ? { workloadId: identityObs.workloadId }
        : {}),
    };

    // Scoped strictly by (authorityOrigin, agentId)
    const identityKey = `${authorityOrigin}\0${agentId}`;

    if (!identitiesMap.has(identityKey)) {
      identitiesMap.set(identityKey, {
        principalId: agentId,
        kind: "mesh-managed",
        authorityOrigin,
        profiles: [],
        handlesSet: new Set(),
        authority: {
          observedOnDisk: true,
          verifiedLiveAuthority: false,
          source: "profiles-v1",
        },
        diagnostics: [],
      });
    }

    const group = identitiesMap.get(identityKey);
    group.profiles.push(allowlistedProfileBinding);
    if (handle) {
      group.handlesSet.add(handle);
    }
  }

  // Cross-profile ambiguity and handle resolution within each identity
  for (const group of identitiesMap.values()) {
    group.profiles.sort(compareRawProfileEntries);
    const sortedProfiles = group.profiles;
    const sortedNames = [...new Set(sortedProfiles.map((p) => p.profile))].sort();
    const uniqueHandles = [...group.handlesSet].sort();

    // Preserve all observations:
    // If exactly one handle is observed across all profiles, set handle to that.
    // If conflicting handles are observed across profiles, handle is null (explicit ambiguity, no arbitrary choice).
    group.handle = uniqueHandles.length === 1 ? uniqueHandles[0] : null;
    group.handles = uniqueHandles;
    delete group.handlesSet;

    if (sortedNames.length > 1) {
      const joinedAnd = sortedNames.map((p) => `"${p}"`).join(" and ");
      const joinedList = sortedNames.map((p) => `"${p}"`).join(", ");

      group.diagnostics.push({
        code: DIAGNOSTIC_CODES.AMBIGUOUS_MAPPING,
        severity: "warning",
        message: `Multiple local profiles (${joinedAnd}) map to agent "${group.principalId}" under origin "${group.authorityOrigin}"`,
      });

      for (const prof of sortedNames) {
        diagnostics.push({
          code: DIAGNOSTIC_CODES.AMBIGUOUS_MAPPING,
          severity: "warning",
          message: `Ambiguous profile mapping: profile "${prof}" and other profiles (${joinedList}) both bind to principal "${group.principalId}"`,
          profile: prof,
          principalId: group.principalId,
        });
      }
    }
  }

  // Cross-identity checks: detect handle collisions across distinct agent IDs
  const handleToAgentIds = new Map();
  for (const ident of identitiesMap.values()) {
    for (const h of ident.handles) {
      if (!handleToAgentIds.has(h)) {
        handleToAgentIds.set(h, new Set());
      }
      handleToAgentIds.get(h).add(ident.principalId);
    }
  }

  const sortedCollidingHandles = [...handleToAgentIds.keys()].sort();
  for (const h of sortedCollidingHandles) {
    const agentIds = handleToAgentIds.get(h);
    if (agentIds.size > 1) {
      const idList = [...agentIds].sort().join(", ");
      diagnostics.push({
        code: DIAGNOSTIC_CODES.HANDLE_COLLISION,
        severity: "warning",
        message: `Handle collision: handle "${h}" is shared across distinct agent IDs (${idList}); identities remain separated and are not merged`,
      });
      for (const identity of identitiesMap.values()) {
        if (identity.handles.includes(h)) {
          identity.diagnostics.push({
            code: DIAGNOSTIC_CODES.HANDLE_COLLISION,
            severity: "warning",
            message: `Handle "${h}" is also claimed by other distinct agent IDs (${idList})`,
          });
        }
      }
    }
  }

  // Cross-origin checks: same agentId under multiple distinct authority origins
  const agentIdToOrigins = new Map();
  for (const ident of identitiesMap.values()) {
    if (!agentIdToOrigins.has(ident.principalId)) {
      agentIdToOrigins.set(ident.principalId, new Set());
    }
    agentIdToOrigins.get(ident.principalId).add(ident.authorityOrigin);
  }

  const sortedAgentIds = [...agentIdToOrigins.keys()].sort();
  for (const aId of sortedAgentIds) {
    const origins = agentIdToOrigins.get(aId);
    if (origins.size > 1) {
      const originList = [...origins].sort().join(", ");
      diagnostics.push({
        code: DIAGNOSTIC_CODES.ORIGIN_MISMATCH,
        severity: "warning",
        message: `Agent ID "${aId}" observed under multiple distinct authority origins (${originList}); origins are not unified`,
        principalId: aId,
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
          message: "Invalid session ID format",
        });
      }

      projectedSessions.push({
        sessionId: validSessionId ? rawSessionId : "(invalid)",
        profile: typeof sess.profile === "string" && isValidProfileName(sess.profile) ? sess.profile : null,
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

  // Sort profiles and diagnostics within each identity
  for (const ident of identities) {
    ident.profiles.sort(compareRawProfileEntries);
    ident.diagnostics.sort(compareDiagnostics);
  }

  // Sort unmapped profiles deterministically
  unmappedProfiles.sort(compareRawProfileEntries);

  // Sort sessions deterministically
  projectedSessions.sort(compareSessions);

  // Sort diagnostics deterministically
  diagnostics.sort(compareDiagnostics);

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

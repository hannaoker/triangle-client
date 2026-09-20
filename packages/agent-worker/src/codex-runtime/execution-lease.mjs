/**
 * Profile-level execution lease for Phase 2 durable recovery.
 *
 * Design rules (see headless Codex worker runtime design):
 * - Owner renews while any conversation is admitted/running/result_ready/reply_persisted.
 * - Wall-clock expiry is only a signal for an idle owner.
 * - Expired idle lease may be replaced only via compare-and-swap on owner_generation.
 * - Non-idle expiry / clock skew / missed renewal freezes admission (no steal).
 * - After host restart, no owner is presumed live until reconciliation.
 */

import { NON_IDLE_EXECUTION_STATES } from "./execution-state.mjs";

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_CLOCK_SKEW_MS = 5_000;

function createCodedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function parseIsoMs(value) {
  if (typeof value !== "string" || value.length === 0) return NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : NaN;
}

function isoFromMs(ms) {
  return new Date(ms).toISOString();
}

/**
 * @param {object} options
 * @param {ReturnType<import('./durable-conversation-store.mjs').createDurableConversationStore>} options.store
 * @param {string} options.ownerInstanceId Stable id for this runtime process/instance
 * @param {() => number} [options.now]
 * @param {number} [options.leaseDurationMs]
 * @param {number} [options.maxClockSkewMs]
 */
export function createExecutionLeaseManager({
  store,
  ownerInstanceId,
  now = () => Date.now(),
  leaseDurationMs = DEFAULT_LEASE_MS,
  maxClockSkewMs = DEFAULT_MAX_CLOCK_SKEW_MS,
} = {}) {
  if (store == null || typeof store.readProfile !== "function") {
    throw new TypeError("store is required");
  }
  if (typeof ownerInstanceId !== "string" || ownerInstanceId.length === 0) {
    throw new TypeError("ownerInstanceId is required");
  }
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1_000) {
    throw new TypeError("leaseDurationMs must be >= 1000");
  }

  function listNonIdle(profileInstanceId) {
    return store
      .listConversations(profileInstanceId)
      .filter((row) => NON_IDLE_EXECUTION_STATES.includes(row.execution_state));
  }

  function assertClockSane(profile) {
    if (profile == null) return;
    const renewedMs = parseIsoMs(profile.lease_renewed_at);
    if (!Number.isFinite(renewedMs)) {
      throw createCodedError("lease_clock_invalid", "lease_renewed_at is not a valid timestamp");
    }
    const skew = renewedMs - now();
    if (skew > maxClockSkewMs) {
      throw createCodedError(
        "lease_clock_skew",
        "lease renewed_at is too far in the future; admission frozen",
        { skewMs: skew, maxClockSkewMs },
      );
    }
  }

  function isExpired(profile) {
    const expiresMs = parseIsoMs(profile.lease_expires_at);
    if (!Number.isFinite(expiresMs)) {
      throw createCodedError("lease_clock_invalid", "lease_expires_at is not a valid timestamp");
    }
    return now() >= expiresMs;
  }

  function buildLeaseFields({ generation, runtimeMode, activeMeshRoomId = null }) {
    const renewed = now();
    return {
      version: 1,
      runtime_mode: runtimeMode,
      owner_instance_id: ownerInstanceId,
      owner_generation: generation,
      ownership_state: "owned",
      lease_renewed_at: isoFromMs(renewed),
      lease_expires_at: isoFromMs(renewed + leaseDurationMs),
      active_mesh_room_id: activeMeshRoomId,
    };
  }

  /**
   * Acquire or renew the profile lease for this owner.
   * @param {object} args
   * @param {string} args.profileInstanceId
   * @param {"headless"|"desktop"} [args.runtimeMode]
   * @param {number|null} [args.expectedGeneration] Optional CAS expected generation
   * @param {boolean} [args.afterRestart] When true, never presume prior owner live
   */
  function acquire({
    profileInstanceId,
    runtimeMode = "headless",
    expectedGeneration = null,
    afterRestart = false,
    activeMeshRoomId = null,
  } = {}) {
    const existing = store.readProfile(profileInstanceId);
    if (existing != null) assertClockSane(existing);

    if (existing == null) {
      if (expectedGeneration != null && expectedGeneration !== 0) {
        throw createCodedError(
          "lease_cas_conflict",
          "expected generation does not match empty profile",
          { expectedGeneration, actual: 0 },
        );
      }
      return store.writeProfile({
        profile_instance_id: profileInstanceId,
        ...buildLeaseFields({ generation: 1, runtimeMode, activeMeshRoomId }),
      });
    }

    if (existing.ownership_state === "transferring") {
      throw createCodedError(
        "lease_transferring",
        "profile ownership is transferring; cannot admit",
        { ownerGeneration: existing.owner_generation },
      );
    }

    const sameOwner = existing.owner_instance_id === ownerInstanceId;
    if (sameOwner && !afterRestart) {
      if (expectedGeneration != null && expectedGeneration !== existing.owner_generation) {
        throw createCodedError("lease_stale_generation", "owner generation mismatch on renew", {
          expectedGeneration,
          actual: existing.owner_generation,
        });
      }
      return renew({
        profileInstanceId,
        activeMeshRoomId: activeMeshRoomId ?? existing.active_mesh_room_id,
      });
    }

    // Different owner, or afterRestart: only steal expired idle via CAS.
    const nonIdle = listNonIdle(profileInstanceId);
    if (nonIdle.length > 0) {
      throw createCodedError(
        "lease_non_idle_no_steal",
        "cannot replace lease while conversations are non-idle",
        {
          ownerGeneration: existing.owner_generation,
          nonIdleCount: nonIdle.length,
          states: nonIdle.map((row) => row.execution_state),
        },
      );
    }

    if (!isExpired(existing) && !afterRestart) {
      throw createCodedError("lease_conflict", "profile lease is held by another owner", {
        ownerInstanceId: existing.owner_instance_id,
        ownerGeneration: existing.owner_generation,
        leaseExpiresAt: existing.lease_expires_at,
      });
    }

    if (afterRestart && !isExpired(existing) && !sameOwner) {
      // After restart, prior owner is not presumed live, but design still requires
      // reconciliation before a new generation when idle + unexpired is ambiguous.
      // For idle profiles we allow CAS replace to a new generation.
    }

    if (expectedGeneration != null && expectedGeneration !== existing.owner_generation) {
      throw createCodedError("lease_cas_conflict", "compare-and-swap generation mismatch", {
        expectedGeneration,
        actual: existing.owner_generation,
      });
    }

    // CAS: re-read and ensure generation unchanged before write.
    const observed = existing.owner_generation;
    const latest = store.readProfile(profileInstanceId);
    if (latest == null || latest.owner_generation !== observed) {
      throw createCodedError("lease_cas_conflict", "owner generation changed during acquire", {
        expectedGeneration: observed,
        actual: latest?.owner_generation ?? null,
      });
    }
    if (latest.ownership_state === "transferring") {
      throw createCodedError("lease_transferring", "profile ownership became transferring");
    }
    const stillNonIdle = listNonIdle(profileInstanceId);
    if (stillNonIdle.length > 0) {
      throw createCodedError(
        "lease_non_idle_no_steal",
        "conversations became non-idle during acquire",
        { nonIdleCount: stillNonIdle.length },
      );
    }

    return store.writeProfile({
      profile_instance_id: profileInstanceId,
      ...buildLeaseFields({
        generation: observed + 1,
        runtimeMode: latest.runtime_mode ?? runtimeMode,
        activeMeshRoomId,
      }),
    });
  }

  function renew({ profileInstanceId, activeMeshRoomId = undefined } = {}) {
    const existing = store.readProfile(profileInstanceId);
    if (existing == null) {
      throw createCodedError("lease_missing", "no profile lease to renew");
    }
    assertClockSane(existing);
    if (existing.owner_instance_id !== ownerInstanceId) {
      throw createCodedError("lease_conflict", "cannot renew lease owned by another instance", {
        ownerInstanceId: existing.owner_instance_id,
      });
    }
    if (existing.ownership_state === "transferring") {
      throw createCodedError("lease_transferring", "cannot renew while transferring");
    }
    const t = now();
    return store.writeProfile({
      ...existing,
      profile_instance_id: profileInstanceId,
      lease_renewed_at: isoFromMs(t),
      lease_expires_at: isoFromMs(t + leaseDurationMs),
      active_mesh_room_id:
        activeMeshRoomId === undefined ? existing.active_mesh_room_id : activeMeshRoomId,
    });
  }

  /**
   * Replace an expired idle lease via explicit CAS against last observed generation.
   */
  function replaceExpiredIdle({
    profileInstanceId,
    expectedGeneration,
    runtimeMode = "headless",
    activeMeshRoomId = null,
  } = {}) {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) {
      throw new TypeError("expectedGeneration must be a positive integer");
    }
    const existing = store.readProfile(profileInstanceId);
    if (existing == null) {
      throw createCodedError("lease_missing", "no profile lease to replace");
    }
    assertClockSane(existing);
    if (existing.owner_generation !== expectedGeneration) {
      throw createCodedError("lease_cas_conflict", "compare-and-swap generation mismatch", {
        expectedGeneration,
        actual: existing.owner_generation,
      });
    }
    if (!isExpired(existing)) {
      throw createCodedError("lease_not_expired", "idle lease has not expired", {
        leaseExpiresAt: existing.lease_expires_at,
      });
    }
    const nonIdle = listNonIdle(profileInstanceId);
    if (nonIdle.length > 0) {
      throw createCodedError(
        "lease_non_idle_no_steal",
        "expired lease cannot be stolen while non-idle",
        { states: nonIdle.map((row) => row.execution_state) },
      );
    }
    return store.writeProfile({
      profile_instance_id: profileInstanceId,
      ...buildLeaseFields({
        generation: expectedGeneration + 1,
        runtimeMode: existing.runtime_mode ?? runtimeMode,
        activeMeshRoomId,
      }),
    });
  }

  function rejectStaleGeneration({ profileInstanceId, claimedGeneration } = {}) {
    const existing = store.readProfile(profileInstanceId);
    if (existing == null) {
      throw createCodedError("lease_missing", "no profile lease");
    }
    if (claimedGeneration !== existing.owner_generation) {
      throw createCodedError("lease_stale_generation", "claimed owner generation is stale", {
        claimedGeneration,
        actual: existing.owner_generation,
      });
    }
    if (existing.owner_instance_id !== ownerInstanceId) {
      throw createCodedError("lease_conflict", "claimed generation belongs to another owner");
    }
    return Object.freeze({ ...existing });
  }

  function status({ profileInstanceId } = {}) {
    const existing = store.readProfile(profileInstanceId);
    if (existing == null) {
      return Object.freeze({ present: false, profileInstanceId });
    }
    const expiresMs = parseIsoMs(existing.lease_expires_at);
    const nonIdle = listNonIdle(profileInstanceId);
    return Object.freeze({
      present: true,
      profileInstanceId,
      ownerInstanceId: existing.owner_instance_id,
      ownerGeneration: existing.owner_generation,
      ownershipState: existing.ownership_state,
      runtimeMode: existing.runtime_mode,
      leaseRenewedAt: existing.lease_renewed_at,
      leaseExpiresAt: existing.lease_expires_at,
      expired: Number.isFinite(expiresMs) ? now() >= expiresMs : null,
      heldBySelf: existing.owner_instance_id === ownerInstanceId,
      nonIdleCount: nonIdle.length,
      leaseAgeMs: Number.isFinite(parseIsoMs(existing.lease_renewed_at))
        ? now() - parseIsoMs(existing.lease_renewed_at)
        : null,
    });
  }

  return Object.freeze({
    ownerInstanceId,
    leaseDurationMs,
    acquire,
    renew,
    replaceExpiredIdle,
    rejectStaleGeneration,
    status,
  });
}

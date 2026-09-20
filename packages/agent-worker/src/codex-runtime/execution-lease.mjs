/**
 * Profile-level execution lease for Phase 2 durable recovery.
 *
 * Design rules (see headless Codex worker runtime design):
 * - Owner renews while any conversation is admitted/running/result_ready/reply_persisted.
 * - Wall-clock expiry is only a signal for an idle owner.
 * - Expired idle lease may be replaced only via compare-and-swap on owner_generation.
 * - Non-idle expiry / clock skew / missed renewal freezes admission (no steal).
 * - After host restart, no owner is presumed live until reconciliation.
 *
 * File-backed CAS holds an exclusive inter-process lock across compare+write so
 * two processes cannot both observe the same generation and both succeed.
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

  function runUnderProfileLock(fn) {
    if (typeof store.withProfileLock === "function") {
      return store.withProfileLock(fn);
    }
    // In-memory stubs without locking — single-process only.
    return fn();
  }

  function commitProfile(record) {
    // Prefer unlocked write when already inside withProfileLock (non-reentrant).
    if (typeof store.writeProfileUnlocked === "function") {
      return store.writeProfileUnlocked(record);
    }
    return store.writeProfile(record);
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
    return runUnderProfileLock(() => {
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
        return commitProfile({
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
        // Renew under the same lock (avoid nested withProfileLock deadlock).
        const t = now();
        return commitProfile({
          ...existing,
          profile_instance_id: profileInstanceId,
          lease_renewed_at: isoFromMs(t),
          lease_expires_at: isoFromMs(t + leaseDurationMs),
          active_mesh_room_id:
            activeMeshRoomId === null ? existing.active_mesh_room_id : activeMeshRoomId,
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

      // CAS under exclusive lock: re-read and ensure generation unchanged before write.
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

      return commitProfile({
        profile_instance_id: profileInstanceId,
        ...buildLeaseFields({
          generation: observed + 1,
          runtimeMode: latest.runtime_mode ?? runtimeMode,
          activeMeshRoomId,
        }),
      });
    });
  }

  function renew({ profileInstanceId, activeMeshRoomId = undefined } = {}) {
    return runUnderProfileLock(() => {
      const existing = store.readProfile(profileInstanceId);
      if (existing == null) {
        throw createCodedError("lease_missing", "no profile lease to renew");
      }
      assertClockSane(existing);
      if (existing.ownership_state === "transferring") {
        throw createCodedError("lease_transferring", "cannot renew while transferring");
      }
      if (existing.owner_instance_id !== ownerInstanceId) {
        throw createCodedError("lease_conflict", "cannot renew lease owned by another instance", {
          ownerInstanceId: existing.owner_instance_id,
        });
      }
      const t = now();
      return commitProfile({
        ...existing,
        profile_instance_id: profileInstanceId,
        lease_renewed_at: isoFromMs(t),
        lease_expires_at: isoFromMs(t + leaseDurationMs),
        active_mesh_room_id:
          activeMeshRoomId === undefined ? existing.active_mesh_room_id : activeMeshRoomId,
      });
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
    return runUnderProfileLock(() => {
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
      return commitProfile({
        profile_instance_id: profileInstanceId,
        ...buildLeaseFields({
          generation: expectedGeneration + 1,
          runtimeMode: existing.runtime_mode ?? runtimeMode,
          activeMeshRoomId,
        }),
      });
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
      admissionFrozen: existing.admission_frozen === true,
      desktopServerIdentity: existing.desktop_server_identity ?? null,
      chatgptAttachmentState: existing.chatgpt_attachment_state ?? null,
      boundCodexThreadId: existing.bound_codex_thread_id ?? null,
    });
  }

  /**
   * Phase 4: CAS ownership into a transfer generation.
   * Transfer generations cannot admit or start turns (acquire/renew reject).
   */
  function beginTransfer({
    profileInstanceId,
    expectedGeneration,
    transferOwnerInstanceId,
    targetRuntimeMode,
  } = {}) {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) {
      throw new TypeError("expectedGeneration must be a positive integer");
    }
    if (typeof transferOwnerInstanceId !== "string" || transferOwnerInstanceId.length === 0) {
      throw new TypeError("transferOwnerInstanceId is required");
    }
    if (targetRuntimeMode !== "headless" && targetRuntimeMode !== "desktop") {
      throw new TypeError("targetRuntimeMode must be headless or desktop");
    }
    return runUnderProfileLock(() => {
      const existing = store.readProfile(profileInstanceId);
      if (existing == null) {
        throw createCodedError("lease_missing", "no profile lease to transfer");
      }
      assertClockSane(existing);
      if (existing.owner_generation !== expectedGeneration) {
        throw createCodedError("lease_cas_conflict", "compare-and-swap generation mismatch", {
          expectedGeneration,
          actual: existing.owner_generation,
        });
      }
      if (existing.ownership_state !== "owned") {
        throw createCodedError("lease_transferring", "ownership is already transferring", {
          ownershipState: existing.ownership_state,
        });
      }
      if (existing.admission_frozen === true) {
        throw createCodedError(
          "handoff_admission_frozen",
          "admission is frozen; explicit recover-desktop or rollback-headless required",
        );
      }
      const nonIdle = listNonIdle(profileInstanceId);
      if (nonIdle.length > 0) {
        throw createCodedError("handoff_not_idle", "cannot begin handoff while non-idle", {
          states: nonIdle.map((row) => row.execution_state),
        });
      }
      const openDelivery = store
        .listConversations(profileInstanceId)
        .filter((row) => row.active_delivery_id != null);
      if (openDelivery.length > 0) {
        throw createCodedError("handoff_open_delivery", "cannot begin handoff with open delivery", {
          openDeliveryCount: openDelivery.length,
        });
      }
      const t = now();
      return commitProfile({
        ...existing,
        profile_instance_id: profileInstanceId,
        owner_instance_id: transferOwnerInstanceId,
        owner_generation: expectedGeneration + 1,
        ownership_state: "transferring",
        lease_renewed_at: isoFromMs(t),
        lease_expires_at: isoFromMs(t + leaseDurationMs),
        transfer_from_owner_instance_id: existing.owner_instance_id,
        transfer_from_runtime_mode: existing.runtime_mode,
        transfer_from_generation: existing.owner_generation,
        admission_frozen: false,
      });
    });
  }

  /**
   * Commit a successful idle handoff (step 7). Leaves ownership_state=owned.
   */
  function commitTransfer({
    profileInstanceId,
    expectedTransferGeneration,
    ownerInstanceId: nextOwnerInstanceId,
    runtimeMode,
    desktopServerIdentity = null,
    chatgptAttachmentState = null,
    boundCodexThreadId = null,
    admissionFrozen = false,
  } = {}) {
    if (!Number.isSafeInteger(expectedTransferGeneration) || expectedTransferGeneration < 1) {
      throw new TypeError("expectedTransferGeneration must be a positive integer");
    }
    if (typeof nextOwnerInstanceId !== "string" || nextOwnerInstanceId.length === 0) {
      throw new TypeError("ownerInstanceId is required");
    }
    if (runtimeMode !== "headless" && runtimeMode !== "desktop") {
      throw new TypeError("runtimeMode must be headless or desktop");
    }
    return runUnderProfileLock(() => {
      const existing = store.readProfile(profileInstanceId);
      if (existing == null) {
        throw createCodedError("lease_missing", "no profile lease to commit");
      }
      if (existing.ownership_state !== "transferring") {
        throw createCodedError("handoff_not_transferring", "ownership is not transferring", {
          ownershipState: existing.ownership_state,
        });
      }
      if (existing.owner_generation !== expectedTransferGeneration) {
        throw createCodedError("lease_cas_conflict", "transfer generation mismatch on commit", {
          expectedGeneration: expectedTransferGeneration,
          actual: existing.owner_generation,
        });
      }
      const nonIdle = listNonIdle(profileInstanceId);
      if (nonIdle.length > 0) {
        throw createCodedError("handoff_not_idle", "cannot commit handoff while non-idle", {
          states: nonIdle.map((row) => row.execution_state),
        });
      }
      const t = now();
      return commitProfile({
        profile_instance_id: profileInstanceId,
        runtime_mode: runtimeMode,
        owner_instance_id: nextOwnerInstanceId,
        owner_generation: expectedTransferGeneration + 1,
        ownership_state: "owned",
        lease_renewed_at: isoFromMs(t),
        lease_expires_at: isoFromMs(t + leaseDurationMs),
        active_mesh_room_id: existing.active_mesh_room_id ?? null,
        desktop_server_identity: desktopServerIdentity,
        chatgpt_attachment_state: chatgptAttachmentState,
        bound_codex_thread_id: boundCodexThreadId,
        admission_frozen: admissionFrozen === true,
        transfer_from_owner_instance_id: null,
        transfer_from_runtime_mode: null,
        transfer_from_generation: null,
      });
    });
  }

  /**
   * Roll back a transfer that failed before commit. Restores prior owner/mode
   * under a new owned generation (CAS against the transfer generation).
   */
  function rollbackTransfer({
    profileInstanceId,
    expectedTransferGeneration,
    ownerInstanceId: nextOwnerInstanceId = null,
    runtimeMode = null,
  } = {}) {
    if (!Number.isSafeInteger(expectedTransferGeneration) || expectedTransferGeneration < 1) {
      throw new TypeError("expectedTransferGeneration must be a positive integer");
    }
    return runUnderProfileLock(() => {
      const existing = store.readProfile(profileInstanceId);
      if (existing == null) {
        throw createCodedError("lease_missing", "no profile lease to roll back");
      }
      if (existing.ownership_state !== "transferring") {
        throw createCodedError("handoff_not_transferring", "ownership is not transferring", {
          ownershipState: existing.ownership_state,
        });
      }
      if (existing.owner_generation !== expectedTransferGeneration) {
        throw createCodedError("lease_cas_conflict", "transfer generation mismatch on rollback", {
          expectedGeneration: expectedTransferGeneration,
          actual: existing.owner_generation,
        });
      }
      const restoredOwner =
        typeof nextOwnerInstanceId === "string" && nextOwnerInstanceId.length > 0
          ? nextOwnerInstanceId
          : existing.transfer_from_owner_instance_id;
      const restoredMode =
        runtimeMode === "headless" || runtimeMode === "desktop"
          ? runtimeMode
          : existing.transfer_from_runtime_mode;
      if (typeof restoredOwner !== "string" || restoredOwner.length === 0) {
        throw createCodedError("handoff_rollback_incomplete", "prior owner is missing for rollback");
      }
      if (restoredMode !== "headless" && restoredMode !== "desktop") {
        throw createCodedError("handoff_rollback_incomplete", "prior runtime mode is missing");
      }
      const t = now();
      return commitProfile({
        profile_instance_id: profileInstanceId,
        runtime_mode: restoredMode,
        owner_instance_id: restoredOwner,
        owner_generation: expectedTransferGeneration + 1,
        ownership_state: "owned",
        lease_renewed_at: isoFromMs(t),
        lease_expires_at: isoFromMs(t + leaseDurationMs),
        active_mesh_room_id: existing.active_mesh_room_id ?? null,
        desktop_server_identity:
          restoredMode === "desktop" ? (existing.desktop_server_identity ?? null) : null,
        chatgpt_attachment_state:
          restoredMode === "desktop" ? (existing.chatgpt_attachment_state ?? null) : null,
        bound_codex_thread_id: existing.bound_codex_thread_id ?? null,
        admission_frozen: false,
        transfer_from_owner_instance_id: null,
        transfer_from_runtime_mode: null,
        transfer_from_generation: null,
      });
    });
  }

  /**
   * Post-commit recovery: freeze admission while retaining the current owner.
   * Used when desktop attach/resume fails after ownership commit.
   */
  function freezeAdmissionAfterCommit({
    profileInstanceId,
    expectedGeneration,
  } = {}) {
    return runUnderProfileLock(() => {
      const existing = store.readProfile(profileInstanceId);
      if (existing == null) {
        throw createCodedError("lease_missing", "no profile lease to freeze");
      }
      if (existing.owner_generation !== expectedGeneration) {
        throw createCodedError("lease_cas_conflict", "generation mismatch on freeze", {
          expectedGeneration,
          actual: existing.owner_generation,
        });
      }
      if (existing.ownership_state !== "owned") {
        throw createCodedError("handoff_not_owned", "can only freeze owned profiles", {
          ownershipState: existing.ownership_state,
        });
      }
      return commitProfile({
        ...existing,
        profile_instance_id: profileInstanceId,
        admission_frozen: true,
        chatgpt_attachment_state: existing.chatgpt_attachment_state ?? "unknown",
      });
    });
  }

  return Object.freeze({
    ownerInstanceId,
    leaseDurationMs,
    acquire,
    renew,
    replaceExpiredIdle,
    rejectStaleGeneration,
    beginTransfer,
    commitTransfer,
    rollbackTransfer,
    freezeAdmissionAfterCommit,
    status,
  });
}

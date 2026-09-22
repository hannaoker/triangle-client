/**
 * Phase 4 — optional idle-only desktop handoff.
 *
 * Explicit operator/API ownership transfer between headless and desktop owners.
 * Generation-scoped execution lease is the authority (CAS + transferring state).
 * Fail closed while non-idle, mid-approval, or when the feature gate is off.
 *
 * Does **not** replace Shared App Server / appServerWake as the production path.
 * Global featureFlags.desktopHandoff and
 * sharedHomeConcurrency.desktopHandoffEnabled stay false until an operator
 * explicitly enables a shadow experiment (see REPIN.md).
 */

import { createCodexAppServerProcess, createFakeAppServerStdioProgram } from "./app-server-process.mjs";
import { resolveDesktopHandoffGate } from "./config-guards.mjs";
import { loadRuntimeManifest } from "./runtime-manifest.mjs";
import { NON_IDLE_EXECUTION_STATES } from "./execution-state.mjs";

function createCodedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/**
 * Shadow / production-headless opt-in for Phase 4 handoff experiments.
 *
 * Production defaults remain off. Activation requires:
 * 1. Shared-home probe passed, AND
 * 2. Either:
 *    - `enableHandoff: true` (unit/integration injection), OR
 *    - `TRIANGLE_DESKTOP_HANDOFF_ENABLE=1` on a shadow or production
 *      headless App Server profile, OR
 *    - both `featureFlags.desktopHandoff` and
 *      `sharedHomeConcurrency.desktopHandoffEnabled` true.
 *
 * Manifest defaults keep both handoff flags **false**. mcp-interactive
 * desktop and grok-bot are ineligible. Dual-claimer stays fail-closed via
 * the idle-only CAS transfer in this module.
 */
export function resolvePhase4DesktopHandoffConfig(
  profileConfig = {},
  {
    manifest = loadRuntimeManifest(),
    env = process.env,
    enableHandoff = false,
  } = {},
) {
  return resolveDesktopHandoffGate(profileConfig, { manifest, env, enableHandoff });
}

/**
 * Synthetic desktop owner for CI — holds the same dedicated CODEX_HOME thread
 * id the Shared App Server binding would use. No live ChatGPT.app required.
 *
 * @param {object} options
 * @param {string} options.ownerInstanceId
 * @param {string} [options.serverIdentity]
 * @param {string} options.codexHome Dedicated Triangle CODEX_HOME (never ~/.codex)
 * @param {object} [options.fakeProgram] Fake stdio App Server program
 * @param {boolean} [options.chatgptAttached]
 */
export function createFakeDesktopOwner({
  ownerInstanceId,
  serverIdentity = "fake-desktop-shared-app-server",
  codexHome,
  fakeProgram = null,
  chatgptAttached = true,
  now = () => Date.now(),
} = {}) {
  if (typeof ownerInstanceId !== "string" || ownerInstanceId.length === 0) {
    throw new TypeError("ownerInstanceId is required");
  }
  if (typeof codexHome !== "string" || !codexHome.startsWith("/")) {
    throw new TypeError("codexHome must be an absolute dedicated Triangle home");
  }
  if (codexHome.includes("/.codex") && !codexHome.includes("codex-runtime")) {
    throw createCodedError(
      "handoff_user_codex_home_forbidden",
      "desktop handoff must not use ~/.codex",
    );
  }

  const program =
    fakeProgram ??
    createFakeAppServerStdioProgram({
      serverIdentity,
      // Synthetic desktop may resume a known thread id without a live rollout
      // file; production Shared App Server still requires a materialized thread.
      requireMaterializedRollout: false,
    });

  let processHandle = null;
  let admissionOpen = false;
  let idle = true;
  let pendingApproval = false;
  let attached = chatgptAttached === true;
  let lastVerifiedThreadId = null;
  let healthOk = true;
  let failNextAttach = false;
  let failNextResumeAdmission = false;

  async function ensureProcess() {
    if (processHandle != null) return processHandle;
    processHandle = createCodexAppServerProcess({
      command: program.command,
      args: program.args,
      codexHome,
      env: { ...process.env, HOME: codexHome, CODEX_HOME: codexHome },
    });
    await processHandle.start();
    await processHandle.initialize({ name: "triangle-desktop-fake", version: "0.0.0" });
    return processHandle;
  }

  return Object.freeze({
    ownerInstanceId,
    serverIdentity,
    pauseAdmission() {
      admissionOpen = false;
    },
    resumeAdmission() {
      if (failNextResumeAdmission) {
        failNextResumeAdmission = false;
        throw createCodedError(
          "handoff_desktop_resume_admission_failed",
          "desktop admission reopen failed after commit",
        );
      }
      admissionOpen = true;
    },
    isAdmissionOpen() {
      return admissionOpen;
    },
    isIdle() {
      return idle === true && pendingApproval !== true;
    },
    hasPendingApproval() {
      return pendingApproval === true;
    },
    setIdle(value) {
      idle = value === true;
    },
    setPendingApproval(value) {
      pendingApproval = value === true;
    },
    setChatgptAttached(value) {
      attached = value === true;
    },
    setHealthy(value) {
      healthOk = value === true;
    },
    failNextAttachOnce() {
      failNextAttach = true;
    },
    failNextResumeAdmissionOnce() {
      failNextResumeAdmission = true;
    },
    async health() {
      return Object.freeze({
        appServerHealthy: healthOk,
        chatgptAttached: attached,
        serverIdentity,
        at: new Date(now()).toISOString(),
      });
    },
    async attachAndVerify({ threadId } = {}) {
      if (typeof threadId !== "string" || threadId.length === 0) {
        throw createCodedError("handoff_thread_missing", "threadId is required for desktop attach");
      }
      if (failNextAttach) {
        failNextAttach = false;
        throw createCodedError("handoff_desktop_attach_failed", "desktop attach failed (synthetic)");
      }
      if (!healthOk) {
        throw createCodedError("handoff_desktop_unhealthy", "desktop App Server is unhealthy");
      }
      const handle = await ensureProcess();
      const resumed = await handle.threadResume({ threadId });
      const resumedId = resumed?.thread?.id;
      if (resumedId !== threadId) {
        throw createCodedError("handoff_thread_mismatch", "desktop thread/resume identity mismatch", {
          expected: threadId,
          actual: resumedId ?? null,
        });
      }
      const read = await handle.threadRead({ threadId, includeTurns: true });
      if (read?.thread?.id !== threadId) {
        throw createCodedError("handoff_thread_read_mismatch", "desktop thread/read identity mismatch", {
          expected: threadId,
          actual: read?.thread?.id ?? null,
        });
      }
      lastVerifiedThreadId = threadId;
      attached = true;
      return Object.freeze({
        threadId,
        serverIdentity,
        chatgptAttached: attached,
      });
    },
    /**
     * Operator `handoff recover-desktop`: App Server healthy but ChatGPT.app
     * absent — relaunch/verify the same binding without flipping ownership.
     */
    async recoverAttachment({ threadId } = {}) {
      const health = await this.health();
      if (!health.appServerHealthy) {
        throw createCodedError(
          "handoff_desktop_unhealthy",
          "cannot recover-desktop while App Server is unhealthy",
        );
      }
      const target = threadId ?? lastVerifiedThreadId;
      if (typeof target !== "string" || target.length === 0) {
        throw createCodedError("handoff_thread_missing", "bound threadId required for recover-desktop");
      }
      // Simulate relaunch of ChatGPT attachment against the same server/thread.
      attached = true;
      return this.attachAndVerify({ threadId: target });
    },
    status() {
      return Object.freeze({
        ownerInstanceId,
        serverIdentity,
        admissionOpen,
        idle,
        pendingApproval,
        chatgptAttached: attached,
        lastVerifiedThreadId,
        healthOk,
      });
    },
    async close() {
      if (processHandle != null) {
        await processHandle.close({ signal: "SIGKILL", timeoutMs: 1_000 });
        processHandle = null;
      }
    },
  });
}

/**
 * @param {object} options
 * @param {ReturnType<import('./durable-conversation-store.mjs').createDurableConversationStore>} options.store
 * @param {ReturnType<import('./execution-lease.mjs').createExecutionLeaseManager>} options.leaseManager
 * @param {{ list?: Function, get?: Function } | null} [options.registry]
 * @param {string} options.profileInstanceId
 * @param {string} options.headlessOwnerInstanceId
 * @param {ReturnType<typeof createFakeDesktopOwner>} options.desktopOwner
 * @param {boolean} [options.enabled]
 * @param {() => number} [options.now]
 * @param {string} [options.transferActorId]
 */
export function createDesktopHandoffController({
  store,
  leaseManager,
  registry = null,
  profileInstanceId,
  headlessOwnerInstanceId,
  desktopOwner,
  enabled = false,
  now = () => Date.now(),
  transferActorId = null,
} = {}) {
  if (store == null || typeof store.readProfile !== "function") {
    throw new TypeError("store is required");
  }
  if (leaseManager == null || typeof leaseManager.beginTransfer !== "function") {
    throw new TypeError("leaseManager with transfer primitives is required");
  }
  if (typeof leaseManager.clearAdmissionFreezeForRecover !== "function") {
    throw new TypeError("leaseManager.clearAdmissionFreezeForRecover is required");
  }
  if (typeof profileInstanceId !== "string" || profileInstanceId.length === 0) {
    throw new TypeError("profileInstanceId is required");
  }
  if (typeof headlessOwnerInstanceId !== "string" || headlessOwnerInstanceId.length === 0) {
    throw new TypeError("headlessOwnerInstanceId is required");
  }
  if (desktopOwner == null || typeof desktopOwner.attachAndVerify !== "function") {
    throw new TypeError("desktopOwner is required");
  }

  const transferOwner =
    typeof transferActorId === "string" && transferActorId.length > 0
      ? transferActorId
      : `transfer:${profileInstanceId.slice(0, 12)}`;

  let admissionPaused = false;
  const startedAt = now();

  function assertEnabled() {
    if (enabled !== true) {
      throw createCodedError(
        "handoff_disabled",
        "desktop handoff is feature-gated off; explicit shadow opt-in required",
      );
    }
  }

  function listConversations() {
    return store.listConversations(profileInstanceId);
  }

  function assertConversationsIdle({ allowFrozen = false } = {}) {
    const rows = listConversations();
    const nonIdle = rows.filter((row) => NON_IDLE_EXECUTION_STATES.includes(row.execution_state));
    if (nonIdle.length > 0) {
      throw createCodedError("handoff_not_idle", "handoff rejected while conversation non-idle", {
        states: nonIdle.map((row) => row.execution_state),
      });
    }
    const open = rows.filter((row) => row.active_delivery_id != null);
    if (open.length > 0) {
      throw createCodedError("handoff_open_delivery", "handoff rejected while delivery is open", {
        openDeliveryCount: open.length,
      });
    }
    const profile = store.readProfile(profileInstanceId);
    if (profile?.admission_frozen === true && !allowFrozen) {
      throw createCodedError(
        "handoff_admission_frozen",
        "admission frozen; use recover-desktop or rollback-headless",
      );
    }
  }

  function assertDesktopQuiesced() {
    if (typeof desktopOwner.hasPendingApproval === "function" && desktopOwner.hasPendingApproval()) {
      throw createCodedError(
        "handoff_approval_pending",
        "handoff rejected while desktop approval is outstanding",
      );
    }
    if (typeof desktopOwner.isIdle === "function" && !desktopOwner.isIdle()) {
      throw createCodedError("handoff_not_idle", "handoff rejected while desktop turn is active");
    }
  }

  function resolveBoundThreadId({ threadId = null, meshRoomId = null } = {}) {
    if (typeof threadId === "string" && threadId.length > 0) return threadId;
    const profile = store.readProfile(profileInstanceId);
    if (typeof profile?.bound_codex_thread_id === "string" && profile.bound_codex_thread_id.length > 0) {
      return profile.bound_codex_thread_id;
    }
    if (typeof meshRoomId === "string" && meshRoomId.length > 0) {
      const row = store.readConversation(profileInstanceId, meshRoomId);
      if (typeof row?.codex_thread_id === "string" && row.codex_thread_id.length > 0) {
        return row.codex_thread_id;
      }
    }
    const rows = listConversations().filter(
      (row) => typeof row.codex_thread_id === "string" && row.codex_thread_id.length > 0,
    );
    if (rows.length === 1) return rows[0].codex_thread_id;
    throw createCodedError(
      "handoff_thread_missing",
      "expected bound Codex thread id for handoff verify",
    );
  }

  function doctor() {
    const lease = leaseManager.status({ profileInstanceId });
    const rows = listConversations();
    const desktop = typeof desktopOwner.status === "function" ? desktopOwner.status() : null;
    return Object.freeze({
      profileInstanceId,
      owner: lease.ownerInstanceId ?? null,
      generation: lease.ownerGeneration ?? null,
      ownershipState: lease.ownershipState ?? null,
      runtimeMode: lease.runtimeMode ?? null,
      leaseAgeMs: lease.leaseAgeMs ?? null,
      executionStates: rows.map((row) => row.execution_state),
      nonIdleCount: lease.nonIdleCount ?? 0,
      boundThreadId: lease.boundCodexThreadId ?? null,
      desktopServerIdentity: lease.desktopServerIdentity ?? null,
      chatgptAttachmentState: lease.chatgptAttachmentState ?? null,
      admissionFrozen: lease.admissionFrozen === true,
      admissionPaused,
      desktop,
      // Identifiers only — never message text.
    });
  }

  /**
   * Explicit headless → desktop idle handoff.
   * Failure before commit rolls ownership back to headless.
   * Failure after commit retains desktop ownership and freezes admission.
   */
  async function handoffToDesktop({ threadId = null, meshRoomId = null } = {}) {
    assertEnabled();
    const handoffStarted = now();

    // Preflight before pausing admission so rejected handoffs leave prior state.
    assertConversationsIdle();
    assertDesktopQuiesced();

    const boundThreadId = resolveBoundThreadId({ threadId, meshRoomId });
    const existing = store.readProfile(profileInstanceId);
    if (existing == null) {
      throw createCodedError("lease_missing", "profile lease required before handoff");
    }
    if (existing.runtime_mode !== "headless") {
      throw createCodedError("handoff_wrong_mode", "handoffToDesktop requires headless owner", {
        runtimeMode: existing.runtime_mode,
      });
    }
    if (existing.ownership_state !== "owned") {
      throw createCodedError("handoff_not_owned", "profile must be owned before handoff", {
        ownershipState: existing.ownership_state,
      });
    }
    if (existing.owner_instance_id !== headlessOwnerInstanceId) {
      throw createCodedError("lease_conflict", "headless owner does not hold the lease", {
        ownerInstanceId: existing.owner_instance_id,
      });
    }

    const priorDesktopAdmission =
      typeof desktopOwner.isAdmissionOpen === "function" ? desktopOwner.isAdmissionOpen() : false;
    admissionPaused = true;
    desktopOwner.pauseAdmission();

    let transfer = null;
    let committed = null;
    try {
      transfer = leaseManager.beginTransfer({
        profileInstanceId,
        expectedGeneration: existing.owner_generation,
        transferOwnerInstanceId: transferOwner,
        targetRuntimeMode: "desktop",
      });

      // Steps 5–6: select desktop App Server and verify resume/read.
      const verified = await desktopOwner.attachAndVerify({ threadId: boundThreadId });

      // Step 7: commit runtime_mode=desktop with desktop server identity.
      committed = leaseManager.commitTransfer({
        profileInstanceId,
        expectedTransferGeneration: transfer.owner_generation,
        ownerInstanceId: desktopOwner.ownerInstanceId,
        runtimeMode: "desktop",
        desktopServerIdentity: desktopOwner.serverIdentity,
        chatgptAttachmentState: verified.chatgptAttached ? "attached" : "absent",
        boundCodexThreadId: boundThreadId,
        admissionFrozen: false,
      });

      try {
        // Step 8: reopen admission through the desktop adapter.
        desktopOwner.resumeAdmission();
      } catch (error) {
        leaseManager.freezeAdmissionAfterCommit({
          profileInstanceId,
          expectedGeneration: committed.owner_generation,
        });
        admissionPaused = true;
        throw error;
      }

      admissionPaused = false;
      return Object.freeze({
        ok: true,
        direction: "headless_to_desktop",
        runtimeMode: "desktop",
        ownerInstanceId: desktopOwner.ownerInstanceId,
        ownerGeneration: committed.owner_generation,
        boundThreadId,
        desktopServerIdentity: desktopOwner.serverIdentity,
        durationMs: now() - handoffStarted,
      });
    } catch (error) {
      if (committed == null && transfer != null) {
        // Failure before commit → roll ownership back to headless.
        leaseManager.rollbackTransfer({
          profileInstanceId,
          expectedTransferGeneration: transfer.owner_generation,
          ownerInstanceId: headlessOwnerInstanceId,
          runtimeMode: "headless",
        });
        admissionPaused = false;
        if (priorDesktopAdmission) desktopOwner.resumeAdmission();
      } else if (transfer == null) {
        // beginTransfer failed after pause; restore prior admission.
        admissionPaused = false;
        if (priorDesktopAdmission) desktopOwner.resumeAdmission();
      }
      throw error;
    }
  }

  /**
   * Explicit desktop → headless idle handoff (same idle + CAS gates).
   */
  async function handoffToHeadless({
    threadId = null,
    meshRoomId = null,
    verifyResume = null,
  } = {}) {
    assertEnabled();
    const handoffStarted = now();

    // Preflight before pausing admission so rejected handoffs leave prior state.
    assertConversationsIdle();
    assertDesktopQuiesced();

    const boundThreadId = resolveBoundThreadId({ threadId, meshRoomId });
    const existing = store.readProfile(profileInstanceId);
    if (existing == null) {
      throw createCodedError("lease_missing", "profile lease required before handoff");
    }
    if (existing.runtime_mode !== "desktop") {
      throw createCodedError("handoff_wrong_mode", "handoffToHeadless requires desktop owner", {
        runtimeMode: existing.runtime_mode,
      });
    }
    if (existing.ownership_state !== "owned") {
      throw createCodedError("handoff_not_owned", "profile must be owned before handoff", {
        ownershipState: existing.ownership_state,
      });
    }
    if (existing.owner_instance_id !== desktopOwner.ownerInstanceId) {
      throw createCodedError("lease_conflict", "desktop owner does not hold the lease", {
        ownerInstanceId: existing.owner_instance_id,
      });
    }

    const priorDesktopAdmission =
      typeof desktopOwner.isAdmissionOpen === "function" ? desktopOwner.isAdmissionOpen() : false;
    admissionPaused = true;
    desktopOwner.pauseAdmission();

    let transfer = null;
    let committed = null;
    try {
      transfer = leaseManager.beginTransfer({
        profileInstanceId,
        expectedGeneration: existing.owner_generation,
        transferOwnerInstanceId: transferOwner,
        targetRuntimeMode: "headless",
      });

      if (typeof verifyResume === "function") {
        const resumed = await verifyResume({ threadId: boundThreadId });
        const resumedId = resumed?.threadId ?? resumed?.thread?.id ?? null;
        if (resumedId !== boundThreadId) {
          throw createCodedError(
            "handoff_thread_mismatch",
            "headless thread/resume identity mismatch",
            { expected: boundThreadId, actual: resumedId },
          );
        }
      }

      committed = leaseManager.commitTransfer({
        profileInstanceId,
        expectedTransferGeneration: transfer.owner_generation,
        ownerInstanceId: headlessOwnerInstanceId,
        runtimeMode: "headless",
        desktopServerIdentity: null,
        chatgptAttachmentState: null,
        boundCodexThreadId: boundThreadId,
        admissionFrozen: false,
      });

      admissionPaused = false;
      return Object.freeze({
        ok: true,
        direction: "desktop_to_headless",
        runtimeMode: "headless",
        ownerInstanceId: headlessOwnerInstanceId,
        ownerGeneration: committed.owner_generation,
        boundThreadId,
        durationMs: now() - handoffStarted,
      });
    } catch (error) {
      if (committed == null && transfer != null) {
        leaseManager.rollbackTransfer({
          profileInstanceId,
          expectedTransferGeneration: transfer.owner_generation,
          ownerInstanceId: desktopOwner.ownerInstanceId,
          runtimeMode: "desktop",
        });
        // Desktop retains ownership after mid-transfer rollback; restore prior
        // admission so the profile is not wedged indefinitely.
        admissionPaused = false;
        if (priorDesktopAdmission) desktopOwner.resumeAdmission();
      } else if (transfer == null) {
        admissionPaused = false;
        if (priorDesktopAdmission) desktopOwner.resumeAdmission();
      }
      throw error;
    }
  }

  /**
   * Operator: `handoff recover-desktop` — App Server healthy, ChatGPT.app absent.
   * Requires owned desktop (not transferring). Clears freeze via locked CAS.
   */
  async function recoverDesktop({ threadId = null, meshRoomId = null } = {}) {
    assertEnabled();
    const existing = store.readProfile(profileInstanceId);
    if (existing == null) {
      throw createCodedError("lease_missing", "no profile lease");
    }
    if (existing.ownership_state === "transferring") {
      throw createCodedError(
        "lease_transferring",
        "cannot recover-desktop while ownership is transferring",
        { ownershipState: existing.ownership_state },
      );
    }
    if (existing.ownership_state !== "owned") {
      throw createCodedError("handoff_not_owned", "recover-desktop requires owned profile", {
        ownershipState: existing.ownership_state,
      });
    }
    if (existing.runtime_mode !== "desktop") {
      throw createCodedError("handoff_wrong_mode", "recover-desktop requires desktop ownership", {
        runtimeMode: existing.runtime_mode,
      });
    }
    if (existing.owner_instance_id !== desktopOwner.ownerInstanceId) {
      throw createCodedError("lease_conflict", "desktop owner does not hold the lease", {
        ownerInstanceId: existing.owner_instance_id,
      });
    }
    assertConversationsIdle({ allowFrozen: true });
    assertDesktopQuiesced();

    const boundThreadId = resolveBoundThreadId({ threadId, meshRoomId });
    const health = await desktopOwner.health();
    if (!health.appServerHealthy) {
      throw createCodedError(
        "handoff_desktop_unhealthy",
        "App Server unhealthy; restore desktop or run rollback-headless",
      );
    }

    const verified = await desktopOwner.recoverAttachment({ threadId: boundThreadId });

    // Clear freeze under locked CAS; retain the same owned desktop generation.
    const renewed = leaseManager.clearAdmissionFreezeForRecover({
      profileInstanceId,
      expectedGeneration: existing.owner_generation,
      expectedOwnerInstanceId: desktopOwner.ownerInstanceId,
      desktopServerIdentity: desktopOwner.serverIdentity,
      chatgptAttachmentState: "attached",
      boundCodexThreadId: boundThreadId,
    });
    desktopOwner.resumeAdmission();
    admissionPaused = false;

    return Object.freeze({
      ok: true,
      action: "recover-desktop",
      ownerInstanceId: renewed.owner_instance_id,
      ownerGeneration: renewed.owner_generation,
      boundThreadId: verified.threadId,
      chatgptAttachmentState: "attached",
    });
  }

  /**
   * Operator: `handoff rollback-headless` — only after proving idle and
   * resuming the exact thread on a headless slot.
   */
  async function rollbackHeadless({
    threadId = null,
    meshRoomId = null,
    verifyResume = null,
  } = {}) {
    assertEnabled();
    const existing = store.readProfile(profileInstanceId);
    if (existing == null) {
      throw createCodedError("lease_missing", "no profile lease");
    }
    if (existing.runtime_mode !== "desktop" && existing.ownership_state !== "transferring") {
      throw createCodedError(
        "handoff_wrong_mode",
        "rollback-headless requires desktop ownership or orphaned transfer",
        { runtimeMode: existing.runtime_mode, ownershipState: existing.ownership_state },
      );
    }

    assertConversationsIdle({ allowFrozen: true });
    assertDesktopQuiesced();
    desktopOwner.pauseAdmission();

    const boundThreadId = resolveBoundThreadId({ threadId, meshRoomId });
    if (typeof verifyResume !== "function") {
      throw createCodedError(
        "handoff_verify_required",
        "rollback-headless requires headless verifyResume proving the exact thread",
      );
    }
    const resumed = await verifyResume({ threadId: boundThreadId });
    const resumedId = resumed?.threadId ?? resumed?.thread?.id ?? null;
    if (resumedId !== boundThreadId) {
      throw createCodedError("handoff_thread_mismatch", "headless resume did not match bound thread", {
        expected: boundThreadId,
        actual: resumedId,
      });
    }

    if (existing.ownership_state === "transferring") {
      const rolled = leaseManager.rollbackTransfer({
        profileInstanceId,
        expectedTransferGeneration: existing.owner_generation,
        ownerInstanceId: headlessOwnerInstanceId,
        runtimeMode: "headless",
      });
      admissionPaused = false;
      return Object.freeze({
        ok: true,
        action: "rollback-headless",
        ownerInstanceId: rolled.owner_instance_id,
        ownerGeneration: rolled.owner_generation,
        boundThreadId,
        from: "transferring",
      });
    }

    // Clear freeze so beginTransfer idle gates can proceed (operator recovery).
    if (existing.admission_frozen === true) {
      store.writeProfile({
        ...existing,
        admission_frozen: false,
      });
    }

    const latest = store.readProfile(profileInstanceId);
    const transfer = leaseManager.beginTransfer({
      profileInstanceId,
      expectedGeneration: latest.owner_generation,
      transferOwnerInstanceId: transferOwner,
      targetRuntimeMode: "headless",
    });
    const committed = leaseManager.commitTransfer({
      profileInstanceId,
      expectedTransferGeneration: transfer.owner_generation,
      ownerInstanceId: headlessOwnerInstanceId,
      runtimeMode: "headless",
      desktopServerIdentity: null,
      chatgptAttachmentState: null,
      boundCodexThreadId: boundThreadId,
      admissionFrozen: false,
    });

    admissionPaused = false;
    return Object.freeze({
      ok: true,
      action: "rollback-headless",
      ownerInstanceId: committed.owner_instance_id,
      ownerGeneration: committed.owner_generation,
      boundThreadId,
      from: "desktop",
    });
  }

  return Object.freeze({
    profileInstanceId,
    enabled,
    doctor,
    handoffToDesktop,
    handoffToHeadless,
    recoverDesktop,
    rollbackHeadless,
    isAdmissionPaused: () => admissionPaused,
    status: doctor,
    startedAt,
    // Keep registry reference for future sticky-slot wiring (Phase 4 uses lease).
    registry,
  });
}

/**
 * HeadlessCursorAcpRuntime — shadow Cursor ACP lane (Codex-like settlement).
 *
 * Helper owns claim/reply/ack. Node never holds mesh_ / mesh_watch_.
 * Reasoner is long-lived `agent acp` (stdio JSON-RPC), Triangle-supervised.
 * Continuity: MESH roomId → ACP sessionId via session/load after process kill.
 * Mode is workload policy (ask conversational-only; agent for authorized tools).
 * Unattended policy answers request_permission + blocking cursor/*.
 *
 * Never joins the Codex App Server pool. Never hosts grok-bot.
 */

import { replyBeforeAckStages } from "../codex-runtime/execution-state.mjs";
import { createCursorAcpProcess } from "./acp-process.mjs";
import {
  createDefaultCursorAcpShadowProfile,
  resolveCursorAcpRuntimeConfig,
} from "./config-guards.mjs";
import { resolveWorkloadMode } from "./acp-protocol.mjs";
import { createMemoryCursorSessionRegistry } from "./session-registry.mjs";
import { createUnattendedAcpPolicy } from "./unattended-policy.mjs";
import { createCursorAcpWorkerPool } from "./worker-pool.mjs";

function createCodedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function inactiveRuntime({ resolved, registry, reason }) {
  return Object.freeze({
    active: false,
    reason: reason ?? resolved.inactiveReason,
    config: resolved,
    async start() {
      throw createCodedError(
        "cursor_acp_runtime_inactive",
        "Cursor ACP runtime is inactive for this profile",
        { reason: reason ?? resolved.inactiveReason },
      );
    },
    async stop() {
      return { active: false };
    },
    async runDelivery() {
      throw createCodedError(
        "cursor_acp_runtime_inactive",
        "Cursor ACP runtime is inactive for this profile",
        { reason: reason ?? resolved.inactiveReason },
      );
    },
    async runReceiptOnly() {
      throw createCodedError("cursor_acp_runtime_inactive", "Cursor ACP runtime inactive");
    },
    async restartSlot() {
      throw createCodedError("cursor_acp_runtime_inactive", "Cursor ACP runtime inactive");
    },
    async recoverAfterRestart() {
      return Object.freeze({ quarantined: 0, reconciledAck: 0 });
    },
    status() {
      return Object.freeze({
        active: false,
        reason: reason ?? resolved.inactiveReason,
        config: resolved,
      });
    },
    registry,
    pool: null,
  });
}

/**
 * @param {object} options
 * @param {object} options.profileConfig
 * @param {{ reply: Function, ack: Function }} [options.transactionProxy]
 * @param {string} [options.cursorHome]
 * @param {string} [options.command]
 * @param {string[]} [options.args]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {boolean} [options.enableShadow]
 */
export function createHeadlessCursorAcpRuntime({
  profileConfig = {},
  transactionProxy = null,
  cursorHome,
  command = "agent",
  args = ["acp"],
  env = process.env,
  enableShadow = false,
  createProcess = createCursorAcpProcess,
  registry = null,
  pool = null,
  unattendedPolicy = null,
  promptTimeoutMs = 120_000,
  poolAcquireWaitMs = 0,
  logger = console,
  now = () => Date.now(),
} = {}) {
  const resolved = resolveCursorAcpRuntimeConfig(profileConfig, {
    enableShadow,
    env,
    preferredPoolSize: 1,
  });
  const resolvedRegistry = registry ?? createMemoryCursorSessionRegistry({ now });

  if (!resolved.active) {
    return inactiveRuntime({ resolved, registry: resolvedRegistry });
  }

  if (transactionProxy != null) {
    if (typeof transactionProxy.reply !== "function" || typeof transactionProxy.ack !== "function") {
      throw new TypeError("transactionProxy.reply and transactionProxy.ack are required");
    }
  }

  const policy =
    unattendedPolicy ??
    createUnattendedAcpPolicy({
      permissionDefault: profileConfig.permissionDefault ?? "allow-once",
    });

  const workerPool =
    pool ??
    createCursorAcpWorkerPool({
      cursorHome,
      command,
      args,
      env,
      preferredSize: 1,
      maxSize: 1,
      createProcess,
      unattendedPolicy: policy,
    });

  let started = false;
  /** @type {string[]} */
  const lastSettlementTrace = [];

  async function start() {
    const poolStatus = await workerPool.start();
    started = true;
    logger.info?.({
      msg: "cursor_acp_runtime_started",
      pool: poolStatus.size,
      runtimeAdapter: resolved.runtimeAdapter,
    });
    return Object.freeze({
      active: true,
      pool: poolStatus,
      config: resolved,
    });
  }

  async function stop() {
    started = false;
    await workerPool.stop();
    return Object.freeze({ active: false });
  }

  async function ensureSession({ processHandle, roomId, profileInstanceId, cwd }) {
    const existing = resolvedRegistry.get(profileInstanceId, roomId);
    if (existing?.cursorSessionId) {
      try {
        await processHandle.sessionLoad({
          sessionId: existing.cursorSessionId,
          cwd,
        });
        return {
          sessionId: existing.cursorSessionId,
          startedNewSession: false,
        };
      } catch (error) {
        logger.error?.({
          msg: "cursor_acp_session_load_failed",
          roomId,
          sessionId: existing.cursorSessionId,
          code: error?.code ?? null,
        });
        // Fall through to mint a new session if load fails.
      }
    }
    const created = await processHandle.sessionNew({ cwd });
    const sessionId = created?.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw createCodedError("acp_session_missing", "session/new did not return sessionId");
    }
    resolvedRegistry.upsert(profileInstanceId, roomId, {
      cursorSessionId: sessionId,
    });
    return { sessionId, startedNewSession: true };
  }

  async function applySessionConfig(processHandle, sessionId) {
    const mode = resolveWorkloadMode(resolved.workload ?? "conversational");
    const modeResult = await processHandle.setMode({ sessionId, mode });
    if (modeResult?.currentValue != null && modeResult.currentValue !== mode) {
      throw createCodedError("acp_mode_mismatch", "session mode currentValue mismatch", {
        expected: mode,
        actual: modeResult.currentValue,
      });
    }
    let modelResult = null;
    if (typeof resolved.model === "string" && resolved.model.length > 0) {
      modelResult = await processHandle.setModel({ sessionId, model: resolved.model });
      if (modelResult?.currentValue != null && modelResult.currentValue !== resolved.model) {
        throw createCodedError("acp_model_mismatch", "session model currentValue mismatch", {
          expected: resolved.model,
          actual: modelResult.currentValue,
        });
      }
    }
    return Object.freeze({ mode, modeResult, modelResult });
  }

  async function runDelivery({
    profileInstanceId,
    roomId,
    deliveryId,
    numericDeliveryId,
    text,
    inboundEventId,
    workingDirectory = null,
  }) {
    if (!started) {
      throw createCodedError("cursor_acp_not_started", "Cursor ACP runtime is not started");
    }
    if (typeof text !== "string" || text.trim().length === 0) {
      throw createCodedError("delivery_text_empty", "delivery text is required");
    }

    lastSettlementTrace.length = 0;
    const prior = resolvedRegistry.get(profileInstanceId, roomId);
    const lease = await workerPool.acquire({
      conversationKey: roomId,
      stickySlotId: prior?.lastWorkerSlotId ?? null,
      waitMs: poolAcquireWaitMs,
    });

    try {
      const ready = await lease.ready();
      const processHandle = ready.processHandle;
      const cwd =
        typeof workingDirectory === "string" && workingDirectory.startsWith("/")
          ? workingDirectory
          : typeof profileConfig.workingDirectory === "string" &&
              profileConfig.workingDirectory.startsWith("/")
            ? profileConfig.workingDirectory
            : processHandle.status().cursorHome;

      resolvedRegistry.upsert(profileInstanceId, roomId, {
        executionState: "admitted",
        activeDeliveryId: deliveryId ?? `delivery_${numericDeliveryId}`,
        lastWorkerSlotId: ready.slotId,
        executionEpoch: (prior?.executionEpoch ?? 0) + 1,
      });

      const { sessionId, startedNewSession } = await ensureSession({
        processHandle,
        roomId,
        profileInstanceId,
        cwd,
      });

      resolvedRegistry.upsert(profileInstanceId, roomId, {
        cursorSessionId: sessionId,
        executionState: "running",
        lastWorkerSlotId: ready.slotId,
      });

      const config = await applySessionConfig(processHandle, sessionId);
      const turn = await processHandle.sessionPrompt({
        sessionId,
        text,
        timeoutMs: promptTimeoutMs,
      });

      const assistantText = turn.assistantText?.trim() ?? "";
      if (assistantText.length === 0 || assistantText === "[NO_REPLY]") {
        throw createCodedError("acp_empty_assistant", "ACP prompt returned empty assistant text", {
          stopReason: turn.stopReason,
        });
      }

      lastSettlementTrace.push("result_ready");
      resolvedRegistry.upsert(profileInstanceId, roomId, {
        executionState: "result_ready",
      });

      if (transactionProxy) {
        const replied = await transactionProxy.reply({
          roomId,
          text: assistantText,
          inReplyToEventId: inboundEventId,
        });
        const replyEventId = replied?.replyEventId ?? null;
        lastSettlementTrace.push("reply_persisted");
        resolvedRegistry.upsert(profileInstanceId, roomId, {
          executionState: "reply_persisted",
          lastReplyEventId: replyEventId,
        });
        await transactionProxy.ack();
        lastSettlementTrace.push("acked");
        resolvedRegistry.upsert(profileInstanceId, roomId, {
          executionState: "acked",
          activeDeliveryId: null,
          lastCompletedDeliveryId: deliveryId ?? `delivery_${numericDeliveryId}`,
        });
        resolvedRegistry.upsert(profileInstanceId, roomId, {
          executionState: "idle",
        });
      } else {
        resolvedRegistry.upsert(profileInstanceId, roomId, {
          executionState: "idle",
          activeDeliveryId: null,
          lastCompletedDeliveryId: deliveryId ?? `delivery_${numericDeliveryId}`,
        });
      }

      return Object.freeze({
        status: "completed",
        sessionId,
        startedNewSession,
        stopReason: turn.stopReason,
        assistantText,
        slotId: ready.slotId,
        mode: config.mode,
        settlementTrace: Object.freeze([...lastSettlementTrace]),
        expectedSettlementOrder: replyBeforeAckStages(),
      });
    } catch (error) {
      try {
        resolvedRegistry.upsert(profileInstanceId, roomId, {
          executionState: "idle",
          activeDeliveryId: null,
        });
      } catch {
        // ignore registry cleanup failures
      }
      throw error;
    } finally {
      lease.release();
    }
  }

  async function runReceiptOnly({
    profileInstanceId,
    roomId,
    deliveryId,
    numericDeliveryId,
    inboundEventId,
  }) {
    if (!transactionProxy) {
      throw createCodedError("transaction_proxy_required", "receipt-only requires transactionProxy");
    }
    await transactionProxy.ack({
      receiptOnly: true,
      roomId,
      deliveryId,
      inboundEventId,
    });
    resolvedRegistry.upsert(profileInstanceId, roomId, {
      executionState: "idle",
      activeDeliveryId: null,
      lastCompletedDeliveryId: deliveryId ?? `delivery_${numericDeliveryId}`,
    });
    return Object.freeze({ status: "acked", receiptOnly: true });
  }

  async function restartSlot(slotId) {
    return workerPool.restartSlot(slotId);
  }

  async function recoverAfterRestart({ profileInstanceId: instanceId = null } = {}) {
    // Prefer the durable helper path: a reply-persisted / ack-missing transaction
    // is reconciled by createHelperDurableDeliveryResolver on the next claim-next.
    // When a proxy is present, also settle a verified replied open via status→ack
    // before the drain admits more work after restart.
    let reconciledAck = 0;
    if (
      transactionProxy != null
      && typeof transactionProxy.status === "function"
      && typeof transactionProxy.ack === "function"
    ) {
      try {
        const status = await transactionProxy.status();
        const open = status?.open;
        if (
          open
          && typeof open === "object"
          && open.state === "replied"
          && Number.isSafeInteger(open.deliveryId)
          && open.deliveryId > 0
        ) {
          await transactionProxy.ack({ resumeOnly: true });
          reconciledAck = 1;
          logger.info?.({
            msg: "cursor_acp_replied_reconciled",
            deliveryId: open.deliveryId,
            path: "ack_only",
          });
        }
      } catch (error) {
        logger.error?.({
          msg: "cursor_acp_recover_after_restart_failed",
          code: error?.code ?? null,
        });
        throw error;
      }
    }

    // Ack already committed in helper but local clear never ran: return memory
    // registry rows to idle without posting another MESH reply.
    if (instanceId != null && typeof resolvedRegistry.listForProfile === "function") {
      for (const row of resolvedRegistry.listForProfile(instanceId)) {
        const roomId = row.meshRoomId ?? row.mesh_room_id ?? row.roomId;
        if (typeof roomId !== "string") continue;
        if (row.executionState === "acked") {
          resolvedRegistry.upsert(instanceId, roomId, {
            executionState: "idle",
            activeDeliveryId: null,
          });
        }
      }
    }

    return Object.freeze({ quarantined: 0, reconciledAck });
  }

  function status() {
    return Object.freeze({
      active: true,
      started,
      config: resolved,
      pool: workerPool.status(),
      lastSettlementTrace: Object.freeze([...lastSettlementTrace]),
    });
  }

  return Object.freeze({
    active: true,
    config: resolved,
    start,
    stop,
    runDelivery,
    runReceiptOnly,
    restartSlot,
    recoverAfterRestart,
    status,
    registry: resolvedRegistry,
    pool: workerPool,
  });
}

export { createDefaultCursorAcpShadowProfile };

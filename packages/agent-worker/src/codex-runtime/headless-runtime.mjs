/**
 * HeadlessCodexRuntime — Phase 1 single-slot shadow + Phase 2 durable recovery.
 *
 * Opt-in only for isolated test profiles (`shadowTestProfile: true` +
 * `runtimeMode: "headless"` + `runtimeAdapter: "codex-app-server"`). Does not
 * replace Shared App Server desktop wake / production mcp-interactive profiles.
 *
 * Phase 1 proves:
 * - thread/start + turn for a new conversation
 * - thread/resume continuity after forced slot restart
 * - reply-before-ack settlement via the trusted transaction proxy
 *
 * Phase 2 adds (still shadow-gated):
 * - profile execution lease acquire / renew
 * - execution epoch bump + stale-epoch ignore
 * - durable registry + completion reconciliation / restart recovery
 * - receipt-only path (claim→ack, no model turn, no MESH reply)
 *
 * No MESH credentials. Dedicated TRIANGLE_CODEX_HOME only. Pool size stays 1.
 */

import { assertNoSecretMaterial } from "./app-server-protocol.mjs";
import { waitForAppServerTurnCompleted } from "./app-server-process.mjs";
import {
  buildCompletionIdempotencyKey,
  recordOrReplayCompletion,
  reconcileProfileAfterRestart,
} from "./completion-reconciler.mjs";
import {
  attachCorrelationToTurnStart,
  buildCorrelationTag,
  selectCorrelationMode,
} from "./correlation.mjs";
import {
  createDurableConversationRegistry,
  createMemoryConversationRegistry,
} from "./conversation-registry.mjs";
import {
  matchesCancellationScope,
  replyBeforeAckStages,
  shouldAcceptExecutionEpochEvent,
} from "./execution-state.mjs";
import { createExecutionLeaseManager } from "./execution-lease.mjs";
import {
  isShadowHeadlessTestProfile,
  resolvePhase1ShadowRuntimeConfig,
} from "./config-guards.mjs";
import { validateHeadlessCodexConfig } from "./runtime-manifest.mjs";
import { createCodexWorkerPool } from "./worker-pool.mjs";

function createCodedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function extractAssistantText(turn) {
  const items = [];
  const pushText = (value) => {
    if (typeof value === "string" && value.trim().length > 0) items.push(value.trim());
  };
  const considerAgentNode = (node) => {
    if (node == null || typeof node !== "object" || Array.isArray(node)) return;
    const type = node.type;
    const looksAgent =
      type === "agentMessage" ||
      type === "assistant_message" ||
      type === "assistantMessage" ||
      node.role === "assistant";
    if (!looksAgent) return;
    if (typeof node.text === "string") pushText(node.text);
    if (typeof node.content === "string") pushText(node.content);
    if (Array.isArray(node.content)) {
      for (const part of node.content) {
        if (typeof part === "string") pushText(part);
        else if (part?.type === "text" && typeof part.text === "string") pushText(part.text);
      }
    }
  };
  const walk = (node) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (typeof node !== "object") return;
    considerAgentNode(node);
    if (Array.isArray(node.items)) walk(node.items);
    if (Array.isArray(node.output)) walk(node.output);
    if (Array.isArray(node.messages)) walk(node.messages);
    if (node.assistantMessage) considerAgentNode({ ...node.assistantMessage, type: "assistantMessage" });
    if (node.assistant_message) considerAgentNode({ ...node.assistant_message, type: "assistantMessage" });
  };
  walk(turn);
  return [...new Set(items)].join("\n").trim();
}

function inactiveRuntime({ resolved, registry, reason }) {
  return Object.freeze({
    active: false,
    reason: reason ?? resolved.inactiveReason,
    config: resolved,
    async start() {
      throw createCodedError(
        "shadow_runtime_inactive",
        "Phase 1 shadow headless runtime is inactive for this profile",
        { reason: reason ?? resolved.inactiveReason },
      );
    },
    async stop() {
      return { active: false };
    },
    async runDelivery() {
      throw createCodedError(
        "shadow_runtime_inactive",
        "Phase 1 shadow headless runtime is inactive for this profile",
        { reason: reason ?? resolved.inactiveReason },
      );
    },
    async runReceiptOnly() {
      throw createCodedError("shadow_runtime_inactive", "shadow runtime inactive");
    },
    async recoverAfterRestart() {
      throw createCodedError("shadow_runtime_inactive", "shadow runtime inactive");
    },
    async cancelDelivery() {
      throw createCodedError("shadow_runtime_inactive", "shadow runtime inactive");
    },
    async restartSlot() {
      throw createCodedError("shadow_runtime_inactive", "shadow runtime inactive");
    },
    acceptEpochEvent() {
      return false;
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
    leaseManager: null,
  });
}

/**
 * Create the Phase 1/2 shadow headless runtime.
 *
 * @param {object} options
 * @param {object} options.profileConfig
 * @param {{ reply: Function, ack: Function }} [options.transactionProxy]
 * @param {string} [options.codexHome]
 * @param {string} [options.command]
 * @param {string[]} [options.args]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {boolean} [options.enableShadow] Force-enable for unit tests
 * @param {ReturnType<typeof createMemoryConversationRegistry>} [options.registry]
 * @param {ReturnType<typeof createCodexWorkerPool>} [options.pool]
 * @param {object} [options.durableStore] Enabled Phase 2 file store
 * @param {ReturnType<typeof createExecutionLeaseManager>} [options.leaseManager]
 * @param {string} [options.ownerInstanceId]
 * @param {string} [options.profileInstanceId] Used when hydrating durable registry
 */
export function createHeadlessCodexRuntime({
  profileConfig = {},
  transactionProxy = null,
  codexHome,
  command = "codex",
  args = ["app-server"],
  env = process.env,
  enableShadow = false,
  registry = null,
  pool = null,
  durableStore = null,
  leaseManager = null,
  ownerInstanceId = `owner-${process.pid}`,
  profileInstanceId = null,
  correlationMode = selectCorrelationMode({ metadataFieldSurvivesThreadRead: true }),
  turnTimeoutMs = 30_000,
  logger = console,
  now = () => Date.now(),
} = {}) {
  const resolved = resolvePhase1ShadowRuntimeConfig(profileConfig, {
    enableShadow,
    env,
  });

  const resolvedRegistry =
    registry ??
    (durableStore?.enabled === true
      ? createDurableConversationRegistry({
          store: durableStore,
          now,
          profileInstanceId,
        })
      : createMemoryConversationRegistry({ now }));

  if (!resolved.active) {
    return inactiveRuntime({ resolved, registry: resolvedRegistry });
  }

  if (transactionProxy != null) {
    if (typeof transactionProxy.reply !== "function" || typeof transactionProxy.ack !== "function") {
      throw new TypeError("transactionProxy.reply and transactionProxy.ack are required");
    }
  }

  const validatedConfig = validateHeadlessCodexConfig(profileConfig);
  const workerPool =
    pool ??
    createCodexWorkerPool({
      codexHome,
      command,
      args,
      env,
      preferredSize: 1,
      maxSize: 1,
      manifest: resolved.manifest,
    });

  const resolvedLeaseManager =
    leaseManager ??
    (durableStore?.enabled === true
      ? createExecutionLeaseManager({
          store: durableStore,
          ownerInstanceId,
          now,
        })
      : null);

  let started = false;
  /** @type {string[]} */
  const lastSettlementTrace = [];
  /** @type {object[]} */
  const ignoredStaleEpochEvents = [];

  async function start() {
    if (started) return status();
    await workerPool.start();
    started = true;
    logger.info?.("triangle_headless_shadow_started", {
      profileId: resolved.profileId,
      pool: workerPool.status(),
      durable: resolvedRegistry.kind === "durable",
    });
    return status();
  }

  async function stop(options) {
    started = false;
    await workerPool.stop(options);
    return status();
  }

  async function restartSlot(options) {
    if (!started) {
      throw createCodedError("shadow_runtime_not_started", "shadow runtime is not started");
    }
    return workerPool.restartSlot(options);
  }

  function acceptEpochEvent({ conversationEpoch, eventEpoch, meta = null } = {}) {
    const accepted = shouldAcceptExecutionEpochEvent({ conversationEpoch, eventEpoch });
    if (!accepted) {
      ignoredStaleEpochEvents.push(
        Object.freeze({
          at: now(),
          conversationEpoch: conversationEpoch ?? null,
          eventEpoch: eventEpoch ?? null,
          meta,
        }),
      );
      logger.info?.("triangle_headless_stale_epoch_ignored", {
        conversationEpoch,
        eventEpoch,
        meta,
      });
    }
    return accepted;
  }

  /**
   * Receipt-only: claim already held by trusted proxy → ack without model turn.
   * No worker slot, no Codex thread, no MESH reply, no execution epoch bump.
   */
  async function runReceiptOnly({
    profileInstanceId: instanceId,
    roomId,
    deliveryId,
    numericDeliveryId,
  } = {}) {
    if (!started) {
      throw createCodedError("shadow_runtime_not_started", "shadow runtime is not started");
    }
    if (typeof instanceId !== "string" || !/^[a-f0-9]{64}$/.test(instanceId)) {
      throw new TypeError("profileInstanceId is invalid");
    }
    if (typeof roomId !== "string" || !/^room_[a-f0-9]{32}$/.test(roomId)) {
      throw new TypeError("roomId is invalid");
    }
    if (!Number.isSafeInteger(numericDeliveryId) || numericDeliveryId < 1) {
      throw new TypeError("numericDeliveryId is invalid");
    }

    lastSettlementTrace.length = 0;
    lastSettlementTrace.push("receipt_claimed");

    if (transactionProxy) {
      await transactionProxy.ack({
        roomId,
        receiptOnly: true,
        deliveryId: deliveryId ?? `delivery_${numericDeliveryId}`,
      });
    }
    lastSettlementTrace.push("acked");

    // Touch registry identifiers only — no thread / epoch admission.
    const existing = resolvedRegistry.get(instanceId, roomId);
    if (existing != null) {
      resolvedRegistry.upsert(instanceId, roomId, {
        lastCompletedDeliveryId: deliveryId ?? `delivery_${numericDeliveryId}`,
      });
    }

    return Object.freeze({
      status: "receipt_only",
      replyRequired: false,
      modelAdmitted: false,
      meshReplyPosted: false,
      workerSlotReserved: false,
      settlementTrace: Object.freeze([...lastSettlementTrace]),
      deliveryId: deliveryId ?? `delivery_${numericDeliveryId}`,
    });
  }

  /**
   * Run one delivery. When `replyRequired === false`, delegates to receipt-only.
   */
  async function runDelivery({
    profileInstanceId: instanceId,
    roomId,
    deliveryId,
    numericDeliveryId,
    text,
    inboundEventId = null,
    cwd = null,
    replyRequired = true,
  } = {}) {
    if (replyRequired === false) {
      return runReceiptOnly({
        profileInstanceId: instanceId,
        roomId,
        deliveryId,
        numericDeliveryId,
      });
    }

    if (!started) {
      throw createCodedError("shadow_runtime_not_started", "shadow runtime is not started");
    }
    if (typeof instanceId !== "string" || !/^[a-f0-9]{64}$/.test(instanceId)) {
      throw new TypeError("profileInstanceId is invalid");
    }
    if (typeof roomId !== "string" || !/^room_[a-f0-9]{32}$/.test(roomId)) {
      throw new TypeError("roomId is invalid");
    }
    if (!Number.isSafeInteger(numericDeliveryId) || numericDeliveryId < 1) {
      throw new TypeError("numericDeliveryId is invalid");
    }
    if (typeof text !== "string" || text.length === 0) {
      throw new TypeError("text is required");
    }
    assertNoSecretMaterial(text, "delivery text");

    lastSettlementTrace.length = 0;

    let leaseRecord = null;
    if (resolvedLeaseManager) {
      leaseRecord = resolvedLeaseManager.acquire({
        profileInstanceId: instanceId,
        runtimeMode: "headless",
        activeMeshRoomId: roomId,
      });
    }

    const slotLease = await workerPool.acquire();
    try {
      if (resolvedLeaseManager) {
        resolvedLeaseManager.renew({
          profileInstanceId: instanceId,
          activeMeshRoomId: roomId,
        });
      }

      const existing = resolvedRegistry.get(instanceId, roomId);
      // Duplicate while active: do not start another Codex turn.
      if (
        existing &&
        existing.activeDeliveryId != null &&
        (existing.executionState === "admitted" ||
          existing.executionState === "running" ||
          existing.executionState === "result_ready" ||
          existing.executionState === "reply_persisted")
      ) {
        if (String(existing.activeDeliveryId) === String(deliveryId ?? `delivery_${numericDeliveryId}`)) {
          return Object.freeze({
            status: "duplicate_active",
            applied: false,
            threadId: existing.codexThreadId,
            executionEpoch: existing.executionEpoch,
            executionState: existing.executionState,
            settlementTrace: Object.freeze([]),
          });
        }
        throw createCodedError(
          "delivery_conflict",
          "conversation already has an active delivery",
          {
            activeDeliveryId: existing.activeDeliveryId,
            next: deliveryId ?? `delivery_${numericDeliveryId}`,
          },
        );
      }

      let threadId = existing?.codexThreadId ?? null;
      let startedNewThread = false;
      const workingDirectory =
        typeof cwd === "string" && cwd.startsWith("/")
          ? cwd
          : typeof profileConfig.workingDirectory === "string" &&
              profileConfig.workingDirectory.startsWith("/")
            ? profileConfig.workingDirectory
            : slotLease.processHandle.status().codexHome;

      if (threadId == null) {
        const startedThread = await slotLease.processHandle.threadStart({
          cwd: workingDirectory,
          approvalPolicy: validatedConfig.approvalPolicy,
          sandbox: validatedConfig.sandboxClass,
          ephemeral: false,
        });
        threadId = startedThread?.thread?.id;
        if (typeof threadId !== "string" || threadId.length === 0) {
          throw createCodedError("thread_start_failed", "thread/start returned no thread id");
        }
        // Persist thread id before turn/start (design: new conversation step 4).
        resolvedRegistry.setThread(instanceId, roomId, threadId, {
          workerSlotId: slotLease.slotId,
        });
        startedNewThread = true;
      } else {
        const resumed = await slotLease.processHandle.threadResume({ threadId });
        const resumedId = resumed?.thread?.id;
        if (resumedId !== threadId) {
          throw createCodedError(
            "thread_resume_mismatch",
            "thread/resume returned a different thread id",
            { expected: threadId, actual: resumedId ?? null },
          );
        }
        resolvedRegistry.upsert(instanceId, roomId, {
          lastWorkerSlotId: slotLease.slotId,
        });
      }

      const priorEpoch = resolvedRegistry.get(instanceId, roomId)?.executionEpoch ?? 0;
      const executionEpoch = priorEpoch + 1;
      resolvedRegistry.upsert(instanceId, roomId, {
        executionState: "admitted",
        activeDeliveryId: deliveryId ?? `delivery_${numericDeliveryId}`,
        executionEpoch,
      });

      if (resolvedLeaseManager) {
        resolvedLeaseManager.renew({
          profileInstanceId: instanceId,
          activeMeshRoomId: roomId,
        });
      }

      const correlationTag = buildCorrelationTag({
        profileInstanceId: instanceId,
        deliveryId: numericDeliveryId,
        executionEpoch,
      });
      const turnParams = attachCorrelationToTurnStart(
        {
          threadId,
          input: [{ type: "text", text }],
        },
        correlationTag,
        { mode: correlationMode },
      );

      resolvedRegistry.upsert(instanceId, roomId, { executionState: "running" });
      const pending = waitForAppServerTurnCompleted(slotLease.processHandle, {
        threadId,
        timeoutMs: turnTimeoutMs,
      });
      // Always attach a sink so a crash-before-response cannot become unhandled.
      const pendingResult = pending.then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      );
      let startedTurn;
      try {
        startedTurn = await slotLease.processHandle.turnStart(turnParams);
      } catch (error) {
        await pendingResult;
        throw error;
      }
      const turnId = startedTurn?.turn?.id;
      if (typeof turnId !== "string" || turnId.length === 0) {
        await pendingResult;
        throw createCodedError("turn_start_failed", "turn/start returned no turn id", {
          outcome: "unknown",
        });
      }
      const completed = await pendingResult;
      if (!completed.ok) throw completed.error;
      const completedTurn = completed.value;
      // Stale-epoch guard: ignore late completions that do not match admitted epoch.
      if (
        completedTurn?.executionEpoch != null &&
        !acceptEpochEvent({
          conversationEpoch: executionEpoch,
          eventEpoch: completedTurn.executionEpoch,
          meta: { turnId, source: "turn/completed" },
        })
      ) {
        throw createCodedError("stale_epoch_terminal", "terminal turn event epoch is stale", {
          executionEpoch,
          eventEpoch: completedTurn.executionEpoch,
        });
      }
      if (completedTurn?.status && completedTurn.status !== "completed") {
        throw createCodedError("turn_failed", "turn did not complete successfully", {
          turnId,
          status: completedTurn.status,
        });
      }
      // Prefer the completed notification payload; fall back to thread/read.
      let turn = completedTurn;
      if (!extractAssistantText(turn)) {
        const read = await slotLease.processHandle.threadRead({
          threadId,
          includeTurns: true,
        });
        const turns = read?.thread?.turns ?? [];
        turn = turns.find((entry) => entry?.id === turnId) ?? turns.at(-1) ?? turn;
      }

      resolvedRegistry.upsert(instanceId, roomId, { executionState: "result_ready" });
      lastSettlementTrace.push("result_ready");

      const assistantText = extractAssistantText(turn);
      if (!assistantText || assistantText.trim() === "[NO_REPLY]") {
        throw createCodedError(
          "assistant_text_missing",
          "claimed work completed without a MESH reply",
        );
      }
      assertNoSecretMaterial(assistantText, "mesh reply");

      let replyEventId = null;
      if (transactionProxy) {
        const replied = await transactionProxy.reply({
          roomId,
          text: assistantText,
          inReplyToEventId: inboundEventId,
        });
        replyEventId =
          typeof replied?.replyEventId === "string" ? replied.replyEventId : null;
        resolvedRegistry.upsert(instanceId, roomId, {
          executionState: "reply_persisted",
          lastReplyEventId: replyEventId,
        });
        lastSettlementTrace.push("reply_persisted");

        if (durableStore?.enabled === true && replyEventId) {
          recordOrReplayCompletion(durableStore, {
            profile_instance_id: instanceId,
            mesh_room_id: roomId,
            idempotency_id: buildCompletionIdempotencyKey({
              profileInstanceId: instanceId,
              roomId,
              deliveryId: deliveryId ?? `delivery_${numericDeliveryId}`,
              executionEpoch,
            }),
            delivery_id: numericDeliveryId,
            reply_event_id: replyEventId,
          });
        }

        await transactionProxy.ack();
        resolvedRegistry.upsert(instanceId, roomId, {
          executionState: "acked",
          activeDeliveryId: null,
          lastCompletedDeliveryId: deliveryId ?? `delivery_${numericDeliveryId}`,
        });
        lastSettlementTrace.push("acked");
      } else {
        // Unit paths without a proxy still record the settlement order contract.
        resolvedRegistry.upsert(instanceId, roomId, { executionState: "reply_persisted" });
        lastSettlementTrace.push("reply_persisted");
        resolvedRegistry.upsert(instanceId, roomId, {
          executionState: "acked",
          activeDeliveryId: null,
          lastCompletedDeliveryId: deliveryId ?? `delivery_${numericDeliveryId}`,
        });
        lastSettlementTrace.push("acked");
      }

      resolvedRegistry.upsert(instanceId, roomId, { executionState: "idle" });

      return Object.freeze({
        status: "completed",
        threadId,
        turnId,
        startedNewThread,
        correlationTag,
        executionEpoch,
        replyEventId,
        settlementTrace: Object.freeze([...lastSettlementTrace]),
        expectedSettlementOrder: replyBeforeAckStages(),
        slotId: slotLease.slotId,
        generation: slotLease.generation,
        ownerGeneration: leaseRecord?.owner_generation ?? null,
      });
    } finally {
      slotLease.release();
    }
  }

  /**
   * After process restart: reconcile durable records before admitting new work.
   * Never posts a duplicate MESH reply for reply_persisted rows.
   */
  async function recoverAfterRestart({ profileInstanceId: instanceId } = {}) {
    if (typeof instanceId !== "string" || !/^[a-f0-9]{64}$/.test(instanceId)) {
      throw new TypeError("profileInstanceId is invalid");
    }
    if (resolvedRegistry.kind === "durable" && typeof resolvedRegistry.reload === "function") {
      resolvedRegistry.reload();
    }
    const report = await reconcileProfileAfterRestart({
      registry: resolvedRegistry,
      store: durableStore?.enabled === true ? durableStore : null,
      transactionProxy,
      profileInstanceId: instanceId,
      now,
      logger,
    });
    // After restart, prior owner is not presumed live. Acquire only when idle.
    if (resolvedLeaseManager && report.quarantined === 0) {
      try {
        resolvedLeaseManager.acquire({
          profileInstanceId: instanceId,
          runtimeMode: "headless",
          afterRestart: true,
        });
      } catch (error) {
        if (error?.code === "lease_non_idle_no_steal") {
          return Object.freeze({ ...report, lease: "deferred_non_idle" });
        }
        throw error;
      }
    }
    return report;
  }

  /**
   * Cancellation scoped to `(conversation, delivery, execution_epoch)`.
   */
  async function cancelDelivery({
    profileInstanceId: instanceId,
    roomId,
    deliveryId,
    executionEpoch,
    interrupt = true,
  } = {}) {
    const record = resolvedRegistry.get(instanceId, roomId);
    if (
      !matchesCancellationScope(record, {
        deliveryId,
        executionEpoch,
      })
    ) {
      return Object.freeze({
        cancelled: false,
        reason: "scope_mismatch",
        executionEpoch: record?.executionEpoch ?? null,
        activeDeliveryId: record?.activeDeliveryId ?? null,
      });
    }

    if (
      interrupt &&
      started &&
      record.executionState === "running" &&
      record.codexThreadId != null
    ) {
      try {
        const slotLease = await workerPool.acquire({ waitMs: 0 });
        try {
          await slotLease.processHandle.turnInterrupt({ threadId: record.codexThreadId });
        } finally {
          slotLease.release();
        }
      } catch (error) {
        if (error?.code !== "pool_slot_busy") throw error;
        // Slot busy with this turn — interrupt best-effort skipped; caller may abandon.
      }
    }

    // Return to idle without acknowledging unless MESH contract says otherwise.
    resolvedRegistry.upsert(instanceId, roomId, {
      executionState: "idle",
      activeDeliveryId: null,
    });
    return Object.freeze({
      cancelled: true,
      deliveryId,
      executionEpoch,
      acknowledged: false,
    });
  }

  function status() {
    return Object.freeze({
      active: true,
      started,
      profileId: resolved.profileId,
      config: resolved,
      pool: workerPool.status(),
      conversations: resolvedRegistry.size(),
      registryKind: resolvedRegistry.kind,
      durableStoreEnabled: durableStore?.enabled === true,
      lease: resolvedLeaseManager
        ? { ownerInstanceId: resolvedLeaseManager.ownerInstanceId }
        : null,
      lastSettlementTrace: Object.freeze([...lastSettlementTrace]),
      ignoredStaleEpochEvents: ignoredStaleEpochEvents.length,
    });
  }

  return Object.freeze({
    active: true,
    reason: null,
    config: resolved,
    start,
    stop,
    runDelivery,
    runReceiptOnly,
    recoverAfterRestart,
    cancelDelivery,
    acceptEpochEvent,
    restartSlot,
    status,
    registry: resolvedRegistry,
    pool: workerPool,
    leaseManager: resolvedLeaseManager,
    durableStore: durableStore?.enabled === true ? durableStore : null,
  });
}

export { isShadowHeadlessTestProfile };

/**
 * HeadlessCodexRuntime — Phase 1–3 shadow path (durable recovery + bounded pool).
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
 * Phase 3 adds (still shadow-gated):
 * - preferred pool size 2 (manifest cap up to 4; do not default to 4)
 * - sticky slot preference via registry `lastWorkerSlotId`
 * - overload fail-closed when the pool is saturated (waitMs=0)
 *
 * No MESH credentials. Dedicated TRIANGLE_CODEX_HOME only.
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
  resolveHeadlessRuntimeConfig,
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
 * Create the Phase 1–3 shadow headless runtime.
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
  enablePhase5Migration = false,
  registry = null,
  pool = null,
  durableStore = null,
  leaseManager = null,
  ownerInstanceId = `owner-${process.pid}`,
  profileInstanceId = null,
  correlationMode = selectCorrelationMode({ metadataFieldSurvivesThreadRead: true }),
  turnTimeoutMs = 30_000,
  /**
   * Pool acquire wait. Default 0 = fail closed on saturation (leave MESH work
   * durable / unclaimed). Bounded waits are FIFO inside the pool.
   */
  poolAcquireWaitMs = 0,
  logger = console,
  now = () => Date.now(),
} = {}) {
  const resolved = resolveHeadlessRuntimeConfig(profileConfig, {
    enableShadow,
    enablePhase5Migration,
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
      preferredSize: resolved.pool.preferredSize,
      maxSize: resolved.pool.maxSize,
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
  /**
   * Owning slot handle for the in-flight delivery. Cancel/timeout must use this
   * (or pool.getActiveHandle) — never a second acquire while the slot is busy.
   * @type {null | {
   *   profileInstanceId: string,
   *   roomId: string,
   *   deliveryId: string,
   *   executionEpoch: number | null,
   *   slotId: string,
   *   processHandle: object,
   *   threadId: string | null,
   * }}
   */
  let activeDelivery = null;

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

  async function restartSlot(options = {}) {
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

    const existingBeforeAcquire = resolvedRegistry.get(instanceId, roomId);
    // Duplicate while active: do not reserve a slot or start another Codex turn.
    if (
      existingBeforeAcquire &&
      existingBeforeAcquire.activeDeliveryId != null &&
      (existingBeforeAcquire.executionState === "admitted" ||
        existingBeforeAcquire.executionState === "running" ||
        existingBeforeAcquire.executionState === "result_ready" ||
        existingBeforeAcquire.executionState === "reply_persisted")
    ) {
      if (
        String(existingBeforeAcquire.activeDeliveryId) ===
        String(deliveryId ?? `delivery_${numericDeliveryId}`)
      ) {
        return Object.freeze({
          status: "duplicate_active",
          applied: false,
          threadId: existingBeforeAcquire.codexThreadId,
          executionEpoch: existingBeforeAcquire.executionEpoch,
          executionState: existingBeforeAcquire.executionState,
          settlementTrace: Object.freeze([]),
        });
      }
      throw createCodedError(
        "delivery_conflict",
        "conversation already has an active delivery",
        {
          activeDeliveryId: existingBeforeAcquire.activeDeliveryId,
          next: deliveryId ?? `delivery_${numericDeliveryId}`,
        },
      );
    }

    const stickySlotId = existingBeforeAcquire?.lastWorkerSlotId ?? null;
    let slotLease;
    try {
      slotLease = await workerPool.acquire({
        stickySlotId,
        conversationKey: roomId,
        waitMs: poolAcquireWaitMs,
      });
    } catch (error) {
      if (
        error?.code === "pool_overloaded" ||
        error?.code === "pool_circuit_open" ||
        error?.code === "pool_slot_busy"
      ) {
        // Fail closed: do not claim / run beyond capacity. MESH work stays durable.
        throw createCodedError(error.code, error.message, {
          waitPolicy: poolAcquireWaitMs > 0 ? "bounded_wait" : "fail_closed",
          size: error.size,
          busy: error.busy,
        });
      }
      throw error;
    }
    let slotReleased = false;
    let unknownOutcomeQuarantined = false;
    activeDelivery = {
      profileInstanceId: instanceId,
      roomId,
      deliveryId: deliveryId ?? `delivery_${numericDeliveryId}`,
      executionEpoch: null,
      slotId: slotLease.slotId,
      processHandle: slotLease.processHandle,
      threadId: null,
    };
    try {
      if (resolvedLeaseManager) {
        resolvedLeaseManager.renew({
          profileInstanceId: instanceId,
          activeMeshRoomId: roomId,
        });
      }

      const existing = resolvedRegistry.get(instanceId, roomId);
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
      activeDelivery.threadId = threadId;

      const priorEpoch = resolvedRegistry.get(instanceId, roomId)?.executionEpoch ?? 0;
      const executionEpoch = priorEpoch + 1;
      resolvedRegistry.upsert(instanceId, roomId, {
        executionState: "admitted",
        activeDeliveryId: deliveryId ?? `delivery_${numericDeliveryId}`,
        executionEpoch,
      });
      activeDelivery.executionEpoch = executionEpoch;

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
        const pendingOutcome = await pendingResult;
        const quarantineError =
          pendingOutcome && pendingOutcome.ok === false ? pendingOutcome.error : error;
        const q = await quarantineUnknownTurnOutcome({
          slotLease,
          threadId,
          error: quarantineError,
        });
        if (q.slotReleased) {
          unknownOutcomeQuarantined = true;
          slotReleased = true;
        }
        throw error;
      }
      const turnId = startedTurn?.turn?.id;
      if (typeof turnId !== "string" || turnId.length === 0) {
        const pendingOutcome = await pendingResult;
        const quarantineError = createCodedError(
          "turn_start_failed",
          "turn/start returned no turn id",
          { outcome: "unknown" },
        );
        const q = await quarantineUnknownTurnOutcome({
          slotLease,
          threadId,
          error: pendingOutcome?.ok === false ? pendingOutcome.error : quarantineError,
        });
        if (q.slotReleased) {
          unknownOutcomeQuarantined = true;
          slotReleased = true;
        }
        throw quarantineError;
      }
      const completed = await pendingResult;
      if (!completed.ok) {
        const q = await quarantineUnknownTurnOutcome({
          slotLease,
          threadId,
          error: completed.error,
        });
        if (q.slotReleased) {
          unknownOutcomeQuarantined = true;
          slotReleased = true;
        }
        throw completed.error;
      }
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

      const durableEnabled = durableStore?.enabled === true;
      let replyEventId = null;
      if (transactionProxy) {
        const replied = await transactionProxy.reply({
          roomId,
          text: assistantText,
          inReplyToEventId: inboundEventId,
        });
        replyEventId =
          typeof replied?.replyEventId === "string" && replied.replyEventId.length > 0
            ? replied.replyEventId
            : null;

        // Durable path must not mark reply_persisted / write completion / ack
        // without a canonical non-empty replyEventId (fail closed).
        if (durableEnabled && replyEventId == null) {
          throw createCodedError(
            "completion_reply_missing",
            "durable reply proof missing; refusing reply_persisted/ack",
            { profileInstanceId: instanceId, roomId },
          );
        }

        resolvedRegistry.upsert(instanceId, roomId, {
          executionState: "reply_persisted",
          lastReplyEventId: replyEventId,
        });
        lastSettlementTrace.push("reply_persisted");

        if (durableEnabled) {
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
      } else if (durableEnabled) {
        // Durable settlement requires a proxy-backed replyEventId.
        throw createCodedError(
          "completion_reply_missing",
          "durable path requires transactionProxy with replyEventId",
          { profileInstanceId: instanceId, roomId },
        );
      } else {
        // Unit paths without a proxy stay order-only when clearly non-durable.
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
      activeDelivery = null;
      if (!slotReleased) {
        slotLease.release();
      }
      // unknownOutcomeQuarantined: slot already restarted; busy cleared by restartSlot.
      void unknownOutcomeQuarantined;
    }
  }

  /**
   * On unknown timeout / crash-before-terminal: interrupt, quarantine the
   * delivery (leave non-idle for reconciler), and replace the slot process so
   * the next delivery cannot start on a still-running/zombie App Server.
   * @returns {{ quarantined: boolean, slotReleased: boolean }}
   */
  async function quarantineUnknownTurnOutcome({ slotLease, threadId, error }) {
    const unknown =
      error?.outcome === "unknown" ||
      error?.code === "seed_turn_timeout" ||
      error?.code === "child_exited" ||
      error?.code === "not_connected" ||
      error?.code === "closing";
    if (!unknown) {
      return { quarantined: false, slotReleased: false };
    }

    logger.info?.("triangle_headless_turn_outcome_unknown", {
      code: error?.code ?? null,
      threadId,
      slotId: slotLease?.slotId ?? null,
    });

    if (threadId != null && typeof slotLease?.processHandle?.turnInterrupt === "function") {
      try {
        const status =
          typeof slotLease.processHandle.status === "function"
            ? slotLease.processHandle.status()
            : null;
        if (status?.connected !== false) {
          await Promise.race([
            slotLease.processHandle.turnInterrupt({ threadId }),
            new Promise((_, reject) => {
              setTimeout(() => {
                reject(createCodedError("interrupt_timeout", "turn interrupt timed out"));
              }, 500);
            }),
          ]);
        }
      } catch {
        // Best-effort interrupt before replacing the process.
      }
    }

    // Leave registry non-idle (running/admitted) so restart reconcile quarantines.
    // Replace only the owning slot process before it becomes reusable — never
    // restart sibling healthy slots that may be serving other conversations.
    try {
      if (typeof workerPool.noteCrash === "function") {
        workerPool.noteCrash(slotLease.slotId);
      }
      await workerPool.restartSlot({
        slotId: slotLease.slotId,
        signal: "SIGKILL",
        timeoutMs: 2_000,
      });
      return { quarantined: true, slotReleased: true };
    } catch (restartError) {
      // If restart fails, still release so we do not permanently wedge the pool;
      // the delivery remains non-idle for operator quarantine.
      logger.info?.("triangle_headless_slot_restart_failed", {
        code: restartError?.code ?? null,
        message: String(restartError?.message ?? restartError),
        slotId: slotLease?.slotId ?? null,
      });
      try {
        slotLease.release({ success: false });
      } catch {
        // ignore
      }
      return { quarantined: true, slotReleased: true };
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
   * Interrupt via the owning delivery handle (or pool.getActiveHandle({ slotId }))
   * — never a second acquire while that slot is busy. Only clear durable/registry
   * state after a confirmed interrupt, or leave quarantined on failure.
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
      const owning =
        activeDelivery != null &&
        activeDelivery.profileInstanceId === instanceId &&
        activeDelivery.roomId === roomId &&
        String(activeDelivery.deliveryId) === String(deliveryId) &&
        activeDelivery.executionEpoch === executionEpoch
          ? activeDelivery
          : typeof workerPool.getActiveHandle === "function"
            ? workerPool.getActiveHandle({
                slotId: record.lastWorkerSlotId ?? null,
              })
            : null;

      if (owning?.processHandle == null) {
        // Cannot prove interrupt while the turn may still be running — fail closed.
        return Object.freeze({
          cancelled: false,
          reason: "no_active_handle",
          quarantined: true,
          deliveryId,
          executionEpoch,
          acknowledged: false,
        });
      }

      try {
        await owning.processHandle.turnInterrupt({ threadId: record.codexThreadId });
      } catch (error) {
        return Object.freeze({
          cancelled: false,
          reason: "interrupt_failed",
          quarantined: true,
          code: error?.code ?? null,
          deliveryId,
          executionEpoch,
          acknowledged: false,
        });
      }

      resolvedRegistry.upsert(instanceId, roomId, {
        executionState: "idle",
        activeDeliveryId: null,
      });
      return Object.freeze({
        cancelled: true,
        interrupted: true,
        deliveryId,
        executionEpoch,
        acknowledged: false,
      });
    }

    // Non-running scoped cancel (e.g. admitted before turn/start): clear without interrupt.
    resolvedRegistry.upsert(instanceId, roomId, {
      executionState: "idle",
      activeDeliveryId: null,
    });
    return Object.freeze({
      cancelled: true,
      interrupted: false,
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

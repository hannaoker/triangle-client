/**
 * HeadlessCodexRuntime — Phase 1 single-slot shadow path.
 *
 * Opt-in only for isolated test profiles (`shadowTestProfile: true` +
 * `runtimeMode: "headless"` + `runtimeAdapter: "codex-app-server"`). Does not
 * replace Shared App Server desktop wake / production mcp-interactive profiles.
 *
 * Proves:
 * - thread/start + turn for a new conversation
 * - thread/resume continuity after forced slot restart
 * - reply-before-ack settlement via the trusted transaction proxy
 *
 * No MESH credentials. Dedicated TRIANGLE_CODEX_HOME only. Pool size stays 1.
 */

import { assertNoSecretMaterial } from "./app-server-protocol.mjs";
import { waitForAppServerTurnCompleted } from "./app-server-process.mjs";
import {
  attachCorrelationToTurnStart,
  buildCorrelationTag,
  selectCorrelationMode,
} from "./correlation.mjs";
import { createMemoryConversationRegistry } from "./conversation-registry.mjs";
import { replyBeforeAckStages } from "./execution-state.mjs";
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

/**
 * Create the Phase 1 shadow headless runtime.
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
 */
export function createHeadlessCodexRuntime({
  profileConfig = {},
  transactionProxy = null,
  codexHome,
  command = "codex",
  args = ["app-server"],
  env = process.env,
  enableShadow = false,
  registry = createMemoryConversationRegistry(),
  pool = null,
  correlationMode = selectCorrelationMode({ metadataFieldSurvivesThreadRead: true }),
  turnTimeoutMs = 30_000,
  logger = console,
} = {}) {
  const resolved = resolvePhase1ShadowRuntimeConfig(profileConfig, {
    enableShadow,
    env,
  });
  if (!resolved.active) {
    return Object.freeze({
      active: false,
      reason: resolved.inactiveReason,
      config: resolved,
      async start() {
        throw createCodedError(
          "shadow_runtime_inactive",
          "Phase 1 shadow headless runtime is inactive for this profile",
          { reason: resolved.inactiveReason },
        );
      },
      async stop() {
        return { active: false };
      },
      async runDelivery() {
        throw createCodedError(
          "shadow_runtime_inactive",
          "Phase 1 shadow headless runtime is inactive for this profile",
          { reason: resolved.inactiveReason },
        );
      },
      async restartSlot() {
        throw createCodedError("shadow_runtime_inactive", "shadow runtime inactive");
      },
      status() {
        return Object.freeze({ active: false, reason: resolved.inactiveReason, config: resolved });
      },
      registry,
      pool: null,
    });
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

  let started = false;
  /** @type {string[]} */
  const lastSettlementTrace = [];

  async function start() {
    if (started) return status();
    await workerPool.start();
    started = true;
    logger.info?.("triangle_headless_shadow_started", {
      profileId: resolved.profileId,
      pool: workerPool.status(),
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

  /**
   * Run one reply-required delivery on the single slot.
   * Persists thread mapping before turn/start; settles reply then ack.
   */
  async function runDelivery({
    profileInstanceId,
    roomId,
    deliveryId,
    numericDeliveryId,
    text,
    inboundEventId = null,
    cwd = null,
  } = {}) {
    if (!started) {
      throw createCodedError("shadow_runtime_not_started", "shadow runtime is not started");
    }
    if (typeof profileInstanceId !== "string" || !/^[a-f0-9]{64}$/.test(profileInstanceId)) {
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
    const lease = await workerPool.acquire();
    try {
      const existing = registry.get(profileInstanceId, roomId);
      let threadId = existing?.codexThreadId ?? null;
      let startedNewThread = false;
      const workingDirectory =
        typeof cwd === "string" && cwd.startsWith("/")
          ? cwd
          : typeof profileConfig.workingDirectory === "string" &&
              profileConfig.workingDirectory.startsWith("/")
            ? profileConfig.workingDirectory
            : lease.processHandle.status().codexHome;

      if (threadId == null) {
        const startedThread = await lease.processHandle.threadStart({
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
        registry.setThread(profileInstanceId, roomId, threadId, {
          workerSlotId: lease.slotId,
        });
        startedNewThread = true;
      } else {
        const resumed = await lease.processHandle.threadResume({ threadId });
        const resumedId = resumed?.thread?.id;
        if (resumedId !== threadId) {
          throw createCodedError(
            "thread_resume_mismatch",
            "thread/resume returned a different thread id",
            { expected: threadId, actual: resumedId ?? null },
          );
        }
        registry.upsert(profileInstanceId, roomId, {
          lastWorkerSlotId: lease.slotId,
        });
      }

      const priorEpoch = registry.get(profileInstanceId, roomId)?.executionEpoch ?? 0;
      const executionEpoch = priorEpoch + 1;
      registry.upsert(profileInstanceId, roomId, {
        executionState: "admitted",
        activeDeliveryId: deliveryId ?? `delivery_${numericDeliveryId}`,
        executionEpoch,
      });

      const correlationTag = buildCorrelationTag({
        profileInstanceId,
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

      registry.upsert(profileInstanceId, roomId, { executionState: "running" });
      const pending = waitForAppServerTurnCompleted(lease.processHandle, {
        threadId,
        timeoutMs: turnTimeoutMs,
      });
      const startedTurn = await lease.processHandle.turnStart(turnParams);
      const turnId = startedTurn?.turn?.id;
      if (typeof turnId !== "string" || turnId.length === 0) {
        throw createCodedError("turn_start_failed", "turn/start returned no turn id", {
          outcome: "unknown",
        });
      }
      const completedTurn = await pending;
      if (completedTurn?.status && completedTurn.status !== "completed") {
        throw createCodedError("turn_failed", "turn did not complete successfully", {
          turnId,
          status: completedTurn.status,
        });
      }
      // Prefer the completed notification payload; fall back to thread/read.
      let turn = completedTurn;
      if (!extractAssistantText(turn)) {
        const read = await lease.processHandle.threadRead({
          threadId,
          includeTurns: true,
        });
        const turns = read?.thread?.turns ?? [];
        turn = turns.find((entry) => entry?.id === turnId) ?? turns.at(-1) ?? turn;
      }

      registry.upsert(profileInstanceId, roomId, { executionState: "result_ready" });
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
        registry.upsert(profileInstanceId, roomId, {
          executionState: "reply_persisted",
          lastReplyEventId: replyEventId,
        });
        lastSettlementTrace.push("reply_persisted");

        await transactionProxy.ack();
        registry.upsert(profileInstanceId, roomId, {
          executionState: "acked",
          activeDeliveryId: null,
          lastCompletedDeliveryId: deliveryId ?? `delivery_${numericDeliveryId}`,
        });
        lastSettlementTrace.push("acked");
      } else {
        // Unit paths without a proxy still record the settlement order contract.
        registry.upsert(profileInstanceId, roomId, { executionState: "reply_persisted" });
        lastSettlementTrace.push("reply_persisted");
        registry.upsert(profileInstanceId, roomId, {
          executionState: "acked",
          activeDeliveryId: null,
          lastCompletedDeliveryId: deliveryId ?? `delivery_${numericDeliveryId}`,
        });
        lastSettlementTrace.push("acked");
      }

      registry.upsert(profileInstanceId, roomId, { executionState: "idle" });

      return Object.freeze({
        status: "completed",
        threadId,
        turnId,
        startedNewThread,
        correlationTag,
        replyEventId,
        settlementTrace: Object.freeze([...lastSettlementTrace]),
        expectedSettlementOrder: replyBeforeAckStages(),
        slotId: lease.slotId,
        generation: lease.generation,
      });
    } finally {
      lease.release();
    }
  }

  function status() {
    return Object.freeze({
      active: true,
      started,
      profileId: resolved.profileId,
      config: resolved,
      pool: workerPool.status(),
      conversations: registry.size(),
      lastSettlementTrace: Object.freeze([...lastSettlementTrace]),
    });
  }

  return Object.freeze({
    active: true,
    reason: null,
    config: resolved,
    start,
    stop,
    runDelivery,
    restartSlot,
    status,
    registry,
    pool: workerPool,
  });
}

export { isShadowHeadlessTestProfile };

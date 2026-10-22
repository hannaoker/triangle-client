import { randomUUID } from "node:crypto";
import { coded } from "./local-messaging-errors.mjs";

export function createLocalMessagingDispatcher({
  journal,
  runRecipient,
  logger = {},
  runnerTimeoutMs = 3600000,
  maxConcurrent = 2,
} = {}) {
  if (!journal) {
    throw coded("invalid_dispatcher_options", "journal is required");
  }
  if (typeof runRecipient !== "function") {
    throw coded("invalid_dispatcher_options", "runRecipient must be a function");
  }

  let activeJournal = journal;
  let active = false;
  let stopping = false;
  let drainResolvers = [];

  const pendingQueue = [];
  const inFlightMessageIds = new Set();
  const activeRecipients = new Set();
  const activeExecutions = new Map(); // messageId -> executionPromise

  let pumpScheduled = false;

  function schedulePump() {
    if (pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      pump();
    });
  }

  function checkDrain() {
    if (stopping && activeExecutions.size === 0) {
      const resolvers = drainResolvers;
      drainResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
    }
  }

  function pump() {
    // Shutdown starts nothing new: unclaimed jobs stay queued_local for the next start.
    if (stopping) {
      checkDrain();
      return;
    }
    while (activeExecutions.size < maxConcurrent) {
      const nextIndex = pendingQueue.findIndex(
        (job) => !activeRecipients.has(job.recipient),
      );
      if (nextIndex === -1) {
        break;
      }

      const [job] = pendingQueue.splice(nextIndex, 1);
      activeRecipients.add(job.recipient);

      const executionPromise = executeJob(job).catch(() => {
        logger.error?.("Local execution storage operation failed; durable state retained for recovery");
      });
      activeExecutions.set(job.messageId, executionPromise);

      executionPromise.finally(() => {
        activeExecutions.delete(job.messageId);
        activeRecipients.delete(job.recipient);
        inFlightMessageIds.delete(job.messageId);
        schedulePump();
        checkDrain();
      });
    }

    checkDrain();
  }

  async function executeJob(job) {
    let fullJob = { ...job };
    // Claim execution atomically
    const claim = await activeJournal.claimExecution(job.messageId);
    if (!claim) {
      // Record was not queued (could be held, completed, or already executing)
      return;
    }

    fullJob = { ...job, ...claim };

    const abortController = new AbortController();
    let timeoutTimer = null;
    let timedOut = false;

    const onStarted = () => {
      if (runnerTimeoutMs > 0 && !abortController.signal.aborted) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          abortController.abort(coded("runner_timeout", `Runner timed out after ${runnerTimeoutMs}ms`));
        }, runnerTimeoutMs);
      }
    };

    let result;
    try {
      result = await runRecipient(fullJob, {
        signal: abortController.signal,
        onStarted,
      });
    } catch (err) {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      const isTimeout =
        timedOut ||
        err?.code === "runner_timeout" ||
        err?.message?.includes("runner_timeout");
      const reason = isTimeout ? "runner_timeout" : "runtime_error";
      const runtimeError = err?.message || String(err);
      await activeJournal
        .recordExecutionFailure({
          messageId: fullJob.messageId,
          reason,
          runtimeError,
        })
        .catch(() => {});
      return;
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }

    try {
      if (timedOut) {
        // Late output is evidence for the owner, never a reply: keep it, hold the record.
        await activeJournal.holdExecution(fullJob.messageId, "runner_timeout", {
          lateResultText: result?.status === "completed" && typeof result.text === "string" ? result.text : undefined,
        });
        return;
      }
      if (result && result.status === "completed") {
        const replyId = "rep-" + randomUUID();
        await activeJournal.recordReply({
          sender: fullJob.recipient,
          recipient: fullJob.sender,
          messageId: replyId,
          requestId: fullJob.requestId,
          inReplyTo: fullJob.messageId,
          text: result.text || "",
          metadata: {...result.metadata, _loopDepth: (fullJob.metadata?._loopDepth ?? fullJob.loopDepth ?? 1) + 1},
        });
        await activeJournal.completeExecution(fullJob.messageId);
      } else {
        await activeJournal.holdExecution(
          fullJob.messageId,
          result?.reason || "uncompleted",
        );
      }
    } catch (persistErr) {
      logger.error?.(`Failed to persist execution completion: ${persistErr.message}`);
      await activeJournal
        .recordExecutionFailure({
          messageId: fullJob.messageId,
          reason: "persistence_failure",
          runtimeError: persistErr.message,
        })
        .catch(() => {});
    }
  }

  async function notifyAdmission(job) {
    if (!job || !job.messageId || !job.recipient) {
      return;
    }
    if (stopping) {
      return;
    }
    if (inFlightMessageIds.has(job.messageId)) {
      return;
    }
    inFlightMessageIds.add(job.messageId);
    pendingQueue.push(job);
    schedulePump();
  }

  async function start({ journal: injectedJournal } = {}) {
    if (injectedJournal) activeJournal = injectedJournal;
    if (active) return;
    active = true;
    stopping = false;

    // Startup recovery claims queued work and holds uncertain work
    const recovery = await activeJournal.recoverQueued();
    if (recovery?.toRun) {
      for (const job of recovery.toRun) {
        if (!inFlightMessageIds.has(job.messageId)) {
          inFlightMessageIds.add(job.messageId);
          pendingQueue.push(job);
        }
      }
    }

    schedulePump();
  }

  async function stop() {
    stopping = true;
    // Only executions that already started are awaited. Queued jobs were never
    // claimed, so the journal still holds them for recovery.
    for (const job of pendingQueue.splice(0)) {
      inFlightMessageIds.delete(job.messageId);
    }
    if (activeExecutions.size === 0) {
      return;
    }
    return new Promise((resolve) => {
      drainResolvers.push(resolve);
    });
  }

  function status() {
    return {
      active: activeExecutions.size,
      queued: pendingQueue.length,
      maxConcurrent,
      activeRecipients: Array.from(activeRecipients),
    };
  }

  return {
    start,
    recover: start,
    notifyAdmission,
    admitExecution: notifyAdmission,
    dispatch: notifyAdmission,
    stop,
    wait: stop,
    status,
  };
}

import { randomUUID } from "node:crypto";
import { coded } from "./local-messaging-errors.mjs";

export function createLocalMessagingDispatcher({
  journal,
  runRecipient,
  logger = {},
  runnerTimeoutMs = 3600000,
  startupTimeoutMs = 60_000,
  availabilityRetryMs = 5_000,
  maxConcurrent = 2,
  now = Date.now,
  compactIntervalMs = 3600000,
  // canRun(recipient) false: the recipient's runtime is not running. Its queued work is
  // retained until a later availability check succeeds.
  canRun = null,
} = {}) {
  const runnable = typeof canRun === "function" ? canRun : () => true;
  if (!journal) {
    throw coded("invalid_dispatcher_options", "journal is required");
  }
  if (typeof runRecipient !== "function") {
    throw coded("invalid_dispatcher_options", "runRecipient must be a function");
  }

  const requireAtomicJournal = candidate => {
    if (typeof candidate?.completeExecutionWithReply !== 'function') throw coded('invalid_dispatcher_options','journal must support atomic runner completion');
  };
  requireAtomicJournal(journal);
  let activeJournal = journal;
  let active = false;
  let stopping = false;
  let drainResolvers = [];

  const pendingQueue = [];
  const inFlightMessageIds = new Set();
  const activeRecipients = new Set();
  const activeExecutions = new Map(); // messageId -> executionPromise

  const controllers = new Map();
  let retryTimer;
  let pumpScheduled = false;
  let lastCompactionAt = null;

  // Cheap retention: once at start, then at most once per interval when work arrives.
  async function compactIfDue() {
    if (typeof activeJournal.compact !== "function") return;
    const at = now();
    if (lastCompactionAt !== null && at - lastCompactionAt < compactIntervalMs) return;
    lastCompactionAt = at;
    try {
      await activeJournal.compact({ now: at });
    } catch (error) {
      logger.error?.("local_messaging_compaction_failed", { error: "Local journal compaction failed", code: error?.code });
    }
  }

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
        (job) => !activeRecipients.has(job.recipient) && runnable(job.recipient),
      );
      if (nextIndex === -1) {
        if (!retryTimer && pendingQueue.some(job => !runnable(job.recipient))) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            schedulePump();
          }, availabilityRetryMs);
          retryTimer.unref();
        }
        break;
      }

      const [job] = pendingQueue.splice(nextIndex, 1);
      activeRecipients.add(job.recipient);

      const cancellation = new AbortController();
      controllers.set(job.messageId, cancellation);
      const executionPromise = executeJob(job, cancellation.signal).catch(() => {
        logger.error?.("Local execution storage operation failed; durable state retained for recovery");
      });
      activeExecutions.set(job.messageId, executionPromise);

      executionPromise.finally(() => {
        controllers.delete(job.messageId);
        activeExecutions.delete(job.messageId);
        activeRecipients.delete(job.recipient);
        inFlightMessageIds.delete(job.messageId);
        schedulePump();
        checkDrain();
      });
    }

    checkDrain();
  }

  async function executeJob(job, cancellation) {
    let fullJob = { ...job };
    // Claim execution atomically
    const claim = await activeJournal.claimExecution(job.messageId);
    if (!claim) {
      // Record was not queued (could be held, completed, or already executing)
      return;
    }

    fullJob = { ...job, ...claim };

    if (cancellation.aborted) return;
    const abortController = new AbortController();
    let started = false;
    let rejectInterrupted;
    const interrupted = new Promise((_, reject) => { rejectInterrupted = reject; });
    const onCancel = () => {
      abortController.abort(cancellation.reason);
      rejectInterrupted(cancellation.reason);
    };
    cancellation.addEventListener("abort", onCancel, { once: true });
    const startupTimer = setTimeout(() => {
      const error = coded("startup_timeout", "Runner admission timed out");
      abortController.abort(error);
      rejectInterrupted(error);
    }, startupTimeoutMs);
    let timeoutTimer = null;
    let timedOut = false;
    let abortGraceTimer;

    const onStarted = () => {
      abortController.signal.throwIfAborted();
      if (started) return;
      started = true;
      clearTimeout(startupTimer);
      if (runnerTimeoutMs > 0 && !abortController.signal.aborted) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          const error = coded("runner_timeout", `Runner timed out after ${runnerTimeoutMs}ms`);
          abortController.abort(error);
          // Allow an exiting runner to return late evidence, but bound an ignored abort.
          abortGraceTimer = setTimeout(() => rejectInterrupted(error), 1000);
        }, runnerTimeoutMs);
      }
    };

    let result;
    try {
      result = await Promise.race([interrupted, runRecipient(fullJob, {
        signal: abortController.signal,
        onStarted,
      })]);
      if (cancellation.aborted) return;
    } catch (err) {
      const isTimeout =
        timedOut ||
        err?.code === "runner_timeout" ||
        err?.message?.includes("runner_timeout");
      if (cancellation.aborted) return;
      if (isTimeout || err?.code === "startup_timeout") {
        await activeJournal.holdExecution(fullJob.messageId, isTimeout ? "runner_timeout" : "startup_timeout");
        return;
      }
      const reason = "runtime_error";
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
      cancellation.removeEventListener("abort", onCancel);
      clearTimeout(startupTimer);
      clearTimeout(abortGraceTimer);
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
        await activeJournal.completeExecutionWithReply({
          sender: fullJob.recipient,
          recipient: fullJob.sender,
          messageId: replyId,
          requestId: fullJob.requestId,
          inReplyTo: fullJob.messageId,
          text: result.text || "",
          metadata: {...result.metadata, _loopDepth: (fullJob.metadata?._loopDepth ?? fullJob.loopDepth ?? 1) + 1},
        });
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
    await compactIfDue();
  }

  async function start({ journal: injectedJournal } = {}) {
    if (injectedJournal) { requireAtomicJournal(injectedJournal); activeJournal = injectedJournal; }
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

    await compactIfDue();
    schedulePump();
  }

  async function stop() {
    stopping = true;
    clearTimeout(retryTimer);
    retryTimer = null;
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
    notifyAdmission,
    cancel(messageId) {
      const execution = controllers.get(messageId);
      execution?.abort(coded("sender_cancelled", "Sender cancelled the request"));
      const index = pendingQueue.findIndex(job => job.messageId === messageId);
      if (index >= 0) {
        pendingQueue.splice(index, 1);
        inFlightMessageIds.delete(messageId);
      }
    },
    stop,
    status,
  };
}

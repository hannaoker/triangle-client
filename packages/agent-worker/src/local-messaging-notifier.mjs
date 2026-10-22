import { randomUUID } from "node:crypto";
import { coded } from "./local-messaging-errors.mjs";

export const DEFAULT_NOTIFIER_MIN_INTERVAL_MS = 15_000;
export const DEFAULT_NOTIFIER_TIMER_INTERVAL_MS = 5_000;

/**
 * Local Messaging Notifier.
 *
 * Evaluates durable notification obligations from canonical unread replies
 * and held messages without model-side polling.
 *
 * Enforces:
 * - One outstanding wake hint across submitting, accepted_awaiting_ack, uncertain, and stale_held.
 * - Exact scoped acknowledgment matching wakeId and binding generation.
 * - Min interval >= 15s between wake hint submissions.
 * - Prior acknowledged fingerprint deduplication so unchanged backlog never loops.
 * - Coalesces backlog into at most one wake hint.
 * - Owner broker defines desktop sender and thread target.
 * - Stop aborts and awaits active adapter.
 */
export function createLocalMessagingNotifier({
  journal,
  targetIdentity,
  threadId,
  bindingId,
  generation = 1,
  wakeConfig = null,
  adapter = null,
  runner = null,
  logger = { info() {}, warn() {}, error() {} },
  minIntervalMs = DEFAULT_NOTIFIER_MIN_INTERVAL_MS,
  timerIntervalMs = DEFAULT_NOTIFIER_TIMER_INTERVAL_MS,
  clock = { now: () => Date.now() },
} = {}) {
  if (!journal) {
    throw coded("invalid_options", "journal is required");
  }
  if (!targetIdentity) {
    throw coded("invalid_options", "targetIdentity is required");
  }

  let timer = null;
  let activeAbortController = null;
  let activeInvocationPromise = null;
  let activeEvaluationPromise = null;
  let stopped = false;
  let started = false;

  async function evaluateObligations() {
    if (stopped) return;
    if (activeEvaluationPromise) {
      return activeEvaluationPromise;
    }

    activeEvaluationPromise = (async () => {
      if (stopped) return;
      if (!wakeConfig?.enabled) return;

      // 1. Fetch current binding row
      const binding = await journal.getWakeBinding(targetIdentity);
      if (stopped || !binding) return;

      // "One outstanding across submitting/accepted_awaiting_ack/uncertain/stale_held, exact scoped ack only."
      if (binding.deliveryState !== "idle") {
        return;
      }

      // 2. Query canonical obligations
      const obligations = await journal.getWakeObligations(targetIdentity);
      if (stopped || !obligations) return;
      const { unreadReplies, heldMessages, hasLateResult, snapshotFingerprint } = obligations;

      // If no unread replies and no held messages, nothing to notify
      if (unreadReplies.length === 0 && heldMessages.length === 0) {
        return;
      }

      // 3. Store prior acknowledged fingerprint so unchanged unread backlog never loops
      if (binding.lastAcknowledgedFingerprint === snapshotFingerprint) {
        return;
      }

      // 4. Enforce minInterval >= 15s
      const now = clock.now();
      if (binding.lastSubmittedAt && now - binding.lastSubmittedAt < minIntervalMs) {
        return;
      }

      if (stopped) return;

      // 5. Build snapshot with fresh wake ID
      const wakeId = randomUUID();
      const snapshot = {
        wakeId,
        replyCount: unreadReplies.length,
        heldCount: heldMessages.length,
        lateResult: hasLateResult,
      };

      const adapterBinding = {
        codexPath: wakeConfig.codexPath,
        codexHome: wakeConfig.codexHome,
        threadId: binding.threadId || threadId,
        bindingId: binding.bindingId || bindingId,
        generation: binding.generation ?? generation,
        enabled: true,
      };

      // 6. Persist submitting BEFORE invoking adapter
      await journal.setWakeSubmitting({
        targetIdentity,
        wakeId,
        fingerprint: snapshotFingerprint,
        submittedAt: now,
      });

      if (stopped) {
        await journal.setWakeUncertain({
          targetIdentity,
          wakeId,
          reason: "aborted",
        });
        return;
      }

      // 7. Invoke adapter with signal
      activeAbortController = new AbortController();
      let activeAdapter = adapter;
      if (!activeAdapter) {
        const mod = await import("./codex-wake-adapter.mjs");
        if (stopped) {
          activeAbortController = null;
          await journal.setWakeUncertain({
            targetIdentity,
            wakeId,
            reason: "aborted",
          });
          return;
        }
        activeAdapter = mod;
      }

      if (stopped) {
        activeAbortController = null;
        await journal.setWakeUncertain({
          targetIdentity,
          wakeId,
          reason: "aborted",
        });
        return;
      }

      try {
        const notifyFn = activeAdapter.notify || activeAdapter;
        activeInvocationPromise = notifyFn(adapterBinding, snapshot, {
          signal: activeAbortController.signal,
          runner: runner ?? wakeConfig.runner,
          timeoutMs: wakeConfig.timeoutMs,
        });

        const result = await activeInvocationPromise;

        if (result?.state === "accepted") {
          await journal.setWakeAccepted({
            targetIdentity,
            wakeId,
            receipt: result.receipt,
          });
        } else {
          await journal.setWakeUncertain({
            targetIdentity,
            wakeId,
            reason: result?.reason || (activeAbortController?.signal?.aborted ? "aborted" : "invocation_failed"),
          });
        }
      } catch (err) {
        await journal.setWakeUncertain({
          targetIdentity,
          wakeId,
          reason: (err.name === "AbortError" || activeAbortController?.signal?.aborted) ? "aborted" : "invocation_error",
        });
      } finally {
        activeAbortController = null;
        activeInvocationPromise = null;
      }
    })();

    try {
      await activeEvaluationPromise;
    } catch (err) {
      logger.error?.("Failed evaluating wake obligations", { error: err.message });
      throw err;
    } finally {
      activeEvaluationPromise = null;
    }
  }

  async function start() {
    if (stopped) throw coded("notifier_closed", "Notifier was stopped");
    if (started) return;
    started = true;

    // Initialize durable wake binding in journal
    await journal.initWakeBinding({
      targetIdentity,
      bindingId,
      threadId,
      generation,
    });

    if (stopped) return;

    if (wakeConfig?.enabled) {
      // Coalesce initial backlog once when explicitly enabled
      await evaluateObligations();

      if (stopped) return;

      timer = setInterval(() => {
        evaluateObligations().catch(() => {});
      }, timerIntervalMs);
      timer.unref?.();
    }
  }

  async function ackNotification({ requester, wakeId, generation: ackGen }) {
    if (requester !== targetIdentity) {
      throw coded(
        "foreign_access_denied",
        `Only bound target ${targetIdentity} can acknowledge wake notification (received ${requester})`,
      );
    }

    const outcome = await journal.ackWake({
      requester,
      wakeId,
      generation: ackGen,
    });

    // An acknowledgment clears the outstanding obligation; evaluate if new backlog arrived
    evaluateObligations().catch(() => {});

    return outcome;
  }

  async function status() {
    const binding = await journal.getWakeBinding(targetIdentity);
    if (!binding) return null;
    const obligations = await journal.getWakeObligations(targetIdentity).catch(() => null);

    return {
      deliveryState: binding.deliveryState,
      activeWakeId: binding.activeWakeId,
      receiptQueuedId: binding.receiptQueuedId,
      receiptThreadId: binding.receiptThreadId,
      pendingRepliesCount: obligations?.unreadReplies?.length ?? 0,
      heldMessagesCount: obligations?.heldMessages?.length ?? 0,
      hasLateResult: obligations?.hasLateResult ?? false,
    };
  }

  async function stop() {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }

    if (activeAbortController) {
      activeAbortController.abort();
    }

    if (activeEvaluationPromise) {
      await activeEvaluationPromise;
    }

    if (typeof adapter?.stop === "function") {
      await adapter.stop();
    }
  }

  return {
    start,
    evaluateObligations,
    notifyObligationChange() {
      evaluateObligations().catch(() => {});
    },
    ackNotification,
    status,
    stop,
  };
}

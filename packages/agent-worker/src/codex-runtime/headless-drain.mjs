/**
 * Persistent unattended drain for one explicitly enabled headless Codex profile.
 *
 * The trusted helper owns mailbox credentials and the open claim. This module
 * only composes its durable delivery resolver with HeadlessCodexRuntime; reply
 * and ack ordering remains inside the runtime + trusted transaction proxy.
 */

function codedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function validateInstanceId(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError("profileInstanceId is invalid");
  }
  return value;
}

export function createHeadlessCodexDrain({
  runtime,
  resolveDelivery,
  profileInstanceId,
  pollIntervalMs = 1_000,
  onDeliveryFailure = null,
  logger = console,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (runtime == null || typeof runtime.start !== "function") {
    throw new TypeError("runtime.start is required");
  }
  for (const method of ["recoverAfterRestart", "runDelivery", "stop"]) {
    if (typeof runtime[method] !== "function") {
      throw new TypeError(`runtime.${method} is required`);
    }
  }
  if (typeof resolveDelivery !== "function") {
    throw new TypeError("resolveDelivery is required");
  }
  validateInstanceId(profileInstanceId);
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60_000) {
    throw new TypeError("pollIntervalMs must be between 100 and 60000");
  }
  if (onDeliveryFailure != null && typeof onDeliveryFailure !== "function") {
    throw new TypeError("onDeliveryFailure must be a function");
  }

  let started = false;
  let stopping = false;
  let timer = null;
  let inFlight = null;
  let lastResult = null;
  /** @type {string | null} Coalesced trailing kick reason while a drain is in flight. */
  let pendingKickReason = null;

  async function runDrainAttempt(reason = "timer") {
    if (!started || stopping) return Object.freeze({ status: "stopped", reason });
    const operation = (async () => {
      const delivery = await resolveDelivery();
      if (delivery == null) {
        lastResult = Object.freeze({ status: "idle", reason });
        return lastResult;
      }
      try {
        const result = await runtime.runDelivery({
          profileInstanceId,
          ...delivery,
        });
        lastResult = Object.freeze({ ...result, reason });
        return lastResult;
      } catch (error) {
        if (onDeliveryFailure != null) {
          try {
            await onDeliveryFailure(error, delivery);
          } catch (recordError) {
            logger.error?.("triangle_headless_drain_failure_record_failed", {
              code: recordError?.code ?? null,
            });
          }
        }
        throw error;
      }
    })();
    inFlight = operation;
    try {
      return await operation;
    } finally {
      if (inFlight === operation) inFlight = null;
      if (pendingKickReason && started && !stopping) {
        const trailingReason = pendingKickReason;
        pendingKickReason = null;
        // Trailing kick: one follow-up drain after the in-flight attempt settles.
        // Do not await inside finally of a nested call — schedule microtask.
        queueMicrotask(() => {
          if (!started || stopping || inFlight != null) return;
          drainOnce(trailingReason).catch((error) => {
            logger.error?.("triangle_headless_drain_trailing_failed", {
              code: error?.code ?? null,
              reason: trailingReason,
            });
          });
        });
      }
    }
  }

  async function drainOnce(reason = "timer") {
    if (!started || stopping) return Object.freeze({ status: "stopped", reason });
    if (inFlight != null) {
      // Only watch kicks arm a trailing drain. Timer/schedule callers already
      // re-arm via schedule(); coalescing them would busy-loop after every turn.
      if (reason === "watch_hint" || reason === "watch_hint_trailing") {
        pendingKickReason = "watch_hint_trailing";
        return Object.freeze({
          status: "already_draining",
          pendingKick: true,
          reason: pendingKickReason,
        });
      }
      return Object.freeze({
        status: "already_draining",
        pendingKick: pendingKickReason != null,
        reason: pendingKickReason,
      });
    }
    return runDrainAttempt(reason);
  }

  /**
   * External watch/supervisor kick. Does not acquire a second claimer.
   * Idle → start drainOnce; already draining → pending trailing kick.
   */
  function kick({ reason = "watch_hint" } = {}) {
    if (typeof reason !== "string" || reason.length === 0 || reason.length > 64) {
      throw new TypeError("kick reason is invalid");
    }
    if (!started || stopping) return Object.freeze({ status: "stopped", reason });
    if (inFlight != null) {
      pendingKickReason = reason === "watch_hint" ? "watch_hint_trailing" : reason;
      return Object.freeze({ status: "pending", reason: pendingKickReason });
    }
    return drainOnce(reason);
  }

  function schedule() {
    if (!started || stopping || timer != null) return;
    timer = setTimer(async () => {
      timer = null;
      try {
        await drainOnce("timer");
      } catch (error) {
        logger.error?.("triangle_headless_drain_failed", {
          code: error?.code ?? null,
        });
      } finally {
        schedule();
      }
    }, pollIntervalMs);
    timer?.unref?.();
  }

  async function start({ runLoop = true } = {}) {
    if (started) return status();
    stopping = false;
    pendingKickReason = null;
    await runtime.start();
    try {
      const recovered = await runtime.recoverAfterRestart({ profileInstanceId });
      if ((recovered?.quarantined ?? 0) > 0) {
        throw codedError(
          "headless_drain_recovery_blocked",
          "restart recovery found quarantined work; refusing new mailbox claims",
          { quarantined: recovered.quarantined },
        );
      }
      started = true;
      if (runLoop) schedule();
      return status();
    } catch (error) {
      await runtime.stop();
      throw error;
    }
  }

  async function stop(options = {}) {
    stopping = true;
    pendingKickReason = null;
    if (timer != null) {
      clearTimer(timer);
      timer = null;
    }
    if (inFlight != null) {
      try {
        await inFlight;
      } catch {
        // The open helper transaction remains durable for restart recovery.
      }
    }
    started = false;
    await runtime.stop(options);
    return status();
  }

  function status() {
    return Object.freeze({
      started,
      stopping,
      draining: inFlight != null,
      pendingKick: pendingKickReason != null,
      pendingKickReason,
      profileInstanceId,
      lastResult,
    });
  }

  return Object.freeze({ start, stop, drainOnce, kick, status });
}

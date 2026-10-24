/**
 * Persistent unattended drain for one Cursor ACP shadow profile.
 *
 * Helper owns mailbox credentials and the open claim. This module only
 * composes the durable delivery resolver with HeadlessCursorAcpRuntime.
 * Reply-before-ack stays inside the runtime + trusted transaction proxy.
 *
 * Never joins the Codex headless pool. Never hosts grok-bot.
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

export function createHeadlessCursorAcpDrain({
  runtime,
  resolveDelivery,
  profileInstanceId,
  pollIntervalMs = 1_000,
  onDeliveryFailure = null,
  /**
   * Optional wake-driven idle cadence (createDrainIdlePolicy in
   * install-watch-dispatcher.mjs). Null keeps the timer claiming every
   * pollIntervalMs, exactly as before.
   */
  idlePolicy = null,
  logger = console,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (runtime == null || typeof runtime.start !== "function") {
    throw new TypeError("runtime.start is required");
  }
  for (const method of ["runDelivery", "stop"]) {
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
  if (
    idlePolicy != null
    && (typeof idlePolicy.evaluateTick !== "function" || typeof idlePolicy.recordAttempt !== "function")
  ) {
    throw new TypeError("idlePolicy must provide evaluateTick and recordAttempt");
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
      // The resolver says `empty` only when the helper listed the mailbox and
      // found nothing pending; any other outcome keeps the lane on its poll cadence.
      const outcome = {};
      let delivery;
      try {
        delivery = await resolveDelivery({ outcome });
      } catch (error) {
        idlePolicy?.recordAttempt({ empty: false });
        throw error;
      }
      if (delivery == null) {
        lastResult = Object.freeze({ status: "idle", reason });
        idlePolicy?.recordAttempt({ empty: outcome.empty === true });
        return lastResult;
      }
      try {
        const result = await runtime.runDelivery({
          profileInstanceId,
          ...delivery,
        });
        lastResult = Object.freeze({ ...result, reason });
        idlePolicy?.recordAttempt({ empty: false });
        return lastResult;
      } catch (error) {
        idlePolicy?.recordAttempt({ empty: false });
        if (onDeliveryFailure != null) {
          try {
            await onDeliveryFailure(error, delivery);
          } catch (recordError) {
            logger.error?.("triangle_cursor_acp_drain_failure_record_failed", {
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
        // One trailing drainOnce claims at most one delivery. Further backlog
        // waits for the pollIntervalMs timer. Do not await inside finally — a
        // nested drainOnce would re-enter this finally, and do not loop here.
        queueMicrotask(() => {
          if (!started || stopping || inFlight != null) return;
          drainOnce(trailingReason).catch((error) => {
            logger.error?.("triangle_cursor_acp_drain_trailing_failed", {
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
      // Timer ticks already re-arm via schedule(). Coalescing them would
      // busy-loop. Only watch hints arm a trailing drain, and the poll
      // interval itself stays pollIntervalMs.
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
   * Install-watch hint for this profile. Uses the supervisor-owned drain;
   * does not open a second claimer or watch listener.
   * Idle → start drainOnce; already draining → one coalesced trailing kick.
   * That trailing kick drains one delivery. Any further backlog falls to the
   * existing pollIntervalMs timer rather than another kick loop.
   */
  function kick({ reason = "watch_hint" } = {}) {
    if (typeof reason !== "string" || reason.length === 0 || reason.length > 64) {
      throw new TypeError("kick reason is invalid");
    }
    if (!started || stopping) return Object.freeze({ status: "stopped", reason });
    try {
      runtime.noteWakeInvoked?.();
    } catch {
      // Diagnostic handoff only; never block watch fan-out.
    }
    if (inFlight != null) {
      pendingKickReason = reason === "watch_hint" ? "watch_hint_trailing" : reason;
      return Object.freeze({ status: "pending", reason: pendingKickReason });
    }
    // Admit-only: the install cursor must advance without waiting on claim.
    const startedDrain = drainOnce(reason);
    if (startedDrain && typeof startedDrain.then === "function") {
      startedDrain.catch((error) => {
        logger.error?.("triangle_cursor_acp_drain_kick_failed", {
          code: error?.code ?? null,
          reason,
        });
      });
    }
    return Object.freeze({ status: "accepted", reason });
  }

  function schedule() {
    if (!started || stopping || timer != null) return;
    timer = setTimer(async () => {
      timer = null;
      try {
        // Wake-driven idle lanes stay quiet until the safety interval; every
        // other tick claims as it always did.
        const tick = idlePolicy ? idlePolicy.evaluateTick() : { skip: false, reason: "timer" };
        if (!tick.skip) await drainOnce(tick.reason);
      } catch (error) {
        logger.error?.("triangle_cursor_acp_drain_failed", {
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
      if (typeof runtime.recoverAfterRestart === "function") {
        const recovered = await runtime.recoverAfterRestart({ profileInstanceId });
        if ((recovered?.quarantined ?? 0) > 0) {
          throw codedError(
            "cursor_acp_drain_recovery_blocked",
            "restart recovery found quarantined work; refusing new mailbox claims",
            { quarantined: recovered.quarantined },
          );
        }
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
        // Open helper transaction remains durable for restart recovery.
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
      pollIntervalMs,
      profileInstanceId,
      lastResult,
      idle: idlePolicy?.status?.() ?? null,
    });
  }

  return Object.freeze({
    start,
    stop,
    drainOnce,
    kick,
    status,
  });
}

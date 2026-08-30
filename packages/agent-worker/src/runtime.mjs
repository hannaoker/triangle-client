function assertInterface(value, method, name) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`${name}.${method} must be a function`);
  }
}

function abortError() {
  const error = new Error("Agent worker operation aborted");
  error.name = "AbortError";
  return error;
}

async function abortable(operation, signal) {
  if (!signal) return operation;
  if (signal.aborted) {
    Promise.resolve(operation).catch(() => {});
    throw abortError();
  }
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(abortError());
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([Promise.resolve(operation), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function defaultSleep(milliseconds, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      operation();
    };
    const onAbort = () => finish(() => reject(abortError()));
    const timer = setTimeout(() => finish(resolve), milliseconds);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function randomConfigurationError() {
  const error = new TypeError("random must return a finite number between 0 and 1");
  error.code = "ERR_AGENT_WORKER_RANDOM";
  return error;
}

export function createAgentWorker({
  deliveryClient,
  runner,
  pollIntervalMs = 15_000,
  maxIdlePollIntervalMs = pollIntervalMs,
  maxBackoffMs = 300_000,
  idleJitterRatio = 0,
  random = Math.random,
  logger = console,
}) {
  assertInterface(deliveryClient, "listUnread", "deliveryClient");
  assertInterface(
    deliveryClient,
    "completeAndAcknowledge",
    "deliveryClient",
  );
  assertInterface(runner, "run", "runner");
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new TypeError("pollIntervalMs must be a positive integer");
  }
  if (!Number.isSafeInteger(maxBackoffMs) || maxBackoffMs < pollIntervalMs) {
    throw new TypeError("maxBackoffMs must be at least pollIntervalMs");
  }
  if (!Number.isSafeInteger(maxIdlePollIntervalMs) || maxIdlePollIntervalMs < pollIntervalMs) {
    throw new TypeError("maxIdlePollIntervalMs must be at least pollIntervalMs");
  }
  if (!Number.isFinite(idleJitterRatio) || idleJitterRatio < 0 || idleJitterRatio > 1) {
    throw new TypeError("idleJitterRatio must be a finite number between 0 and 1");
  }
  if (typeof random !== "function") throw new TypeError("random must be a function");

  function idleDelay(milliseconds) {
    const sample = random();
    if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
      throw randomConfigurationError();
    }
    const factor = 1 + ((sample * 2) - 1) * idleJitterRatio;
    return Math.max(
      pollIntervalMs,
      Math.min(maxIdlePollIntervalMs, Math.round(milliseconds * factor)),
    );
  }

  let activeCycle;

  async function executeCycle(signal) {
    const messages = await abortable(deliveryClient.listUnread({ signal }), signal);
    if (!Array.isArray(messages)) {
      throw new TypeError("deliveryClient.listUnread must return an array");
    }
    if (messages.length === 0) return { found: 0, processed: 0 };

    const message = messages[0];
    const completion = await abortable(deliveryClient.completeAndAcknowledge(
      message,
      (request, options) => abortable(
        runner.run(request, { signal: options?.signal ?? signal }),
        options?.signal ?? signal,
      ),
      { signal },
    ), signal);
    return {
      found: messages.length,
      processed: completion?.claimed === false ? 0 : 1,
    };
  }

  const worker = {
    runOnce({ signal } = {}) {
      if (activeCycle) return activeCycle;
      activeCycle = executeCycle(signal).finally(() => {
        activeCycle = undefined;
      });
      return activeCycle;
    },

    async watch({
      signal,
      sleep = defaultSleep,
    } = {}) {
      let processed = 0;
      let backoffMs = pollIntervalMs;
      let idleBackoffMs = pollIntervalMs;
      while (!signal?.aborted) {
        try {
          const result = await worker.runOnce({ signal });
          processed += result.processed;
          backoffMs = pollIntervalMs;
          if (result.processed === 0 && !signal?.aborted) {
            await abortable(sleep(idleDelay(idleBackoffMs), { signal }), signal);
            idleBackoffMs = Math.min(idleBackoffMs * 2, maxIdlePollIntervalMs);
          } else {
            idleBackoffMs = pollIntervalMs;
          }
        } catch (error) {
          if (error?.code === "ERR_AGENT_WORKER_RANDOM") throw error;
          if (signal?.aborted) break;
          idleBackoffMs = pollIntervalMs;
          logger.error?.("agent_worker_cycle_failed", {
            error: "Worker cycle failed",
          });
          if (!signal?.aborted) {
            await abortable(sleep(backoffMs, { signal }), signal).catch((error) => {
              if (!signal?.aborted) throw error;
            });
          }
          backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
        }
      }
      return { processed, stopped: true };
    },
  };
  return worker;
}

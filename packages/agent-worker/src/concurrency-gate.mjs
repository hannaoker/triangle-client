function abortError() {
  const error = new Error("Reasoning admission aborted");
  error.name = "AbortError";
  return error;
}

export function createConcurrencyGate({ limit = 2 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("limit must be a positive integer");
  }

  let active = 0;
  const waiting = [];

  function admitNext() {
    while (active < limit && waiting.length > 0) {
      const entry = waiting.shift();
      if (entry.signal?.aborted) {
        entry.cleanup();
        entry.reject(abortError());
        continue;
      }
      active += 1;
      entry.cleanup();
      entry.resolve();
    }
  }

  function acquire(signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const entry = {
        signal,
        resolve,
        reject,
        cleanup() { signal?.removeEventListener?.("abort", onAbort); },
      };
      const onAbort = () => {
        const index = waiting.indexOf(entry);
        if (index < 0) return;
        waiting.splice(index, 1);
        entry.cleanup();
        reject(abortError());
      };
      signal?.addEventListener?.("abort", onAbort, { once: true });
      waiting.push(entry);
      admitNext();
    });
  }

  return Object.freeze({
    async run(operation, { signal } = {}) {
      if (typeof operation !== "function") {
        throw new TypeError("operation must be a function");
      }
      await acquire(signal);
      try {
        return await operation();
      } finally {
        active -= 1;
        admitNext();
      }
    },
  });
}

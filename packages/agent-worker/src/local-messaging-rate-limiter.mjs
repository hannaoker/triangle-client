import { coded } from "./local-messaging-errors.mjs";

export function createPerSenderRateLimiter({
  maxRequestsPerWindow = 60,
  windowMs = 60000,
} = {}) {
  const senderHistory = new Map();

  function prune(history, cutoff) {
    while (history.length > 0 && history[0].time < cutoff) {
      history.shift();
    }
  }

  return {
    check(senderId) {
      if (!senderId) throw coded("invalid_sender", "senderId required for rate limiting");
      const now = Date.now();
      const cutoff = now - windowMs;

      let history = senderHistory.get(senderId);
      if (!history) {
        history = [];
        senderHistory.set(senderId, history);
      }

      prune(history, cutoff);

      if (history.length >= maxRequestsPerWindow) {
        throw coded(
          "rate_limit_exceeded",
          `Rate limit of ${maxRequestsPerWindow} requests per ${windowMs}ms exceeded`,
        );
      }
      return true;
    },

    consume(senderId) {
      if (!senderId) return;
      let history = senderHistory.get(senderId);
      if (!history) {
        history = [];
        senderHistory.set(senderId, history);
      }
      history.push({ time: Date.now() });
    },

    reserve(senderId) {
      this.check(senderId);
      let history = senderHistory.get(senderId);
      if (!history) {
        history = [];
        senderHistory.set(senderId, history);
      }
      const entry = { time: Date.now() };
      history.push(entry);

      let settled = false;
      return {
        commit() {
          if (settled) return;
          settled = true;
        },
        rollback() {
          if (settled) return;
          settled = true;
          const idx = history.indexOf(entry);
          if (idx !== -1) {
            history.splice(idx, 1);
          }
        },
        release() {
          this.rollback();
        },
      };
    },

    checkAndConsume(senderId) {
      this.check(senderId);
      this.consume(senderId);
      return true;
    },

    reset() {
      senderHistory.clear();
    },
  };
}

// Server-side exchange cap that does not depend on caller-supplied linking: callers
// that omit inReplyTo restart at loop depth 1, so ping-pong between two agents is
// also bounded by how many messages one sender/recipient pair may exchange (both
// directions share the budget) within a sliding window. Reservations follow the
// same reserve/commit/rollback protocol as the per-sender limiter.
export function createPairExchangeLimiter({
  maxExchanges = 10,
  windowMs = 10 * 60 * 1000,
} = {}) {
  if (!Number.isSafeInteger(maxExchanges) || maxExchanges < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw coded("invalid_limiter_options", "maxExchanges and windowMs must be positive integers");
  }
  const pairHistory = new Map();
  const keyFor = (a, b) => (a < b ? `${a}\0${b}` : `${b}\0${a}`);

  return {
    reserve(senderId, recipientId) {
      if (!senderId || !recipientId) throw coded("invalid_sender", "sender and recipient required for exchange limiting");
      const now = Date.now();
      const key = keyFor(senderId, recipientId);
      const entries = pairHistory.get(key) ?? [];
      while (entries.length > 0 && entries[0].time <= now - windowMs) entries.shift();
      if (entries.length >= maxExchanges) {
        pairHistory.set(key, entries);
        throw coded(
          "exchange_limit_exceeded",
          `More than ${maxExchanges} messages between these agents within ${windowMs}ms; assuming a conversation loop`,
        );
      }
      const entry = { time: now };
      entries.push(entry);
      pairHistory.set(key, entries);

      let settled = false;
      return {
        commit() {
          settled = true;
        },
        // A duplicate retry or a rejected admission is not an exchange.
        rollback() {
          if (settled) return;
          settled = true;
          const index = entries.indexOf(entry);
          if (index !== -1) entries.splice(index, 1);
        },
      };
    },

    reset() {
      pairHistory.clear();
    },
  };
}

// Bounded LRU: reads refresh an entry, inserts evict the least recently used.
function createBoundedLru(maxEntries) {
  const entries = new Map();
  return {
    get(key) {
      if (!entries.has(key)) return undefined;
      const value = entries.get(key);
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
    clear() {
      entries.clear();
    },
  };
}

export function createConversationLoopTracker({
  maxLoopDepth = 10,
  journal = null,
  maxTrackedMessages = 10000,
} = {}) {
  if (!Number.isSafeInteger(maxTrackedMessages) || maxTrackedMessages < 1) {
    throw coded("invalid_tracker_options", "maxTrackedMessages must be a positive integer");
  }
  // Bounded in-memory depth by messageId and requestId; the durable journal answers for evicted entries.
  const depthByMessageId = createBoundedLru(maxTrackedMessages);
  const depthByRequestId = createBoundedLru(maxTrackedMessages);

  return {
    async resolveParentDepth(parentMessageId) {
      if (!parentMessageId) return null;

      // 1. In-memory check
      const remembered = depthByMessageId.get(parentMessageId);
      if (remembered !== undefined) return remembered;

      // 2. Injected durable ancestry seam (journal)
      if (journal && typeof journal.getRecord === "function") {
        const record = await journal.getRecord(parentMessageId);
        if (record) {
          const storedDepth =
            record.metadata?._loopDepth ||
            record.metadata?.loopDepth ||
            (record.inReplyTo ? 2 : 1);
          depthByMessageId.set(parentMessageId, storedDepth);
          if (record.requestId) depthByRequestId.set(record.requestId, storedDepth);
          return storedDepth;
        }
      }

      return null;
    },

    async calculateDepth({
      claims = null,
      inReplyTo = null,
      messageId = null,
      requestId = null,
    } = {}) {
      const serverLimit = maxLoopDepth;
      const claimLimit = claims?.maxLoopDepth || null;
      const effectiveLimit = claimLimit ? Math.min(serverLimit, claimLimit) : serverLimit;

      let effectiveDepth = (claims?.loopDepth && typeof claims.loopDepth === "number" && claims.loopDepth >= 1)
        ? claims.loopDepth
        : 1;

      // Always honor parent regardless loopDepth: fail unknown parent, prevent untrusted reset
      if (claims?.parentMessageId) {
        const parentDepth = await this.resolveParentDepth(claims.parentMessageId);
        if (parentDepth === null) {
          throw coded("parent_not_found", `Parent message ${claims.parentMessageId} not found in causal ancestry`);
        }
        effectiveDepth = Math.max(effectiveDepth, parentDepth + 1);
      }

      if (inReplyTo && inReplyTo !== claims?.parentMessageId) {
        const parentDepth = await this.resolveParentDepth(inReplyTo);
        if (parentDepth === null) {
          throw coded("parent_not_found", `Parent message ${inReplyTo} not found in causal ancestry`);
        }
        effectiveDepth = Math.max(effectiveDepth, parentDepth + 1);
      }

      if (effectiveDepth > effectiveLimit) {
        throw coded(
          "loop_limit_exceeded",
          `Conversation loop depth of ${effectiveDepth} exceeds maximum limit of ${effectiveLimit}`,
        );
      }

      return effectiveDepth;
    },

    commitAdmission({ messageId, requestId, depth, isDuplicate = false }) {
      // Duplicate retry does not advance depth
      if (isDuplicate) return;

      if (messageId) depthByMessageId.set(messageId, depth);
      if (requestId) depthByRequestId.set(requestId, depth);
    },

    getDepth(id) {
      if (!id) return 1;
      return depthByMessageId.get(id) || depthByRequestId.get(id) || 1;
    },

    reset() {
      depthByMessageId.clear();
      depthByRequestId.clear();
    },
  };
}

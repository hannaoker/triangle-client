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

export function createConversationLoopTracker({
  maxLoopDepth = 10,
  journal = null,
} = {}) {
  // Store depth by messageId and requestId for in-memory lookup
  const depthByMessageId = new Map();
  const depthByRequestId = new Map();

  return {
    async resolveParentDepth(parentMessageId) {
      if (!parentMessageId) return null;

      // 1. In-memory check
      if (depthByMessageId.has(parentMessageId)) {
        return depthByMessageId.get(parentMessageId);
      }

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

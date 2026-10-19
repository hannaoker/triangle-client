import { awaitWithSignal } from "../../triangle-cli/src/workload.mjs";
import { createHash } from "node:crypto";
import {
  deriveTrustedClaimId,
  deriveTrustedReplyIdempotencyKey,
} from "../../agent-worker/src/helper-transaction-proxy.mjs";
export const replyDigest = (text) =>
  createHash("sha256").update(text, "utf8").digest("hex");
export function createCustodian({
  store,
  transport,
  runner,
  agentId,
  now = Date.now,
  hook,
}) {
  const stamp = () => now();
  async function cycle({ signal } = {}) {
    return store.withLock(async () => {
      const health = (state) =>
        store.writeHealth({ state, updatedAt: stamp() });
      const save = async (r, phase, extra = {}) => {
        Object.assign(r, extra, { phase, updatedAt: stamp() });
        store.save(r);
        await hook?.(phase, r);
      };
      signal?.throwIfAborted();
      try {
        await transport.verify({ signal });
      } catch (error) {
        health("paused");
        throw error;
      }
      let r = store.get();
      if (!r) {
        const list = await transport.list({ signal });
        if (!list.length) {
          health("idle");
          return { state: "idle" };
        }
        const d = list[0];
        r = {
          schema: 1,
          agentId,
          instanceId: store.instanceId,
          deliveryId: d.deliveryId,
          roomId: d.roomId,
          eventId: d.eventId,
          roomSequence: d.roomSequence,
          claimId: deriveTrustedClaimId(store.instanceId, d.deliveryId),
          replyKey: deriveTrustedReplyIdempotencyKey(
            store.instanceId,
            d.deliveryId,
          ),
          phase: "prepared",
          failureCount: 0,
          createdAt: stamp(),
          updatedAt: stamp(),
        };
        store.save(r);
        await hook?.("prepared", r);
      }
      if (r.phase === "quarantined") {
        health("quarantined");
        return { state: "quarantined" };
      }
      if (r.phase === "failed" && r.nextAttemptAt > stamp()) {
        health("failed");
        return { state: "failed" };
      }
      const recovery = ["executing", "replying", "replied"].includes(r.phase);
      // Even verified replies reacquire the deterministic claim before ACK.
      let claim;
      try {
        claim = await transport.claim(r, { signal });
      } catch (error) {
        health("ownership_lost");
        throw error;
      }
      const controller = new AbortController();
      const ownedSignal = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
      let timer,
        expiryTimer,
        expiresAt = 0,
        renewal,
        stopped = false;
      function schedule(lease) {
        if (stopped) return;
        const expiry = Date.parse(lease?.leaseExpiresAt);
        if (!Number.isFinite(expiry) || expiry <= stamp()) {
          controller.abort(Error("ownership_lost"));
          return;
        }
        expiresAt = expiry;
        clearTimeout(expiryTimer);
        expiryTimer = setTimeout(
          () => controller.abort(Error("ownership_lost")),
          Math.max(1, expiry - stamp()),
        );
        timer = setTimeout(
          () => {
            renewal = (async () => {
              try {
                const next = await transport.claim(r, { signal: ownedSignal });
                schedule(next);
              } catch {
                controller.abort(Error("ownership_lost"));
              }
            })();
          },
          Math.max(1, Math.min(30000, (expiry - stamp()) / 3)),
        );
      }
      schedule(claim);
      const assertOwner = () => {
        if (stamp() >= expiresAt) controller.abort(Error("ownership_lost"));
        ownedSignal.throwIfAborted();
      };
      try {
        assertOwner();
        health("working");
        if (recovery) {
          const found = r.receiptOnly
            ? null
            : await transport.findReply(r, { signal: ownedSignal });
          assertOwner();
          if (found && r.replyDigest) {
            await save(r, "replied", { replyEventId: found.eventId });
          } else if (r.phase !== "replied" || !r.receiptOnly) {
            await save(r, "quarantined", { reason: "unknown_execution" });
            health("quarantined");
            return { state: "quarantined" };
          }
        } else {
          await save(r, "claimed");
          const inbound = await transport.inbound(r, { signal: ownedSignal });
          assertOwner();
          if (inbound.replyRequired === false) {
            await save(r, "replied", { receiptOnly: true });
          } else {
            await save(r, "executing");
            assertOwner();
            let result;
            try {
              result = await awaitWithSignal(
                runner.run(inbound, { signal: ownedSignal }),
                ownedSignal,
              );
            } catch (error) {
              assertOwner();
              if (error?.knownFailure === true) {
                const count = r.failureCount + 1;
                await save(r, count >= 3 ? "quarantined" : "failed", {
                  failureCount: count,
                  reason: "runner_failed",
                  nextAttemptAt: stamp() + Math.min(60000, 1000 * 2 ** count),
                });
                health(r.phase);
                return { state: r.phase };
              }
              await save(r, "quarantined", { reason: "unknown_execution" });
              health("quarantined");
              return { state: "quarantined" };
            }
            assertOwner();
            if (
              result?.status !== "completed" ||
              typeof result.text !== "string" ||
              !result.text.trim() ||
              Buffer.byteLength(result.text) > 32768
            ) {
              await save(r, "quarantined", { reason: "invalid_runner_result" });
              health("quarantined");
              return { state: "quarantined" };
            }
            await save(r, "replying", {
              replyDigest: replyDigest(result.text),
            });
            assertOwner();
            let found;
            try {
              found = await transport.reply(r, result.text, {
                signal: ownedSignal,
              });
            } catch {
              assertOwner();
              found = await transport.findReply(r, { signal: ownedSignal });
              if (!found) {
                await save(r, "quarantined", { reason: "reply_unresolved" });
                health("quarantined");
                return { state: "quarantined" };
              }
            }
            assertOwner();
            await save(r, "replied", { replyEventId: found.eventId });
          }
        }
        assertOwner();
        await transport.ack(r, { signal: ownedSignal });
        assertOwner();
        await hook?.("acknowledged", r);
        store.clear();
        health("completed");
        return { state: "completed" };
      } catch (error) {
        if (
          !ownedSignal.aborted &&
          error?.code === "invalid_authority_response" &&
          ["executing", "replying", "replied"].includes(r.phase)
        ) {
          await save(r, "quarantined", { reason: "reply_unresolved" });
          health("quarantined");
          return { state: "quarantined" };
        }
        health(controller.signal.aborted ? "ownership_lost" : "failed");
        throw error;
      } finally {
        stopped = true;
        clearTimeout(timer);
        clearTimeout(expiryTimer);
        controller.abort();
        await renewal;
      }
    });
  }
  return Object.freeze({
    cycle,
    retry: (deliveryId) => store.retry(deliveryId),
  });
}

import { createPeerEngineManager } from "./peer-engine-manager.mjs";
import { createPeerDrainService } from "./peer-drain-service.mjs";
import { createCommandRunner } from "./command-runner.mjs";
import { createConcurrencyGate } from "./concurrency-gate.mjs";

function waitForAbort(signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal?.addEventListener?.("abort", resolve, { once: true });
  });
}

function coded(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function createPeerLane({
  peerConfigs,
  createPeerEngine = createPeerEngineManager,
  createPeerDrain = createPeerDrainService,
  createRunner = createCommandRunner,
  gate = createConcurrencyGate(),
  logger = { info() {}, warn() {}, error() {} },
} = {}) {
  if (!Array.isArray(peerConfigs)) {
    throw new TypeError("peerConfigs must be an array");
  }

  const entries = peerConfigs.map((config) => {
    return {
      config,
      engineManager: null,
      drain: null,
      initError: null,
      lastError: null,
    };
  });

  let isWatching = false;
  let closed = false;

  function ensureEntry(entry) {
    if (closed) {
      throw coded("peer_lane_closed", "Peer lane is closed");
    }
    if (entry.drain && entry.engineManager) {
      return { engineManager: entry.engineManager, drain: entry.drain };
    }
    if (entry.initError) {
      throw entry.initError;
    }
    try {
      const context = Object.freeze({
        instanceId: entry.config.profileInstanceId,
        peerProfile: entry.config.profile,
      });
      const adapterRunner = createRunner(entry.config.runnerConfig, context);
      if (!adapterRunner || typeof adapterRunner.run !== "function") {
        throw new TypeError("createRunner must return a runner");
      }
      const runner = Object.freeze({
        run(request, options = {}) {
          return gate.run(
            () => adapterRunner.run(request, options),
            { signal: options.signal },
          );
        },
      });
      const engineManager = createPeerEngine({
        profile: entry.config.profile,
        profileInstanceId: entry.config.profileInstanceId,
        stateRoot: entry.config.stateRoot,
        allowedPeers: entry.config.allowedPeers,
        routes: entry.config.routes,
        relay: entry.config.relay,
        relayOnly: entry.config.relayOnly,
        directOnly: entry.config.directOnly,
        relayUrl: entry.config.relayUrl,
        binaryPath: entry.config.engineBinaryPath,
        logger,
      });
      const drain = createPeerDrain({
        stateRoot: entry.config.stateRoot,
        profile: entry.config.profile,
        profileInstanceId: entry.config.profileInstanceId,
        engineManager,
        runner,
        routes: entry.config.routes,
        pollIntervalMs: entry.config.pollIntervalMs,
        runnerTimeoutMs: entry.config.runnerTimeoutMs,
        logger,
      });
      if (!drain || typeof drain.step !== "function") {
        throw new TypeError("createPeerDrain must return a drain service");
      }
      entry.engineManager = engineManager;
      entry.drain = drain;
      return { engineManager, drain };
    } catch (error) {
      entry.initError = error;
      entry.lastError = error;
      throw error;
    }
  }

  return Object.freeze({
    get isWatching() {
      return isWatching;
    },

    async runOnce({ signal } = {}) {
      if (closed) throw coded("peer_lane_closed", "Peer lane is closed");
      if (isWatching) {
        throw coded("peer_lane_busy", "runOnce cannot run while watch() is active");
      }
      return Promise.all(
        entries.map(async (entry) => {
          const { config } = entry;
          try {
            const { engineManager, drain } = ensureEntry(entry);
            await engineManager.start({ signal });
            try {
              const outcome = await drain.step({ signal });
              return {
                profile: config.profile,
                profileInstanceId: config.profileInstanceId,
                instanceId: config.profileInstanceId,
                outcome,
              };
            } finally {
              try {
                await engineManager.stop();
              } catch (error) {
                logger.warn?.("triangle_client_peer_engine_stop_failed", {
                  profile: config.profile,
                  profileInstanceId: config.profileInstanceId,
                  error: "Peer engine could not be stopped after one-shot drain",
                });
              }
            }
          } catch (error) {
            if (signal?.aborted || error?.name === "AbortError") throw error;
            entry.lastError = error;
            logger.error?.("triangle_client_peer_instance_failed", {
              profile: config.profile,
              profileInstanceId: config.profileInstanceId,
              error: "Peer instance cycle failed",
            });
            return {
              profile: config.profile,
              profileInstanceId: config.profileInstanceId,
              instanceId: config.profileInstanceId,
              failed: true,
            };
          }
        }),
      );
    },

    async watch({ signal, sleep, runDurableWakeLoop } = {}) {
      if (closed) throw coded("peer_lane_closed", "Peer lane is closed");
      if (isWatching) {
        throw coded("peer_lane_busy", "watch() is already active");
      }
      if (typeof runDurableWakeLoop !== "function") {
        throw new TypeError("runDurableWakeLoop must be a function");
      }
      isWatching = true;
      try {
        const profileLoops = entries.map((entry) => {
          return runDurableWakeLoop({
            start: async () => {
              const { engineManager, drain } = ensureEntry(entry);
              try {
                await engineManager.start({ signal });
                const drainPromise = typeof drain.start === "function"
                  ? drain.start({
                      runLoop: true,
                      signal,
                      sleep,
                      pollIntervalMs: entry.config.pollIntervalMs,
                    })
                  : drain.step({ signal });
                await drainPromise;
                if (!signal?.aborted) {
                  await waitForAbort(signal);
                }
                return {
                  status: "stopped",
                  skipped: false,
                  profileInstanceId: entry.config.profileInstanceId,
                };
              } catch (err) {
                entry.lastError = err;
                throw err;
              } finally {
                try {
                  if (typeof drain.stop === "function") {
                    await drain.stop();
                  } else if (typeof drain.close === "function") {
                    await drain.close();
                  }
                } catch {}
                try {
                  await engineManager.stop();
                } catch {}
              }
            },
            stop: async () => {
              try {
                if (entry.drain) {
                  if (typeof entry.drain.stop === "function") {
                    await entry.drain.stop();
                  } else if (typeof entry.drain.close === "function") {
                    await entry.drain.close();
                  }
                }
              } catch {}
              try {
                if (entry.engineManager) {
                  await entry.engineManager.stop();
                }
              } catch {}
            },
            logEvent: "triangle_client_peer_wake_failed",
            logMessage: "Peer engine drain failed",
          });
        });

        const settled = await Promise.all(profileLoops);
        return settled.map((res, i) => {
          if (res) return res;
          const config = entries[i].config;
          return {
            status: "stopped",
            skipped: false,
            profileInstanceId: config.profileInstanceId,
          };
        });
      } finally {
        isWatching = false;
      }
    },

    async sendPeerMessage({
      profileInstanceId,
      toEndpointId,
      text,
      requestId,
      messageId,
      signal,
    } = {}) {
      if (closed) throw coded("peer_lane_closed", "Peer lane is closed");
      if (!isWatching) {
        throw coded("peer_lane_not_running", "sendPeerMessage requires an active watch() session");
      }
      signal?.throwIfAborted();
      if (typeof profileInstanceId !== "string" || profileInstanceId.length === 0) {
        throw new TypeError("Unknown peer profileInstanceId");
      }
      const entry = entries.find((e) => e.config.profileInstanceId === profileInstanceId);
      if (!entry) {
        throw new TypeError("Unknown peer profileInstanceId");
      }
      if (
        typeof toEndpointId !== "string" ||
        !entry.config.allowedPeers.includes(toEndpointId)
      ) {
        const err = new TypeError("Recipient is not in allowedPeers");
        err.code = "recipient_not_allowed";
        throw err;
      }
      const route = entry.config.routes instanceof Map
        ? entry.config.routes.get(toEndpointId)
        : entry.config.routes?.[toEndpointId];
      if (!route || route.id !== toEndpointId) {
        const err = new TypeError("No configured route for recipient");
        err.code = "route_unavailable";
        throw err;
      }

      const { drain } = ensureEntry(entry);
      if (typeof drain.sendRequest !== "function") {
        throw new TypeError("Peer drain does not support sendRequest");
      }

      return await drain.sendRequest({
        toEndpointId,
        text,
        requestId,
        messageId,
        signal,
      });
    },

    async pendingPeerReplies({ profileInstanceId, inReplyTo, requestId, limit } = {}) {
      if (closed) throw coded("peer_lane_closed", "Peer lane is closed");
      const selected = profileInstanceId === undefined
        ? entries
        : entries.filter((entry) => entry.config.profileInstanceId === profileInstanceId);
      if (profileInstanceId !== undefined && selected.length === 0) {
        throw new TypeError("Unknown peer profileInstanceId");
      }
      const results = [];
      for (const entry of selected) {
        let drain;
        try {
          drain = ensureEntry(entry).drain;
        } catch {
          continue;
        }
        const replies = await (drain.pendingReplies?.({ inReplyTo, requestId, limit }) ?? []);
        for (const reply of replies) {
          results.push({
            profile: entry.config.profile,
            profileInstanceId: entry.config.profileInstanceId,
            ...reply,
          });
        }
      }
      return results;
    },

    async consumePeerReply({ profileInstanceId, fromEndpointId, messageId } = {}) {
      if (closed) throw coded("peer_lane_closed", "Peer lane is closed");
      if (typeof profileInstanceId !== "string" || profileInstanceId.length === 0) {
        throw new TypeError("Unknown peer profileInstanceId");
      }
      const entry = entries.find((e) => e.config.profileInstanceId === profileInstanceId);
      if (!entry) {
        throw new TypeError("Unknown peer profileInstanceId");
      }
      const { drain } = ensureEntry(entry);
      if (typeof drain.consumeReply !== "function") {
        throw new TypeError("Peer drain does not support received-reply consumption");
      }
      const outcome = await drain.consumeReply({ fromEndpointId, messageId });
      return {
        profileInstanceId,
        ...outcome,
      };
    },

    async resolvePeerRecord({
      profileInstanceId,
      fromEndpointId,
      messageId,
      action,
      operationId,
      expectedRevision,
    } = {}) {
      if (closed) throw coded("peer_lane_closed", "Peer lane is closed");
      if (typeof profileInstanceId !== "string" || profileInstanceId.length === 0) {
        throw new TypeError("Unknown peer profileInstanceId");
      }
      const entry = entries.find((e) => e.config.profileInstanceId === profileInstanceId);
      if (!entry) {
        throw new TypeError("Unknown peer profileInstanceId");
      }
      const { drain } = ensureEntry(entry);
      if (typeof drain.resolvePeerRecord !== "function") {
        throw new TypeError("Peer drain does not support resolvePeerRecord");
      }
      return await drain.resolvePeerRecord({
        fromEndpointId,
        messageId,
        action,
        operationId,
        expectedRevision,
      });
    },

    async peerStatus({ profileInstanceId } = {}) {
      const selected = profileInstanceId === undefined
        ? entries
        : entries.filter((entry) => entry.config.profileInstanceId === profileInstanceId);
      if (profileInstanceId !== undefined && selected.length === 0) {
        throw new TypeError("Unknown peer profileInstanceId");
      }
      return selected.map((entry) => {
        let phaseCounts = {};
        let held = [];
        let replyFailed = [];
        let rejected = [];
        let totalRecords = 0;
        let journalFull = false;

        try {
          ensureEntry(entry);
        } catch {
          // ignore lazy init error here; entry.lastError captures it
        }

        if (entry.drain) {
          try {
            const status = entry.drain.status();
            totalRecords = status.totalRecords ?? 0;
            journalFull = status.journalFull ?? false;
            for (const r of status) {
              phaseCounts[r.phase] = (phaseCounts[r.phase] ?? 0) + 1;
              if (r.phase === "held") {
                held.push({
                  messageId: r.message_id,
                  fromEndpointId: r.sender,
                  reason: r.reason ?? null,
                });
              } else if (r.phase === "reply_failed") {
                replyFailed.push({
                  messageId: r.message_id,
                  fromEndpointId: r.sender,
                  reason: r.reason ?? null,
                });
              } else if (r.phase === "rejected") {
                rejected.push({
                  messageId: r.message_id,
                  fromEndpointId: r.sender,
                  reason: r.reason ?? null,
                });
              }
            }
          } catch {}
        }

        return {
          profile: entry.config.profile,
          profileInstanceId: entry.config.profileInstanceId,
          engineState: entry.engineManager?.state ?? "stopped",
          endpointId: entry.engineManager?.endpointId ?? null,
          phaseCounts,
          held,
          replyFailed,
          rejected,
          totalRecords,
          journalFull,
          lastError: entry.lastError
            ? { code: entry.lastError.code, message: entry.lastError.message }
            : null,
        };
      });
    },

    async close() {
      if (closed) return;
      closed = true;
      for (const entry of entries) {
        if (entry.drain) {
          try {
            await (entry.drain.close?.() ?? entry.drain.stop?.());
          } catch (e) {
            logger.warn?.("triangle_client_peer_drain_close_failed", {
              profile: entry.config.profile,
              profileInstanceId: entry.config.profileInstanceId,
              error: e?.message,
            });
          }
        }
        if (entry.engineManager) {
          try {
            await entry.engineManager.stop();
          } catch {}
        }
      }
    },
  });
}

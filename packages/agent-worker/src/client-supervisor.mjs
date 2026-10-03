import path from "node:path";

import { createCommandRunner, createRunnerEnvironment } from "./command-runner.mjs";
import { createConcurrencyGate } from "./concurrency-gate.mjs";
import {
  createHelperWatchTransport,
  createInstallationWatchTransportFactory,
  ensureHelperWatchGrant,
} from "./helper-watch-transport.mjs";
import {
  INSTALL_WATCH_HELD_POLL_IDLE_MS,
  createInstallWatchDispatcher,
  resolveInstallWatchCursorPath,
} from "./install-watch-dispatcher.mjs";
import { createMailboxClient, validateMailboxClientOptions } from "./mailbox-client.mjs";
import { createMailboxHarness, createWakeRuntime } from "./profile-scheduler.mjs";
import { createAgentWorker } from "./runtime.mjs";
import {
  createAppServerWakeBridge,
  createAtomicFileBindingStore,
  createAtomicFileCursorStore,
  createAuthenticatedAppServerTransport,
  createCapabilityTokenAuthResolver,
  createProductionAppServerDeliveryResolver,
  createSharedCodexSession,
  createTrustedTransactionProxy,
  validateBinding,
} from "./shared-codex-app-server.mjs";
import {
  createGrokBotWakeBridge,
  validateGrokBotBinding,
} from "./grok-bot-wake.mjs";
let CLIENT_SUPERVISOR_CLAIMER_OWNER = "dev.thetriangle.client";
let EXACT_HEADLESS_WAKE_KEYS = Object.freeze([
  "profile",
  "profileInstanceId",
  "helperPath",
  "workingDirectory",
  "codexHome",
  "stateRoot",
  "command",
  "pollIntervalMs",
  "agentId",
]);
let createHeadlessClaimerGuard = () => {
  throw new TypeError("codex-runtime is unavailable in this worker runtime bundle");
};
let createInstalledHeadlessDrain = () => {
  throw new TypeError("codex-runtime is unavailable in this worker runtime bundle");
};
let normalizeHeadlessWakeConfig = () => {
  throw new TypeError("codex-runtime is unavailable in this worker runtime bundle");
};
try {
  const codexDrainModule = await import("./codex-runtime/headless-drain-service.mjs");
  CLIENT_SUPERVISOR_CLAIMER_OWNER = codexDrainModule.CLIENT_SUPERVISOR_CLAIMER_OWNER;
  EXACT_HEADLESS_WAKE_KEYS = codexDrainModule.HEADLESS_WAKE_KEYS;
  createHeadlessClaimerGuard = codexDrainModule.createHeadlessClaimerGuard;
  createInstalledHeadlessDrain = codexDrainModule.createInstalledHeadlessDrain;
  normalizeHeadlessWakeConfig = codexDrainModule.normalizeHeadlessWakeConfig;
} catch {
  // codex-runtime is bundled only with Codex worker runtimes.
}
let CURSOR_ACP_CLIENT_SUPERVISOR_CLAIMER_OWNER = "dev.thetriangle.client";
let createCursorAcpClaimerGuard = () => {
  throw new TypeError("cursor-acp-runtime is unavailable in this worker runtime bundle");
};
let createInstalledCursorAcpDrain = () => {
  throw new TypeError("cursor-acp-runtime is unavailable in this worker runtime bundle");
};
let normalizeCursorAcpWakeConfig = () => {
  throw new TypeError("cursor-acp-runtime is unavailable in this worker runtime bundle");
};
try {
  const cursorDrainModule = await import("./cursor-acp-runtime/headless-drain-service.mjs");
  CURSOR_ACP_CLIENT_SUPERVISOR_CLAIMER_OWNER = cursorDrainModule.CLIENT_SUPERVISOR_CLAIMER_OWNER;
  createCursorAcpClaimerGuard = cursorDrainModule.createCursorAcpClaimerGuard;
  createInstalledCursorAcpDrain = cursorDrainModule.createInstalledCursorAcpDrain;
  normalizeCursorAcpWakeConfig = cursorDrainModule.normalizeCursorAcpWakeConfig;
} catch {
  // cursor-acp-runtime requires codex-runtime, which is bundled only with Codex worker runtimes.
}

import {
  APP_SERVER_BINDING_KEYS,
  APP_SERVER_WAKE_KEYS,
  GROK_BOT_BINDING_KEYS,
  GROK_BOT_WAKE_KEYS,
  HEADLESS_WAKE_KEYS,
  INSTANCE_ID,
  LEGACY_HEADLESS_WAKE_UNSET,
  hasExactKeys,
  isRenewableWatchCredentialError,
  positiveInteger,
  validateAppServerWake,
  validateCursorAcpWakes,
  validateDrain,
  validateEventWake,
  validateGrokBotWake,
  validateHeadlessWakes,
  validateRunner,
} from "./client-supervisor-schema.mjs";

export {
  APP_SERVER_BINDING_KEYS,
  APP_SERVER_WAKE_KEYS,
  GROK_BOT_BINDING_KEYS,
  GROK_BOT_WAKE_KEYS,
  HEADLESS_WAKE_KEYS,
} from "./client-supervisor-schema.mjs";

export function createClientSupervisor({
  instances = [],
  eventWake = null,
  appServerWake = null,
  grokBotWake = null,
  headlessWakes = null,
  cursorAcpWakes = null,
  headlessWake = LEGACY_HEADLESS_WAKE_UNSET,
  createDeliveryClient = createMailboxClient,
  createRunner = createCommandRunner,
  createWorker = createAgentWorker,
  createWake = createWakeRuntime,
  createWatchTransport = createHelperWatchTransport,
  ensureWatchGrant = ensureHelperWatchGrant,
  createHarness = createMailboxHarness,
  createAppServerTransport = createAuthenticatedAppServerTransport,
  createAuthResolver = createCapabilityTokenAuthResolver,
  createBindingStore = createAtomicFileBindingStore,
  createCursorStore = createAtomicFileCursorStore,
  createSession = createSharedCodexSession,
  createWakeBridge = createAppServerWakeBridge,
  createGrokBotBridge = createGrokBotWakeBridge,
  createHeadlessDrain = createInstalledHeadlessDrain,
  createClaimerGuard = createHeadlessClaimerGuard,
  createCursorAcpDrain = createInstalledCursorAcpDrain,
  createCursorAcpClaimer = createCursorAcpClaimerGuard,
  createInstallDispatcher = createInstallWatchDispatcher,
  resolveDelivery,
  maxConcurrentReasoners = 2,
  pollIntervalMs = 15_000,
  maxIdlePollIntervalMs = 300_000,
  maxBackoffMs = 300_000,
  idleJitterRatio = 0.1,
  random = Math.random,
  logger = console,
  /**
   * Phase 2 Option A: one install watch dispatcher when Bob (grokBot) is present.
   * Membership eligibility remains inactive — headless kicks register only when
   * agentId is on the headless wake bootstrap; grant stay Bob-only until gated ensure.
   */
  useInstallWatchDispatcher = null,
} = {}) {
  if (headlessWake !== LEGACY_HEADLESS_WAKE_UNSET) {
    throw new TypeError("headlessWake is not supported; use headlessWakes");
  }
  if (!Array.isArray(instances) || instances.length > 100) {
    throw new TypeError("instances must contain between 0 and 100 entries");
  }
  const wakeConfig = validateEventWake(eventWake);
  const appServerConfig = validateAppServerWake(appServerWake);
  const grokBotConfig = validateGrokBotWake(grokBotWake);
  const headlessConfigs = validateHeadlessWakes(headlessWakes);
  const cursorAcpConfigs = validateCursorAcpWakes(cursorAcpWakes);
  if (
    instances.length < 1
    && !wakeConfig
    && !appServerConfig
    && !grokBotConfig
    && headlessConfigs.length === 0
    && cursorAcpConfigs.length === 0
  ) {
    throw new TypeError("instances must contain between 1 and 100 entries");
  }
  positiveInteger(maxConcurrentReasoners, "maxConcurrentReasoners");
  const gate = createConcurrencyGate({ limit: maxConcurrentReasoners });
  const seen = new Set();
  // One MESH held poll per installation: App Server + Grok Bot (+ eventWake)
  // that share an installationId must coalesce onto a single watch-poll.
  const sharedWatchTransport = createInstallationWatchTransportFactory(createWatchTransport);
  // A grant is installation-scoped too. Track its generation so listeners that
  // fail together on one expired credential join (or observe) one renewal.
  const watchGrantRenewals = new Map();
  // Option A: Bob-owned install dispatcher. Skip when eventWake is also present
  // (legacy multi-lane event path); Mini production is grokBot ± headless.
  const installDispatcherEnabled = useInstallWatchDispatcher == null
    ? Boolean(grokBotConfig) && !wakeConfig
    : Boolean(useInstallWatchDispatcher);
  if (installDispatcherEnabled && !grokBotConfig) {
    throw new TypeError("useInstallWatchDispatcher requires grokBotWake");
  }

  function watchGrantState(installationId) {
    let state = watchGrantRenewals.get(installationId);
    if (!state) {
      state = { generation: 0, inFlight: null };
      watchGrantRenewals.set(installationId, state);
    }
    return state;
  }

  async function renewWatchGrant({ helperPath, installationId, actorProfile, signal }, observedGeneration) {
    const state = watchGrantState(installationId);
    if (state.generation !== observedGeneration) return { renewed: false, reusedRenewal: true };
    if (!state.inFlight) {
      state.inFlight = Promise.resolve().then(async () => {
        await ensureWatchGrant({ helperPath, installationId, actorProfile, signal });
        state.generation += 1;
        return { renewed: true };
      }).finally(() => {
        state.inFlight = null;
      });
    }
    return state.inFlight;
  }

  const entries = instances.map((instance) => {
    if (!instance || !INSTANCE_ID.test(instance.instanceId)) {
      throw new TypeError("instanceId must be 64 lowercase hexadecimal characters");
    }
    if (seen.has(instance.instanceId)) throw new TypeError("duplicate instanceId");
    seen.add(instance.instanceId);
    if (!instance.mailbox || typeof instance.mailbox !== "object" || Array.isArray(instance.mailbox)) {
      throw new TypeError("mailbox must be an object");
    }

    const runnerConfig = validateRunner(instance);
    const context = Object.freeze({ instanceId: instance.instanceId });
    const deliveryClient = createDeliveryClient({ ...instance.mailbox }, context);
    const adapterRunner = createRunner(runnerConfig, context);
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
    const worker = createWorker({
      deliveryClient,
      runner,
      pollIntervalMs,
      maxIdlePollIntervalMs,
      maxBackoffMs,
      idleJitterRatio,
      random,
      logger,
    }, context);
    if (!worker || typeof worker.watch !== "function" || typeof worker.runOnce !== "function") {
      throw new TypeError("createWorker must return a worker");
    }
    return Object.freeze({ instanceId: instance.instanceId, worker });
  });

  const clients = new Map();
  const runners = new Map();
  if (wakeConfig) {
    for (const profile of wakeConfig.profiles) {
      if (seen.has(profile.instanceId)) {
        throw new TypeError("eventWake instanceId collides with a worker instance");
      }
    }
    for (const drain of wakeConfig.drains) {
      const context = Object.freeze({ instanceId: drain.instanceId });
      const deliveryClient = createDeliveryClient({ ...drain.mailbox }, context);
      // Ungated: profile-scheduler holds the shared gate around harness preflight/run.
      const adapterRunner = createRunner(drain.runnerConfig, context);
      if (!adapterRunner || typeof adapterRunner.run !== "function") {
        throw new TypeError("createRunner must return a runner");
      }
      clients.set(drain.instanceId, deliveryClient);
      runners.set(drain.instanceId, adapterRunner);
    }
  }

  if (appServerConfig) {
    if (seen.has(appServerConfig.binding.instanceId)) {
      throw new TypeError("appServerWake instanceId collides with a worker instance");
    }
    if (wakeConfig?.profiles.some((profile) => profile.instanceId === appServerConfig.binding.instanceId)) {
      throw new TypeError("appServerWake instanceId collides with an eventWake profile");
    }
  }

  if (grokBotConfig) {
    if (seen.has(grokBotConfig.binding.instanceId)) {
      throw new TypeError("grokBotWake instanceId collides with a worker instance");
    }
    if (wakeConfig?.profiles.some((profile) => profile.instanceId === grokBotConfig.binding.instanceId)) {
      throw new TypeError("grokBotWake instanceId collides with an eventWake profile");
    }
    if (appServerConfig?.binding.instanceId === grokBotConfig.binding.instanceId) {
      throw new TypeError("grokBotWake instanceId collides with an appServerWake profile");
    }
  }

  for (const headlessConfig of headlessConfigs) {
    if (seen.has(headlessConfig.profileInstanceId)) {
      throw new TypeError("headlessWake instanceId collides with a worker instance");
    }
    if (wakeConfig?.profiles.some((profile) => profile.instanceId === headlessConfig.profileInstanceId)) {
      throw new TypeError("headlessWake instanceId collides with an eventWake profile");
    }
    if (appServerConfig?.binding.instanceId === headlessConfig.profileInstanceId) {
      throw new TypeError("headlessWake instanceId collides with an appServerWake profile");
    }
    if (grokBotConfig?.binding.instanceId === headlessConfig.profileInstanceId) {
      throw new TypeError("headlessWake instanceId collides with a grokBotWake profile");
    }
  }

  for (const cursorAcpConfig of cursorAcpConfigs) {
    if (seen.has(cursorAcpConfig.profileInstanceId)) {
      throw new TypeError("cursorAcpWake instanceId collides with a worker instance");
    }
    if (wakeConfig?.profiles.some((profile) => profile.instanceId === cursorAcpConfig.profileInstanceId)) {
      throw new TypeError("cursorAcpWake instanceId collides with an eventWake profile");
    }
    if (appServerConfig?.binding.instanceId === cursorAcpConfig.profileInstanceId) {
      throw new TypeError("cursorAcpWake instanceId collides with an appServerWake profile");
    }
    if (grokBotConfig?.binding.instanceId === cursorAcpConfig.profileInstanceId) {
      throw new TypeError("cursorAcpWake instanceId collides with a grokBotWake profile");
    }
    if (headlessConfigs.some((config) => config.profileInstanceId === cursorAcpConfig.profileInstanceId)) {
      throw new TypeError("cursorAcpWake instanceId collides with a headlessWake profile");
    }
    if (headlessConfigs.some((config) => config.profile === cursorAcpConfig.profile)) {
      throw new TypeError("cursorAcpWake profile collides with a headlessWake profile");
    }
  }

  const harness = wakeConfig ? createHarness({ clients, runners, logger }) : null;
  const transport = wakeConfig
    ? sharedWatchTransport({
      helperPath: wakeConfig.helperPath,
      installationId: wakeConfig.installationId,
    })
    : null;
  const wakeRuntime = wakeConfig
    ? createWake({
      profiles: wakeConfig.profiles,
      transport,
      gate,
      harness,
      cursorPath: wakeConfig.cursorPath,
      logger,
    })
    : null;
  if (wakeConfig && (!wakeRuntime || typeof wakeRuntime.start !== "function")) {
    throw new TypeError("createWake must return a wake runtime");
  }

  let appServerBridge = null;
  if (appServerConfig) {
    const authResolver = createAuthResolver({
      serverIdentity: appServerConfig.binding.serverIdentity,
      tokenFile: appServerConfig.authTokenFile,
      tokenEnv: appServerConfig.authTokenEnv,
    });
    const appTransport = createAppServerTransport({
      endpoint: appServerConfig.binding.endpoint,
      resolveAuth: () => authResolver.resolveAuth(),
    });
    const bindingStore = createBindingStore({ filePath: appServerConfig.bindingPath });
    const deliveryResolver = typeof resolveDelivery === "function"
      ? resolveDelivery
      : createProductionAppServerDeliveryResolver({
        helperPath: appServerConfig.helperPath,
        profile: appServerConfig.actorProfile,
        // mcp-interactive App Server claims own the coordinator-delivery lane.
        protocol: "coordinator-delivery-v1",
      });
    const transactionProxy = createTrustedTransactionProxy({
      helperPath: appServerConfig.helperPath,
      profile: appServerConfig.actorProfile,
      protocol: "coordinator-delivery-v1",
    });
    const session = createSession({
      binding: appServerConfig.binding,
      transport: appTransport,
      bindingStore,
      transactionProxy,
      logger,
    });
    const watchTransport = sharedWatchTransport({
      helperPath: appServerConfig.helperPath,
      installationId: appServerConfig.installationId,
    });
    const cursorStore = createCursorStore({ filePath: appServerConfig.cursorPath });
    // App Server joins the Bob install dispatcher only when it shares Bob's
    // installationId. Otherwise it must keep its own watch loop.
    const appServerCoveredByInstallDispatcher = installDispatcherEnabled
      && grokBotConfig != null
      && appServerConfig.installationId === grokBotConfig.installationId;
    appServerBridge = createWakeBridge({
      binding: appServerConfig.binding,
      session,
      watchTransport,
      cursorStore,
      helperPath: appServerConfig.helperPath,
      installationId: appServerConfig.installationId,
      actorProfile: appServerConfig.actorProfile,
      // Supervisor already refreshed the grant with an event-driven actor.
      // Bridge must not re-ensure using the mcp-interactive claim profile.
      ensureBeforeWatch: false,
      resolveDelivery: deliveryResolver,
      ownWatchLoop: !appServerCoveredByInstallDispatcher,
      logger,
    });
    if (!appServerBridge || typeof appServerBridge.start !== "function") {
      throw new TypeError("createWakeBridge must return an App Server wake bridge");
    }
  }

  let grokBotBridge = null;
  if (grokBotConfig) {
    const watchTransport = sharedWatchTransport({
      helperPath: grokBotConfig.helperPath,
      installationId: grokBotConfig.installationId,
    });
    const cursorStore = createCursorStore({ filePath: grokBotConfig.cursorPath });
    const quotaResetStorePath = path.join(
      path.dirname(grokBotConfig.cursorPath),
      `grok-bot-quota-reset.${grokBotConfig.binding.instanceId}.json`,
    );
    grokBotBridge = createGrokBotBridge({
      binding: grokBotConfig.binding,
      watchTransport,
      cursorStore,
      helperPath: grokBotConfig.helperPath,
      installationId: grokBotConfig.installationId,
      actorProfile: grokBotConfig.actorProfile,
      // When eventWake is also present, supervisor ensures with that actor first.
      // Under install dispatcher, ensure stays on the dispatcher wake loop (#55).
      ensureBeforeWatch: false,
      webhookUrlPath: grokBotConfig.webhookUrlPath,
      webhookKeyPath: grokBotConfig.webhookKeyPath,
      ownWatchLoop: !installDispatcherEnabled,
      logger,
      quotaResetStorePath,
    });
    if (!grokBotBridge || typeof grokBotBridge.start !== "function") {
      throw new TypeError("createGrokBotBridge must return a Grok Bot wake bridge");
    }
  }

  const headlessEntries = [];
  const headlessWakeSkipReasons = {};
  const headlessAdmissions = [];
  for (const headlessConfig of headlessConfigs) {
    const lockDirectory = path.resolve(path.dirname(headlessConfig.helperPath), "..", "client");
    const lockPath = path.join(lockDirectory, `headless-claimer.${headlessConfig.profile}.json`);
    const headlessClaimer = createClaimerGuard({
      profile: headlessConfig.profile,
      allowedRoomId: headlessConfig.allowedRoomId ?? null,
      helperPath: headlessConfig.helperPath,
      lockPath,
    });
    try {
      headlessClaimer.assertSupervisorMayClaim();
    } catch (error) {
      if (
        error?.code === "dedicated_headless_drain_loaded"
        || error?.code === "supervisor_headless_claimer_active"
        || error?.code === "cursor_acp_claimer_blocks_codex"
        || error?.code === "cursor_acp_drain_blocks_codex"
      ) {
        headlessWakeSkipReasons[headlessConfig.profile] = error.code;
        logger.error?.("triangle_client_headless_wake_skipped", {
          error: "Refusing dual headless mailbox claimers",
          code: error.code,
        });
      } else {
        throw error;
      }
    }
    headlessAdmissions.push({ config: headlessConfig, claimer: headlessClaimer });
  }
  if (Object.keys(headlessWakeSkipReasons).length > 0) {
    for (const config of headlessConfigs) {
      headlessWakeSkipReasons[config.profile] ??= "headless_pool_admission_failed";
    }
  } else {
    for (const { config: headlessConfig, claimer: headlessClaimer } of headlessAdmissions) {
      const drain = createHeadlessDrain(headlessConfig, {
        logger,
        ownerInstanceId: `client-supervisor-${process.pid}`,
      });
      if (!drain || typeof drain.start !== "function" || typeof drain.stop !== "function") {
        throw new TypeError("createHeadlessDrain must return a drain");
      }
      headlessEntries.push(Object.freeze({ config: headlessConfig, drain, claimer: headlessClaimer }));
    }
  }

  const cursorAcpEntries = [];
  const cursorAcpWakeSkipReasons = {};
  const cursorAcpAdmissions = [];
  for (const cursorAcpConfig of cursorAcpConfigs) {
    const lockDirectory = path.resolve(path.dirname(cursorAcpConfig.helperPath), "..", "client");
    const lockPath = path.join(lockDirectory, `cursor-acp-claimer.${cursorAcpConfig.profile}.json`);
    const cursorAcpClaimer = createCursorAcpClaimer({
      profile: cursorAcpConfig.profile,
      shadowTestProfile: true,
      helperPath: cursorAcpConfig.helperPath,
      lockPath,
    });
    try {
      cursorAcpClaimer.assertSupervisorMayClaim();
    } catch (error) {
      if (
        error?.code === "dedicated_cursor_acp_drain_loaded"
        || error?.code === "supervisor_cursor_acp_claimer_active"
        || error?.code === "codex_drain_blocks_cursor_acp"
        || error?.code === "codex_claimer_blocks_cursor_acp"
      ) {
        cursorAcpWakeSkipReasons[cursorAcpConfig.profile] = error.code;
        logger.error?.("triangle_client_cursor_acp_wake_skipped", {
          error: "Refusing dual Cursor ACP mailbox claimers",
          code: error.code,
        });
      } else {
        throw error;
      }
    }
    cursorAcpAdmissions.push({ config: cursorAcpConfig, claimer: cursorAcpClaimer });
  }
  if (Object.keys(cursorAcpWakeSkipReasons).length > 0) {
    for (const config of cursorAcpConfigs) {
      cursorAcpWakeSkipReasons[config.profile] ??= "cursor_acp_pool_admission_failed";
    }
  } else {
    for (const { config: cursorAcpConfig, claimer: cursorAcpClaimer } of cursorAcpAdmissions) {
      const drain = createCursorAcpDrain(cursorAcpConfig, {
        logger,
        ownerInstanceId: `client-supervisor-${process.pid}`,
      });
      if (!drain || typeof drain.start !== "function" || typeof drain.stop !== "function") {
        throw new TypeError("createCursorAcpDrain must return a drain");
      }
      cursorAcpEntries.push(Object.freeze({ config: cursorAcpConfig, drain, claimer: cursorAcpClaimer }));
    }
  }

  let installDispatcher = null;
  if (installDispatcherEnabled && grokBotBridge && grokBotConfig) {
    const dispatcherProfiles = [];
    const dispatcherHandlers = new Map();
    const laneCursorStores = [];

    dispatcherProfiles.push({
      instanceId: grokBotConfig.binding.instanceId,
      agentId: grokBotConfig.binding.agentId,
    });
    dispatcherHandlers.set(grokBotConfig.binding.instanceId, async (wake) => {
      try {
        return await grokBotBridge.handleWake(wake);
      } catch (error) {
        // D3: must reject the fan-out barrier so the install cursor does not
        // advance past a failed Bob wake (at-least-once replay on next poll).
        logger.error?.("triangle_grok_bot_wake_failed", {
          code: error?.code,
          message: error?.message,
          instanceId: wake?.instanceId,
          httpStatus: error?.status ?? null,
          reason: typeof wake?.reason === "string" ? wake.reason.slice(0, 64) : undefined,
        });
        throw error;
      }
    });
    laneCursorStores.push(createCursorStore({ filePath: grokBotConfig.cursorPath }));

    if (
      appServerBridge
      && appServerConfig
      && appServerConfig.installationId === grokBotConfig.installationId
    ) {
      dispatcherProfiles.push({
        instanceId: appServerConfig.binding.instanceId,
        agentId: appServerConfig.binding.agentId,
      });
      dispatcherHandlers.set(appServerConfig.binding.instanceId, async (wake) => {
        try {
          return await appServerBridge.handleWake(wake);
        } catch (error) {
          logger.error?.("triangle_app_server_wake_admit_failed", {
            code: error?.code,
            message: error?.message,
            instanceId: wake?.instanceId,
          });
          throw error;
        }
      });
      laneCursorStores.push(createCursorStore({ filePath: appServerConfig.cursorPath }));
    }

    // Register kick handlers when agentId is present. Events arrive only after
    // Phase 4 ensure adds those agent ids to the install grant.
    for (const entry of headlessEntries) {
      const agentId = entry.config.agentId;
      if (typeof agentId !== "string" || agentId.length === 0) continue;
      if (dispatcherProfiles.some((profile) => profile.agentId === agentId)) {
        throw new TypeError("headlessWake agentId collides with an install dispatcher profile");
      }
      if (typeof entry.drain.kick !== "function") {
        throw new TypeError("headless drain must expose kick() for install dispatcher");
      }
      dispatcherProfiles.push({
        instanceId: entry.config.profileInstanceId,
        agentId,
      });
      dispatcherHandlers.set(entry.config.profileInstanceId, async (wake) => {
        const reason = typeof wake?.reason === "string" && wake.reason.length > 0
          ? (wake.reason.startsWith("watch_hint") ? wake.reason : "watch_hint")
          : "watch_hint";
        const result = entry.drain.kick({ reason });
        return result && typeof result.then === "function" ? result : result;
      });
    }

    const installCursorPath = resolveInstallWatchCursorPath(grokBotConfig.cursorPath);
    const watchTransport = sharedWatchTransport({
      helperPath: grokBotConfig.helperPath,
      installationId: grokBotConfig.installationId,
    });
    installDispatcher = createInstallDispatcher({
      profiles: dispatcherProfiles,
      handlers: dispatcherHandlers,
      transport: watchTransport,
      cursorStore: createCursorStore({ filePath: installCursorPath }),
      laneCursorStores,
      // Phase 0.5 hold proven on Mini prod (~26s empty tip). Short reconnect
      // backoff only — rollback to INSTALL_WATCH_SAFE_IDLE_POLL_MS if hold dies.
      idlePollIntervalMs: INSTALL_WATCH_HELD_POLL_IDLE_MS,
      logger,
    });
    if (!installDispatcher || typeof installDispatcher.start !== "function") {
      throw new TypeError("createInstallDispatcher must return a dispatcher");
    }
  }

  return Object.freeze({
    instanceIds: Object.freeze(entries.map(({ instanceId }) => instanceId)),
    eventWakeProfileIds: Object.freeze(wakeConfig ? wakeConfig.profiles.map(({ instanceId }) => instanceId) : []),
    appServerInstanceId: appServerConfig?.binding.instanceId ?? null,
    grokBotInstanceId: grokBotConfig?.binding.instanceId ?? null,
    headlessInstanceIds: Object.freeze(headlessConfigs.map((config) => config.profileInstanceId)),
    cursorAcpInstanceIds: Object.freeze(cursorAcpConfigs.map((config) => config.profileInstanceId)),
    eventWake: wakeConfig,
    appServerWake: appServerConfig,
    grokBotWake: grokBotConfig,
    headlessWakes: headlessConfigs,
    cursorAcpWakes: cursorAcpConfigs,
    headlessWakeSkipReasons: Object.freeze({ ...headlessWakeSkipReasons }),
    cursorAcpWakeSkipReasons: Object.freeze({ ...cursorAcpWakeSkipReasons }),
    installWatchDispatcherEnabled: installDispatcherEnabled,
    installWatchProfileIds: Object.freeze(
      installDispatcher?.profiles?.map(({ instanceId }) => instanceId) ?? [],
    ),

    async runOnce({ signal } = {}) {
      const results = await Promise.all(entries.map(async ({ instanceId, worker }) => {
        try {
          return { instanceId, ...(await worker.runOnce({ signal })) };
        } catch (error) {
          if (signal?.aborted || error?.name === "AbortError") throw error;
          logger.error?.("triangle_client_instance_failed", {
            instanceId,
            error: "Instance cycle failed",
          });
          return { instanceId, found: null, processed: 0, failed: true };
        }
      }));
      return { instances: results };
    },

    async watch({ signal, sleep } = {}) {
      // Initial watch-grant ensure is scoped to the affected wake loop below so
      // worker / headless / Cursor ACP drains start independently. Persistent
      // 402/429 backoff must not serialize ahead of unrelated mailbox lanes.
      // Preference matches prior supervisor ensure: eventWake > appServer (with
      // event-driven actor) > grokBot. Shared grant renewal stays installation-scoped.
      const wakeEnsure = wakeRuntime && wakeConfig.ensureBeforeWatch
        ? {
          helperPath: wakeConfig.helperPath,
          installationId: wakeConfig.installationId,
          actorProfile: wakeConfig.actorProfile,
        }
        : null;
      const appServerEnsure = !wakeEnsure
        && appServerBridge
        && appServerConfig.ensureBeforeWatch
        && wakeConfig?.actorProfile
        ? {
          // App Server actorProfile is mcp-interactive (claim/reply owner). Grant
          // ensure must use an event-driven actor so notify members can refresh.
          helperPath: appServerConfig.helperPath,
          installationId: appServerConfig.installationId,
          actorProfile: wakeConfig.actorProfile,
        }
        : null;
      const grokBotEnsure = !wakeEnsure
        && !appServerEnsure
        && grokBotBridge
        && grokBotConfig.ensureBeforeWatch
        ? {
          // Grok Bot Bob may act as grant actor (unlike mcp-interactive).
          helperPath: grokBotConfig.helperPath,
          installationId: grokBotConfig.installationId,
          actorProfile: wakeConfig?.actorProfile ?? grokBotConfig.actorProfile,
        }
        : null;

      const workerLoop = Promise.all(entries.map(async ({ instanceId, worker }) => {
        try {
          return { instanceId, ...(await worker.watch({ signal, sleep })) };
        } catch {
          logger.error?.("triangle_client_instance_failed", {
            instanceId,
            error: "Instance loop failed",
          });
          return { instanceId, processed: 0, stopped: false };
        }
      }));

      // Keep wake loops independent and durable: a listener failure must not
      // resolve Promise.all and exit the supervisor (LaunchAgent KeepAlive thrash).
      // Retry until abort instead of returning.
      async function sleepBeforeWakeRetry(delayMs = 5_000) {
        if (typeof sleep === "function") {
          await sleep(delayMs, { signal });
          return;
        }
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, delayMs);
          signal?.addEventListener?.("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
          if (signal?.aborted) {
            clearTimeout(timer);
            resolve();
          }
        });
      }

      async function runDurableWakeLoop({
        start,
        stop = null,
        renewal = null,
        ensure = null,
        logEvent,
        logMessage,
      }) {
        let consecutiveFailures = 0;
        let initialEnsureDone = false;
        while (!signal?.aborted) {
          const observedGeneration = renewal
            ? watchGrantState(renewal.installationId).generation
            : null;
          try {
            if (ensure && !initialEnsureDone) {
              await ensureWatchGrant({ ...ensure, signal });
              initialEnsureDone = true;
            }
            const result = await start();
            consecutiveFailures = 0;
            return result;
          } catch (error) {
            if (signal?.aborted || error?.name === "AbortError") return null;
            consecutiveFailures += 1;
            const ensureFailed = Boolean(ensure) && !initialEnsureDone;
            const status = error?.status ?? error?.httpStatus;
            if (ensureFailed && (status === 402 || status === 429)) {
              logger.error?.("triangle_client_watch_ensure_failed", {
                error: "Watch grant ensure rejected",
                status,
                code: error?.code,
                rejectedCode: error?.rejectedCode,
              });
            } else {
              logger.error?.(logEvent, {
                error: logMessage,
                code: error?.code,
                rejectedCode: typeof error?.rejectedCode === "string" ? error.rejectedCode : undefined,
                failureCode: typeof error?.failureCode === "string" ? error.failureCode : undefined,
                message: typeof error?.message === "string" ? error.message.slice(0, 200) : undefined,
              });
            }
            // Clear sticky started/session state before retry so the next
            // start() cannot spam already_started after a watch-poll failure.
            if (typeof stop === "function") {
              try {
                await stop();
              } catch {
                /* ignore stop errors during restart */
              }
            }
            let activeError = error;
            if (renewal && isRenewableWatchCredentialError(error)) {
              try {
                await renewWatchGrant({ ...renewal, signal }, observedGeneration);
              } catch (renewalError) {
                if (signal?.aborted || renewalError?.name === "AbortError") return null;
                activeError = renewalError;
                logger.error?.("triangle_client_watch_grant_renewal_failed", {
                  error: "Watch grant renewal failed",
                  code: renewalError?.code,
                  rejectedCode: typeof renewalError?.rejectedCode === "string"
                    ? renewalError.rejectedCode
                    : undefined,
                  failureCode: typeof renewalError?.failureCode === "string"
                    ? renewalError.failureCode
                    : undefined,
                });
              }
            }
            const code = activeError?.code;
            if (code === "binding_endpoint_changed" || code === "binding_server_identity_changed") {
              await new Promise((resolve) => {
                signal?.addEventListener?.("abort", resolve, { once: true });
                if (signal?.aborted) resolve();
              });
              return null;
            }
            const activeStatus = activeError?.status ?? activeError?.httpStatus;
            let delayMs = Math.min(maxBackoffMs, 5_000 * Math.pow(2, Math.min(consecutiveFailures - 1, 6)));
            if (activeStatus === 402) {
              delayMs = Math.max(delayMs, 15 * 60_000);
            } else if (activeStatus === 429) {
              delayMs = Math.max(delayMs, 30_000);
            }
            const jitter = Math.floor(random() * delayMs * 0.1);
            await sleepBeforeWakeRetry(delayMs + jitter);
          }
        }
        return null;
      }

      const wakeLoop = wakeRuntime
        ? runDurableWakeLoop({
          start: () => wakeRuntime.start({ signal }),
          stop: typeof wakeRuntime.stop === "function" ? () => wakeRuntime.stop() : null,
          renewal: wakeConfig.ensureBeforeWatch ? {
            helperPath: wakeConfig.helperPath,
            installationId: wakeConfig.installationId,
            actorProfile: wakeConfig.actorProfile,
          } : null,
          ensure: wakeEnsure,
          logEvent: "triangle_client_event_wake_failed",
          logMessage: "Event-driven wake listener failed",
        })
        : Promise.resolve(null);

      const installDispatcherLoop = installDispatcher
        ? runDurableWakeLoop({
          start: async () => {
            // Handler-only bridges arm webhook/session state; dispatcher owns the poll.
            if (appServerBridge) {
              await appServerBridge.start({ signal });
            }
            if (grokBotBridge) {
              await grokBotBridge.start({ signal });
            }
            return installDispatcher.start({ signal });
          },
          stop: async () => {
            try {
              await installDispatcher.stop();
            } catch {
              /* ignore */
            }
            if (grokBotBridge) {
              try {
                await grokBotBridge.stop();
              } catch {
                /* ignore */
              }
            }
            if (appServerBridge) {
              try {
                await appServerBridge.stop();
              } catch {
                /* ignore */
              }
            }
          },
          renewal: grokBotConfig.ensureBeforeWatch ? {
            helperPath: grokBotConfig.helperPath,
            installationId: grokBotConfig.installationId,
            actorProfile: wakeConfig?.actorProfile ?? grokBotConfig.actorProfile,
          } : null,
          ensure: grokBotEnsure,
          logEvent: "triangle_client_install_watch_failed",
          logMessage: "Install watch dispatcher failed",
        })
        : Promise.resolve(null);

      const appServerLoop = installDispatcher
        ? Promise.resolve(null)
        : appServerBridge
          ? runDurableWakeLoop({
            start: () => appServerBridge.start({ signal }),
            stop: () => appServerBridge.stop(),
            renewal: appServerConfig.ensureBeforeWatch && wakeConfig?.actorProfile ? {
              helperPath: appServerConfig.helperPath,
              installationId: appServerConfig.installationId,
              actorProfile: wakeConfig.actorProfile,
            } : null,
            ensure: appServerEnsure,
            logEvent: "triangle_client_app_server_wake_failed",
            logMessage: "App Server bound wake listener failed",
          })
          : Promise.resolve(null);

      const grokBotLoop = installDispatcher
        ? Promise.resolve(null)
        : grokBotBridge
          ? runDurableWakeLoop({
            start: () => grokBotBridge.start({ signal }),
            stop: () => grokBotBridge.stop(),
            renewal: grokBotConfig.ensureBeforeWatch ? {
              helperPath: grokBotConfig.helperPath,
              installationId: grokBotConfig.installationId,
              actorProfile: wakeConfig?.actorProfile ?? grokBotConfig.actorProfile,
            } : null,
            ensure: grokBotEnsure,
            logEvent: "triangle_client_grok_bot_wake_failed",
            logMessage: "Grok Bot wake listener failed",
          })
          : Promise.resolve(null);

      function waitForAbort(target) {
        if (target?.aborted) return Promise.resolve();
        if (target == null) return new Promise(() => {});
        return new Promise((resolve) => {
          target.addEventListener("abort", () => resolve(), { once: true });
        });
      }

      const headlessLoop = headlessEntries.length
        ? runDurableWakeLoop({
          start: async () => {
            const acquired = [];
            try {
              for (const entry of headlessEntries) {
                entry.claimer.acquire({ owner: CLIENT_SUPERVISOR_CLAIMER_OWNER });
                acquired.push(entry);
              }
              const starts = headlessEntries.map((entry) => entry.drain.start({ runLoop: true }));
              try {
                await Promise.all(starts);
              } catch (error) {
                // Promise.all rejects on the first failure. Wait for every peer
                // start attempt to settle before rollback so a late start cannot
                // escape after its drain has already been stopped.
                await Promise.allSettled(starts);
                throw error;
              }
              await waitForAbort(signal);
              return headlessEntries.map(({ config }) => ({ status: "stopped", skipped: false, profileInstanceId: config.profileInstanceId }));
            } finally {
              for (const entry of [...headlessEntries].reverse()) {
                try { await entry.drain.stop(); } catch {}
              }
              for (const entry of [...acquired].reverse()) {
                entry.claimer.release({ owner: CLIENT_SUPERVISOR_CLAIMER_OWNER });
              }
            }
          },
          stop: async () => {
            for (const entry of [...headlessEntries].reverse()) {
              try { await entry.drain.stop(); } catch {}
            }
            for (const entry of [...headlessEntries].reverse()) {
              entry.claimer.release({ owner: CLIENT_SUPERVISOR_CLAIMER_OWNER });
            }
          },
          logEvent: "triangle_client_headless_wake_failed",
          logMessage: "Headless Codex drain failed",
        })
        : Promise.resolve(
          headlessConfigs.length
            ? headlessConfigs.map((config) => headlessWakeSkipReasons[config.profile]
              ? { skipped: true, reason: headlessWakeSkipReasons[config.profile], profileInstanceId: config.profileInstanceId }
              : null)
            : [],
        );

      const cursorAcpLoop = cursorAcpEntries.length
        ? runDurableWakeLoop({
          start: async () => {
            const acquired = [];
            try {
              for (const entry of cursorAcpEntries) {
                entry.claimer.acquire({ owner: CURSOR_ACP_CLIENT_SUPERVISOR_CLAIMER_OWNER });
                acquired.push(entry);
              }
              const starts = cursorAcpEntries.map((entry) => entry.drain.start({ runLoop: true }));
              try {
                await Promise.all(starts);
              } catch (error) {
                await Promise.allSettled(starts);
                throw error;
              }
              await waitForAbort(signal);
              return cursorAcpEntries.map(({ config }) => ({
                status: "stopped",
                skipped: false,
                profileInstanceId: config.profileInstanceId,
              }));
            } finally {
              for (const entry of [...cursorAcpEntries].reverse()) {
                try { await entry.drain.stop(); } catch {}
              }
              for (const entry of [...acquired].reverse()) {
                entry.claimer.release({ owner: CURSOR_ACP_CLIENT_SUPERVISOR_CLAIMER_OWNER });
              }
            }
          },
          stop: async () => {
            for (const entry of [...cursorAcpEntries].reverse()) {
              try { await entry.drain.stop(); } catch {}
            }
            for (const entry of [...cursorAcpEntries].reverse()) {
              entry.claimer.release({ owner: CURSOR_ACP_CLIENT_SUPERVISOR_CLAIMER_OWNER });
            }
          },
          logEvent: "triangle_client_cursor_acp_wake_failed",
          logMessage: "Cursor ACP drain failed",
        })
        : Promise.resolve(
          cursorAcpConfigs.length
            ? cursorAcpConfigs.map((config) => cursorAcpWakeSkipReasons[config.profile]
              ? {
                skipped: true,
                reason: cursorAcpWakeSkipReasons[config.profile],
                profileInstanceId: config.profileInstanceId,
              }
              : null)
            : [],
        );

      const [instances, wakeResult, installResult, appServerResult, grokBotResult, headlessResult, cursorAcpResult] = await Promise.all([
        workerLoop,
        wakeLoop,
        installDispatcherLoop,
        appServerLoop,
        grokBotLoop,
        headlessLoop,
        cursorAcpLoop,
      ]);
      return {
        instances,
        eventWake: wakeResult,
        installWatch: installResult,
        appServerWake: appServerResult,
        // Under the install dispatcher, Bob/handler prep is folded into installWatch.
        grokBotWake: installDispatcher ? (installResult ?? { status: "install_dispatcher" }) : grokBotResult,
        headlessWakes: Array.isArray(headlessResult) ? headlessResult : [headlessResult].filter(Boolean),
        cursorAcpWakes: Array.isArray(cursorAcpResult) ? cursorAcpResult : [cursorAcpResult].filter(Boolean),
      };
    },
  });
}

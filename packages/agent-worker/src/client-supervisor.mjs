import { createCommandRunner, createRunnerEnvironment } from "./command-runner.mjs";
import { createConcurrencyGate } from "./concurrency-gate.mjs";
import {
  createHelperWatchTransport,
  ensureHelperWatchGrant,
} from "./helper-watch-transport.mjs";
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

const INSTANCE_ID = /^[a-f0-9]{64}$/;
const AGENT_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const INSTALLATION_ID = /^inst_[A-Za-z0-9_-]{10,75}$/;
const RUNNER_KEYS = new Set(["command", "args", "timeoutMs"]);
const DRAIN_KEYS = ["instanceId", "mailbox", "runner", "runnerEnvironment"];
const APP_SERVER_WAKE_KEYS = [
  "actorProfile",
  "authTokenEnv",
  "authTokenFile",
  "binding",
  "bindingPath",
  "cursorPath",
  "ensureBeforeWatch",
  "helperPath",
  "installationId",
];
const APP_SERVER_BINDING_KEYS = [
  "adapterVersion",
  "agentId",
  "enabled",
  "endpoint",
  "installationId",
  "instanceId",
  "roomScope",
  "serverIdentity",
  "threadId",
];
const GROK_BOT_WAKE_KEYS = [
  "actorProfile",
  "binding",
  "bindingPath",
  "cursorPath",
  "ensureBeforeWatch",
  "helperPath",
  "installationId",
  "webhookKeyPath",
  "webhookUrlPath",
];
const GROK_BOT_BINDING_KEYS = [
  "adapterVersion",
  "agentId",
  "enabled",
  "grokAgentId",
  "installationId",
  "instanceId",
  "profile",
  "wakeMode",
];

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validateRunner(instance) {
  if (!instance.runner || typeof instance.runner !== "object" || Array.isArray(instance.runner)) {
    throw new TypeError("runner must be an object");
  }
  for (const key of Object.keys(instance.runner)) {
    if (!RUNNER_KEYS.has(key)) throw new TypeError(`runner.${key} is not supported`);
  }
  if (!instance.runnerEnvironment || typeof instance.runnerEnvironment !== "object" || Array.isArray(instance.runnerEnvironment)) {
    throw new TypeError("runner environment must be an object");
  }
  const environment = createRunnerEnvironment(instance.runnerEnvironment);
  const suppliedKeys = Object.keys(instance.runnerEnvironment).sort();
  const safeKeys = Object.keys(environment).sort();
  if (
    suppliedKeys.length !== safeKeys.length ||
    suppliedKeys.some((key, index) => key !== safeKeys[index])
  ) {
    throw new TypeError("runner environment contains unsupported or credential-bearing values");
  }
  if (environment.TRIANGLE_INSTANCE_ID !== instance.instanceId) {
    throw new TypeError("runner environment instance does not match instanceId");
  }
  return { ...instance.runner, environment };
}

function validateDrain(drain, profileAgentId) {
  if (!hasExactKeys(drain, DRAIN_KEYS) || !INSTANCE_ID.test(drain.instanceId)) {
    throw new TypeError("eventWake drain is invalid");
  }
  if (!drain.mailbox || typeof drain.mailbox !== "object" || Array.isArray(drain.mailbox)) {
    throw new TypeError("mailbox must be an object");
  }
  const mailbox = validateMailboxClientOptions(drain.mailbox);
  if (mailbox.recipientId !== profileAgentId) {
    throw new TypeError("eventWake drain recipient does not match profile agentId");
  }
  const runner = validateRunner(drain);
  return Object.freeze({
    instanceId: drain.instanceId,
    mailbox,
    runner: Object.freeze({
      command: drain.runner.command,
      args: drain.runner.args,
      timeoutMs: drain.runner.timeoutMs,
    }),
    runnerEnvironment: drain.runnerEnvironment,
    runnerConfig: runner,
  });
}

function validateEventWake(eventWake) {
  if (eventWake == null) return null;
  if (!eventWake || typeof eventWake !== "object" || Array.isArray(eventWake)) {
    throw new TypeError("eventWake must be an object");
  }
  const expected = [
    "actorProfile",
    "cursorPath",
    "drains",
    "ensureBeforeWatch",
    "helperPath",
    "installationId",
    "profiles",
  ];
  const actual = Object.keys(eventWake).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError("eventWake schema is invalid");
  }
  if (typeof eventWake.installationId !== "string" || !INSTALLATION_ID.test(eventWake.installationId)) {
    throw new TypeError("eventWake.installationId is invalid");
  }
  if (typeof eventWake.helperPath !== "string" || !eventWake.helperPath.startsWith("/") || eventWake.helperPath.includes("\0")) {
    throw new TypeError("eventWake.helperPath is invalid");
  }
  if (typeof eventWake.cursorPath !== "string" || !eventWake.cursorPath.startsWith("/") || eventWake.cursorPath.includes("\0")) {
    throw new TypeError("eventWake.cursorPath is invalid");
  }
  if (typeof eventWake.actorProfile !== "string" || eventWake.actorProfile.length === 0 || eventWake.actorProfile.includes("\0")) {
    throw new TypeError("eventWake.actorProfile is invalid");
  }
  if (typeof eventWake.ensureBeforeWatch !== "boolean") {
    throw new TypeError("eventWake.ensureBeforeWatch must be a boolean");
  }
  if (!Array.isArray(eventWake.profiles) || eventWake.profiles.length < 1 || eventWake.profiles.length > 100) {
    throw new TypeError("eventWake.profiles must contain between 1 and 100 entries");
  }
  if (!Array.isArray(eventWake.drains) || eventWake.drains.length !== eventWake.profiles.length) {
    throw new TypeError("eventWake.drains must match profiles");
  }
  const seenInstances = new Set();
  const seenAgents = new Set();
  const profiles = eventWake.profiles.map((profile) => {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      throw new TypeError("eventWake profile is invalid");
    }
    const keys = Object.keys(profile).sort();
    if (keys.length !== 2 || keys[0] !== "agentId" || keys[1] !== "instanceId") {
      throw new TypeError("eventWake profile schema is invalid");
    }
    if (!INSTANCE_ID.test(profile.instanceId)) throw new TypeError("eventWake instanceId is invalid");
    if (typeof profile.agentId !== "string" || !AGENT_ID.test(profile.agentId)) {
      throw new TypeError("eventWake agentId is invalid");
    }
    if (seenInstances.has(profile.instanceId) || seenAgents.has(profile.agentId)) {
      throw new TypeError("eventWake profiles must be unique");
    }
    seenInstances.add(profile.instanceId);
    seenAgents.add(profile.agentId);
    return Object.freeze({ instanceId: profile.instanceId, agentId: profile.agentId });
  });
  const agentByInstance = new Map(profiles.map((profile) => [profile.instanceId, profile.agentId]));
  const seenDrains = new Set();
  const drains = eventWake.drains.map((drain) => {
    const normalized = validateDrain(drain, agentByInstance.get(drain?.instanceId));
    if (!agentByInstance.has(normalized.instanceId) || seenDrains.has(normalized.instanceId)) {
      throw new TypeError("eventWake drains must match profiles");
    }
    seenDrains.add(normalized.instanceId);
    return normalized;
  });
  if (seenDrains.size !== seenInstances.size) {
    throw new TypeError("eventWake drains must match profiles");
  }
  return Object.freeze({
    installationId: eventWake.installationId,
    helperPath: eventWake.helperPath,
    cursorPath: eventWake.cursorPath,
    actorProfile: eventWake.actorProfile,
    ensureBeforeWatch: eventWake.ensureBeforeWatch,
    profiles,
    drains,
  });
}

function validateAppServerWake(appServerWake) {
  if (appServerWake == null) return null;
  if (!hasExactKeys(appServerWake, APP_SERVER_WAKE_KEYS)) {
    throw new TypeError("appServerWake schema is invalid");
  }
  if (typeof appServerWake.installationId !== "string" || !INSTALLATION_ID.test(appServerWake.installationId)) {
    throw new TypeError("appServerWake.installationId is invalid");
  }
  if (typeof appServerWake.helperPath !== "string" || !appServerWake.helperPath.startsWith("/") || appServerWake.helperPath.includes("\0")) {
    throw new TypeError("appServerWake.helperPath is invalid");
  }
  if (typeof appServerWake.cursorPath !== "string" || !appServerWake.cursorPath.startsWith("/") || appServerWake.cursorPath.includes("\0")) {
    throw new TypeError("appServerWake.cursorPath is invalid");
  }
  if (typeof appServerWake.bindingPath !== "string" || !appServerWake.bindingPath.startsWith("/") || appServerWake.bindingPath.includes("\0")) {
    throw new TypeError("appServerWake.bindingPath is invalid");
  }
  if (typeof appServerWake.actorProfile !== "string" || appServerWake.actorProfile.length === 0 || appServerWake.actorProfile.includes("\0")) {
    throw new TypeError("appServerWake.actorProfile is invalid");
  }
  if (typeof appServerWake.ensureBeforeWatch !== "boolean") {
    throw new TypeError("appServerWake.ensureBeforeWatch must be a boolean");
  }
  if (!hasExactKeys(appServerWake.binding, APP_SERVER_BINDING_KEYS)) {
    throw new TypeError("appServerWake.binding schema is invalid");
  }
  const binding = validateBinding(appServerWake.binding);
  if (!binding.enabled) {
    throw new TypeError("appServerWake.binding.enabled must be true");
  }
  if (binding.installationId !== appServerWake.installationId) {
    throw new TypeError("appServerWake binding installationId mismatch");
  }
  const hasFile = typeof appServerWake.authTokenFile === "string";
  const hasEnv = typeof appServerWake.authTokenEnv === "string";
  if (hasFile === hasEnv) {
    throw new TypeError("appServerWake requires exactly one of authTokenFile or authTokenEnv");
  }
  if (hasFile) {
    if (!appServerWake.authTokenFile.startsWith("/") || appServerWake.authTokenFile.includes("\0")) {
      throw new TypeError("appServerWake.authTokenFile is invalid");
    }
    if (appServerWake.authTokenEnv !== null) {
      throw new TypeError("appServerWake.authTokenEnv must be null when authTokenFile is set");
    }
  } else if (appServerWake.authTokenFile !== null) {
    throw new TypeError("appServerWake.authTokenFile must be null when authTokenEnv is set");
  } else if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(appServerWake.authTokenEnv)) {
    throw new TypeError("appServerWake.authTokenEnv is invalid");
  }
  return Object.freeze({
    installationId: appServerWake.installationId,
    helperPath: appServerWake.helperPath,
    cursorPath: appServerWake.cursorPath,
    bindingPath: appServerWake.bindingPath,
    actorProfile: appServerWake.actorProfile,
    ensureBeforeWatch: appServerWake.ensureBeforeWatch,
    authTokenFile: appServerWake.authTokenFile,
    authTokenEnv: appServerWake.authTokenEnv,
    binding,
  });
}

function validateGrokBotWake(grokBotWake) {
  if (grokBotWake == null) return null;
  if (!hasExactKeys(grokBotWake, GROK_BOT_WAKE_KEYS)) {
    throw new TypeError("grokBotWake schema is invalid");
  }
  if (typeof grokBotWake.installationId !== "string" || !INSTALLATION_ID.test(grokBotWake.installationId)) {
    throw new TypeError("grokBotWake.installationId is invalid");
  }
  if (typeof grokBotWake.helperPath !== "string" || !grokBotWake.helperPath.startsWith("/") || grokBotWake.helperPath.includes("\0")) {
    throw new TypeError("grokBotWake.helperPath is invalid");
  }
  if (typeof grokBotWake.cursorPath !== "string" || !grokBotWake.cursorPath.startsWith("/") || grokBotWake.cursorPath.includes("\0")) {
    throw new TypeError("grokBotWake.cursorPath is invalid");
  }
  if (typeof grokBotWake.bindingPath !== "string" || !grokBotWake.bindingPath.startsWith("/") || grokBotWake.bindingPath.includes("\0")) {
    throw new TypeError("grokBotWake.bindingPath is invalid");
  }
  if (typeof grokBotWake.webhookUrlPath !== "string" || !grokBotWake.webhookUrlPath.startsWith("/") || grokBotWake.webhookUrlPath.includes("\0")) {
    throw new TypeError("grokBotWake.webhookUrlPath is invalid");
  }
  if (typeof grokBotWake.webhookKeyPath !== "string" || !grokBotWake.webhookKeyPath.startsWith("/") || grokBotWake.webhookKeyPath.includes("\0")) {
    throw new TypeError("grokBotWake.webhookKeyPath is invalid");
  }
  if (typeof grokBotWake.actorProfile !== "string" || grokBotWake.actorProfile.length === 0 || grokBotWake.actorProfile.includes("\0")) {
    throw new TypeError("grokBotWake.actorProfile is invalid");
  }
  if (typeof grokBotWake.ensureBeforeWatch !== "boolean") {
    throw new TypeError("grokBotWake.ensureBeforeWatch must be a boolean");
  }
  if (!hasExactKeys(grokBotWake.binding, GROK_BOT_BINDING_KEYS)) {
    throw new TypeError("grokBotWake.binding schema is invalid");
  }
  const binding = validateGrokBotBinding(grokBotWake.binding);
  if (!binding.enabled) {
    throw new TypeError("grokBotWake.binding.enabled must be true");
  }
  if (binding.installationId !== grokBotWake.installationId) {
    throw new TypeError("grokBotWake binding installationId mismatch");
  }
  if (binding.profile !== grokBotWake.actorProfile) {
    throw new TypeError("grokBotWake binding profile mismatch");
  }
  return Object.freeze({
    installationId: grokBotWake.installationId,
    helperPath: grokBotWake.helperPath,
    cursorPath: grokBotWake.cursorPath,
    bindingPath: grokBotWake.bindingPath,
    webhookUrlPath: grokBotWake.webhookUrlPath,
    webhookKeyPath: grokBotWake.webhookKeyPath,
    actorProfile: grokBotWake.actorProfile,
    ensureBeforeWatch: grokBotWake.ensureBeforeWatch,
    binding,
  });
}

export function createClientSupervisor({
  instances = [],
  eventWake = null,
  appServerWake = null,
  grokBotWake = null,
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
  resolveDelivery,
  maxConcurrentReasoners = 2,
  pollIntervalMs = 15_000,
  maxIdlePollIntervalMs = 300_000,
  maxBackoffMs = 300_000,
  idleJitterRatio = 0.1,
  random = Math.random,
  logger = console,
} = {}) {
  if (!Array.isArray(instances) || instances.length > 100) {
    throw new TypeError("instances must contain between 0 and 100 entries");
  }
  const wakeConfig = validateEventWake(eventWake);
  const appServerConfig = validateAppServerWake(appServerWake);
  const grokBotConfig = validateGrokBotWake(grokBotWake);
  if (instances.length < 1 && !wakeConfig && !appServerConfig && !grokBotConfig) {
    throw new TypeError("instances must contain between 1 and 100 entries");
  }
  positiveInteger(maxConcurrentReasoners, "maxConcurrentReasoners");
  const gate = createConcurrencyGate({ limit: maxConcurrentReasoners });
  const seen = new Set();

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

  const harness = wakeConfig ? createHarness({ clients, runners, logger }) : null;
  const transport = wakeConfig
    ? createWatchTransport({
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
    const watchTransport = createWatchTransport({
      helperPath: appServerConfig.helperPath,
      installationId: appServerConfig.installationId,
    });
    const cursorStore = createCursorStore({ filePath: appServerConfig.cursorPath });
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
      logger,
    });
    if (!appServerBridge || typeof appServerBridge.start !== "function") {
      throw new TypeError("createWakeBridge must return an App Server wake bridge");
    }
  }

  let grokBotBridge = null;
  if (grokBotConfig) {
    const watchTransport = createWatchTransport({
      helperPath: grokBotConfig.helperPath,
      installationId: grokBotConfig.installationId,
    });
    const cursorStore = createCursorStore({ filePath: grokBotConfig.cursorPath });
    grokBotBridge = createGrokBotBridge({
      binding: grokBotConfig.binding,
      watchTransport,
      cursorStore,
      helperPath: grokBotConfig.helperPath,
      installationId: grokBotConfig.installationId,
      actorProfile: grokBotConfig.actorProfile,
      // When eventWake is also present, supervisor ensures with that actor first.
      ensureBeforeWatch: false,
      webhookUrlPath: grokBotConfig.webhookUrlPath,
      webhookKeyPath: grokBotConfig.webhookKeyPath,
      logger,
    });
    if (!grokBotBridge || typeof grokBotBridge.start !== "function") {
      throw new TypeError("createGrokBotBridge must return a Grok Bot wake bridge");
    }
  }

  return Object.freeze({
    instanceIds: Object.freeze(entries.map(({ instanceId }) => instanceId)),
    eventWakeProfileIds: Object.freeze(wakeConfig ? wakeConfig.profiles.map(({ instanceId }) => instanceId) : []),
    appServerInstanceId: appServerConfig?.binding.instanceId ?? null,
    grokBotInstanceId: grokBotConfig?.binding.instanceId ?? null,
    eventWake: wakeConfig,
    appServerWake: appServerConfig,
    grokBotWake: grokBotConfig,

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
      if (wakeRuntime && wakeConfig.ensureBeforeWatch) {
        await ensureWatchGrant({
          helperPath: wakeConfig.helperPath,
          installationId: wakeConfig.installationId,
          actorProfile: wakeConfig.actorProfile,
          signal,
        });
      } else if (appServerBridge && appServerConfig.ensureBeforeWatch && wakeConfig?.actorProfile) {
        // App Server actorProfile is mcp-interactive (claim/reply owner). Grant
        // ensure must use an event-driven actor so notify members can refresh.
        await ensureWatchGrant({
          helperPath: appServerConfig.helperPath,
          installationId: appServerConfig.installationId,
          actorProfile: wakeConfig.actorProfile,
          signal,
        });
      } else if (grokBotBridge && grokBotConfig.ensureBeforeWatch) {
        // Grok Bot Bob may act as grant actor (unlike mcp-interactive).
        await ensureWatchGrant({
          helperPath: grokBotConfig.helperPath,
          installationId: grokBotConfig.installationId,
          actorProfile: wakeConfig?.actorProfile ?? grokBotConfig.actorProfile,
          signal,
        });
      }

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
      async function sleepBeforeWakeRetry() {
        if (typeof sleep === "function") {
          await sleep(5_000, { signal });
          return;
        }
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 5_000);
          signal?.addEventListener?.("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      }

      async function runDurableWakeLoop({
        start,
        stop = null,
        logEvent,
        logMessage,
      }) {
        while (!signal?.aborted) {
          try {
            return await start();
          } catch (error) {
            if (signal?.aborted || error?.name === "AbortError") return null;
            logger.error?.(logEvent, {
              error: logMessage,
              code: error?.code,
              message: typeof error?.message === "string" ? error.message.slice(0, 200) : undefined,
            });
            // Clear sticky started/session state before retry so the next
            // start() cannot spam already_started after a watch-poll failure.
            if (typeof stop === "function") {
              try {
                await stop();
              } catch {
                /* ignore stop errors during restart */
              }
            }
            await sleepBeforeWakeRetry();
          }
        }
        return null;
      }

      const wakeLoop = wakeRuntime
        ? runDurableWakeLoop({
          start: () => wakeRuntime.start({ signal }),
          stop: typeof wakeRuntime.stop === "function" ? () => wakeRuntime.stop() : null,
          logEvent: "triangle_client_event_wake_failed",
          logMessage: "Event-driven wake listener failed",
        })
        : Promise.resolve(null);

      const appServerLoop = appServerBridge
        ? runDurableWakeLoop({
          start: () => appServerBridge.start({ signal }),
          stop: () => appServerBridge.stop(),
          logEvent: "triangle_client_app_server_wake_failed",
          logMessage: "App Server bound wake listener failed",
        })
        : Promise.resolve(null);

      const grokBotLoop = grokBotBridge
        ? runDurableWakeLoop({
          start: () => grokBotBridge.start({ signal }),
          stop: () => grokBotBridge.stop(),
          logEvent: "triangle_client_grok_bot_wake_failed",
          logMessage: "Grok Bot wake listener failed",
        })
        : Promise.resolve(null);

      const [instances, wakeResult, appServerResult, grokBotResult] = await Promise.all([
        workerLoop,
        wakeLoop,
        appServerLoop,
        grokBotLoop,
      ]);
      return {
        instances,
        eventWake: wakeResult,
        appServerWake: appServerResult,
        grokBotWake: grokBotResult,
      };
    },
  });
}

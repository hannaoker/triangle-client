import path from "node:path";

import { createCommandRunner, createRunnerEnvironment } from "./command-runner.mjs";
import { createConcurrencyGate } from "./concurrency-gate.mjs";
import {
  createHelperWatchTransport,
  createInstallationWatchTransportFactory,
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
import {
  CLIENT_SUPERVISOR_CLAIMER_OWNER,
  HEADLESS_WAKE_KEYS as EXACT_HEADLESS_WAKE_KEYS,
  createHeadlessClaimerGuard,
  createInstalledHeadlessDrain,
  normalizeHeadlessWakeConfig,
} from "./codex-runtime/headless-drain-service.mjs";
import {
  CLIENT_SUPERVISOR_CLAIMER_OWNER as CURSOR_ACP_CLIENT_SUPERVISOR_CLAIMER_OWNER,
  createCursorAcpClaimerGuard,
  createInstalledCursorAcpDrain,
  normalizeCursorAcpWakeConfig,
} from "./cursor-acp-runtime/headless-drain-service.mjs";

const INSTANCE_ID = /^[a-f0-9]{64}$/;
const AGENT_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const INSTALLATION_ID = /^inst_[A-Za-z0-9_-]{10,75}$/;
const RUNNER_KEYS = new Set(["command", "args", "timeoutMs"]);
const DRAIN_KEYS = ["instanceId", "mailbox", "runner", "runnerEnvironment"];
const LEGACY_HEADLESS_WAKE_UNSET = Symbol("legacy-headless-wake-unset");
export const APP_SERVER_WAKE_KEYS = Object.freeze([
  "actorProfile",
  "authTokenEnv",
  "authTokenFile",
  "binding",
  "bindingPath",
  "cursorPath",
  "ensureBeforeWatch",
  "helperPath",
  "installationId",
]);
export const APP_SERVER_BINDING_KEYS = Object.freeze([
  "adapterVersion",
  "agentId",
  "enabled",
  "endpoint",
  "installationId",
  "instanceId",
  "roomScope",
  "serverIdentity",
  "threadId",
]);
export const GROK_BOT_WAKE_KEYS = Object.freeze([
  "actorProfile",
  "binding",
  "bindingPath",
  "cursorPath",
  "ensureBeforeWatch",
  "helperPath",
  "installationId",
  "webhookKeyPath",
  "webhookUrlPath",
]);
export const GROK_BOT_BINDING_KEYS = Object.freeze([
  "adapterVersion",
  "agentId",
  "enabled",
  "grokAgentId",
  "installationId",
  "instanceId",
  "profile",
  "wakeMode",
]);
export const HEADLESS_WAKE_KEYS = EXACT_HEADLESS_WAKE_KEYS;

function isRenewableWatchCredentialError(error) {
  const rejectedCode = typeof error?.rejectedCode === "string"
    ? error.rejectedCode
    : error?.diagnosis?.rejectedCode;
  return rejectedCode === "watch_credential_invalid"
    || rejectedCode === "replacement_unauthorized";
}

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

function validateHeadlessWake(headlessWake) {
  if (headlessWake == null) return null;
  return normalizeHeadlessWakeConfig(headlessWake);
}

function validateHeadlessWakes(headlessWakes) {
  const values = headlessWakes ?? [];
  if (!Array.isArray(values) || values.length > 100) throw new TypeError("headlessWakes must contain between 0 and 100 entries");
  const normalized = values.map(validateHeadlessWake).sort((a, b) => a.profile.localeCompare(b.profile));
  const profiles = new Set(); const instanceIds = new Set(); const stateRoots = new Set();
  for (const wake of normalized) {
    if (profiles.has(wake.profile)) throw new TypeError("duplicate headless profile");
    if (instanceIds.has(wake.profileInstanceId)) throw new TypeError("duplicate headless instanceId");
    if (stateRoots.has(wake.stateRoot)) throw new TypeError("duplicate headless stateRoot");
    profiles.add(wake.profile); instanceIds.add(wake.profileInstanceId); stateRoots.add(wake.stateRoot);
  }
  return Object.freeze(normalized);
}

function validateCursorAcpWake(cursorAcpWake) {
  if (cursorAcpWake == null) return null;
  return normalizeCursorAcpWakeConfig(cursorAcpWake);
}

function validateCursorAcpWakes(cursorAcpWakes) {
  const values = cursorAcpWakes ?? [];
  if (!Array.isArray(values) || values.length > 100) throw new TypeError("cursorAcpWakes must contain between 0 and 100 entries");
  const normalized = values.map(validateCursorAcpWake).sort((a, b) => a.profile.localeCompare(b.profile));
  const profiles = new Set(); const instanceIds = new Set(); const stateRoots = new Set();
  for (const wake of normalized) {
    if (profiles.has(wake.profile)) throw new TypeError("duplicate cursor-acp profile");
    if (instanceIds.has(wake.profileInstanceId)) throw new TypeError("duplicate cursor-acp instanceId");
    if (stateRoots.has(wake.stateRoot)) throw new TypeError("duplicate cursor-acp stateRoot");
    profiles.add(wake.profile); instanceIds.add(wake.profileInstanceId); stateRoots.add(wake.stateRoot);
  }
  return Object.freeze(normalized);
}

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
  resolveDelivery,
  maxConcurrentReasoners = 2,
  pollIntervalMs = 15_000,
  maxIdlePollIntervalMs = 300_000,
  maxBackoffMs = 300_000,
  idleJitterRatio = 0.1,
  random = Math.random,
  logger = console,
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
      ensureBeforeWatch: false,
      webhookUrlPath: grokBotConfig.webhookUrlPath,
      webhookKeyPath: grokBotConfig.webhookKeyPath,
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
        renewal = null,
        logEvent,
        logMessage,
      }) {
        while (!signal?.aborted) {
          const observedGeneration = renewal
            ? watchGrantState(renewal.installationId).generation
            : null;
          try {
            return await start();
          } catch (error) {
            if (signal?.aborted || error?.name === "AbortError") return null;
            logger.error?.(logEvent, {
              error: logMessage,
              code: error?.code,
              rejectedCode: typeof error?.rejectedCode === "string" ? error.rejectedCode : undefined,
              failureCode: typeof error?.failureCode === "string" ? error.failureCode : undefined,
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
            if (renewal && isRenewableWatchCredentialError(error)) {
              try {
                await renewWatchGrant({ ...renewal, signal }, observedGeneration);
              } catch (renewalError) {
                if (signal?.aborted || renewalError?.name === "AbortError") return null;
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
            await sleepBeforeWakeRetry();
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
          logEvent: "triangle_client_event_wake_failed",
          logMessage: "Event-driven wake listener failed",
        })
        : Promise.resolve(null);

      const appServerLoop = appServerBridge
        ? runDurableWakeLoop({
          start: () => appServerBridge.start({ signal }),
          stop: () => appServerBridge.stop(),
          renewal: appServerConfig.ensureBeforeWatch && wakeConfig?.actorProfile ? {
            helperPath: appServerConfig.helperPath,
            installationId: appServerConfig.installationId,
            actorProfile: wakeConfig.actorProfile,
          } : null,
          logEvent: "triangle_client_app_server_wake_failed",
          logMessage: "App Server bound wake listener failed",
        })
        : Promise.resolve(null);

      const grokBotLoop = grokBotBridge
        ? runDurableWakeLoop({
          start: () => grokBotBridge.start({ signal }),
          stop: () => grokBotBridge.stop(),
          renewal: grokBotConfig.ensureBeforeWatch ? {
            helperPath: grokBotConfig.helperPath,
            installationId: grokBotConfig.installationId,
            actorProfile: wakeConfig?.actorProfile ?? grokBotConfig.actorProfile,
          } : null,
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

      const [instances, wakeResult, appServerResult, grokBotResult, headlessResult, cursorAcpResult] = await Promise.all([
        workerLoop,
        wakeLoop,
        appServerLoop,
        grokBotLoop,
        headlessLoop,
        cursorAcpLoop,
      ]);
      return {
        instances,
        eventWake: wakeResult,
        appServerWake: appServerResult,
        grokBotWake: grokBotResult,
        headlessWakes: Array.isArray(headlessResult) ? headlessResult : [headlessResult].filter(Boolean),
        cursorAcpWakes: Array.isArray(cursorAcpResult) ? cursorAcpResult : [cursorAcpResult].filter(Boolean),
      };
    },
  });
}

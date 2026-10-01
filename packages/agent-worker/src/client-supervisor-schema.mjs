import { createRunnerEnvironment } from "./command-runner.mjs";
import { validateMailboxClientOptions } from "./mailbox-client.mjs";
import { validateBinding } from "./shared-codex-app-server.mjs";
import { validateGrokBotBinding } from "./grok-bot-wake.mjs";
import {
  HEADLESS_WAKE_KEYS as EXACT_HEADLESS_WAKE_KEYS,
  normalizeHeadlessWakeConfig,
} from "./codex-runtime/headless-drain-service.mjs";
import { normalizeCursorAcpWakeConfig } from "./cursor-acp-runtime/headless-drain-service.mjs";

export const INSTANCE_ID = /^[a-f0-9]{64}$/;
export const AGENT_ID = /^[A-Za-z0-9._:-]{1,120}$/;
export const INSTALLATION_ID = /^inst_[A-Za-z0-9_-]{10,75}$/;
const RUNNER_KEYS = new Set(["command", "args", "timeoutMs"]);
const DRAIN_KEYS = ["instanceId", "mailbox", "runner", "runnerEnvironment"];
export const LEGACY_HEADLESS_WAKE_UNSET = Symbol("legacy-headless-wake-unset");
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

export function isRenewableWatchCredentialError(error) {
  const rejectedCode = typeof error?.rejectedCode === "string"
    ? error.rejectedCode
    : error?.diagnosis?.rejectedCode;
  return rejectedCode === "watch_credential_invalid"
    || rejectedCode === "replacement_unauthorized";
}

export function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

export function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function validateRunner(instance) {
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

export function validateDrain(drain, profileAgentId) {
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

export function validateEventWake(eventWake) {
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

export function validateAppServerWake(appServerWake) {
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

export function validateGrokBotWake(grokBotWake) {
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

export function validateHeadlessWake(headlessWake) {
  if (headlessWake == null) return null;
  return normalizeHeadlessWakeConfig(headlessWake);
}

export function validateHeadlessWakes(headlessWakes) {
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

export function validateCursorAcpWake(cursorAcpWake) {
  if (cursorAcpWake == null) return null;
  return normalizeCursorAcpWakeConfig(cursorAcpWake);
}

export function validateCursorAcpWakes(cursorAcpWakes) {
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


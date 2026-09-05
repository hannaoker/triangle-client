import { createCommandRunner, createRunnerEnvironment } from "./command-runner.mjs";
import { createConcurrencyGate } from "./concurrency-gate.mjs";
import {
  createHelperWatchTransport,
  ensureHelperWatchGrant,
} from "./helper-watch-transport.mjs";
import { createMailboxClient } from "./mailbox-client.mjs";
import { createFakeHarness, createWakeRuntime } from "./profile-scheduler.mjs";
import { createAgentWorker } from "./runtime.mjs";

const INSTANCE_ID = /^[a-f0-9]{64}$/;
const AGENT_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const INSTALLATION_ID = /^inst_[A-Za-z0-9_-]{10,75}$/;
const RUNNER_KEYS = new Set(["command", "args", "timeoutMs"]);

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
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

function validateEventWake(eventWake) {
  if (eventWake == null) return null;
  if (!eventWake || typeof eventWake !== "object" || Array.isArray(eventWake)) {
    throw new TypeError("eventWake must be an object");
  }
  const expected = ["actorProfile", "cursorPath", "ensureBeforeWatch", "helperPath", "installationId", "profiles"];
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
  return Object.freeze({
    installationId: eventWake.installationId,
    helperPath: eventWake.helperPath,
    cursorPath: eventWake.cursorPath,
    actorProfile: eventWake.actorProfile,
    ensureBeforeWatch: eventWake.ensureBeforeWatch,
    profiles,
  });
}

export function createClientSupervisor({
  instances = [],
  eventWake = null,
  createDeliveryClient = createMailboxClient,
  createRunner = createCommandRunner,
  createWorker = createAgentWorker,
  createWake = createWakeRuntime,
  createWatchTransport = createHelperWatchTransport,
  ensureWatchGrant = ensureHelperWatchGrant,
  createHarness = createFakeHarness,
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
  if (instances.length < 1 && !wakeConfig) {
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

  if (wakeConfig) {
    for (const profile of wakeConfig.profiles) {
      if (seen.has(profile.instanceId)) {
        throw new TypeError("eventWake instanceId collides with a worker instance");
      }
    }
  }

  const harness = wakeConfig ? createHarness() : null;
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

  return Object.freeze({
    instanceIds: Object.freeze(entries.map(({ instanceId }) => instanceId)),
    eventWakeProfileIds: Object.freeze(wakeConfig ? wakeConfig.profiles.map(({ instanceId }) => instanceId) : []),
    eventWake: wakeConfig,

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

      const wakeLoop = wakeRuntime
        ? wakeRuntime.start({ signal }).catch((error) => {
          if (signal?.aborted || error?.name === "AbortError") return null;
          logger.error?.("triangle_client_event_wake_failed", {
            error: "Event-driven wake listener failed",
          });
          throw error;
        })
        : Promise.resolve(null);

      const [instances, wakeResult] = await Promise.all([workerLoop, wakeLoop]);
      return { instances, eventWake: wakeResult };
    },
  });
}

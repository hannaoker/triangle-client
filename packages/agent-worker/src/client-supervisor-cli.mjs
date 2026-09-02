import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { createClientSupervisor } from "./client-supervisor.mjs";
import { createRunnerEnvironment } from "./command-runner.mjs";
import { validateMailboxClientOptions } from "./mailbox-client.mjs";

const MAX_BOOTSTRAP_BYTES = 1024 * 1024;
const INSTANCE_ID = /^[a-f0-9]{64}$/;
const EXACT_TOP_LEVEL_KEYS = ["version", "maxConcurrentReasoners", "instances"];
const EXACT_INSTANCE_KEYS = ["instanceId", "mailbox", "runner", "runnerEnvironment"];
const EXACT_MAILBOX_KEYS = ["meshUrl", "meshToken", "recipientId", "pageLimit"];
const EXACT_RUNNER_KEYS = ["command", "args", "timeoutMs"];
const ACTIVATION_TIMEOUT_MS = 30_000;

function invalidBootstrap() {
  return new TypeError("Invalid Triangle Client bootstrap");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  if (!isObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function positiveInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function nonemptyString(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function assertNoDuplicateJSONKeys(text) {
  let offset = 0;

  function fail() { throw invalidBootstrap(); }
  function whitespace() {
    while (offset < text.length && /[\t\n\r ]/.test(text[offset])) offset += 1;
  }
  function string() {
    if (text[offset] !== '"') fail();
    const start = offset++;
    while (offset < text.length) {
      const character = text[offset++];
      if (character === '"') {
        try { return JSON.parse(text.slice(start, offset)); }
        catch { fail(); }
      }
      if (character === "\\") {
        const escape = text[offset++];
        if (!['"', "\\", "/", "b", "f", "n", "r", "t", "u"].includes(escape)) fail();
        if (escape === "u") {
          if (!/^[a-fA-F0-9]{4}$/.test(text.slice(offset, offset + 4))) fail();
          offset += 4;
        }
      } else if (character.charCodeAt(0) < 0x20) {
        fail();
      }
    }
    fail();
  }
  function literal(value) {
    if (text.slice(offset, offset + value.length) !== value) fail();
    offset += value.length;
  }
  function number() {
    const match = text.slice(offset).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) fail();
    offset += match[0].length;
  }
  function array() {
    offset += 1;
    whitespace();
    if (text[offset] === "]") { offset += 1; return; }
    while (true) {
      value();
      whitespace();
      if (text[offset] === "]") { offset += 1; return; }
      if (text[offset++] !== ",") fail();
      whitespace();
    }
  }
  function object() {
    offset += 1;
    whitespace();
    const keys = new Set();
    if (text[offset] === "}") { offset += 1; return; }
    while (true) {
      const key = string();
      if (keys.has(key)) fail();
      keys.add(key);
      whitespace();
      if (text[offset++] !== ":") fail();
      whitespace();
      value();
      whitespace();
      if (text[offset] === "}") { offset += 1; return; }
      if (text[offset++] !== ",") fail();
      whitespace();
    }
  }
  function value() {
    whitespace();
    switch (text[offset]) {
      case "{": object(); return;
      case "[": array(); return;
      case '"': string(); return;
      case "t": literal("true"); return;
      case "f": literal("false"); return;
      case "n": literal("null"); return;
      default: number();
    }
  }

  value();
  whitespace();
  if (offset !== text.length) fail();
}

function hasValidMailboxKeys(mailbox) {
  if (!isObject(mailbox)) return false;
  const actual = Object.keys(mailbox);
  const allowed = new Set([
    "meshToken",
    "meshUrl",
    "pageLimit",
    "recipientId",
    "workloadId",
    "workloadPrivateKey",
  ]);
  const required = [
    "meshToken",
    "meshUrl",
    "pageLimit",
    "recipientId",
  ];
  if (!required.every((k) => Object.hasOwn(mailbox, k))) return false;
  if (!actual.every((k) => allowed.has(k))) return false;
  return true;
}

function validateInstance(instance, seen) {
  if (!hasExactKeys(instance, EXACT_INSTANCE_KEYS) || !INSTANCE_ID.test(instance.instanceId)) {
    throw invalidBootstrap();
  }
  if (seen.has(instance.instanceId)) throw invalidBootstrap();
  seen.add(instance.instanceId);

  const { mailbox, runner, runnerEnvironment } = instance;
  if (
    !hasValidMailboxKeys(mailbox) ||
    !hasExactKeys(runner, EXACT_RUNNER_KEYS) ||
    !nonemptyString(runner.command) ||
    !Array.isArray(runner.args) ||
    runner.args.some((argument) => typeof argument !== "string" || argument.includes("\0")) ||
    !positiveInteger(runner.timeoutMs, 1, 2_147_483_647) ||
    !isObject(runnerEnvironment) ||
    Object.values(runnerEnvironment).some((value) => typeof value !== "string" || value.includes("\0"))
  ) {
    throw invalidBootstrap();
  }
  try { instance.mailbox = validateMailboxClientOptions(mailbox); }
  catch { throw invalidBootstrap(); }
  let sanitizedEnvironment;
  try { sanitizedEnvironment = createRunnerEnvironment(runnerEnvironment); }
  catch { throw invalidBootstrap(); }
  const suppliedKeys = Object.keys(runnerEnvironment).sort();
  const safeKeys = Object.keys(sanitizedEnvironment).sort();
  if (
    suppliedKeys.length !== safeKeys.length ||
    suppliedKeys.some((key, index) => key !== safeKeys[index]) ||
    sanitizedEnvironment.TRIANGLE_INSTANCE_ID !== instance.instanceId
  ) {
    throw invalidBootstrap();
  }
}

function assertMailboxTokensAreConfined(instances) {
  for (const [ownerIndex, owner] of instances.entries()) {
    const secrets = [owner.mailbox.meshToken];
    if (owner.mailbox.workloadPrivateKey) {
      secrets.push(owner.mailbox.workloadPrivateKey);
    }
    for (const secret of secrets) {
      for (const [instanceIndex, instance] of instances.entries()) {
        const outsideValues = [
          instance.instanceId,
          instance.mailbox.meshUrl,
          instance.mailbox.recipientId,
          instance.mailbox.workloadId,
          instance.runner.command,
          ...instance.runner.args,
          ...Object.keys(instance.runnerEnvironment),
          ...Object.values(instance.runnerEnvironment),
        ].filter(Boolean);
        if (ownerIndex !== instanceIndex) {
          outsideValues.push(instance.mailbox.meshToken);
          if (instance.mailbox.workloadPrivateKey) {
            outsideValues.push(instance.mailbox.workloadPrivateKey);
          }
        }
        for (const candidate of outsideValues) {
          if (candidate.includes(secret)) throw invalidBootstrap();
        }
      }
    }
  }
}

export function parseClientSupervisorBootstrap(text) {
  try {
    if (typeof text !== "string" || Buffer.byteLength(text) > MAX_BOOTSTRAP_BYTES) {
      throw invalidBootstrap();
    }
    assertNoDuplicateJSONKeys(text);
    const bootstrap = JSON.parse(text);
    if (
      !hasExactKeys(bootstrap, EXACT_TOP_LEVEL_KEYS) ||
      bootstrap.version !== 1 ||
      !positiveInteger(bootstrap.maxConcurrentReasoners, 1, 16) ||
      !Array.isArray(bootstrap.instances) ||
      bootstrap.instances.length < 1 ||
      bootstrap.instances.length > 100
    ) {
      throw invalidBootstrap();
    }
    const seen = new Set();
    for (const instance of bootstrap.instances) validateInstance(instance, seen);
    assertMailboxTokensAreConfined(bootstrap.instances);
    return bootstrap;
  } catch {
    throw invalidBootstrap();
  }
}

async function readBoundedInput(input, signal) {
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    if (signal.aborted) throw new Error("aborted");
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_BOOTSTRAP_BYTES) throw invalidBootstrap();
    chunks.push(bytes);
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
}

function sanitizedLogger(stderr) {
  return Object.freeze({
    error() { stderr.write("triangle-client: instance cycle failed\n"); },
  });
}

async function waitForPrivateActivation({ path: markerPath, generation, parentPid, configDigest, signal }) {
  const safePath = typeof markerPath === "string" && markerPath.startsWith("/") && !markerPath.includes("\0");
  const deadline = Date.now() + ACTIVATION_TIMEOUT_MS;
  while (!signal.aborted && Date.now() < deadline) {
    let handle;
    try {
      if (!safePath) throw new Error("activation unavailable");
      if (await realpath(markerPath) !== path.resolve(markerPath)) throw new Error("unsafe activation path");
      handle = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.uid !== process.getuid() || (metadata.mode & 0o777) !== 0o600 || metadata.nlink !== 1 || metadata.size > 1024) {
        throw new Error("unsafe activation marker");
      }
      const raw = await handle.readFile({ encoding: "utf8" });
      const value = JSON.parse(raw);
      if (!hasExactKeys(value, ["version", "generation", "parentPid", "configDigest", "activatedAtMilliseconds"]) ||
          value.version !== 1 || value.generation !== generation || value.parentPid !== parentPid || value.configDigest !== configDigest ||
          !Number.isSafeInteger(value.activatedAtMilliseconds) || value.activatedAtMilliseconds > Date.now() + 2_000) {
        throw new Error("invalid activation marker");
      }
      return;
    } catch {
      await new Promise((resolve, reject) => {
        if (signal.aborted) { reject(new Error("aborted")); return; }
        const onAbort = () => { clearTimeout(timer); reject(new Error("aborted")); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, 20);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  throw new Error("activation timed out");
}

export async function runClientSupervisorCLI({
  argv = process.argv.slice(2),
  input = process.stdin,
  stderr = process.stderr,
  processEvents = process,
  createSupervisor = createClientSupervisor,
  notifyReady,
  awaitActivation = async () => {},
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    stderr.write("triangle-client: invalid invocation\n");
    return 64;
  }

  const controller = new AbortController();
  const onSignal = () => {
    controller.abort();
    if (typeof input.destroy === "function" && !input.destroyed) input.destroy();
  };
  processEvents.once("SIGINT", onSignal);
  processEvents.once("SIGTERM", onSignal);
  try {
    let bootstrap;
    let bootstrapText;
    try {
      bootstrapText = await readBoundedInput(input, controller.signal);
      bootstrap = parseClientSupervisorBootstrap(bootstrapText);
    } catch {
      if (controller.signal.aborted) return 0;
      stderr.write("triangle-client: invalid bootstrap\n");
      return 64;
    }
    try {
      const supervisor = createSupervisor({
        instances: bootstrap.instances,
        maxConcurrentReasoners: bootstrap.maxConcurrentReasoners,
        logger: sanitizedLogger(stderr),
      });
      const configDigest = createHash("sha256").update(Buffer.from(bootstrapText, "utf8")).digest("hex");
      const generation = randomUUID();
      const parentPid = process.ppid;
      try {
        notifyReady?.({
          type: "triangle-client-supervisor-ready",
          generation,
          parentPid,
          configDigest,
        });
      } catch {}
      await awaitActivation({ generation, parentPid, configDigest, signal: controller.signal });
      await supervisor.watch({ signal: controller.signal });
      return 0;
    } catch {
      if (controller.signal.aborted) return 0;
      stderr.write("triangle-client: supervisor failed\n");
      return 70;
    }
  } finally {
    processEvents.removeListener("SIGINT", onSignal);
    processEvents.removeListener("SIGTERM", onSignal);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const notifyReady = typeof process.send === "function"
    ? (message) => process.send(message)
    : (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  process.exitCode = await runClientSupervisorCLI({
    notifyReady,
    awaitActivation: (options) => waitForPrivateActivation({
      ...options,
      path: process.env.TRIANGLE_ACTIVATION_MARKER_PATH,
    }),
  });
}

#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createCommandRunner } from "./command-runner.mjs";
import { createMailboxClient } from "./mailbox-client.mjs";
import { createAgentWorker } from "./runtime.mjs";

function requiredEnv(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new TypeError(`${name} is required`);
  return value;
}

function positive(value, fallback, name) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return selected;
}

function meshUrl(value) {
  const url = new URL(value);
  const local =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !local) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("meshUrl must use HTTPS");
  }
  return url.toString().replace(/\/$/, "");
}

function agentId(value) {
  if (!/^agent_[a-f0-9]{32}$/.test(value)) {
    throw new TypeError("agentId is invalid");
  }
  return value;
}

export function resolveWorkerConfig(raw, configPath, env = process.env) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("Worker config must be an object");
  }
  const allowed = new Set([
    "meshUrlEnv",
    "meshTokenEnv",
    "agentIdEnv",
    "runner",
    "pollIntervalMs",
    "maxBackoffMs",
    "runnerTimeoutMs",
    "pageLimit",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new TypeError(`${key} is not supported`);
  }
  for (const key of ["meshUrlEnv", "meshTokenEnv", "agentIdEnv"]) {
    if (typeof raw[key] !== "string" || !raw[key].trim()) {
      throw new TypeError(`${key} is required`);
    }
  }
  if (typeof raw.runner?.module !== "string" || !raw.runner.module) {
    throw new TypeError("runner.module is required");
  }
  const pollIntervalMs = positive(raw.pollIntervalMs, 15_000, "pollIntervalMs");
  const maxBackoffMs = positive(raw.maxBackoffMs, 300_000, "maxBackoffMs");
  if (maxBackoffMs < pollIntervalMs) {
    throw new TypeError("maxBackoffMs must be at least pollIntervalMs");
  }
  const pageLimit = raw.pageLimit ?? 1;
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 100) {
    throw new TypeError("pageLimit must be between 1 and 100");
  }
  return {
    mailbox: {
      meshUrl: meshUrl(requiredEnv(env, raw.meshUrlEnv)),
      meshToken: requiredEnv(env, raw.meshTokenEnv),
      recipientId: agentId(requiredEnv(env, raw.agentIdEnv)),
      pageLimit,
    },
    runner: {
      command: process.execPath,
      args: [path.resolve(path.dirname(configPath), raw.runner.module)],
      timeoutMs: positive(raw.runnerTimeoutMs, 600_000, "runnerTimeoutMs"),
    },
    pollIntervalMs,
    maxBackoffMs,
  };
}

function argumentsFrom(argv) {
  const mode = argv.includes("--watch") ? "watch" : "once";
  const index = argv.indexOf("--config");
  if (index < 0 || !argv[index + 1]) {
    throw new TypeError("--config <path> is required");
  }
  return { mode, configPath: path.resolve(argv[index + 1]) };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { mode, configPath } = argumentsFrom(argv);
  const raw = JSON.parse(await readFile(configPath, "utf8"));
  const config = resolveWorkerConfig(raw, configPath, env);
  const deliveryClient = createMailboxClient(config.mailbox);
  const worker = createAgentWorker({
    deliveryClient,
    runner: createCommandRunner(config.runner),
    pollIntervalMs: config.pollIntervalMs,
    maxBackoffMs: config.maxBackoffMs,
    logger: {
      error(event, details) {
        process.stderr.write(`${JSON.stringify({ event, ...details })}\n`);
      },
    },
  });
  if (mode === "once") {
    process.stdout.write(`${JSON.stringify(await worker.runOnce())}\n`);
    return 0;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const result = await worker.watch({ signal: controller.signal });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : "Worker failed"}\n`);
      process.exitCode = 1;
    },
  );
}

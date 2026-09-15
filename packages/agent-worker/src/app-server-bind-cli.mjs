#!/usr/bin/env node
/**
 * Intentional App Server wake-thread rebind.
 *
 * Updates durable `app-server-binding.json` `threadId` without changing
 * installation / server identity. The live shared Codex session picks this up
 * on the next connect() or admit() via syncThreadFromStore / mergeBindingThreadId.
 *
 * Usage:
 *   node app-server-bind-cli.mjs --thread-id <id> [--binding-path <path>]
 */

import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  createAtomicFileBindingStore,
  validateBinding,
} from "./shared-codex-app-server.mjs";

export const DEFAULT_APP_SERVER_BINDING_PATH = path.join(
  homedir(),
  "Library",
  "Application Support",
  "The Triangle",
  "client",
  "app-server-binding.json",
);

const THREAD_ID = /^[A-Za-z0-9._:-]{8,120}$/;

export function parseAppServerBindArgs(argv) {
  const args = [...argv];
  let threadId = null;
  let bindingPath = DEFAULT_APP_SERVER_BINDING_PATH;
  let help = false;
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--help" || flag === "-h") {
      help = true;
      continue;
    }
    if (flag === "--thread-id") {
      threadId = args.shift() ?? null;
      continue;
    }
    if (flag === "--binding-path") {
      bindingPath = args.shift() ?? null;
      continue;
    }
    throw new TypeError(`unknown argument: ${flag}`);
  }
  return { threadId, bindingPath, help };
}

export async function rebindAppServerBindingFile({
  threadId,
  bindingPath = DEFAULT_APP_SERVER_BINDING_PATH,
  createBindingStore = createAtomicFileBindingStore,
} = {}) {
  if (typeof threadId !== "string" || !THREAD_ID.test(threadId)) {
    throw new TypeError("threadId is invalid");
  }
  if (typeof bindingPath !== "string" || !bindingPath.startsWith("/") || bindingPath.includes("\0")) {
    throw new TypeError("bindingPath is invalid");
  }
  const store = createBindingStore({ filePath: bindingPath });
  const existing = await store.read();
  if (existing == null) {
    const error = new Error(`app-server binding not found at ${bindingPath}`);
    error.code = "binding_missing";
    throw error;
  }
  if (!existing.enabled) {
    const error = new Error("app-server binding is disabled; enable it before rebind");
    error.code = "binding_disabled";
    throw error;
  }
  const next = validateBinding({ ...existing, threadId });
  await store.write(next);
  return {
    status: "rebound",
    bindingPath,
    previousThreadId: existing.threadId,
    threadId: next.threadId,
    note: "Live wake session applies this on next connect/admit sync",
  };
}

function printHelp() {
  process.stdout.write(`Usage: app-server-bind-cli.mjs --thread-id <id> [--binding-path <path>]

Rebind App Server wake to a Codex desktop thread without editing JSON by hand.
Default binding path:
  ${DEFAULT_APP_SERVER_BINDING_PATH}
`);
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseAppServerBindArgs(argv);
  if (parsed.help) {
    printHelp();
    return 0;
  }
  if (parsed.threadId == null) {
    printHelp();
    process.stderr.write("error: --thread-id is required\n");
    return 2;
  }
  const result = await rebindAppServerBindingFile({
    threadId: parsed.threadId,
    bindingPath: parsed.bindingPath,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

const invokedAsCli = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedAsCli) {
  main().then((code) => process.exit(code)).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: "error",
      code: error?.code ?? "error",
      message: error?.message ?? String(error),
    })}\n`);
    process.exit(1);
  });
}

#!/usr/bin/env node
/**
 * Run every triangle-client test suite and report each exit status.
 * Does not fail-fast: all suites run even when an early suite fails.
 * Exit nonzero if any suite fails.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @type {{ name: string, command: string, args: string[] }[]} */
const suites = [
  {
    name: "agent-worker (triangle-client)",
    command: "npm",
    args: ["--prefix", "packages/agent-worker", "run", "test:triangle-client"],
  },
  {
    name: "client-console",
    command: "npm",
    args: ["--prefix", "packages/client-console", "test"],
  },
  {
    name: "triangle-client-service",
    command: "node",
    args: ["--test", "tests/triangle-client-service.test.mjs"],
  },
  {
    name: "cutover-headless-supervisor",
    command: "node",
    args: ["--test", "tests/cutover-headless-supervisor.test.mjs"],
  },
  {
    name: "enable-headless-engagement",
    command: "node",
    args: ["--test", "tests/enable-headless-engagement.test.mjs"],
  },
  {
    name: "worker-service-render",
    command: "node",
    args: ["--test", "tests/worker-service-render.test.mjs"],
  },
  {
    name: "macos-mailbox-helper host",
    command: "node",
    args: ["packages/macos-mailbox-helper/scripts/run-tests.mjs", "host"],
  },
  {
    name: "a2a-gateway",
    command: "npm",
    args: ["--prefix", "packages/a2a-gateway", "test"],
  },
  {
    name: "agents/codex",
    command: "npm",
    args: ["--prefix", "agents/codex", "test"],
  },
  {
    name: "agents/hermes",
    command: "npm",
    args: ["--prefix", "agents/hermes", "test"],
  },
];

const group = process.argv[2]; // optional: runtime | gateway | all
const selected =
  group === "runtime"
    ? suites.slice(0, 6)
    : group === "gateway"
      ? suites.slice(6)
      : suites;

const results = [];
for (const suite of selected) {
  console.log(`\n======== ${suite.name} ========`);
  const started = Date.now();
  const result = spawnSync(suite.command, suite.args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    shell: false,
  });
  const status = result.status === null ? 1 : result.status;
  const signal = result.signal;
  results.push({
    name: suite.name,
    status,
    signal,
    ms: Date.now() - started,
  });
  if (signal) {
    console.error(`[${suite.name}] terminated by signal ${signal}`);
  } else {
    console.error(`[${suite.name}] exit ${status} (${Date.now() - started}ms)`);
  }
}

console.log("\n======== suite summary ========");
for (const row of results) {
  const mark = row.status === 0 && !row.signal ? "PASS" : "FAIL";
  console.log(
    `${mark}\t${row.name}\texit=${row.status}${row.signal ? ` signal=${row.signal}` : ""}\t${row.ms}ms`,
  );
}
const failed = results.filter((row) => row.status !== 0 || row.signal);
console.log(
  failed.length === 0
    ? `All ${results.length} suites passed.`
    : `${failed.length}/${results.length} suites failed.`,
);
process.exit(failed.length === 0 ? 0 : 1);

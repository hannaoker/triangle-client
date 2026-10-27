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

/** @type {{ name: string, group: "runtime" | "gateway", command: string, args: string[] }[]} */
export const suites = [
  {
    name: "test runner contracts",
    group: "runtime",
    command: "node",
    args: ["--test", "tests/test-runner.test.mjs"],
  },
  {
    name: "packaged installer",
    group: "runtime",
    command: "node",
    args: ["--test", process.platform === "linux" ? "tests/linux-package.test.mjs" : "tests/client-package.test.mjs"],
  },
  {
    name: "agent-worker (triangle-client)",
    group: "runtime",
    command: "npm",
    args: ["--prefix", "packages/agent-worker", "run", "test:triangle-client"],
  },
  {
    name: "triangle-cli (permissions v1)",
    group: "runtime",
    command: "npm",
    args: ["--prefix", "packages/triangle-cli", "test"],
  },
  {
    name: "linux-runtime",
    group: "runtime",
    command: "npm",
    args: ["--prefix", "packages/linux-runtime", "test"],
  },
  {
    name: "client-console",
    group: "runtime",
    command: "npm",
    args: ["--prefix", "packages/client-console", "test"],
  },
  {
    name: "triangle-client-service",
    group: "runtime",
    command: "node",
    args: ["--test", "tests/triangle-client-service.test.mjs"],
  },
  {
    name: "cutover-headless-supervisor",
    group: "runtime",
    command: "node",
    args: ["--test", "tests/cutover-headless-supervisor.test.mjs"],
  },
  {
    name: "enable-headless-engagement",
    group: "runtime",
    command: "node",
    args: ["--test", "tests/enable-headless-engagement.test.mjs"],
  },
  {
    name: "hermes-exec-wrapper",
    group: "runtime",
    command: "node",
    args: ["--test", "tests/hermes-exec-wrapper.test.mjs"],
  },
  {
    name: "worker-service-render",
    group: "runtime",
    command: "node",
    args: ["--test", "tests/worker-service-render.test.mjs"],
  },
  {
    name: "macos-mailbox-helper host",
    group: "runtime",
    command: "node",
    args: ["packages/macos-mailbox-helper/scripts/run-tests.mjs", "host"],
  },
  {
    name: "a2a-gateway",
    group: "gateway",
    command: "npm",
    args: ["--prefix", "packages/a2a-gateway", "test"],
  },
  {
    name: "agents/codex",
    group: "gateway",
    command: "npm",
    args: ["--prefix", "agents/codex", "test"],
  },
  {
    name: "agents/hermes",
    group: "gateway",
    command: "npm",
    args: ["--prefix", "agents/hermes", "test"],
  },
  {
    name: "peer-proof-hermes",
    group: "runtime",
    command: "node",
    args: ["--test", "tests/peer-proof-hermes.test.mjs"],
  },
];

export function selectSuites(group = "all") {
  if (!["all", "runtime", "gateway"].includes(group)) throw new RangeError("Unknown test group");
  return group === "all" ? suites : suites.filter((suite) => suite.group === group);
}

function main() {
  let selected;
  try {
    selected = selectSuites(process.argv[2]);
  } catch {
    console.error("Usage: run-all-tests.mjs [all|runtime|gateway]");
    process.exitCode = 64;
    return;
  }

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

}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) main();

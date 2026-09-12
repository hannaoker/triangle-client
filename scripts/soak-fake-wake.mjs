#!/usr/bin/env node
/**
 * Fake-harness wake soak for Phase 2 verification.
 *
 * Usage:
 *   node scripts/soak-fake-wake.mjs                  # accelerated (~500 cycles)
 *   node scripts/soak-fake-wake.mjs --hours 24       # wall-clock 24h soak
 *   node scripts/soak-fake-wake.mjs --cycles 10000   # cycle-bounded soak
 *
 * Exit 0 only when drain ran, no duplicate drains for the same watermark,
 * and the shared reasoning gate never exceeds maxConcurrentReasoners.
 */

import { createConcurrencyGate } from "../packages/agent-worker/src/concurrency-gate.mjs";
import { createProfileScheduler } from "../packages/agent-worker/src/profile-scheduler.mjs";

function parseArgs(argv) {
  let hours = null;
  let cycles = 500;
  let profiles = 5;
  let limit = 2;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--hours") hours = Number(argv[++index]);
    else if (arg === "--cycles") cycles = Number(argv[++index]);
    else if (arg === "--profiles") profiles = Number(argv[++index]);
    else if (arg === "--limit") limit = Number(argv[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (hours != null) {
    if (!Number.isFinite(hours) || hours <= 0) throw new Error("--hours must be > 0");
    cycles = null;
  } else if (!Number.isSafeInteger(cycles) || cycles < 1) {
    throw new Error("--cycles must be a positive integer");
  }
  return { hours, cycles, profiles, limit };
}

function id(index) {
  return index.toString(16).padStart(64, "0");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const gate = createConcurrencyGate({ limit: options.limit });
  let active = 0;
  let peak = 0;
  let drainCount = 0;
  let duplicateDrains = 0;
  let peakHeapUsedBytes = 0;
  let peakRssBytes = 0;
  const lastDrainedByInstance = new Map();
  const harness = Object.freeze({
    async preflight() { return true; },
    async run({ instanceId, highWatermark }) {
      active += 1;
      peak = Math.max(peak, active);
      drainCount += 1;
      const previous = lastDrainedByInstance.get(instanceId) ?? 0;
      if (highWatermark <= previous) duplicateDrains += 1;
      lastDrainedByInstance.set(instanceId, Math.max(previous, highWatermark));
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return { status: "drained" };
    },
  });
  const scheduler = createProfileScheduler({
    gate,
    harness,
    initialBackoffMs: 1,
    maxBackoffMs: 5,
  });
  const started = Date.now();
  const deadline = options.hours != null ? started + options.hours * 3_600_000 : null;
  let submitted = 0;
  let watermark = 0;
  const expectedByInstance = new Map();

  function sampleMemory() {
    const memory = process.memoryUsage();
    peakHeapUsedBytes = Math.max(peakHeapUsedBytes, memory.heapUsed);
    peakRssBytes = Math.max(peakRssBytes, memory.rss);
  }
  sampleMemory();

  while (true) {
    if (deadline != null && Date.now() >= deadline) break;
    if (options.cycles != null && submitted >= options.cycles) break;
    watermark += 1;
    submitted += 1;
    const instanceId = id(((submitted - 1) % options.profiles) + 1);
    expectedByInstance.set(instanceId, watermark);
    scheduler.submitWake({ instanceId, highWatermark: watermark });
    if (submitted % 50 === 0) {
      await scheduler.idle();
      sampleMemory();
    }
  }
  await scheduler.idle();
  sampleMemory();

  const reconciledByInstance = new Map(
    scheduler.snapshot().map((state) => [state.instanceId, state.lastReconciled]),
  );
  const lostWakeProfiles = [...expectedByInstance].filter(
    ([instanceId, expected]) => reconciledByInstance.get(instanceId) !== expected,
  );
  const report = {
    submitted,
    drainCount,
    peakConcurrentReasoners: peak,
    maxConcurrentReasoners: options.limit,
    duplicateDrains,
    lostWakeProfiles: lostWakeProfiles.length,
    retainedObservationCount: expectedByInstance.size + lastDrainedByInstance.size,
    peakHeapUsedBytes,
    peakRssBytes,
    finalWatermarks: [...expectedByInstance].map(([instanceId, expected]) => ({
      instanceId,
      expected,
      reconciled: reconciledByInstance.get(instanceId) ?? null,
    })),
    elapsedMs: Date.now() - started,
    mode: options.hours != null ? `wall-hours:${options.hours}` : `cycles:${options.cycles}`,
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (peak > options.limit || duplicateDrains > 0 || lostWakeProfiles.length > 0 || drainCount < 1) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exitCode = 1;
});

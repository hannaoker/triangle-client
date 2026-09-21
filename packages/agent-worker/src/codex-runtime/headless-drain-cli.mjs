#!/usr/bin/env node

import {
  DEDICATED_HEADLESS_DRAIN_CLAIMER_OWNER,
  createHeadlessClaimerGuard,
  createInstalledHeadlessDrain,
  isDirectExecution,
  loadHeadlessDrainConfig,
} from "./headless-drain-service.mjs";

function parseArgs(argv) {
  let profile = null;
  let once = false;
  const overrides = {};
  const valueFlags = new Map([
    ["--room-id", "TRIANGLE_HEADLESS_ROOM_ID"],
    ["--working-directory", "TRIANGLE_HEADLESS_WORKING_DIRECTORY"],
    ["--codex-home", "TRIANGLE_CODEX_HOME"],
    ["--codex-cli", "CODEX_CLI"],
    ["--helper", "TRIANGLE_MAILBOX_HELPER"],
    ["--state-root", "TRIANGLE_HEADLESS_STATE_ROOT"],
    ["--poll-interval-ms", "TRIANGLE_HEADLESS_POLL_INTERVAL_MS"],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--profile" && typeof argv[i + 1] === "string") {
      profile = argv[++i];
    } else if (argv[i] === "--once") {
      once = true;
    } else if (valueFlags.has(argv[i]) && typeof argv[i + 1] === "string") {
      overrides[valueFlags.get(argv[i])] = argv[++i];
    } else {
      throw new TypeError(`unknown argument: ${argv[i]}`);
    }
  }
  if (profile == null) throw new TypeError("--profile is required");
  return { profile, once, overrides };
}

export async function main(argv = process.argv.slice(2), { env = process.env, logger = console } = {}) {
  const { profile, once, overrides } = parseArgs(argv);
  const config = loadHeadlessDrainConfig({
    profile,
    env: {
      ...env,
      ...overrides,
      TRIANGLE_PHASE5_MIGRATION_ENABLE: "1",
      TRIANGLE_HEADLESS_RUNTIME_PROFILES: profile,
    },
  });
  const claimer = createHeadlessClaimerGuard({
    profile: config.profile,
    allowedRoomId: config.allowedRoomId,
    env: config.env,
  });
  claimer.assertDedicatedDrainMayClaim();
  claimer.acquire({ owner: DEDICATED_HEADLESS_DRAIN_CLAIMER_OWNER });
  const releaseClaimer = () => {
    claimer.release({ owner: DEDICATED_HEADLESS_DRAIN_CLAIMER_OWNER });
  };
  try {
    const drain = createInstalledHeadlessDrain(config, { logger });
    await drain.start({ runLoop: !once });
    if (once) {
      try {
        const result = await drain.drainOnce();
        await drain.stop();
        logger.info?.("triangle_headless_drain_once_complete", { status: result.status });
        return 0;
      } finally {
        releaseClaimer();
      }
    }

    const stop = async () => {
      try {
        await drain.stop({ signal: "SIGTERM", timeoutMs: 5_000 });
      } finally {
        releaseClaimer();
      }
    };
    process.once("SIGINT", () => { void stop().finally(() => process.exit(0)); });
    process.once("SIGTERM", () => { void stop().finally(() => process.exit(0)); });
    logger.info?.("triangle_headless_drain_started", {
      profile: config.profile,
      profileInstanceId: config.profileInstanceId,
    });
    return new Promise(() => {});
  } catch (error) {
    releaseClaimer();
    throw error;
  }
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    console.error("triangle_headless_drain_fatal", { code: error?.code ?? null });
    process.exitCode = 1;
  });
}

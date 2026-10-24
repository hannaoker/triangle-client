import assert from "node:assert/strict";
import test from "node:test";

import { createClientSupervisor } from "../src/client-supervisor.mjs";
import { createHeadlessCodexDrain } from "../src/codex-runtime/headless-drain.mjs";
import { deriveProfileInstanceId } from "../src/codex-runtime/headless-drain-service.mjs";
import { createHeadlessCursorAcpDrain } from "../src/cursor-acp-runtime/headless-drain.mjs";
import { createDrainIdlePolicy, createInstallWatchDispatcher } from "../src/install-watch-dispatcher.mjs";
import { createWakeClient } from "../src/wake-client.mjs";

const POLL_MS = 30_000;
const SAFETY_MS = 300_000;
const HOUR_MS = 3_600_000;
const INSTALLATION = "inst_N7VhDq3mQ2";
const ROOM = `room_${"a".repeat(32)}`;

// --- virtual time -----------------------------------------------------------

function createVirtualTime(start = 1_800_000_000_000) {
  let current = start;
  let sequence = 0;
  const timers = [];
  const api = {
    now: () => current,
    setTimer(fn, delay) {
      const timer = { at: current + delay, sequence: sequence++, fn, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { if (timer) timer.cleared = true; },
    sleep(ms, { signal } = {}) {
      return new Promise((resolve) => {
        if (signal?.aborted) { resolve(); return; }
        const timer = api.setTimer(() => resolve(), ms);
        signal?.addEventListener?.("abort", () => { api.clearTimer(timer); resolve(); }, { once: true });
      });
    },
    async settle() {
      for (let index = 0; index < 12; index += 1) await new Promise((resolve) => setImmediate(resolve));
    },
    async advance(ms) {
      const target = current + ms;
      for (;;) {
        const due = timers
          .filter((timer) => !timer.cleared && timer.at <= target)
          .sort((a, b) => a.at - b.at || a.sequence - b.sequence)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        current = Math.max(current, due.at);
        due.cleared = true;
        await due.fn();
        await api.settle();
      }
      current = target;
      await api.settle();
    },
  };
  return api;
}

// --- one drain with a scripted helper --------------------------------------

/** The helper's mailbox as `resolveDelivery` sees it: it lists, then claims what is there. */
function createMailbox(time) {
  const pending = [];
  const log = [];
  let nextId = 1;
  let failures = 0;
  let receipts = 0;
  return {
    log,
    pending,
    deposit() { const id = nextId++; pending.push({ id, depositedAt: time.now() }); return id; },
    failNext(count = 1) { failures += count; },
    settleReceiptsNext(count = 1) { receipts += count; },
    get claims() { return log.filter((entry) => entry.type === "claim-next").length; },
    resolveDelivery: async ({ outcome } = {}) => {
      log.push({ type: "claim-next", at: time.now() });
      if (failures > 0) { failures -= 1; throw Object.assign(new Error("helper failed"), { code: "helper_failed" }); }
      if (receipts > 0) { receipts -= 1; return null; } // a receipt was settled: not empty, outcome untouched
      const next = pending.shift();
      if (!next) { if (outcome) outcome.empty = true; return null; }
      log.push({ type: "delivery", id: next.id, depositedAt: next.depositedAt, claimedAt: time.now() });
      return {
        roomId: ROOM, deliveryId: `delivery_${next.id}`, numericDeliveryId: next.id,
        text: "hello", inboundEventId: `event_${"b".repeat(32)}`,
      };
    },
  };
}

const DRAINS = [
  {
    name: "Cursor ACP",
    create(options) {
      return createHeadlessCursorAcpDrain({
        ...options,
        runtime: { async start() {}, async runDelivery() { return { status: "completed" }; }, async stop() {} },
      });
    },
  },
  {
    name: "headless Codex",
    create(options) {
      return createHeadlessCodexDrain({
        ...options,
        runtime: {
          async start() {},
          async recoverAfterRestart() { return { quarantined: 0 }; },
          async runDelivery() { return { status: "completed" }; },
          async stop() {},
        },
      });
    },
  },
];

function laneFixture(drainKind, { wakeDriven = true, healthy = () => true, random = () => 0, time = createVirtualTime() } = {}) {
  const mailbox = createMailbox(time);
  const profileInstanceId = "c".repeat(64);
  const idlePolicy = wakeDriven
    ? createDrainIdlePolicy({
      pollIntervalMs: POLL_MS, safetyPollIntervalMs: SAFETY_MS, wakeChannelHealthy: healthy, random, now: time.now,
    })
    : null;
  const delays = [];
  const drain = drainKind.create({
    resolveDelivery: mailbox.resolveDelivery,
    profileInstanceId,
    pollIntervalMs: POLL_MS,
    ...(idlePolicy ? { idlePolicy } : {}),
    logger: { error() {} },
    setTimer(fn, delay) { delays.push(delay); return time.setTimer(fn, delay); },
    clearTimer: time.clearTimer,
  });
  return { drain, mailbox, time, delays, idlePolicy };
}

for (const drainKind of DRAINS) {
  test(`${drainKind.name} drain without a policy claims on every poll tick (unchanged)`, async () => {
    const { drain, mailbox, time, delays } = laneFixture(drainKind, { wakeDriven: false });
    await drain.start({ runLoop: true });
    await time.advance(HOUR_MS);
    await drain.stop();
    assert.equal(mailbox.claims, 120, "one claim-next per 30 s tick for an hour");
    assert.ok(delays.every((delay) => delay === POLL_MS), "timer period is untouched");
    assert.equal(drain.status().idle, null);
  });

  test(`${drainKind.name} wake-driven drain claims at the safety interval while idle and the watch is healthy`, async () => {
    const { drain, mailbox, time, delays } = laneFixture(drainKind);
    await drain.start({ runLoop: true });
    await time.advance(HOUR_MS);
    await drain.stop();
    // First tick at 30 s, then every 300 s once the mailbox is known empty.
    assert.deepEqual(
      mailbox.log.map((entry) => (entry.at - 1_800_000_000_000) / 1000),
      [30, 330, 630, 930, 1230, 1530, 1830, 2130, 2430, 2730, 3030, 3330],
    );
    assert.ok(delays.every((delay) => delay === POLL_MS), "the timer still ticks every poll interval; ticks are just quiet");
    const idle = drain.status().idle;
    assert.equal(idle.wakeDriven, true);
    assert.equal(idle.safetyPolls, 11);
    assert.ok(idle.skippedTicks > 100, "ticks were skipped");
    assert.equal(drain.status().lastResult.reason, "safety_poll");
  });

  test(`${drainKind.name} wake-driven drain claims immediately on a hint and drains the backlog at the old pace`, async () => {
    const { drain, mailbox, time } = laneFixture(drainKind);
    await drain.start({ runLoop: true });
    await time.advance(60_000); // t=30 claimed (empty); t=60 was a quiet tick
    assert.equal(mailbox.claims, 1);

    // A hint while idle claims at once, with no wait for the safety interval.
    mailbox.deposit();
    mailbox.deposit();
    mailbox.deposit();
    drain.kick({ reason: "watch_hint" });
    await time.settle();
    assert.equal(mailbox.claims, 2);
    const first = mailbox.log.find((entry) => entry.type === "delivery");
    assert.equal(first.claimedAt, first.depositedAt, "claimed at the moment of the hint");
    assert.equal(drain.status().lastResult.status, "completed");

    // Work was found, so the following ticks keep claiming every 30 s (the existing
    // pace for a backlog): t=90 and t=120 take the other two, t=150 finds it empty.
    await time.advance(30_000);
    await time.advance(30_000);
    assert.equal(mailbox.log.filter((entry) => entry.type === "delivery").length, 3);
    assert.equal(mailbox.pending.length, 0);
    assert.equal(mailbox.claims, 4);
    await time.advance(30_000);
    assert.equal(mailbox.claims, 5, "the empty claim that ends the backlog");

    // Idle again: quiet until the safety interval (150 s + 300 s = t=450).
    await time.advance(270_000);
    assert.equal(mailbox.claims, 5, "ticks are quiet");
    await time.advance(30_000);
    assert.equal(mailbox.claims, 6, "safety interval reached");
    await drain.stop();
  });

  test(`${drainKind.name} wake-driven drain never stretches its cadence when the watch is not healthy`, async () => {
    let healthy = false;
    const { drain, mailbox, time } = laneFixture(drainKind, { healthy: () => healthy });
    await drain.start({ runLoop: true });
    await time.advance(5 * POLL_MS);
    assert.equal(mailbox.claims, 5, "unhealthy watch: every tick claims");
    healthy = true;
    await time.advance(5 * POLL_MS);
    assert.equal(mailbox.claims, 5, "watch delivering and the mailbox known empty: quiet");
    healthy = false;
    await time.advance(3 * POLL_MS);
    assert.equal(mailbox.claims, 8, "the watch dropped: back to claiming on every tick");
    await drain.stop();
  });

  test(`${drainKind.name} wake-driven drain retries failures and settled receipts at the poll cadence`, async () => {
    const { drain, mailbox, time } = laneFixture(drainKind);
    await drain.start({ runLoop: true });
    await time.advance(2 * POLL_MS); // t=30 claimed (empty), t=60 quiet
    assert.equal(mailbox.claims, 1);

    // A failed attempt (here from a hint) is retried on the very next tick, and again.
    mailbox.failNext(2);
    drain.kick({ reason: "watch_hint" });
    await time.settle();
    assert.equal(mailbox.claims, 2, "the hint's attempt failed");
    await time.advance(POLL_MS);
    assert.equal(mailbox.claims, 3, "retried on the next tick; failed again");
    await time.advance(POLL_MS);
    assert.equal(mailbox.claims, 4, "retried once more; succeeded and found it empty");
    await time.advance(POLL_MS);
    assert.equal(mailbox.claims, 4, "idle again: quiet");

    // A claim that settled a receipt may have more behind it: keep polling until empty.
    mailbox.settleReceiptsNext(2);
    drain.kick({ reason: "watch_hint" });
    await time.settle();
    assert.equal(mailbox.claims, 5, "receipt settled by the hint's attempt");
    await time.advance(POLL_MS);
    assert.equal(mailbox.claims, 6, "next tick settled the second receipt");
    await time.advance(POLL_MS);
    assert.equal(mailbox.claims, 7, "next tick found the mailbox empty");
    await time.advance(POLL_MS);
    assert.equal(mailbox.claims, 7, "quiet again");
    await drain.stop();
  });

  test(`${drainKind.name} wake-driven drain treats a resolver that does not report emptiness as busy`, async () => {
    const time = createVirtualTime();
    let calls = 0;
    const drain = drainKind.create({
      resolveDelivery: async () => { calls += 1; return null; }, // legacy resolver: no outcome
      profileInstanceId: "c".repeat(64),
      pollIntervalMs: POLL_MS,
      idlePolicy: createDrainIdlePolicy({
        pollIntervalMs: POLL_MS, safetyPollIntervalMs: SAFETY_MS, wakeChannelHealthy: () => true, now: time.now,
      }),
      logger: { error() {} },
      setTimer: time.setTimer,
      clearTimer: time.clearTimer,
    });
    await drain.start({ runLoop: true });
    await time.advance(10 * POLL_MS);
    await drain.stop();
    assert.equal(calls, 10, "unknown results keep the old cadence");
  });

  test(`${drainKind.name} drain rejects a malformed idle policy`, () => {
    assert.throws(() => laneFixtureWith(drainKind, {}), /idlePolicy/);
    assert.throws(() => laneFixtureWith(drainKind, { evaluateTick() {} }), /idlePolicy/);
    assert.throws(() => laneFixtureWith(drainKind, { recordAttempt() {} }), /idlePolicy/);
  });
}

function laneFixtureWith(drainKind, idlePolicy) {
  return drainKind.create({
    resolveDelivery: async () => null,
    profileInstanceId: "c".repeat(64),
    pollIntervalMs: POLL_MS,
    idlePolicy,
  });
}

// --- the supervisor decides which lanes are wake-driven ---------------------

function headlessWake(overrides = {}) {
  const profile = overrides.profile ?? "codex-bob-test";
  return {
    profile,
    profileInstanceId: deriveProfileInstanceId(profile),
    helperPath: "/trusted/triangle-mailbox",
    workingDirectory: "/srv/triangle-work",
    codexHome: "/private/codex-home",
    stateRoot: `/private/headless-state/${profile}`,
    command: "/trusted/bin/codex",
    pollIntervalMs: POLL_MS,
    ...overrides,
  };
}

function cursorWake(overrides = {}) {
  const profile = overrides.profile ?? "cursor-acp-shadow-test";
  return {
    profile,
    profileInstanceId: deriveProfileInstanceId(profile),
    helperPath: "/trusted/triangle-mailbox",
    workingDirectory: "/srv/triangle-cursor-work",
    cursorHome: "/private/cursor-acp-home",
    stateRoot: `/private/cursor-acp-state/${profile}`,
    command: "/trusted/bin/agent",
    pollIntervalMs: POLL_MS,
    shadowTestProfile: true,
    ...overrides,
  };
}

function supervisorFixture(extra = {}) {
  const seen = { headless: [], cursor: [], dispatcher: [] };
  const state = { healthy: false };
  const guard = () => ({ assertSupervisorMayClaim() {}, acquire() {}, release() {} });
  const options = {
    instances: [],
    headlessWakes: [
      headlessWake({ profile: "bob", agentId: "agent_bob", installationId: INSTALLATION }),
      headlessWake({ profile: "codex-headless", agentId: "agent_codex_headless", installationId: INSTALLATION }),
    ],
    cursorAcpWakes: [
      cursorWake({ profile: "ghost", agentId: "agent_ghost", installationId: INSTALLATION }),
      cursorWake({ profile: "timer-only" }), // no agentId: not a member of the install watch
    ],
    useInstallWatchDispatcher: true,
    createWatchTransport: () => ({ async poll() { return { cursor: 0, events: [] }; } }),
    createCursorStore: () => ({ async read() { return 0; }, async write() {} }),
    createClaimerGuard: guard,
    createCursorAcpClaimer: guard,
    createHeadlessDrain(config, drainOptions) {
      seen.headless.push({ profile: config.profile, options: drainOptions });
      return { async start() {}, async stop() {}, kick() { return { status: "accepted" }; } };
    },
    createCursorAcpDrain(config, drainOptions) {
      seen.cursor.push({ profile: config.profile, options: drainOptions });
      return { async start() {}, async stop() {}, kick() { return { status: "accepted" }; } };
    },
    createInstallDispatcher(dispatcherOptions) {
      seen.dispatcher.push(dispatcherOptions);
      return {
        async start() {}, async stop() { return { status: "stopped" }; },
        profiles: dispatcherOptions.profiles,
        wakeChannelHealthy: () => state.healthy,
      };
    },
    ensureWatchGrant: async () => ({ ensured: true }),
    logger: { error() {} },
    ...extra,
  };
  return { supervisor: createClientSupervisor(options), seen, state };
}

test("supervisor makes install-watch lanes wake-driven by default and leaves timer-only lanes alone", () => {
  const { seen } = supervisorFixture();
  const byProfile = (list, profile) => list.find((entry) => entry.profile === profile).options;
  for (const [list, profile] of [[seen.headless, "bob"], [seen.headless, "codex-headless"], [seen.cursor, "ghost"]]) {
    const options = byProfile(list, profile);
    assert.ok(options.idlePolicy, `${profile} is a watch member and leans on hints`);
    assert.equal(options.idlePolicy.active, true);
    assert.equal(options.idlePolicy.safetyPollIntervalMs, SAFETY_MS, "default safety interval is 5 minutes");
  }
  assert.equal(Object.hasOwn(byProfile(seen.cursor, "timer-only"), "idlePolicy"), false, "no agentId means no hints: keep the poll timer");
  assert.equal(seen.dispatcher.length, 1);
});

test("the lane's policy follows the install dispatcher's health", () => {
  const { seen, state } = supervisorFixture();
  const policy = seen.cursor.find((entry) => entry.profile === "ghost").options.idlePolicy;
  policy.recordAttempt({ empty: true });
  assert.equal(policy.evaluateTick().skip, false, "dispatcher not healthy yet: claim");
  state.healthy = true;
  assert.equal(policy.evaluateTick().skip, true, "dispatcher delivering: stay quiet");
  state.healthy = false;
  assert.equal(policy.evaluateTick().skip, false, "dispatcher stopped delivering: claim");
});

test("claimSafetyPollIntervalMs configures, or with 0 disables, wake-driven claiming", () => {
  const custom = supervisorFixture({ claimSafetyPollIntervalMs: 600_000 }).seen;
  assert.equal(custom.cursor.find((entry) => entry.profile === "ghost").options.idlePolicy.safetyPollIntervalMs, 600_000);
  const off = supervisorFixture({ claimSafetyPollIntervalMs: 0 }).seen;
  for (const entry of [...off.headless, ...off.cursor]) {
    assert.equal(Object.hasOwn(entry.options, "idlePolicy"), false, `${entry.profile}: 0 keeps the old cadence`);
  }
  // A safety interval no longer than the lane's own poll interval would never skip a tick.
  const same = supervisorFixture({ claimSafetyPollIntervalMs: POLL_MS }).seen;
  for (const entry of [...same.headless, ...same.cursor]) {
    assert.equal(Object.hasOwn(entry.options, "idlePolicy"), false, `${entry.profile}: nothing to stretch`);
  }
  assert.throws(() => supervisorFixture({ claimSafetyPollIntervalMs: 1_000 }), /claimSafetyPollIntervalMs/);
  assert.throws(() => supervisorFixture({ claimSafetyPollIntervalMs: "300000" }), /claimSafetyPollIntervalMs/);
});

test("lanes without an install watch keep their poll timer", () => {
  const { seen } = supervisorFixture({
    useInstallWatchDispatcher: false,
    headlessWakes: [headlessWake({ profile: "bob" })],
    cursorAcpWakes: [cursorWake({ profile: "ghost" })],
  });
  for (const entry of [...seen.headless, ...seen.cursor]) {
    assert.equal(Object.hasOwn(entry.options, "idlePolicy"), false, entry.profile);
  }
  assert.equal(seen.dispatcher.length, 0);
});

test("watchIdlePollIntervalMs reaches the install dispatcher and defaults to 30 seconds", () => {
  assert.equal(supervisorFixture().seen.dispatcher[0].idlePollIntervalMs, 30_000);
  assert.equal(supervisorFixture({ watchIdlePollIntervalMs: 90_000 }).seen.dispatcher[0].idlePollIntervalMs, 90_000);
  assert.throws(() => supervisorFixture({ watchIdlePollIntervalMs: 1_000 }), /watchIdlePollIntervalMs/);
  assert.throws(() => supervisorFixture({ watchIdlePollIntervalMs: 0 }), /watchIdlePollIntervalMs/);
  assert.throws(() => supervisorFixture({ watchIdlePollIntervalMs: 601_000 }), /watchIdlePollIntervalMs/);
});

// --- one hour on the Mini's three lanes: what the helper is asked to run -----

/**
 * The real install dispatcher + wake client + the real drains, with the helper
 * replaced by counters. `claim-next` and `watch-poll` are the two idle helper
 * commands; each is one `triangle-mailbox` process.
 */
async function runHour({ wakeDriven, hours = 1, scenario = () => {} }) {
  const time = createVirtualTime();
  const origin = time.now();
  const lanes = {};
  const watchLog = [];
  let healthyProbe = () => false;
  let eventsFor = []; // [{ at, agentId, highWatermark }]
  let failWatchUntil = 0;
  let cursor = 0;
  const agents = { ghost: "agent_ghost", bob: "agent_bob", "codex-headless": "agent_codex_headless" };
  const kinds = { ghost: DRAINS[0], bob: DRAINS[1], "codex-headless": DRAINS[1] };

  for (const [profile, kind] of Object.entries(kinds)) {
    const mailbox = createMailbox(time);
    const policy = wakeDriven
      ? createDrainIdlePolicy({
        pollIntervalMs: POLL_MS, safetyPollIntervalMs: SAFETY_MS, random: () => 0.5, now: time.now,
        wakeChannelHealthy: () => healthyProbe(),
      })
      : null;
    const drain = kind.create({
      resolveDelivery: mailbox.resolveDelivery,
      profileInstanceId: deriveProfileInstanceId(profile),
      pollIntervalMs: POLL_MS,
      ...(policy ? { idlePolicy: policy } : {}),
      logger: { error() {} },
      setTimer: time.setTimer,
      clearTimer: time.clearTimer,
    });
    lanes[profile] = { drain, mailbox };
  }

  const dispatcher = createInstallWatchDispatcher({
    profiles: Object.keys(lanes).map((profile) => ({ instanceId: deriveProfileInstanceId(profile), agentId: agents[profile] })),
    handlers: new Map(Object.keys(lanes).map((profile) => [
      deriveProfileInstanceId(profile),
      async (wake) => lanes[profile].drain.kick({ reason: wake.reason?.startsWith("watch_hint") ? wake.reason : "watch_hint" }),
    ])),
    transport: {
      async poll({ cursor: from }) {
        watchLog.push({ type: "watch-poll", at: time.now() });
        if (time.now() < failWatchUntil) throw Object.assign(new Error("watch helper down"), { code: "helper_unavailable" });
        const ready = eventsFor.filter((event) => event.at <= time.now() && event.highWatermark > from);
        const events = ready.map((event) => ({ agent_id: event.agentId, high_watermark: event.highWatermark }));
        cursor = Math.max(cursor, from, ...ready.map((event) => event.highWatermark));
        return { events, cursor };
      },
    },
    idlePollIntervalMs: POLL_MS,
    coalesceMs: 300,
    logger: { error() {} },
    wakeClientFactory: (options) => createWakeClient({ ...options, now: time.now, sleep: time.sleep, random: () => 0.5 }),
  });
  healthyProbe = () => dispatcher.wakeChannelHealthy();

  const controller = new AbortController();
  for (const lane of Object.values(lanes)) await lane.drain.start({ runLoop: true });
  // The supervisor's durable loop: a failed watch is restarted after a backoff. The
  // dispatcher's startup reconcile hints every lane once, as in production.
  const watching = (async () => {
    while (!controller.signal.aborted) {
      try {
        await dispatcher.start({ signal: controller.signal });
      } catch {
        await dispatcher.stop();
        await time.sleep(5_000, { signal: controller.signal });
      }
    }
  })();

  await time.settle(); // the startup reconcile hints every lane at t=0
  const context = {
    time, origin, lanes, watchLog,
    emit(profile, delayMs = 0) {
      cursor += 1;
      eventsFor.push({ at: time.now() + delayMs, agentId: agents[profile], highWatermark: cursor });
      return cursor;
    },
    failWatchFor(ms) { failWatchUntil = time.now() + ms; },
    dispatcher,
  };
  await scenario(context);
  await time.advance(hours * HOUR_MS - (time.now() - origin));
  controller.abort();
  await dispatcher.stop();
  for (const lane of Object.values(lanes)) await lane.drain.stop();
  await time.advance(1);
  await watching;
  const claims = Object.fromEntries(Object.entries(lanes).map(([profile, lane]) => [profile, lane.mailbox.claims]));
  return { ...context, claims, watchPolls: watchLog.length };
}

test("an idle hour on ghost, bob and codex-headless: helper runs per hour, before and after", async (t) => {
  const before = await runHour({ wakeDriven: false });
  const after = await runHour({ wakeDriven: true });
  const total = (result) => Object.values(result.claims).reduce((sum, value) => sum + value, 0);
  t.diagnostic(`claim-next runs per hour, legacy 30 s timers: ${JSON.stringify(before.claims)} (${total(before)}); watch-poll runs: ${before.watchPolls}`);
  t.diagnostic(`claim-next runs per hour, wake-driven:         ${JSON.stringify(after.claims)} (${total(after)}); watch-poll runs: ${after.watchPolls}`);

  for (const profile of ["ghost", "bob", "codex-headless"]) {
    // 120 poll ticks in the hour plus the startup-reconcile hint.
    assert.equal(before.claims[profile], 121, `${profile}: legacy lane claims every 30 s`);
    // The startup hint at t=0, then one safety poll about every 330 s (300 s + 10% mean jitter, on a 30 s tick).
    assert.equal(after.claims[profile], 11, `${profile}: ${after.claims[profile]} claims in a wake-driven hour`);
  }
  // The watch is the wake channel: its cadence is the same before and after. (A
  // virtual poll takes no time; the Mini's take about a second, which is the 110/h seen there.)
  assert.ok(before.watchPolls >= 108 && before.watchPolls <= 120, `watch-poll runs ${before.watchPolls}`);
  assert.equal(after.watchPolls, before.watchPolls);
});

test("a delivery announced by a hint is claimed within one watch cycle, while the lane is wake-driven", async (t) => {
  const latencies = {};
  const result = await runHour({
    wakeDriven: true,
    async scenario({ time, lanes, emit }) {
      await time.advance(1_000_000); // well into the quiet part of the hour
      for (const [offset, profile] of [[0, "ghost"], [7_000, "bob"], [13_000, "codex-headless"]]) {
        await time.advance(offset === 0 ? 0 : 6_000);
        lanes[profile].mailbox.deposit();
        emit(profile);
      }
    },
  });
  for (const [profile, lane] of Object.entries(result.lanes)) {
    const delivery = lane.mailbox.log.find((entry) => entry.type === "delivery");
    assert.ok(delivery, `${profile}: the delivery was claimed`);
    latencies[profile] = (delivery.claimedAt - delivery.depositedAt) / 1000;
    // Worst case: the event lands just after a poll (one idle cycle, 30 s + 10% jitter + the poll) + 300 ms coalescing.
    assert.ok(latencies[profile] <= 34, `${profile}: ${latencies[profile]} s from event to claim`);
  }
  t.diagnostic(`event-to-claim latency while wake-driven (s): ${JSON.stringify(latencies)}`);
});

test("a delivery whose hint never arrives is still claimed by the safety poll, within its bound", async () => {
  const result = await runHour({
    wakeDriven: true,
    async scenario({ time, lanes }) {
      await time.advance(1_000_000);
      lanes.ghost.mailbox.deposit(); // no wake event at all
    },
  });
  const delivery = result.lanes.ghost.mailbox.log.find((entry) => entry.type === "delivery");
  assert.ok(delivery, "the safety poll found it");
  const latency = (delivery.claimedAt - delivery.depositedAt) / 1000;
  // Safety interval + up to 20% jitter + one poll tick of quantisation.
  assert.ok(latency <= 300 + 60 + 30, `${latency} s`);
});

test("when the watch goes down, lanes go back to claiming every tick and pick up work within a poll interval", async () => {
  const result = await runHour({
    wakeDriven: true,
    async scenario({ time, lanes, failWatchFor }) {
      await time.advance(1_000_000); // quiet, healthy, wake-driven
      failWatchFor(20 * 60_000); // the install watch is down for 20 minutes (ensure/402/429 style outage)
      await time.advance(5_000);
      lanes.bob.mailbox.deposit(); // arrives with no way to be announced
    },
  });
  const delivery = result.lanes.bob.mailbox.log.find((entry) => entry.type === "delivery");
  assert.ok(delivery);
  const latency = (delivery.claimedAt - delivery.depositedAt) / 1000;
  assert.ok(latency <= 90, `${latency} s: lanes polled normally once the watch stopped delivering`);
});

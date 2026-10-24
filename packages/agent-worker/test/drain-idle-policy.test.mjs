import assert from "node:assert/strict";
import test from "node:test";

import {
  createHelperDurableDeliveryResolver,
  isEmptyMailboxStatus,
} from "../src/helper-transaction-proxy.mjs";
import { createTrustedTransactionProxy } from "../src/shared-codex-app-server.mjs";
import { createWakeClient } from "../src/wake-client.mjs";
import {
  CLAIM_SAFETY_POLL_JITTER_RATIO,
  DEFAULT_CLAIM_SAFETY_POLL_MS,
  MAX_CLAIM_SAFETY_POLL_MS,
  MAX_WATCH_IDLE_POLL_MS,
  MIN_CLAIM_SAFETY_POLL_MS,
  MIN_WATCH_IDLE_POLL_MS,
  createDrainIdlePolicy,
  createInstallWatchDispatcher,
  validateClaimSafetyPollIntervalMs,
  validateWatchIdlePollIntervalMs,
} from "../src/install-watch-dispatcher.mjs";

const INSTANCE = "a".repeat(64);
const roomId = `room_${"a".repeat(32)}`;
const eventId = `event_${"b".repeat(32)}`;

function clock(start = 1_000_000) {
  let value = start;
  return { now: () => value, set: (next) => { value = next; }, advance: (ms) => { value += ms; } };
}

function policy(overrides = {}) {
  const time = overrides.time ?? clock();
  let healthy = overrides.healthy ?? true;
  const instance = createDrainIdlePolicy({
    pollIntervalMs: 30_000,
    safetyPollIntervalMs: 300_000,
    wakeChannelHealthy: overrides.probe ?? (() => healthy),
    random: overrides.random ?? (() => 0),
    now: time.now,
    ...(overrides.options ?? {}),
  });
  return { instance, time, setHealthy: (value) => { healthy = value; } };
}

test("claim safety interval validates as 0 (off) or a bounded integer", () => {
  assert.equal(DEFAULT_CLAIM_SAFETY_POLL_MS, 300_000);
  assert.equal(validateClaimSafetyPollIntervalMs(0), 0);
  assert.equal(validateClaimSafetyPollIntervalMs(undefined), 0);
  assert.equal(validateClaimSafetyPollIntervalMs(null), 0);
  assert.equal(validateClaimSafetyPollIntervalMs(MIN_CLAIM_SAFETY_POLL_MS), MIN_CLAIM_SAFETY_POLL_MS);
  assert.equal(validateClaimSafetyPollIntervalMs(MAX_CLAIM_SAFETY_POLL_MS), MAX_CLAIM_SAFETY_POLL_MS);
  for (const bad of [-1, 1, MIN_CLAIM_SAFETY_POLL_MS - 1, MAX_CLAIM_SAFETY_POLL_MS + 1, 30_000.5, "300000", NaN, Infinity]) {
    assert.throws(() => validateClaimSafetyPollIntervalMs(bad), /claimSafetyPollIntervalMs/, String(bad));
  }
});

test("watch idle poll validates inside the owner-tunable bounds", () => {
  assert.equal(validateWatchIdlePollIntervalMs(30_000), 30_000);
  assert.equal(validateWatchIdlePollIntervalMs(MIN_WATCH_IDLE_POLL_MS), MIN_WATCH_IDLE_POLL_MS);
  assert.equal(validateWatchIdlePollIntervalMs(MAX_WATCH_IDLE_POLL_MS), MAX_WATCH_IDLE_POLL_MS);
  for (const bad of [0, 9_999, MAX_WATCH_IDLE_POLL_MS + 1, 30_000.5, "30000", undefined, null, NaN]) {
    assert.throws(() => validateWatchIdlePollIntervalMs(bad), /watchIdlePollIntervalMs/, String(bad));
  }
});

test("policy arguments are validated", () => {
  const base = { pollIntervalMs: 30_000, safetyPollIntervalMs: 300_000, wakeChannelHealthy: () => true };
  assert.doesNotThrow(() => createDrainIdlePolicy(base));
  assert.throws(() => createDrainIdlePolicy({ ...base, pollIntervalMs: 0 }), /pollIntervalMs/);
  assert.throws(() => createDrainIdlePolicy({ ...base, safetyPollIntervalMs: 1.5 }), /safetyPollIntervalMs/);
  assert.throws(() => createDrainIdlePolicy({ ...base, wakeChannelHealthy: undefined }), /wakeChannelHealthy/);
  assert.throws(() => createDrainIdlePolicy({ ...base, jitterRatio: 2 }), /jitterRatio/);
  assert.throws(() => createDrainIdlePolicy(), /pollIntervalMs/);
});

test("a lane that has not finished an attempt yet claims on every tick", () => {
  const { instance } = policy();
  assert.deepEqual(instance.evaluateTick(), { skip: false, reason: "timer" });
  assert.deepEqual(instance.evaluateTick(), { skip: false, reason: "timer" });
});

test("a tick after an empty attempt waits for the safety interval, then claims once", () => {
  const { instance, time } = policy();
  instance.recordAttempt({ empty: true });
  for (const elapsed of [30_000, 60_000, 150_000, 299_999]) {
    time.set(1_000_000 + elapsed);
    assert.deepEqual(instance.evaluateTick(), { skip: true, reason: "wake_driven_idle" }, `at +${elapsed}`);
  }
  time.set(1_000_000 + 300_000);
  assert.deepEqual(instance.evaluateTick(), { skip: false, reason: "safety_poll" });
  assert.equal(instance.status().skippedTicks, 4);
  assert.equal(instance.status().safetyPolls, 1);
  // The attempt that tick makes restarts the wait.
  instance.recordAttempt({ empty: true });
  time.advance(60_000);
  assert.equal(instance.evaluateTick().skip, true);
});

test("jitter stretches the safety interval by at most the configured ratio", () => {
  assert.equal(CLAIM_SAFETY_POLL_JITTER_RATIO, 0.2);
  for (const [random, due] of [[() => 0, 300_000], [() => 0.5, 330_000], [() => 0.999999, 359_999]]) {
    const { instance, time } = policy({ random });
    instance.recordAttempt({ empty: true });
    time.advance(due - 1);
    assert.equal(instance.evaluateTick().skip, true, `just before ${due}`);
    time.advance(1);
    assert.equal(instance.evaluateTick().skip, false, `at ${due}`);
  }
  // A misbehaving random() cannot push the deadline outside [safety, safety * 1.2].
  for (const random of [() => -5, () => 7, () => NaN]) {
    const { instance, time } = policy({ random });
    instance.recordAttempt({ empty: true });
    time.advance(360_000);
    assert.equal(instance.evaluateTick().skip, false);
  }
});

test("only an attempt that positively found the mailbox empty relaxes the cadence", () => {
  for (const attempt of [{ empty: false }, {}, { empty: "yes" }, { empty: 1 }, undefined]) {
    const { instance, time } = policy();
    instance.recordAttempt(attempt);
    time.advance(30_000);
    assert.deepEqual(instance.evaluateTick(), { skip: false, reason: "timer" }, JSON.stringify(attempt));
  }
  // Work found after idling puts the lane straight back on the poll cadence.
  const { instance, time } = policy();
  instance.recordAttempt({ empty: true });
  time.advance(30_000);
  assert.equal(instance.evaluateTick().skip, true);
  instance.recordAttempt({ empty: false });
  time.advance(30_000);
  assert.deepEqual(instance.evaluateTick(), { skip: false, reason: "timer" });
});

test("an unhealthy, unknown or throwing wake channel keeps the poll cadence", () => {
  const { instance, time, setHealthy } = policy();
  instance.recordAttempt({ empty: true });
  time.advance(30_000);
  assert.equal(instance.evaluateTick().skip, true);
  setHealthy(false);
  assert.deepEqual(instance.evaluateTick(), { skip: false, reason: "timer" });
  setHealthy(true);
  assert.equal(instance.evaluateTick().skip, true);
  for (const probe of [() => { throw new Error("boom"); }, () => undefined, () => 1, () => "true", () => null]) {
    const broken = policy({ probe });
    broken.instance.recordAttempt({ empty: true });
    broken.time.advance(30_000);
    assert.deepEqual(broken.instance.evaluateTick(), { skip: false, reason: "timer" });
  }
});

test("a clock that moves backwards fails open", () => {
  const { instance, time } = policy();
  instance.recordAttempt({ empty: true });
  time.set(1_000_000 - 3_600_000);
  assert.equal(instance.evaluateTick().skip, false);
});

test("a safety interval at or below the poll interval never skips", () => {
  for (const safetyPollIntervalMs of [30_000, 20_000, 1]) {
    const { instance, time } = policy({ options: { safetyPollIntervalMs } });
    assert.equal(instance.active, false);
    instance.recordAttempt({ empty: true });
    time.advance(1);
    assert.deepEqual(instance.evaluateTick(), { skip: false, reason: "timer" });
  }
});

// --- the resolver is what says "empty" ---

test("only a listed, empty mailbox counts as empty", () => {
  const empty = { shouldStartModel: false, transactionStuck: false, open: null, status: "idle", suppressedDeliveryIds: [3, 4], quarantined: [] };
  assert.equal(isEmptyMailboxStatus(empty), true);
  assert.equal(isEmptyMailboxStatus({ shouldStartModel: false }), true);
  assert.equal(isEmptyMailboxStatus({ open: undefined }), true);
  for (const notEmpty of [
    null, undefined, "idle", 1, [],
    { ...empty, receiptOnly: true, replyRequired: false },
    { ...empty, transactionStuck: true },
    { ...empty, shouldStartModel: true },
    { ...empty, open: { deliveryId: 7, roomId, state: "claimed" } },
    { ...empty, open: { deliveryId: 7, roomId, state: "replied" } },
    { ...empty, open: {} },
  ]) {
    assert.equal(isEmptyMailboxStatus(notEmpty), false, JSON.stringify(notEmpty));
  }
});

function resolverFor(handler) {
  const commands = [];
  const resolveDelivery = createHelperDurableDeliveryResolver({
    helperPath: "/trusted/triangle-mailbox",
    profile: "ghost",
    protocol: "self-serve-drain",
    createProxy: createTrustedTransactionProxy,
    async run(_file, args) {
      commands.push(args[0]);
      return handler(args[0], commands.length);
    },
  });
  return { resolveDelivery, commands };
}

const ok = (payload) => ({ code: 0, stderr: "", stdout: JSON.stringify(payload) });

test("the resolver marks the outcome empty only when the helper found nothing pending", async () => {
  const scenarios = [
    ["empty mailbox", () => ok({ shouldStartModel: false, transactionStuck: false, open: null, status: "idle" }), null, true],
    ["only suppressed deliveries", () => ok({ shouldStartModel: false, transactionStuck: false, open: null, suppressedDeliveryIds: [9] }), null, true],
    ["a receipt was just settled", () => ok({ shouldStartModel: false, open: null, replyRequired: false, receiptOnly: true }), null, undefined],
    ["an open claim that needs no model turn", () => ok({
      shouldStartModel: false, replyRequired: true, open: { deliveryId: 5, roomId, inboundEventId: eventId, state: "claimed" },
    }), null, undefined],
  ];
  for (const [name, handler, expected, empty] of scenarios) {
    const { resolveDelivery } = resolverFor(handler);
    const outcome = {};
    assert.equal(await resolveDelivery({ outcome }), expected, name);
    assert.equal(outcome.empty, empty, name);
  }
});

test("the resolver does not call a claim, a helper outage or a stuck transaction empty", async () => {
  // Claimed delivery: returned to the caller, never empty.
  const claimed = resolverFor((command) => command === "transaction-claim-next"
    ? ok({ shouldStartModel: true, replyRequired: true, admitText: "hello", open: { deliveryId: 5, roomId, inboundEventId: eventId, state: "claimed" } })
    : ok({}));
  const claimedOutcome = {};
  assert.equal((await claimed.resolveDelivery({ outcome: claimedOutcome })).text, "hello");
  assert.equal(claimedOutcome.empty, undefined);

  // A replied-but-unacked transaction is acked first; the empty status after that is not "nothing was pending".
  const replied = resolverFor((command, call) => {
    if (command === "transaction-claim-next") {
      return call === 1
        ? ok({ shouldStartModel: false, open: { deliveryId: 5, roomId, inboundEventId: eventId, state: "replied" } })
        : ok({ shouldStartModel: false, open: null });
    }
    return ok({});
  });
  const repliedOutcome = {};
  assert.equal(await replied.resolveDelivery({ outcome: repliedOutcome }), null);
  assert.deepEqual(replied.commands, ["transaction-claim-next", "transaction-ack", "transaction-claim-next"]);
  assert.equal(repliedOutcome.empty, undefined);

  // Helper unavailable: nothing is known about the mailbox.
  const unavailable = resolverFor(() => ({ code: 1, stderr: JSON.stringify({ code: "helper_unavailable", safeToRetry: true }), stdout: "" }));
  const unavailableOutcome = {};
  assert.equal(await unavailable.resolveDelivery({ outcome: unavailableOutcome }), null);
  assert.equal(unavailableOutcome.empty, undefined);
  // An unreadable reply says nothing about the mailbox either.
  const garbled = resolverFor(() => ({ code: 0, stderr: "", stdout: "not json" }));
  const garbledOutcome = {};
  assert.equal(await garbled.resolveDelivery({ outcome: garbledOutcome }), null);
  assert.equal(garbledOutcome.empty, undefined);

  // Stuck: throws, never empty.
  const stuck = resolverFor(() => ok({ shouldStartModel: false, transactionStuck: true, open: null }));
  const stuckOutcome = {};
  await assert.rejects(stuck.resolveDelivery({ outcome: stuckOutcome }), /stuck/);
  assert.equal(stuckOutcome.empty, undefined);

  // No outcome argument (every existing caller) still works.
  const bare = resolverFor(() => ok({ shouldStartModel: false, open: null }));
  assert.equal(await bare.resolveDelivery(), null);
  assert.equal(await bare.resolveDelivery({ signal: undefined, outcome: null }), null);
  assert.equal(await bare.resolveDelivery({ reason: "wake" }), null);
});

// --- the wake channel says whether hints can be relied on ---

function watchTransport(responses) {
  const queue = [...responses];
  const polls = [];
  return {
    polls,
    async poll({ cursor }) {
      polls.push(cursor);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test("wake client health follows watch polls: healthy only after a recent success", async () => {
  const time = clock(5_000_000);
  const failing = Object.assign(new Error("helper down"), { code: "helper_unavailable" });
  const transport = watchTransport([{ events: [], cursor: 0 }, { events: [], cursor: 0 }, failing, { events: [], cursor: 0 }]);
  const wake = createWakeClient({
    profiles: [{ instanceId: INSTANCE, agentId: "agent_a" }],
    transport,
    onWake: async () => {},
    idlePollIntervalMs: 30_000,
    idleJitterRatio: 0.1,
    now: time.now,
    sleep: async () => {},
  });
  assert.equal(wake.health().healthy, false, "no poll yet");
  assert.equal(wake.health().lastPollOkAt, null);

  await wake.runOnce();
  assert.equal(wake.health().healthy, true);
  // Window: three idle cycles with jitter plus a minute for a held poll.
  const window = wake.health().healthyWithinMs;
  assert.equal(window, Math.ceil(30_000 * 1.1) * 3 + 60_000);
  time.advance(window);
  assert.equal(wake.health().healthy, true, "still inside the window");
  time.advance(1);
  assert.equal(wake.health().healthy, false, "silent for longer than the window");

  await wake.runOnce();
  assert.equal(wake.health().healthy, true, "a successful poll makes it healthy again");
  await assert.rejects(wake.runOnce(), /helper down/);
  assert.equal(wake.health().healthy, false, "a failed poll is unhealthy at once, well inside the window");
  assert.equal(wake.health().lastPollOkAt, null);
  await wake.runOnce();
  assert.equal(wake.health().healthy, true, "recovers on the next successful poll");
  await wake.stop();
  assert.equal(wake.health().healthy, false, "stopped");
});

test("a resync reply still proves the channel works", async () => {
  const resync = Object.assign(new Error("resync"), { code: "resync_required", restartCursor: 12 });
  const woken = [];
  const wake = createWakeClient({
    profiles: [{ instanceId: INSTANCE, agentId: "agent_a" }],
    transport: watchTransport([resync]),
    onWake: async (event) => { woken.push(event.reason); },
    sleep: async () => {},
    logger: { error() {} },
  });
  await wake.runOnce();
  assert.deepEqual(woken, ["resync_reconcile"]);
  assert.equal(wake.health().healthy, true);
});

test("dispatcher exposes wake channel health and fails safe without a client", async () => {
  const time = clock(7_000_000);
  const transport = watchTransport([{ events: [], cursor: 0 }]);
  const dispatcher = createInstallWatchDispatcher({
    profiles: [{ instanceId: INSTANCE, agentId: "agent_a" }],
    handlers: new Map([[INSTANCE, async () => ({ status: "accepted" })]]),
    transport,
    idlePollIntervalMs: 10_000,
    wakeClientFactory: (options) => createWakeClient({ ...options, now: time.now, sleep: async () => {} }),
  });
  assert.equal(dispatcher.wakeChannelHealthy(), false, "before start");
  await dispatcher.start({ maxCycles: 1 });
  assert.equal(dispatcher.wakeChannelHealthy(), true, "after a successful watch poll");
  time.advance(10 * 60_000);
  assert.equal(dispatcher.wakeChannelHealthy(), false, "stale");
  await dispatcher.stop();
  assert.equal(dispatcher.wakeChannelHealthy(), false, "after stop");

  // A wake client without health(), or one whose health() throws, is "not healthy".
  for (const health of [undefined, () => { throw new Error("boom"); }]) {
    const odd = createInstallWatchDispatcher({
      profiles: [{ instanceId: INSTANCE, agentId: "agent_a" }],
      handlers: new Map([[INSTANCE, async () => ({ status: "accepted" })]]),
      transport,
      wakeClientFactory: () => ({
        async reconcileStartup() {},
        async watch() { return { cycles: 0 }; },
        async stop() {},
        ...(health ? { health } : {}),
      }),
    });
    await odd.start({ maxCycles: 1 });
    assert.equal(odd.wakeChannelHealthy(), false);
  }
});

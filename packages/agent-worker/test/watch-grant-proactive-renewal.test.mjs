// L1e: installation-scoped proactive watch-grant renewal, helper expiry
// plumbing, and timestamped supervisor stderr lines.
import assert from "node:assert/strict";
import test from "node:test";

import {
  createWatchGrantRenewalRegistry,
  parseGrantExpiry,
  PROACTIVE_RENEWAL_FRACTION,
} from "../src/client-supervisor.mjs";
import { sanitizedLogger } from "../src/client-supervisor-cli.mjs";
import { ensureHelperWatchGrant, parseWatchGrantStatusExpiry } from "../src/helper-watch-transport.mjs";

const EPOCH_MS = Date.parse("2026-10-17T19:00:00.000Z");
const TTL_MS = 3_600_000;
const INSTALLATION = "inst_N7VhDq3mQ2";
const RENEWAL = { helperPath: "/trusted/triangle-mailbox", installationId: INSTALLATION, actorProfile: "event-hermes" };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createClock() {
  let current = EPOCH_MS;
  const timers = [];
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    now: () => current,
    sleep(ms, { signal } = {}) {
      return new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const timer = { at: current + ms, resolve };
        timers.push(timer);
        signal?.addEventListener?.("abort", () => {
          const index = timers.indexOf(timer);
          if (index >= 0) timers.splice(index, 1);
          resolve();
        }, { once: true });
      });
    },
    async advanceTo(at) {
      for (;;) {
        await settle();
        timers.sort((a, b) => a.at - b.at);
        if (!timers.length || timers[0].at > at) break;
        const next = timers.shift();
        current = next.at;
        next.resolve();
      }
      current = Math.max(current, at);
      await settle();
    },
    pending: () => timers.length,
    settle,
  };
}

const iso = (ms) => new Date(ms).toISOString();

test("parseGrantExpiry accepts helper ISO UTC expiries and rejects untrusted values", () => {
  const now = EPOCH_MS;
  assert.equal(parseGrantExpiry(iso(now + TTL_MS), now), now + TTL_MS);
  assert.equal(parseGrantExpiry("2026-10-17T20:00:00Z", now), Date.parse("2026-10-17T20:00:00Z"));
  for (const bad of [undefined, null, 42, "", "tomorrow", "2026-10-17T20:00:00", "2026-10-17T20:00:00+00:00",
    iso(now - 1), iso(now + 30 * 24 * 3_600_000)]) {
    assert.equal(parseGrantExpiry(bad, now), null, String(bad));
  }
});

test("one proactive renewal per installation at 85% of the lifetime; duplicate schedulers are no-ops", async () => {
  const clock = createClock();
  const calls = [];
  const registry = createWatchGrantRenewalRegistry({
    now: clock.now,
    ensureWatchGrant: async () => {
      calls.push(clock.now());
      return { ensured: true, expiresAt: iso(clock.now() + TTL_MS) };
    },
  });
  const controller = new AbortController();
  registry.recordEnsure(INSTALLATION, { ensured: true, expiresAt: iso(EPOCH_MS + TTL_MS) });
  const a = registry.runProactive({ renewal: RENEWAL, signal: controller.signal, sleep: clock.sleep });
  const b = registry.runProactive({ renewal: { ...RENEWAL, actorProfile: "other" }, signal: controller.signal, sleep: clock.sleep });
  const renewAt = EPOCH_MS + TTL_MS * PROACTIVE_RENEWAL_FRACTION;
  await clock.advanceTo(renewAt - 1);
  assert.equal(calls.length, 0);
  await clock.advanceTo(renewAt);
  assert.deepEqual(calls, [renewAt]);
  assert.equal(registry.state(INSTALLATION).generation, 1);
  controller.abort();
  await Promise.all([a, b]);
  assert.equal(registry.state(INSTALLATION).proactiveOwner, null);
});

test("proactive and rejection-driven renewal coalesce onto one watch-ensure", async () => {
  const clock = createClock();
  const gate = deferred();
  let calls = 0;
  const registry = createWatchGrantRenewalRegistry({
    now: clock.now,
    ensureWatchGrant: async () => {
      calls += 1;
      await gate.promise;
      return { ensured: true, expiresAt: iso(clock.now() + TTL_MS) };
    },
  });
  const controller = new AbortController();
  registry.recordEnsure(INSTALLATION, { ensured: true, expiresAt: iso(EPOCH_MS + TTL_MS) });
  const observed = registry.state(INSTALLATION).generation;
  const scheduler = registry.runProactive({ renewal: RENEWAL, signal: controller.signal, sleep: clock.sleep });
  await clock.advanceTo(EPOCH_MS + TTL_MS * PROACTIVE_RENEWAL_FRACTION);
  assert.equal(calls, 1, "proactive renewal in flight");
  // A listener rejected on the same generation joins the in-flight renewal.
  const reactive = registry.renew(RENEWAL, observed);
  await clock.settle();
  assert.equal(calls, 1, "reactive trigger must not start a second watch-ensure");
  gate.resolve();
  assert.deepEqual(await reactive, { renewed: true, trigger: "proactive" });
  // A late rejection from a poll that started on the old credential reuses it.
  assert.deepEqual(await registry.renew(RENEWAL, observed), { renewed: false, reusedRenewal: true, trigger: "rejection" });
  assert.equal(calls, 1);
  controller.abort();
  await scheduler;
});

test("a reactive renewal reschedules the proactive timer instead of double-renewing", async () => {
  const clock = createClock();
  const calls = [];
  const registry = createWatchGrantRenewalRegistry({
    now: clock.now,
    ensureWatchGrant: async () => {
      calls.push(clock.now());
      return { ensured: true, expiresAt: iso(clock.now() + TTL_MS) };
    },
  });
  const controller = new AbortController();
  registry.recordEnsure(INSTALLATION, { ensured: true, expiresAt: iso(EPOCH_MS + TTL_MS) });
  const scheduler = registry.runProactive({ renewal: RENEWAL, signal: controller.signal, sleep: clock.sleep });
  await clock.advanceTo(EPOCH_MS + 10 * 60_000);
  await registry.renew(RENEWAL, registry.state(INSTALLATION).generation); // e.g. revoked out of band
  const reactiveAt = EPOCH_MS + 10 * 60_000;
  await clock.advanceTo(EPOCH_MS + TTL_MS * PROACTIVE_RENEWAL_FRACTION + 1);
  assert.deepEqual(calls, [reactiveAt], "stale timer for the first grant must not fire");
  await clock.advanceTo(reactiveAt + TTL_MS * PROACTIVE_RENEWAL_FRACTION);
  assert.deepEqual(calls, [reactiveAt, reactiveAt + TTL_MS * PROACTIVE_RENEWAL_FRACTION]);
  controller.abort();
  await scheduler;
});

test("unknown expiry (legacy helper) schedules nothing; reactive renew still works", async () => {
  const clock = createClock();
  let calls = 0;
  const registry = createWatchGrantRenewalRegistry({
    now: clock.now,
    ensureWatchGrant: async () => { calls += 1; return { ensured: true }; },
  });
  const controller = new AbortController();
  registry.recordEnsure(INSTALLATION, { ensured: true });
  const scheduler = registry.runProactive({ renewal: RENEWAL, signal: controller.signal, sleep: clock.sleep });
  await clock.advanceTo(EPOCH_MS + 5 * TTL_MS);
  assert.equal(calls, 0);
  assert.equal(clock.pending(), 0, "no timer armed without an expiry");
  assert.deepEqual(await registry.renew(RENEWAL, 0), { renewed: true, trigger: "rejection" });
  assert.equal(calls, 1);
  controller.abort();
  await scheduler;
});

test("an injected sleep that returns immediately cannot hot-loop the scheduler", async () => {
  let calls = 0;
  const registry = createWatchGrantRenewalRegistry({
    now: () => EPOCH_MS,
    ensureWatchGrant: async () => { calls += 1; return { ensured: true }; },
  });
  const controller = new AbortController();
  registry.recordEnsure(INSTALLATION, { ensured: true, expiresAt: iso(EPOCH_MS + TTL_MS) });
  let sleeps = 0;
  const scheduler = registry.runProactive({
    renewal: RENEWAL,
    signal: controller.signal,
    sleep: async () => { sleeps += 1; },
  });
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(sleeps <= 3, `scheduler spun ${sleeps} times`);
  assert.equal(calls, 0);
  controller.abort();
  await scheduler;
});

test("supervisor stderr lines lead with an ISO timestamp and carry HTTP status", () => {
  let written = "";
  const logger = sanitizedLogger({ write(chunk) { written += chunk; } }, {
    now: () => Date.parse("2026-10-18T02:39:24.000Z"),
  });
  logger.error("triangle_client_install_watch_failed", { rejectedCode: "watch_credential_invalid", status: 401 });
  logger.error("triangle_client_watch_grant_proactive_renewal_failed", { code: "helper_unavailable", status: 429 });
  logger.error("triangle_client_watch_grant_renewal_failed", { code: "invalid_grant" });
  assert.equal(written, [
    "2026-10-18T02:39:24.000Z triangle-client: instance cycle failed (watch_credential_invalid/401) [install_watch_failed]",
    "2026-10-18T02:39:24.000Z triangle-client: instance cycle failed (helper_unavailable/429) [watch_grant_proactive_renewal_failed]",
    "2026-10-18T02:39:24.000Z triangle-client: instance cycle failed (invalid_grant) [watch_grant_renewal_failed]",
    "",
  ].join("\n"));
});

test("watch-ensure stdout expiresAt is surfaced; legacy and malformed stdout are not", async () => {
  const status = (extra) => `${JSON.stringify({ state: "finalized", listenerReady: true, operatorAction: "none", ...extra })}\n`;
  assert.equal(parseWatchGrantStatusExpiry(status({ expiresAt: "2026-10-17T20:39:24.123Z" })), "2026-10-17T20:39:24.123Z");
  assert.equal(parseWatchGrantStatusExpiry(status({})), null);
  assert.equal(parseWatchGrantStatusExpiry(status({ expiresAt: "soon" })), null);
  assert.equal(parseWatchGrantStatusExpiry("not json"), null);

  const run = async (_file, args) => {
    assert.equal(args[0], "watch-ensure");
    return { code: 0, stdout: status({ expiresAt: "2026-10-17T20:39:24.123Z" }), stderr: "" };
  };
  assert.deepEqual(
    await ensureHelperWatchGrant({ helperPath: "/trusted/triangle-mailbox", installationId: INSTALLATION, actorProfile: "event-hermes", run }),
    { ensured: true, expiresAt: "2026-10-17T20:39:24.123Z" },
  );
  const legacyRun = async () => ({ code: 0, stdout: status({}), stderr: "" });
  assert.deepEqual(
    await ensureHelperWatchGrant({ helperPath: "/trusted/triangle-mailbox", installationId: INSTALLATION, actorProfile: "event-hermes", run: legacyRun }),
    { ensured: true },
  );
});

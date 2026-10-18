// L1d / M0a reproducer -> L1e regression: hourly
// `watch_credential_invalid [install_watch_failed]`.
//
// Live evidence (Mac mini, Oct 14-17 2026 PT): 81 consecutive
// `instance cycle failed (watch_credential_invalid) [install_watch_failed]`
// lines, one per 3600 s + 10..42 s (median 25 s), never followed by
// `[watch_grant_renewal_failed]`. The cadence resets on supervisor restart
// (restart 2026-10-16 21:31:00 -> next failure 22:31:19).
//
// Mechanism (no race required): MESH stamps a watch grant with
// expires_at = create + grantTtlSeconds (cap 3600 s; finalize does not extend
// it), the helper used to drop expires_at, and runDurableWakeLoop only renewed
// after a poll was rejected. L1e: the helper reports `expiresAt` from
// watch-ensure and the supervisor renews proactively at 85 % of the lifetime;
// helpers without `expiresAt` keep the old reactive behaviour.
//
// Everything below runs the real supervisor loop on a discrete-event virtual
// clock: a fake MESH grant store with a 3600 s TTL, a 25 s held poll, and a
// 2 s watch-ensure.
import assert from "node:assert/strict";
import test from "node:test";

import { createClientSupervisor, PROACTIVE_RENEWAL_FRACTION } from "../src/client-supervisor.mjs";

const GRANT_TTL_MS = 3_600_000; // production MESH_MAILBOX_WATCH_GRANT_TTL_SECONDS cap
const HELD_POLL_MS = 25_000; // MESH pollTimeoutSeconds default
const ENSURE_MS = 2_000; // helper create/join/finalize round trips
const SIMULATED_MS = 3 * GRANT_TTL_MS + 10 * 60_000;
const EPOCH_MS = Date.parse("2026-10-17T00:00:00.000Z");

const id = (index) => index.toString(16).padStart(64, "0");

function eventWakeFixture() {
  const instanceId = id(2);
  const agentId = `agent_${"e".repeat(32)}`;
  return {
    installationId: "inst_N7VhDq3mQ2",
    helperPath: "/trusted/triangle-mailbox",
    cursorPath: "/private/wake-cursor.json",
    actorProfile: "event-hermes",
    ensureBeforeWatch: true,
    profiles: [{ instanceId, agentId }],
    drains: [{
      instanceId,
      mailbox: {
        meshUrl: "https://mesh.example",
        meshToken: `mesh_${"e".repeat(64)}`,
        recipientId: agentId,
        pageLimit: 1,
      },
      runner: { command: "/trusted/runner", args: [], timeoutMs: 1_000 },
      runnerEnvironment: { PATH: "/usr/bin", TRIANGLE_INSTANCE_ID: instanceId },
    }],
  };
}

/** Discrete-event clock: sleeps resolve only when the driver advances time. */
export function createVirtualClock() {
  let current = 0;
  let sequence = 0;
  const timers = [];
  const settle = async () => {
    for (let i = 0; i < 25; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  function sleep(ms, { signal } = {}) {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = { at: current + Math.max(0, ms), seq: sequence += 1, resolve };
      timers.push(timer);
      signal?.addEventListener?.("abort", () => {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
        resolve();
      }, { once: true });
    });
  }
  async function runUntil(limitMs) {
    for (;;) {
      await settle();
      if (timers.length === 0) return;
      timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      if (timers[0].at > limitMs) {
        current = limitMs;
        return;
      }
      const next = timers.shift();
      current = next.at;
      next.resolve();
    }
  }
  async function drain() {
    for (let i = 0; i < 1_000 && timers.length; i += 1) {
      timers.shift().resolve();
      await settle();
    }
  }
  return {
    now: () => current,
    wallNow: () => EPOCH_MS + current,
    sleep,
    runUntil,
    drain,
    settle,
  };
}

/** Fake MESH grant store shared across supervisor processes (restarts). */
function createFakeMesh(clock) {
  let grant = null;
  let serial = 0;
  return {
    get grant() { return grant; },
    mint() {
      serial += 1;
      if (grant) grant.revoked = true; // finalize revokes the replaced grant
      grant = { id: serial, createdAt: clock.now(), expiresAt: clock.now() + GRANT_TTL_MS, revoked: false };
      return grant;
    },
  };
}

async function runSupervisor({
  clock,
  mesh,
  durationMs,
  reportExpiry = true,
  failEnsure = () => null,
}) {
  const ensures = [];
  const failures = [];
  const renewalFailures = [];
  const proactiveFailures = [];
  const controller = new AbortController();

  const supervisor = createClientSupervisor({
    instances: [],
    eventWake: eventWakeFixture(),
    now: clock.wallNow,
    createWake: () => ({
      async start({ signal }) {
        while (!signal.aborted) {
          // Each helper `watch-poll` reads the current local credential; MESH
          // resolves the grant once at the start of the held poll.
          const credential = mesh.grant;
          if (!credential || credential.revoked || clock.now() >= credential.expiresAt) {
            const error = new Error("watch grant request was rejected (watch_credential_invalid)");
            error.rejectedCode = "watch_credential_invalid";
            error.status = 401;
            throw error;
          }
          await clock.sleep(HELD_POLL_MS, { signal });
        }
        return { status: "stopped" };
      },
      async stop() {},
    }),
    ensureWatchGrant: async ({ signal }) => {
      await clock.sleep(ENSURE_MS, { signal });
      const injected = failEnsure(ensures.length);
      if (injected) {
        ensures.push({ at: clock.now(), failed: true });
        throw injected;
      }
      const previous = mesh.grant;
      const grant = mesh.mint();
      ensures.push({ at: clock.now(), grant: grant.id, previousExpiresAt: previous?.expiresAt ?? null });
      return reportExpiry
        ? { ensured: true, expiresAt: new Date(EPOCH_MS + grant.expiresAt).toISOString() }
        : { ensured: true };
    },
    logger: {
      error(event, detail) {
        if (event === "triangle_client_event_wake_failed" && detail?.rejectedCode === "watch_credential_invalid") {
          failures.push({ at: clock.now(), status: detail.status });
        }
        if (event === "triangle_client_watch_grant_renewal_failed") renewalFailures.push({ at: clock.now(), detail });
        if (event === "triangle_client_watch_grant_proactive_renewal_failed") {
          proactiveFailures.push({ at: clock.now(), detail });
        }
      },
    },
  });

  const watching = supervisor.watch({ signal: controller.signal, sleep: clock.sleep });
  await clock.runUntil(clock.now() + durationMs);
  controller.abort();
  await clock.drain();
  await watching;
  return { ensures, failures, renewalFailures, proactiveFailures };
}

test("watch grant is renewed before its server-side expiry (no hourly watch_credential_invalid)", async () => {
  const clock = createVirtualClock();
  const mesh = createFakeMesh(clock);
  const { ensures, failures, renewalFailures } = await runSupervisor({ clock, mesh, durationMs: SIMULATED_MS });
  assert.deepEqual(failures, [], `expected zero expiry failures over ~3 h, got ${failures.length}`);
  assert.deepEqual(renewalFailures, []);
  // Initial ensure + one proactive renewal per elapsed 85 % of a lifetime.
  const expected = 1 + Math.floor(SIMULATED_MS / (GRANT_TTL_MS * PROACTIVE_RENEWAL_FRACTION + ENSURE_MS));
  assert.equal(ensures.length, expected);
  for (const ensure of ensures.slice(1)) {
    assert.ok(ensure.at < ensure.previousExpiresAt, "renewal must land before the previous grant expires");
    assert.ok(ensure.previousExpiresAt - ensure.at >= 0.1 * GRANT_TTL_MS, "renewal should leave a safety margin");
  }
});

test("legacy helper without expiresAt falls back to reactive renewal (one failure per TTL, one uncontended renewal)", async () => {
  const clock = createVirtualClock();
  const mesh = createFakeMesh(clock);
  const { ensures, failures, renewalFailures } = await runSupervisor({
    clock, mesh, durationMs: SIMULATED_MS, reportExpiry: false,
  });
  assert.equal(failures.length, 3);
  for (let i = 1; i < failures.length; i += 1) {
    const overheadMs = failures[i].at - failures[i - 1].at - GRANT_TTL_MS;
    assert.ok(overheadMs > 0 && overheadMs <= HELD_POLL_MS + ENSURE_MS + 6_000, String(overheadMs));
  }
  assert.ok(failures.every((failure) => failure.status === 401), "failure lines should carry HTTP status");
  assert.equal(ensures.length, 1 + failures.length);
  assert.deepEqual(renewalFailures, []);
});

test("restart: a new supervisor schedules from its own initial ensure and the old scheduler stops", async () => {
  const clock = createVirtualClock();
  const mesh = createFakeMesh(clock);
  const first = await runSupervisor({ clock, mesh, durationMs: 40 * 60_000 });
  assert.equal(first.ensures.length, 1);
  const stoppedAt = clock.now();
  const second = await runSupervisor({ clock, mesh, durationMs: 2 * GRANT_TTL_MS });
  assert.deepEqual(second.failures, []);
  assert.equal(second.ensures[0].at, stoppedAt + ENSURE_MS, "restart re-ensures immediately");
  assert.equal(second.ensures.length, 1 + 2);
  assert.equal(first.ensures.length, 1, "aborted supervisor must not renew after shutdown");
});

test("failed proactive renewal is retried, then the reactive path still recovers", async () => {
  const clock = createVirtualClock();
  const mesh = createFakeMesh(clock);
  const quota = Object.assign(new Error("rate limited"), { status: 429, code: "helper_unavailable" });
  // Ensure #0 (initial) succeeds; every proactive attempt for grant 1 fails.
  const { ensures, failures, proactiveFailures } = await runSupervisor({
    clock,
    mesh,
    durationMs: GRANT_TTL_MS + 10 * 60_000,
    failEnsure: (index) => (index >= 1 && clock.now() < GRANT_TTL_MS ? quota : null),
  });
  assert.ok(proactiveFailures.length >= 2, `expected retries, got ${proactiveFailures.length}`);
  assert.ok(proactiveFailures.every((entry) => entry.detail.status === 429));
  assert.equal(failures.length, 1, "reactive fallback logs exactly one expiry failure");
  assert.ok(ensures.at(-1).failed !== true && ensures.at(-1).at > GRANT_TTL_MS, "reactive renewal minted a new grant");
});

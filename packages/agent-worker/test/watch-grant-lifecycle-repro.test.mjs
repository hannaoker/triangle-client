// L1d / M0a reproducer: hourly `watch_credential_invalid [install_watch_failed]`.
//
// Live evidence (Mac mini, Oct 14-17 2026 PT): 81 consecutive
// `instance cycle failed (watch_credential_invalid) [install_watch_failed]`
// lines, one per 3600 s + 10..42 s (median 25 s), never followed by
// `[watch_grant_renewal_failed]`. The cadence resets on supervisor restart
// (restart 2026-10-16 21:31:00 -> next failure 22:31:19).
//
// Mechanism (no race required):
//   * MESH stamps a watch grant with expires_at = create + grantTtlSeconds
//     (the-triangle mesh/app/lib/mailbox-watch.ts; config caps TTL at 3600 s).
//     Finalize does not extend it and there is no refresh endpoint.
//   * The helper drops expires_at: StagedWatchGrant carries it, but
//     FinalizedWatchGrant / WatchGrantBinding do not, so nothing local knows
//     when the credential dies.
//   * runDurableWakeLoop only renews *reactively* after a poll is rejected with
//     watch_credential_invalid, so every grant lifetime ends in exactly one
//     logged failure + stop/renew/5 s backoff/restart.
//
// The deterministic sequence is modelled with a virtual clock: a fake MESH
// grant store with a 3600 s TTL, a 25 s held poll, and the real supervisor
// loop. The `todo` test states the desired behaviour (renew before expiry) and
// currently FAILS; node:test reports it as todo so the suite stays green. The
// second test pins today's behaviour and the evidence against a renewal race.
import assert from "node:assert/strict";
import test from "node:test";

import { createClientSupervisor } from "../src/client-supervisor.mjs";

const GRANT_TTL_MS = 3_600_000; // production MESH_MAILBOX_WATCH_GRANT_TTL_SECONDS cap
const HELD_POLL_MS = 25_000; // MESH pollTimeoutSeconds default
const ENSURE_MS = 2_000; // helper create/join/finalize round trips
const SIMULATED_MS = 3 * GRANT_TTL_MS + 10 * 60_000;

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

function simulateLiveLifecycle() {
  let now = 0;
  let grant = null;
  let grantSerial = 0;
  const ensures = [];
  const failures = [];
  const renewalFailures = [];
  const controller = new AbortController();
  const stopIfDone = () => { if (now >= SIMULATED_MS) controller.abort(); };

  const supervisor = createClientSupervisor({
    instances: [],
    eventWake: eventWakeFixture(),
    createWake: () => ({
      async start({ signal }) {
        // Held long-poll loop against the current credential.
        const held = grant;
        while (!signal.aborted) {
          now += HELD_POLL_MS;
          stopIfDone();
          if (signal.aborted) return { status: "stopped" };
          if (!held || now >= held.expiresAt) {
            const error = new Error("watch grant request was rejected (watch_credential_invalid)");
            error.rejectedCode = "watch_credential_invalid";
            error.status = 401;
            throw error;
          }
          await Promise.resolve();
        }
        return { status: "stopped" };
      },
      async stop() {},
    }),
    // Stands in for `triangle-mailbox watch-ensure`: MESH mints a fresh grant
    // whose lifetime is fixed at creation.
    ensureWatchGrant: async () => {
      now += ENSURE_MS;
      grantSerial += 1;
      grant = { id: grantSerial, createdAt: now, expiresAt: now + GRANT_TTL_MS };
      ensures.push({ at: now, grant: grant.id });
      return { ensured: true };
    },
    logger: {
      error(event, detail) {
        if (event === "triangle_client_event_wake_failed" && detail?.rejectedCode === "watch_credential_invalid") {
          failures.push({ at: now, expiredGrant: grant?.id, lateMs: now - (grant?.expiresAt ?? now) });
        }
        if (event === "triangle_client_watch_grant_renewal_failed") renewalFailures.push({ at: now, detail });
      },
    },
  });

  return supervisor.watch({
    signal: controller.signal,
    sleep: async (ms) => { now += ms; stopIfDone(); },
  }).then(() => ({ ensures, failures, renewalFailures, now }));
}

test(
  "watch grant is renewed before its server-side expiry (no hourly watch_credential_invalid)",
  { todo: "L1d: supervisor/helper only renew reactively; WatchGrantBinding drops expires_at" },
  async () => {
    const { failures } = await simulateLiveLifecycle();
    assert.deepEqual(failures, [], `expected zero expiry failures over ~3 h, got ${failures.length}`);
  },
);

test("current behaviour: exactly one reactive failure per grant TTL, recovered by one uncontended renewal", async () => {
  const { ensures, failures, renewalFailures } = await simulateLiveLifecycle();
  // One failure per elapsed grant lifetime (~3 h simulated => 3 failures).
  assert.equal(failures.length, 3);
  // Each failure is detected within one held-poll window after expiry.
  for (const failure of failures) {
    assert.ok(failure.lateMs >= 0 && failure.lateMs <= HELD_POLL_MS, JSON.stringify(failure));
  }
  // Inter-failure spacing = TTL + detection lag + ensure time, i.e. the
  // ~3600 s + 10..42 s cadence observed live.
  for (let i = 1; i < failures.length; i += 1) {
    const overheadMs = failures[i].at - failures[i - 1].at - GRANT_TTL_MS;
    assert.ok(overheadMs > 0 && overheadMs <= HELD_POLL_MS + ENSURE_MS, String(overheadMs));
  }
  // Not a race: the initial ensure plus exactly one renewal per failure, and
  // every renewal succeeded first time (live log has no renewal_failed lines).
  assert.equal(ensures.length, 1 + failures.length);
  assert.deepEqual(renewalFailures, []);
});

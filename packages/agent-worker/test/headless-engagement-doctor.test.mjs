import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  formatDoctorReport,
  runHeadlessEngagementDoctor,
} from "../src/headless-engagement-doctor.mjs";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "headless-doctor-"));
  const client = path.join(root, "client");
  mkdirSync(client, { recursive: true, mode: 0o700 });
  const workdir = path.join(root, "work");
  const codexHome = path.join(root, "codex-home");
  const command = path.join(root, "codex");
  mkdirSync(workdir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(command, "#!/bin/sh\n", { mode: 0o700 });
  writeFileSync(
    path.join(client, "ready.json"),
    `${JSON.stringify({
      version: 1,
      generation: "11111111-1111-4111-8111-111111111111",
      parentPid: 42,
      configDigest: "abc",
      readyAtMilliseconds: Date.now(),
    })}\n`,
  );
  writeFileSync(
    path.join(client, "headless-runtime-binding.json"),
    `${JSON.stringify({
      version: 2,
      common: {
        adapterVersion: "1",
        installationId: "inst_x",
        workingDirectory: workdir,
        codexHome,
        command,
        pollIntervalMs: 30000,
      },
      profiles: [
        {
          profile: "bob",
          instanceId: "a".repeat(64),
          stateRoot: path.join(root, "state", "bob"),
        },
      ],
    })}\n`,
  );
  return { root, client };
}

test("doctor reports progress separately and exits 0 when healthy", () => {
  const { root, client } = fixture();
  try {
    writeFileSync(
      path.join(client, "headless-progress.json"),
      `${JSON.stringify({
        watch: { connection: "connected", grantHealth: "ok" },
        profiles: {
          bob: {
            lastAcceptedKickAt: "2026-10-03T20:00:00.000Z",
            lastClaimAt: "2026-10-03T20:00:05.000Z",
            lastReplyAt: "2026-10-03T20:00:10.000Z",
            lastAckAt: "2026-10-03T20:00:11.000Z",
            pendingCount: 0,
          },
        },
      })}\n`,
    );
    const result = runHeadlessEngagementDoctor({
      clientRoot: client,
      advisoryHeldAt: () => false,
      pidAlive: () => false,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.report.supervisor.readyGeneration, "11111111-1111-4111-8111-111111111111");
    assert.equal(result.report.watch.connection, "connected");
    assert.equal(result.report.profiles[0].progress.lastAckAt, "2026-10-03T20:00:11.000Z");
    assert.match(formatDoctorReport(result.report), /ok/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor exits non-zero on missing ready generation", () => {
  const { root, client } = fixture();
  try {
    rmSync(path.join(client, "ready.json"));
    const result = runHeadlessEngagementDoctor({
      clientRoot: client,
      advisoryHeldAt: () => false,
    });
    assert.equal(result.exitCode, 2);
    assert.ok(result.report.blockers.some((row) => row.code === "no_ready_generation"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor marks kick-ok drain-stale as degraded without deleting open txns", () => {
  const { root, client } = fixture();
  try {
    const openDir = path.join(root, "model-state", "instances", "a".repeat(64), "mailbox-transactions");
    mkdirSync(openDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(openDir, "open.json"),
      `${JSON.stringify({ state: "claimed", deliveryId: 9, protocol: "coordinator-delivery-v1" })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      path.join(client, "headless-progress.json"),
      `${JSON.stringify({
        profiles: {
          bob: {
            lastAcceptedKickAt: "2026-10-03T21:00:00.000Z",
            lastClaimAt: "2026-10-03T20:00:00.000Z",
            pendingCount: 2,
            oldestPendingAt: "2026-10-03T19:00:00.000Z",
          },
        },
      })}\n`,
    );
    const result = runHeadlessEngagementDoctor({
      clientRoot: client,
      now: Date.parse("2026-10-03T21:05:00.000Z"),
      advisoryHeldAt: () => false,
    });
    assert.equal(result.exitCode, 1);
    assert.ok(result.report.warnings.some((row) => row.code === "kick_ok_drain_stale"));
    assert.equal(result.report.profiles[0].openTransaction.state, "claimed");
    assert.ok(existsSync(path.join(openDir, "open.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

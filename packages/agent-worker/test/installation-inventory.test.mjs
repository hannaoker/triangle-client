import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, linkSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  formatDoctorReport,
  runHeadlessEngagementDoctor,
} from "../src/headless-engagement-doctor.mjs";
import {
  classifyLane,
  deriveClientInstanceId,
  evaluateOpenTransaction,
  isValidProfileName,
  readInstallationInventory,
  UNAVAILABLE,
} from "../src/installation-inventory.mjs";
import {
  enrollmentRecord,
  FIXTURE_INSTALLATION_ID,
  openTransactionRecord,
  secureRegistry,
  writeEnrollment,
  writeInstallationIdentity,
  writeJson,
  writeWorkerManifest,
} from "./inventory-fixture-helpers.mjs";

const FAKE_TOKEN = "mesh_SENTINEL_TOKEN_must_never_print_0123456789";
const FAKE_BODY = "SENTINEL MESSAGE BODY must never print";
const NOW = Date.parse("2026-10-17T20:00:00.000Z");

/**
 * Mixed Codex / Cursor ACP / worker installation, modeled on the live Mini:
 * bob (codex headless), ghost (cursor-acp), gravity2 (antigravity worker),
 * hermes-off (disabled worker), plus optional broken entries.
 */
function mixedFixture({
  acpBindingProfiles = ["ghost"],
  workerManifests = ["antigravity", "hermes"],
  extraRegistry = [],
  journalOverrides = {},
} = {}) {
  // Real path: Swift rejects binding state roots with a symlinked component
  // (macOS /var -> /private/var).
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "inventory-"));
  const app = path.join(root, "The Triangle");
  const client = path.join(app, "client");
  const work = path.join(root, "work");
  const codexCommand = path.join(root, "codex");
  const agentCommand = path.join(root, "agent");
  mkdirSync(work, { recursive: true });
  mkdirSync(client, { recursive: true, mode: 0o700 });
  writeFileSync(codexCommand, "#!/bin/sh\n", { mode: 0o700 });
  writeFileSync(agentCommand, "#!/bin/sh\n", { mode: 0o700 });
  const codexHome = path.join(app, "model-state", "codex-runtime-home");
  mkdirSync(codexHome, { recursive: true });

  const registry = [
    { profile: "bob", runtimeAdapter: "codex", deliveryMode: "headless-app-server", enabled: true },
    { profile: "ghost", runtimeAdapter: "cursor-acp", deliveryMode: "headless-cursor-acp", enabled: true },
    { profile: "gravity2", runtimeAdapter: "antigravity", deliveryMode: "worker", enabled: true },
    { profile: "hermes-off", runtimeAdapter: "hermes", deliveryMode: "worker", enabled: false },
    ...extraRegistry,
  ];
  for (const row of registry) {
    const instanceId = row.instanceId ?? deriveClientInstanceId(row.profile);
    writeJson(path.join(client, "instances", `${instanceId}.json`), {
      version: 1,
      instanceId,
      profile: row.profile,
      runtimeAdapter: row.runtimeAdapter,
      enabled: row.enabled,
      ...(row.deliveryMode ? { deliveryMode: row.deliveryMode } : {}),
    });
    const journal = journalOverrides[row.profile] ?? {};
    if (journal !== "absent") writeEnrollment(app, row.profile, journal);
  }
  // Backup journal files are never authoritative.
  writeFileSync(path.join(app, "enrollment-journal", `profile-${Buffer.from("bob").toString("hex")}.json.bak-old`), "{}");
  // A verified enrollment with no registry row.
  writeEnrollment(app, "loner");
  writeInstallationIdentity(client);
  secureRegistry(app);

  writeJson(path.join(client, "ready.json"), {
    version: 1, generation: "11111111-1111-4111-8111-111111111111", parentPid: 42, configDigest: "x", readyAtMilliseconds: NOW,
  });
  const bobState = path.join(app, "model-state", "headless-drain", "bob");
  writeJson(path.join(client, "headless-runtime-binding.json"), {
    version: 2,
    common: { adapterVersion: "1", installationId: FIXTURE_INSTALLATION_ID, workingDirectory: work, codexHome, command: codexCommand, pollIntervalMs: 30000 },
    profiles: [{ profile: "bob", instanceId: deriveClientInstanceId("bob"), stateRoot: bobState }],
  });
  writeJson(path.join(client, "cursor-acp-runtime-binding.json"), {
    version: 1,
    common: { adapterVersion: "1", installationId: FIXTURE_INSTALLATION_ID, workingDirectory: work, cursorHome: path.join(app, "cursor-home"), command: agentCommand, pollIntervalMs: 30000 },
    profiles: acpBindingProfiles.map((profile) => ({
      profile,
      instanceId: deriveClientInstanceId(profile),
      stateRoot: path.join(app, "model-state", "cursor-acp-drain", profile),
    })),
  });
  for (const adapter of workerManifests) writeWorkerManifest(app, adapter);
  // Claimer locks for codex/acp lanes.
  writeJson(path.join(client, "headless-claimer.bob.json"), {
    version: 1, profile: "bob", owner: "dev.thetriangle.client", pid: 609, family: "codex", acquiredAt: "2026-10-17T04:31:02.758Z", generation: null,
  });
  writeJson(path.join(client, "cursor-acp-claimer.ghost.json"), {
    version: 1, profile: "ghost", owner: "dev.thetriangle.client", pid: 609, family: "cursor-acp", acquiredAt: "2026-10-17T04:31:02.793Z", generation: null,
  });
  // Codex drain journal: ownership + completions + conversations.
  writeJson(path.join(bobState, "profile.json"), {
    version: 1, profile_instance_id: deriveClientInstanceId("bob"), runtime_mode: "headless", owner_instance_id: "client-supervisor",
    owner_generation: 33, ownership_state: "owned", lease_renewed_at: "2026-10-17T05:10:59.747Z",
    lease_expires_at: "2026-10-17T05:11:59.747Z", active_mesh_room_id: "room_1", updated_at: "2026-10-17T05:10:59.747Z",
  });
  writeJson(path.join(bobState, "completions", "x:room_1:delivery_1:e1.json"), {
    version: 1, mesh_room_id: "room_1", delivery_id: 1, reply_event_id: "evt_1", completed_at: "2026-10-17T05:00:00.000Z",
  });
  writeJson(path.join(bobState, "completions", "x:room_1:delivery_2:e2.json"), {
    version: 1, mesh_room_id: "room_1", delivery_id: 2, reply_event_id: "evt_2", completed_at: "2026-10-17T05:10:00.000Z",
  });
  writeJson(path.join(bobState, "conversations", "room_1.json"), {
    version: 1, mesh_room_id: "room_1", active_delivery_id: null, execution_state: "idle", updated_at: "2026-10-17T05:10:30.000Z",
  });
  mkdirSync(path.join(app, "model-state", "cursor-acp-drain", "ghost"), { recursive: true });
  // Worker conversation map for gravity2 (room → updatedAt only).
  writeJson(path.join(app, "model-state", "instances", deriveClientInstanceId("gravity2"), "triangle-antigravity-conversations.json"), {
    version: 1, rooms: { room_g: { conversationId: "c1", updatedAt: "2026-10-16T22:00:00.000Z" } },
  });
  // Credential file with a token: existence only, never read into output.
  writeJson(path.join(app, "credentials", "local", "mailbox", "gravity2.json"), {
    version: 1, origin: "https://example.test", token: FAKE_TOKEN, agentId: "agent_gravity2", handle: "gravity2",
  });
  // A valid, recent open transaction for ghost.
  writeJson(
    path.join(app, "model-state", "instances", deriveClientInstanceId("ghost"), "mailbox-transactions", "open.json"),
    openTransactionRecord(deriveClientInstanceId("ghost")),
  );
  return { root, app, client };
}

const heldFor = (...names) => (lockPath) => names.some((n) => lockPath.endsWith(n));

function snapshot(dir) {
  const out = {};
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        out[full] = `dir:${st.mtimeMs}`;
        walk(full);
      } else {
        out[full] = `${st.mtimeMs}:${st.size}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`;
      }
    }
  };
  walk(dir);
  return out;
}

test("mixed Codex/ACP/worker registry: every profile appears, reconciled to its own binding", () => {
  const { root, client } = mixedFixture();
  try {
    const result = runHeadlessEngagementDoctor({
      clientRoot: client, now: NOW, pidAlive: () => true,
      advisoryHeldAt: heldFor("headless-claimer.bob.json", "cursor-acp-claimer.ghost.json"),
    });
    const inv = result.report.inventory;
    const byName = Object.fromEntries(inv.profiles.map((p) => [p.profile, p]));
    assert.deepEqual(Object.keys(byName).sort(), ["bob", "ghost", "gravity2", "hermes-off"]);

    assert.equal(byName.bob.lane, "codex-headless");
    assert.equal(byName.bob.binding.status, "bound");
    assert.equal(byName.bob.activity.lastReplyAt, "2026-10-17T05:10:00.000Z");
    assert.equal(byName.bob.activity.lastReplySource, "completion_journal");
    assert.equal(byName.bob.activity.lastClaimAt, UNAVAILABLE);
    assert.equal(byName.bob.activity.lastAckAt, UNAVAILABLE);
    assert.equal(byName.bob.owner.headlessOwnership.ownerGeneration, 33);
    assert.equal(byName.bob.pollWatch.pollIntervalMs, 30000);

    assert.equal(byName.ghost.lane, "cursor-acp");
    assert.equal(byName.ghost.deliveryMode, "headless-cursor-acp");
    assert.equal(byName.ghost.binding.kind, "cursor-acp");
    assert.equal(byName.ghost.binding.status, "bound");
    assert.equal(byName.ghost.owner.claimers[0].family, "cursor-acp");
    assert.equal(byName.ghost.owner.claimers[0].advisoryHeld, true);
    assert.equal(byName.ghost.journal.openTransaction.state, "claimed");
    assert.equal(byName.ghost.activity.openTransactionAgeMs, 10 * 60_000);
    // No claim/reply/ack evidence in local journal for ACP → degraded, not ok.
    assert.equal(byName.ghost.status, "degraded");
    assert.ok(byName.ghost.faults.includes("progress_evidence_unavailable"));

    assert.equal(byName.gravity2.lane, "worker");
    assert.equal(byName.gravity2.runtimeAdapter, "antigravity");
    assert.equal(byName.gravity2.support, "experimental");
    assert.equal(byName.gravity2.binding.kind, "worker-runtime-manifest");
    assert.equal(byName.gravity2.binding.status, "bound");
    assert.equal(byName.gravity2.credential, "file_present");
    assert.equal(byName.gravity2.pollWatch.mode, "poll");
    assert.equal(byName.gravity2.activity.lastConversationUpdateAt, "2026-10-16T22:00:00.000Z");
    assert.equal(byName.gravity2.capabilities, UNAVAILABLE);
    assert.equal(byName.gravity2.owner.supervisorAdmission, UNAVAILABLE);

    assert.equal(byName["hermes-off"].status, "disabled");
    assert.equal(byName["hermes-off"].pollWatch.mode, "not_started_disabled");
    assert.deepEqual(byName["hermes-off"].faults, []);

    assert.deepEqual(inv.enrolledUnregistered, ["loner"]);
    // Missing ACP/worker progress evidence must keep the result non-healthy.
    assert.equal(result.ok, false);
    assert.notEqual(result.exitCode, 0);

    const text = formatDoctorReport(result.report);
    for (const name of ["bob", "ghost", "gravity2", "hermes-off"]) {
      assert.match(text, new RegExp(`profile ${name} \\[`));
    }
    assert.match(text, /profile hermes-off \[disabled\]/);
    assert.doesNotMatch(text, /^ok$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("enabled ACP profile missing from cursor-acp binding is a hard fault, never omitted", () => {
  const { root, client } = mixedFixture({
    acpBindingProfiles: ["ghost"],
    extraRegistry: [{ profile: "shadow", runtimeAdapter: "cursor-acp", deliveryMode: "headless-cursor-acp", enabled: true }],
  });
  try {
    const result = runHeadlessEngagementDoctor({ clientRoot: client, now: NOW, pidAlive: () => true, advisoryHeldAt: () => true });
    const shadow = result.report.inventory.profiles.find((p) => p.profile === "shadow");
    assert.equal(shadow.status, "fault");
    assert.equal(shadow.binding.status, "missing");
    assert.equal(result.exitCode, 2);
    assert.ok(result.report.blockers.some((b) => b.code === "binding_missing" && b.profile === "shadow"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("enabled worker without its runtime manifest is a hard fault", () => {
  const { root, client } = mixedFixture({ workerManifests: ["hermes"] });
  try {
    const result = runHeadlessEngagementDoctor({ clientRoot: client, now: NOW, pidAlive: () => true, advisoryHeldAt: () => true });
    const g = result.report.inventory.profiles.find((p) => p.profile === "gravity2");
    assert.equal(g.binding.status, "missing");
    assert.equal(g.status, "fault");
    assert.equal(result.exitCode, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("disabled profile without any binding is shown, not started, and not a fault", () => {
  const { root, client } = mixedFixture({ workerManifests: ["antigravity"] });
  try {
    const result = runHeadlessEngagementDoctor({ clientRoot: client, now: NOW, pidAlive: () => true, advisoryHeldAt: () => true });
    const off = result.report.inventory.profiles.find((p) => p.profile === "hermes-off");
    assert.equal(off.status, "disabled");
    assert.equal(off.binding.status, "missing");
    assert.ok(!result.report.blockers.some((b) => b.profile === "hermes-off"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unsupported and mismatched entries are explicit faults", () => {
  const { root, client } = mixedFixture({
    extraRegistry: [
      { profile: "grok", runtimeAdapter: "grok-bot", deliveryMode: "grok-bot", enabled: true },
      { profile: "odd", runtimeAdapter: "hermes", deliveryMode: "headless-cursor-acp", enabled: true },
      { profile: "forged", runtimeAdapter: "codex", deliveryMode: "headless-app-server", enabled: true, instanceId: "f".repeat(64) },
    ],
    journalOverrides: { odd: { state: "registered_not_installed", reasonCode: "unusable_registration_response" } },
  });
  try {
    const result = runHeadlessEngagementDoctor({ clientRoot: client, now: NOW, pidAlive: () => true, advisoryHeldAt: () => true });
    const byName = Object.fromEntries(result.report.inventory.profiles.map((p) => [p.profile, p]));
    assert.equal(byName.grok.status, "unsupported");
    assert.equal(byName.odd.support, "unsupported");
    assert.ok(byName.odd.faults.includes("enrollment_unverified"));
    assert.equal(byName.forged.status, "fault");
    assert.ok(result.report.blockers.some((b) => b.code === "registry_entry_invalid"));
    assert.equal(result.exitCode, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("orphan binding rows and missing registry never yield healthy-by-omission", () => {
  const { root, client } = mixedFixture({ acpBindingProfiles: ["ghost", "phantom"] });
  try {
    let result = runHeadlessEngagementDoctor({ clientRoot: client, now: NOW, pidAlive: () => true, advisoryHeldAt: () => true });
    assert.ok(result.report.warnings.some((w) => w.code === "binding_orphan" && w.profile === "phantom"));
    // Swift throws invalidBootstrap for the whole lane when a binding row is not
    // an enabled lane member, so ghost cannot run either.
    assert.ok(result.report.blockers.some((b) => b.code === "binding_invalid" && /entry_not_enabled_lane_member/.test(b.message)));
    assert.equal(result.report.inventory.profiles.find((p) => p.profile === "ghost").status, "fault");
    assert.equal(result.exitCode, 2);
    rmSync(path.join(client, "instances"), { recursive: true, force: true });
    result = runHeadlessEngagementDoctor({ clientRoot: client, now: NOW, pidAlive: () => true, advisoryHeldAt: () => true });
    assert.equal(result.exitCode, 2);
    assert.ok(result.report.blockers.some((b) => b.code === "registry_absent"));
    assert.doesNotMatch(formatDoctorReport(result.report), /^ok$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor is read-only and keeps tokens and message bodies out of output", () => {
  const { root, app, client } = mixedFixture();
  try {
    // A stray-field open transaction carrying a token and a body: invalid for
    // Swift (custody fault) and never echoed.
    writeJson(path.join(app, "model-state", "instances", deriveClientInstanceId("ghost"), "mailbox-transactions", "open.json"), {
      ...openTransactionRecord(deriveClientInstanceId("ghost")), claimId: FAKE_TOKEN, body: FAKE_BODY,
    });
    const before = snapshot(app);
    const result = runHeadlessEngagementDoctor({ clientRoot: client, now: NOW, pidAlive: () => true, advisoryHeldAt: () => false });
    assert.ok(result.report.inventory.profiles.find((p) => p.profile === "ghost").faults.includes("unreadable_custody"));
    const after = snapshot(app);
    assert.deepEqual(after, before);
    const json = JSON.stringify(result.report);
    const text = formatDoctorReport(result.report);
    for (const out of [json, text]) {
      assert.ok(!out.includes(FAKE_TOKEN), "token leaked");
      assert.ok(!out.includes(FAKE_BODY), "body leaked");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventory module uses no mutating filesystem or process APIs", () => {
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "installation-inventory.mjs"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const fsImport = /import \{([^}]*)\} from "node:fs";/.exec(source);
  assert.deepEqual(
    fsImport[1].split(",").map((name) => name.trim()).filter(Boolean).sort(),
    ["accessSync", "existsSync", "lstatSync", "readFileSync", "readdirSync", "statSync"],
  );
  for (const forbidden of [
    /\bwriteFile/, /\bappendFile/, /\bmkdir/, /\brename/, /\bunlink/, /\brmSync\b/, /\brm\(/, /\bcopyFile/,
    /\bchmod/, /\bchown/, /\butimes/, /\btruncate/, /child_process/, /\bspawn/, /execSync|execFile/, /acquireAdvisoryLock/, /fetch\(/,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});

test("lane classification mirrors Swift participation rules", () => {
  assert.equal(classifyLane({ runtimeAdapter: "codex", deliveryMode: "headless-app-server" }).support, "supported");
  assert.equal(classifyLane({ runtimeAdapter: "cursor-acp", deliveryMode: "headless-app-server" }).support, "unsupported");
  assert.equal(classifyLane({ runtimeAdapter: "cursor-acp", deliveryMode: "headless-cursor-acp" }).lane, "cursor-acp");
  assert.equal(classifyLane({ runtimeAdapter: "antigravity", deliveryMode: "worker" }).support, "experimental");
  assert.equal(classifyLane({ runtimeAdapter: "grok-bot", deliveryMode: "grok-bot" }).support, "unsupported");
  assert.equal(deriveClientInstanceId("ghost"), "27234fb4916f5bf1a6b37b8ebdc1f276f12407bad084ecc35e97fb904567755e");
});

test("inventory requires injected liveness probes (no implicit side channels)", () => {
  assert.throws(() => readInstallationInventory({ clientRoot: "/tmp/x" }), TypeError);
});

// ---------------------------------------------------------------------------
// F3: open-transaction age/failure policy across Codex, Cursor ACP, and worker.

const TWO_HOURS_AGO = "2026-10-17T18:00:00.000Z";
const openTxnPath = (app, profile) =>
  path.join(app, "model-state", "instances", deriveClientInstanceId(profile), "mailbox-transactions", "open.json");

function writeOpenTxn(app, profile, { createdAt = TWO_HOURS_AGO, failureCount = 3, state = "claimed" } = {}) {
  writeJson(openTxnPath(app, profile), openTransactionRecord(deriveClientInstanceId(profile), {
    deliveryId: 9, state, failureCount, lastFailureReason: failureCount > 0 ? "runtime_failed" : null, createdAt,
  }));
}

/** Restrict the mixed fixture to the named profiles (the review's reduction). */
function onlyProfiles(fixture, keep) {
  const wanted = new Set(keep.map((p) => `${deriveClientInstanceId(p)}.json`));
  for (const name of readdirSync(path.join(fixture.client, "instances"))) {
    if (!wanted.has(name)) rmSync(path.join(fixture.client, "instances", name));
  }
  if (!keep.includes("bob")) rmSync(path.join(fixture.client, "headless-runtime-binding.json"));
}

const runDoctor = (client, extra = {}) => runHeadlessEngagementDoctor({
  clientRoot: client, now: NOW, pidAlive: () => true, advisoryHeldAt: () => true, ...extra,
});

test("ACP: an old unfinished claim with failures is a fault even with a historical lastClaimAt (review F3 repro)", () => {
  const f = mixedFixture();
  try {
    onlyProfiles(f, ["ghost"]);
    writeOpenTxn(f.app, "ghost");
    writeJson(path.join(f.client, "headless-progress.json"), { version: 1, profiles: { ghost: { lane: "cursor-acp", lastClaimAt: TWO_HOURS_AGO } } });
    const result = runDoctor(f.client);
    const ghost = result.report.inventory.profiles.find((p) => p.profile === "ghost");
    assert.equal(ghost.activity.openTransactionAgeMs, 2 * 60 * 60_000);
    assert.equal(ghost.activity.openTransactionHealth, "stalled_failing");
    assert.ok(ghost.faults.includes("open_transaction_stalled"));
    assert.equal(ghost.status, "fault");
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.exitCode, 2);
    assert.equal(result.ok, false);
    assert.ok(result.report.blockers.some((b) => b.code === "open_transaction_stalled" && b.profile === "ghost"));
    assert.match(formatDoctorReport(result.report), /openHealth=stalled_failing/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("workers (supported hermes and experimental antigravity): an old unfinished claim with failures is a fault", () => {
  const f = mixedFixture({ extraRegistry: [{ profile: "hermes-on", runtimeAdapter: "hermes", deliveryMode: "worker", enabled: true }] });
  try {
    onlyProfiles(f, ["gravity2", "hermes-on"]);
    writeOpenTxn(f.app, "gravity2");
    writeOpenTxn(f.app, "hermes-on");
    writeJson(path.join(f.client, "headless-progress.json"), {
      version: 1,
      profiles: {
        gravity2: { lane: "worker", lastClaimAt: TWO_HOURS_AGO, lastReplyAt: "2026-10-17T10:00:00.000Z", lastAckAt: "2026-10-17T10:00:01.000Z" },
        "hermes-on": { lane: "worker", lastClaimAt: TWO_HOURS_AGO },
      },
    });
    const result = runDoctor(f.client);
    for (const name of ["gravity2", "hermes-on"]) {
      const row = result.report.inventory.profiles.find((p) => p.profile === name);
      assert.equal(row.lane, "worker");
      assert.equal(row.status, "fault", name);
      assert.ok(row.faults.includes("open_transaction_stalled"), name);
      assert.ok(!row.faults.includes("progress_evidence_unavailable"), name);
    }
    assert.equal(result.exitCode, 2);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Codex headless: the same open-transaction policy applies", () => {
  const f = mixedFixture();
  try {
    onlyProfiles(f, ["bob"]);
    writeOpenTxn(f.app, "bob");
    const result = runDoctor(f.client);
    const bob = result.report.inventory.profiles.find((p) => p.profile === "bob");
    assert.equal(bob.activity.lastReplySource, "completion_journal");
    assert.equal(bob.status, "fault");
    assert.ok(bob.faults.includes("open_transaction_stalled"));
    assert.equal(result.exitCode, 2);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("idle installation with only old completed work and no open transaction is not stalled", () => {
  const f = mixedFixture();
  try {
    onlyProfiles(f, ["ghost", "gravity2"]);
    rmSync(openTxnPath(f.app, "ghost"));
    const old = "2026-10-10T08:00:00.000Z"; // a week before NOW
    writeJson(path.join(f.client, "headless-progress.json"), {
      version: 1,
      profiles: {
        ghost: { lane: "cursor-acp", lastClaimAt: old, lastReplyAt: old, lastAckAt: old },
        gravity2: { lane: "worker", lastClaimAt: old, lastReplyAt: old, lastAckAt: old },
      },
    });
    const result = runDoctor(f.client);
    for (const name of ["ghost", "gravity2"]) {
      const row = result.report.inventory.profiles.find((p) => p.profile === name);
      assert.equal(row.activity.openTransactionHealth, "none", name);
      assert.equal(row.status, "ok", `${name}: ${row.faults}`);
    }
    assert.equal(result.exitCode, 0, JSON.stringify([result.report.blockers, result.report.warnings]));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("doctor maxOpenTxnAgeMs is passed through to the inventory for every lane", () => {
  const f = mixedFixture();
  try {
    onlyProfiles(f, ["ghost"]);
    writeOpenTxn(f.app, "ghost", { createdAt: "2026-10-17T19:30:00.000Z", failureCount: 0 }); // 30 min old
    writeJson(path.join(f.client, "headless-progress.json"), { version: 1, profiles: { ghost: { lane: "cursor-acp", lastClaimAt: "2026-10-17T19:30:00.000Z" } } });
    let result = runDoctor(f.client); // default 15 min budget
    let ghost = result.report.inventory.profiles.find((p) => p.profile === "ghost");
    assert.equal(ghost.activity.openTransactionHealth, "stalled");
    assert.equal(ghost.status, "degraded");
    assert.equal(result.exitCode, 1);
    result = runDoctor(f.client, { maxOpenTxnAgeMs: 60 * 60_000 });
    ghost = result.report.inventory.profiles.find((p) => p.profile === "ghost");
    assert.equal(ghost.activity.maxOpenTransactionAgeMs, 60 * 60_000);
    assert.equal(ghost.activity.openTransactionHealth, "ok");
    assert.equal(ghost.status, "ok");
    assert.equal(result.exitCode, 0);
    result = runDoctor(f.client, { maxOpenTxnAgeMs: 5 * 60_000 });
    assert.equal(result.report.inventory.profiles.find((p) => p.profile === "ghost").activity.openTransactionHealth, "stalled");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("open-transaction policy verdicts", () => {
  const budget = { maxOpenTxnAgeMs: 15 * 60_000 };
  const open = (ageMs, failureCount) => ({ readable: true, state: "claimed", ageMs, failureCount });
  assert.equal(evaluateOpenTransaction(null, budget).verdict, "none");
  assert.equal(evaluateOpenTransaction(open(60_000, 0), budget).verdict, "ok");
  assert.equal(evaluateOpenTransaction(open(60_000, 1), budget).fault.hard, false);
  assert.equal(evaluateOpenTransaction(open(60_000, 5), budget).verdict, "stuck");
  assert.equal(evaluateOpenTransaction(open(60_000, 5), budget).fault.hard, true);
  assert.equal(evaluateOpenTransaction(open(16 * 60_000, 0), budget).fault.hard, false);
  assert.equal(evaluateOpenTransaction(open(16 * 60_000, 3), budget).fault.hard, true);
  assert.equal(evaluateOpenTransaction(open(null, 0), budget).verdict, "age_unavailable");
  assert.throws(() => readInstallationInventory({ clientRoot: "/tmp/x", pidAlive: () => true, advisoryHeldAt: () => true, maxOpenTxnAgeMs: 0 }), TypeError);
});

// ---------------------------------------------------------------------------
// F4: profile names follow the persisted Swift ProfileName contract.

const SIXTY_FOUR_ASCII = `Agent_${"x".repeat(55)}.v1`; // exactly 64 bytes
const SIXTY_FOUR_UTF8 = "é".repeat(32); // 64 UTF-8 bytes, 32 characters

test("profile-name validator mirrors Swift ProfileName", () => {
  assert.equal(Buffer.byteLength(SIXTY_FOUR_ASCII), 64);
  for (const ok of ["bob", "Agent_One", "UPPER", "dot.name", "under_score", "a", SIXTY_FOUR_ASCII, SIXTY_FOUR_UTF8, "-leading", "has space"]) {
    assert.equal(isValidProfileName(ok), true, ok);
  }
  for (const bad of ["", `${SIXTY_FOUR_ASCII}x`, `${SIXTY_FOUR_UTF8}e`, "a/b", "a\\b", "a\u0000b", "tab\tname", "zero\u200bwidth", "\ud800", 7, null]) {
    assert.equal(isValidProfileName(bad), false, JSON.stringify(bad));
  }
});

test("existing uppercase/underscore/dot/64-byte profiles, including disabled Agent_One, are accepted as-is", () => {
  const f = mixedFixture({
    extraRegistry: [
      { profile: "Agent_One", runtimeAdapter: "hermes", deliveryMode: "worker", enabled: false },
      { profile: "Worker.Two", runtimeAdapter: "hermes", deliveryMode: "worker", enabled: true },
      { profile: "ACP_Three", runtimeAdapter: "cursor-acp", deliveryMode: "headless-cursor-acp", enabled: true },
      { profile: SIXTY_FOUR_ASCII, runtimeAdapter: "hermes", deliveryMode: "worker", enabled: false },
      { profile: SIXTY_FOUR_UTF8, runtimeAdapter: "hermes", deliveryMode: "worker", enabled: true },
    ],
    acpBindingProfiles: ["ghost", "ACP_Three"],
  });
  try {
    const result = runDoctor(f.client);
    const byName = Object.fromEntries(result.report.inventory.profiles.map((p) => [p.profile, p]));
    assert.ok(!result.report.blockers.some((b) => b.code === "registry_entry_invalid"), JSON.stringify(result.report.blockers));
    // Disabled profiles: shown, not started, not a fault.
    for (const name of ["Agent_One", SIXTY_FOUR_ASCII]) {
      assert.equal(byName[name].status, "disabled", name);
      assert.deepEqual(byName[name].faults, [], name);
      assert.ok(!result.report.blockers.some((b) => b.profile === name), name);
    }
    // Enabled ones: identity preserved, enrollment resolved by exact name, no hard fault.
    for (const name of ["Worker.Two", "ACP_Three", SIXTY_FOUR_UTF8]) {
      assert.equal(byName[name].profile, name);
      assert.equal(byName[name].instanceId, deriveClientInstanceId(name));
      assert.equal(byName[name].enrollment.state, "verified", name);
      assert.notEqual(byName[name].status, "fault", `${name}: ${byName[name].faults}`);
    }
    assert.equal(byName.ACP_Three.binding.status, "bound");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("registry rows outside the Swift contract are still explicit faults", () => {
  const f = mixedFixture({
    extraRegistry: [
      { profile: `${SIXTY_FOUR_ASCII}x`, runtimeAdapter: "hermes", deliveryMode: "worker", enabled: false },
      { profile: "bad/name", runtimeAdapter: "hermes", deliveryMode: "worker", enabled: false },
    ],
  });
  try {
    const result = runDoctor(f.client);
    const invalid = result.report.blockers.filter((b) => b.code === "registry_entry_invalid");
    assert.equal(invalid.length, 2);
    assert.ok(invalid.every((b) => /invalid_profile/.test(b.message)));
    assert.equal(result.exitCode, 2);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Codex review round 1 (#82): mirror the Swift decoders/validators exactly.

const profileRow = (result, name) => result.report.inventory.profiles.find((p) => p.profile === name);

test("legacy registry row without deliveryMode decodes as worker (Swift decoder default), not the adapter default", () => {
  const f = mixedFixture({
    workerManifests: ["antigravity", "hermes", "codex"],
    extraRegistry: [
      { profile: "legacy-codex", runtimeAdapter: "codex", enabled: true },
      { profile: "legacy-hermes", runtimeAdapter: "hermes", enabled: true },
    ],
  });
  try {
    const result = runDoctor(f.client);
    const codex = profileRow(result, "legacy-codex");
    assert.equal(codex.deliveryMode, "worker");
    assert.equal(codex.deliveryModeSource, "decoder_default_worker");
    assert.equal(codex.lane, "worker");
    assert.equal(codex.binding.kind, "worker-runtime-manifest");
    assert.ok(!codex.faults.includes("binding_missing"), JSON.stringify(codex.faults));
    assert.equal(profileRow(result, "legacy-hermes").lane, "worker");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("registry rows Swift cannot decode are faults even when disabled", () => {
  const f = mixedFixture({
    extraRegistry: [
      { profile: "bad-adapter", runtimeAdapter: "gemini", deliveryMode: "worker", enabled: false },
      { profile: "bad-mode", runtimeAdapter: "hermes", deliveryMode: "carrier-pigeon", enabled: false },
    ],
  });
  try {
    const extraId = deriveClientInstanceId("extra-key");
    writeJson(path.join(f.client, "instances", `${extraId}.json`), {
      version: 1, instanceId: extraId, profile: "extra-key", runtimeAdapter: "hermes", enabled: false, deliveryMode: "worker", note: "x",
    });
    const missingId = deriveClientInstanceId("missing-enabled");
    writeJson(path.join(f.client, "instances", `${missingId}.json`), {
      version: 1, instanceId: missingId, profile: "missing-enabled", runtimeAdapter: "hermes",
    });
    const result = runDoctor(f.client);
    const invalid = result.report.blockers.filter((b) => b.code === "registry_entry_invalid");
    const messages = invalid.map((b) => `${b.profile}:${b.message}`).join("\n");
    assert.match(messages, /bad-adapter:.*invalid_runtime_adapter/);
    assert.match(messages, /bad-mode:.*invalid_delivery_mode/);
    assert.match(messages, /extra-key:.*unexpected_keys/);
    assert.match(messages, /missing-enabled:.*missing_keys/);
    assert.equal(result.exitCode, 2);

    writeFileSync(path.join(f.client, "instances", "notes.txt"), "x");
    const stray = runDoctor(f.client);
    assert.ok(stray.report.blockers.some((b) => b.code === "registry_stray_file"));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("enrollment records are trusted only when they decode for the same profile", () => {
  const f = mixedFixture();
  try {
    onlyProfiles(f, ["ghost"]);
    rmSync(openTxnPath(f.app, "ghost"));
    writeJson(path.join(f.client, "headless-progress.json"), { version: 1, profiles: { ghost: { lane: "cursor-acp", lastClaimAt: "2026-10-17T19:00:00.000Z" } } });
    const journalFile = path.join(f.app, "enrollment-journal", `profile-${Buffer.from("ghost").toString("hex")}.json`);
    assert.equal(runDoctor(f.client).exitCode, 0);
    for (const bad of [
      enrollmentRecord("ghost", { profile: "bob" }),
      (({ origin, ...rest }) => rest)(enrollmentRecord("ghost")),
      enrollmentRecord("ghost", { origin: "http://example.test" }),
      enrollmentRecord("ghost", { agentID: "agent_ghost" }),
      enrollmentRecord("ghost", { state: "VERIFIED" }),
      { ...enrollmentRecord("ghost"), extra: true },
    ]) {
      writeJson(journalFile, bad);
      const result = runDoctor(f.client);
      const ghost = profileRow(result, "ghost");
      assert.equal(ghost.enrollment.state, "invalid_record", JSON.stringify(bad));
      assert.ok(ghost.faults.includes("enrollment_unverified"));
      assert.equal(result.exitCode, 2);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("lane bindings Swift would reject are invalid (never bound) when the lane has members", () => {
  const f = mixedFixture();
  try {
    onlyProfiles(f, ["ghost"]);
    const bindingPath = path.join(f.client, "cursor-acp-runtime-binding.json");
    const good = JSON.parse(readFileSync(bindingPath, "utf8"));
    const cases = {
      state_root_not_standardized_absolute: (b) => { b.profiles[0].stateRoot = "relative/ghost"; },
      installation_id_mismatch: (b) => { b.common.installationId = "inst_some_other_installation"; },
      poll_interval_ms: (b) => { b.common.pollIntervalMs = 5; },
      common_keys: (b) => { b.common.extra = 1; },
      profile_keys: (b) => { b.profiles[0].unexpected = true; },
      shadow_test_profile: (b) => { b.profiles[0].shadowTestProfile = "yes"; },
    };
    for (const [problem, mutate] of Object.entries(cases)) {
      const b = structuredClone(good);
      mutate(b);
      writeJson(bindingPath, b);
      const result = runDoctor(f.client);
      const ghost = profileRow(result, "ghost");
      assert.equal(ghost.binding.status, "invalid", problem);
      assert.ok(ghost.binding.problems.includes(problem), `${problem}: ${ghost.binding.problems}`);
      assert.ok(ghost.faults.includes("binding_invalid"));
      assert.ok(result.report.blockers.some((row) => row.code === "binding_invalid"));
      assert.equal(result.exitCode, 2);
    }
    // A symlinked component in the state root.
    const real = path.join(f.root, "real-state");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, path.join(f.root, "linked-state"));
    const b = structuredClone(good);
    b.profiles[0].stateRoot = path.join(f.root, "linked-state", "ghost");
    writeJson(bindingPath, b);
    assert.ok(profileRow(runDoctor(f.client), "ghost").binding.problems.includes("state_root_symlink"));
    // Missing installation identity: Swift would mint a new id that cannot match.
    writeJson(bindingPath, good);
    rmSync(path.join(f.client, "installation.json"));
    assert.ok(profileRow(runDoctor(f.client), "ghost").binding.problems.includes("installation_identity_absent"));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("an invalid binding for a lane with no enabled members is only a warning", () => {
  const f = mixedFixture();
  try {
    onlyProfiles(f, ["gravity2"]);
    writeJson(path.join(f.client, "cursor-acp-runtime-binding.json"), { version: 1, profiles: [] });
    const result = runDoctor(f.client);
    assert.ok(result.report.warnings.some((w) => w.code === "binding_invalid"));
    assert.ok(!result.report.blockers.some((b) => b.code === "binding_invalid"));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("worker manifests are validated, not just found", () => {
  const f = mixedFixture();
  try {
    onlyProfiles(f, ["gravity2"]);
    const manifestPath = path.join(f.app, "worker-runtime", "antigravity.manifest.json");
    const good = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(profileRow(runDoctor(f.client), "gravity2").binding.status, "bound");
    assert.equal(profileRow(runDoctor(f.client), "gravity2").binding.integrity, "not_verified");
    const cases = {
      manifest_keys: () => ({}),
      environment_keys: (m) => ({ ...m, environment: { ...m.environment, HERMES_CLI: "/x" } }),
      path_not_project_bin: (m) => ({ ...m, environment: { ...m.environment, PATH: "/usr/bin" } }),
      project_root_not_bundle: (m) => ({ ...m, projectRoot: "/x", environment: { ...m.environment, TRIANGLE_PROJECT_ROOT: "/x", PATH: "/x/bin" } }),
      unsupported_version: (m) => ({ ...m, version: 1 }),
    };
    for (const [problem, make] of Object.entries(cases)) {
      writeJson(manifestPath, make(structuredClone(good)));
      const result = runDoctor(f.client);
      const g = profileRow(result, "gravity2");
      assert.equal(g.binding.status, "invalid", problem);
      assert.ok(g.binding.problems.includes(problem), `${problem}: ${g.binding.problems}`);
      assert.equal(g.status, "fault");
      assert.equal(result.exitCode, 2);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("parseable open transactions Swift would reject are custody faults, not ok", () => {
  const f = mixedFixture();
  try {
    onlyProfiles(f, ["ghost"]);
    writeJson(path.join(f.client, "headless-progress.json"), { version: 1, profiles: { ghost: { lane: "cursor-acp", lastClaimAt: "2026-10-17T19:50:00.000Z" } } });
    const id = deriveClientInstanceId("ghost");
    assert.equal(runDoctor(f.client).exitCode, 0);
    for (const bad of [
      openTransactionRecord(deriveClientInstanceId("bob")),
      { ...openTransactionRecord(id), claimId: `claim_${"0".repeat(32)}` },
      { ...openTransactionRecord(id), state: "replied" },
      { ...openTransactionRecord(id), createdAt: "yesterday" },
      (({ replyResolution, ...rest }) => rest)(openTransactionRecord(id)),
    ]) {
      writeJson(openTxnPath(f.app, "ghost"), bad);
      const result = runDoctor(f.client);
      const ghost = profileRow(result, "ghost");
      assert.equal(ghost.journal.openTransaction.readable, false);
      assert.ok(ghost.faults.includes("unreadable_custody"), JSON.stringify(ghost.faults));
      assert.equal(result.exitCode, 2);
    }
    const legacy = openTransactionRecord(id);
    delete legacy.inboundEventId; delete legacy.inboundRoomSequence; delete legacy.replyRequired;
    writeJson(openTxnPath(f.app, "ghost"), legacy);
    assert.equal(profileRow(runDoctor(f.client), "ghost").status, "ok", "legacy-optional keys may be absent");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

function appServerBinding(profile, overrides = {}) {
  return {
    adapterVersion: "1",
    enabled: true,
    installationId: FIXTURE_INSTALLATION_ID,
    instanceId: deriveClientInstanceId(profile),
    agentId: enrollmentRecord(profile).agentID,
    roomScope: "room_scope_1",
    serverIdentity: "server-1",
    endpoint: "ws://127.0.0.1:4500",
    threadId: "thread_1",
    ...overrides,
  };
}

test("App Server binding mirrors prepareAppServerWake prerequisites and watch membership", () => {
  const appsRow = { profile: "apps", runtimeAdapter: "codex", deliveryMode: "mcp-interactive", enabled: true };
  const cases = [
    { name: "valid", binding: appServerBinding("apps"), token: true, status: "bound", watch: true },
    { name: "token missing", binding: appServerBinding("apps"), token: false, status: "missing", watch: true, code: "binding_missing" },
    { name: "installation mismatch", binding: appServerBinding("apps", { installationId: "inst_other_installation_9" }), token: true, status: "instance_id_mismatch", watch: true, code: "binding_mismatch" },
    { name: "agent mismatch", binding: appServerBinding("apps", { agentId: `agent_${"0".repeat(32)}` }), token: true, status: "instance_id_mismatch", watch: true, code: "binding_mismatch" },
    { name: "agent absent", binding: appServerBinding("apps", { agentId: undefined }), token: true, status: "instance_id_mismatch", watch: true, code: "binding_mismatch" },
    { name: "http endpoint", binding: appServerBinding("apps", { endpoint: "http://127.0.0.1:4500" }), token: true, status: "invalid", watch: true, code: "binding_invalid" },
    { name: "disabled", binding: appServerBinding("apps", { enabled: false }), token: true, status: "invalid", watch: true, code: "binding_invalid" },
    { name: "empty thread", binding: appServerBinding("apps", { threadId: "" }), token: true, status: "invalid", watch: true, code: "binding_invalid" },
    { name: "other instance", binding: appServerBinding("other"), token: true, status: "missing", watch: false, code: "binding_missing" },
    { name: "no binding", binding: null, token: true, status: "missing", watch: false, code: "binding_missing" },
  ];
  for (const c of cases) {
    const { root, client } = mixedFixture({ extraRegistry: [appsRow] });
    try {
      if (c.binding) writeJson(path.join(client, "app-server-binding.json"), c.binding);
      if (c.token) writeFileSync(path.join(client, "app-server-ws.token"), `${FAKE_TOKEN}\n`, { mode: 0o600 });
      const inventory = readInstallationInventory({ clientRoot: client, now: NOW, pidAlive: () => true, advisoryHeldAt: () => true });
      const apps = inventory.profiles.find((p) => p.profile === "apps");
      assert.equal(apps.binding.status, c.status, c.name);
      assert.equal(apps.pollWatch.watchMember, c.watch, c.name);
      if (c.code) {
        assert.ok(apps.faults.includes(c.code), `${c.name}: ${apps.faults}`);
        assert.equal(apps.status, "fault", c.name);
      } else {
        assert.ok(!apps.faults.some((f) => f.startsWith("binding_")), c.name);
      }
      assert.doesNotMatch(JSON.stringify(inventory), /SENTINEL_TOKEN/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("both claimer families holding locks for one Cursor ACP profile is a hard conflict", () => {
  const { root, client } = mixedFixture();
  try {
    writeJson(path.join(client, "headless-claimer.ghost.json"), {
      version: 1, profile: "ghost", owner: "dev.thetriangle.client", pid: 610, family: "codex", acquiredAt: "2026-10-17T04:31:02.800Z", generation: null,
    });
    const result = runHeadlessEngagementDoctor({ clientRoot: client, now: NOW, pidAlive: () => true, advisoryHeldAt: () => true });
    const ghost = result.report.inventory.profiles.find((p) => p.profile === "ghost");
    assert.ok(ghost.faults.includes("dual_claimer_conflict"));
    assert.equal(ghost.status, "fault");
    assert.ok(result.report.blockers.some((b) => b.code === "dual_claimer_conflict" && b.profile === "ghost"));
    assert.equal(result.exitCode, 2);
    // Only one held: no conflict.
    const single = runHeadlessEngagementDoctor({
      clientRoot: client, now: NOW, pidAlive: () => true, advisoryHeldAt: (file) => !file.endsWith("headless-claimer.ghost.json"),
    });
    assert.ok(!single.report.blockers.some((b) => b.code === "dual_claimer_conflict"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("journal activity uses the newest rows when a journal exceeds the scan limit", () => {
  const { root, client } = mixedFixture();
  try {
    const app = path.dirname(client);
    const completions = path.join(app, "model-state", "headless-drain", "bob", "completions");
    const old = new Date("2026-10-01T00:00:00.000Z");
    for (let i = 0; i < 5005; i += 1) {
      const file = path.join(completions, `a-old-${String(i).padStart(5, "0")}.json`);
      writeFileSync(file, `${JSON.stringify({ version: 1, completed_at: "2026-10-01T00:00:00.000Z" })}\n`);
      utimesSync(file, old, old);
    }
    // Sorts last by name, newest by mtime.
    writeJson(path.join(completions, "z-newest.json"), { version: 1, completed_at: "2026-10-17T19:59:00.000Z" });
    const inventory = readInstallationInventory({ clientRoot: client, now: NOW, pidAlive: () => true, advisoryHeldAt: () => true });
    const bob = inventory.profiles.find((p) => p.profile === "bob");
    assert.equal(bob.journal.completions.count, 5008);
    assert.equal(bob.journal.completions.scanLimited, true);
    assert.equal(bob.journal.completions.lastCompletedAt, "2026-10-17T19:59:00.000Z");
    assert.equal(bob.activity.lastReplyAt, "2026-10-17T19:59:00.000Z");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("event-driven profiles need a runnable worker adapter and its manifest (Codex review r3)", () => {
  const { root, client } = mixedFixture({
    extraRegistry: [
      { profile: "evt-hermes", runtimeAdapter: "hermes", deliveryMode: "event-driven", enabled: true },
      { profile: "evt-codex", runtimeAdapter: "codex", deliveryMode: "event-driven", enabled: true },
      { profile: "evt-acp", runtimeAdapter: "cursor-acp", deliveryMode: "event-driven", enabled: true },
    ],
  });
  try {
    const inventory = readInstallationInventory({ clientRoot: client, now: NOW, pidAlive: () => true, advisoryHeldAt: () => true });
    const byName = Object.fromEntries(inventory.profiles.map((p) => [p.profile, p]));
    assert.equal(byName["evt-hermes"].binding.kind, "worker-runtime-manifest");
    assert.equal(byName["evt-hermes"].binding.status, "bound");
    assert.ok(!byName["evt-hermes"].faults.some((f) => f.startsWith("binding_")));
    assert.equal(byName["evt-codex"].binding.status, "missing", "no codex worker manifest installed");
    assert.ok(byName["evt-codex"].faults.includes("binding_missing"));
    assert.equal(byName["evt-codex"].status, "fault");
    assert.equal(byName["evt-acp"].support, "unsupported");
    assert.ok(byName["evt-acp"].faults.includes("lane_unsupported"));
    assert.equal(classifyLane({ runtimeAdapter: "grok-bot", deliveryMode: "event-driven" }).support, "unsupported");
    assert.equal(classifyLane({ runtimeAdapter: "antigravity", deliveryMode: "event-driven" }).support, "experimental");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registry storage Swift refuses to open is a fault, never a healthy profile (Codex review r3)", () => {
  const read = (client) => runHeadlessEngagementDoctor({ clientRoot: client, now: NOW, pidAlive: () => true, advisoryHeldAt: () => true });
  {
    const { root, client } = mixedFixture();
    try {
      chmodSync(path.join(client, "instances"), 0o755);
      const result = read(client);
      assert.ok(result.report.blockers.some((b) => b.code === "registry_unsafe"));
      assert.equal(result.report.inventory.profiles.length, 0);
      assert.equal(result.exitCode, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const bobFile = (client) => path.join(client, "instances", `${deriveClientInstanceId("bob")}.json`);
  const cases = [
    ["group-readable file", (client) => chmodSync(bobFile(client), 0o644), "unsafe_file"],
    ["hard-linked file", (client) => linkSync(bobFile(client), path.join(path.dirname(client), "bob-link.json")), "unsafe_file"],
    ["symlinked file", (client) => {
      const target = path.join(path.dirname(client), "bob-target.json");
      writeFileSync(target, readFileSync(bobFile(client)), { mode: 0o600 });
      rmSync(bobFile(client));
      symlinkSync(target, bobFile(client));
    }, "unsafe_file"],
    ["oversized valid JSON", (client) => {
      const value = JSON.parse(readFileSync(bobFile(client), "utf8"));
      writeFileSync(bobFile(client), `${JSON.stringify(value)}${" ".repeat(2100)}\n`, { mode: 0o600 });
    }, "oversized"],
  ];
  for (const [name, mutate, problem] of cases) {
    const { root, client } = mixedFixture();
    try {
      mutate(client);
      const result = read(client);
      const invalid = result.report.inventory.profiles.find((p) => p.registry?.valid === false);
      assert.ok(invalid, name);
      assert.deepEqual(invalid.registry.problems, [problem], name);
      assert.ok(!result.report.inventory.profiles.some((p) => p.profile === "bob" && p.status === "ok"), name);
      assert.ok(result.report.blockers.some((b) => b.code === "registry_entry_invalid"), name);
      assert.equal(result.exitCode, 2, name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a bound runtime command must be an executable regular file (Codex review r3)", () => {
  for (const [name, mutate] of [
    ["not executable", (agent) => chmodSync(agent, 0o600)],
    ["directory", (agent) => { rmSync(agent); mkdirSync(agent); }],
  ]) {
    const { root, client } = mixedFixture();
    try {
      mutate(path.join(root, "agent"));
      const inventory = readInstallationInventory({ clientRoot: client, now: NOW, pidAlive: () => true, advisoryHeldAt: () => true });
      const ghost = inventory.profiles.find((p) => p.profile === "ghost");
      assert.equal(ghost.binding.commandPresent, false, name);
      assert.ok(ghost.faults.includes("runtime_command_missing"), name);
      assert.equal(ghost.status, "fault", name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function symlinkInPlace(file) {
  const target = `${file}.target`;
  writeFileSync(target, readFileSync(file), { mode: 0o600 });
  rmSync(file);
  symlinkSync(target, file);
}

test("custody Swift refuses for enrollment, installation identity, and open transactions is never healthy (Codex review r4)", () => {
  const read = (client) => readInstallationInventory({ clientRoot: client, now: NOW, pidAlive: () => true, advisoryHeldAt: () => true });
  const enrollmentFile = (client, profile) => path.join(path.dirname(client), "enrollment-journal", `profile-${Buffer.from(profile).toString("hex")}.json`);
  const enrollmentCases = [
    ["symlink", (client) => symlinkInPlace(enrollmentFile(client, "gravity2")), "unsafe_storage"],
    ["group-readable", (client) => chmodSync(enrollmentFile(client, "gravity2"), 0o644), "unsafe_storage"],
    ["oversized", (client) => writeFileSync(enrollmentFile(client, "gravity2"), `${readFileSync(enrollmentFile(client, "gravity2"), "utf8").trim()}${" ".repeat(4100)}\n`, { mode: 0o600 }), "invalid_record"],
    ["journal dir 0755", (client) => chmodSync(path.dirname(enrollmentFile(client, "gravity2")), 0o755), "unsafe_storage"],
  ];
  for (const [name, mutate, state] of enrollmentCases) {
    const { root, client } = mixedFixture();
    try {
      mutate(client);
      const gravity = read(client).profiles.find((p) => p.profile === "gravity2");
      assert.equal(gravity.enrollment.state, state, name);
      assert.ok(gravity.faults.includes("enrollment_unverified"), name);
      assert.equal(gravity.status, "fault", name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const identityCases = [
    ["symlink", (client) => symlinkInPlace(path.join(client, "installation.json"))],
    ["group-readable", (client) => chmodSync(path.join(client, "installation.json"), 0o644)],
    ["hard link", (client) => linkSync(path.join(client, "installation.json"), path.join(path.dirname(client), "installation-link.json"))],
    ["oversized", (client) => writeFileSync(path.join(client, "installation.json"), `${JSON.stringify({ version: 1, installationId: FIXTURE_INSTALLATION_ID })}${" ".repeat(600)}\n`, { mode: 0o600 })],
  ];
  for (const [name, mutate] of identityCases) {
    const { root, client } = mixedFixture();
    try {
      mutate(client);
      const inventory = read(client);
      assert.equal(inventory.installationIdentity, "unsafe", name);
      for (const profile of ["bob", "ghost"]) {
        const row = inventory.profiles.find((p) => p.profile === profile);
        assert.notEqual(row.binding.status, "bound", `${name}: ${profile}`);
        assert.equal(row.status, "fault", `${name}: ${profile}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const openFile = (client) => path.join(path.dirname(client), "model-state", "instances", deriveClientInstanceId("ghost"), "mailbox-transactions", "open.json");
  const openCases = [
    ["symlink", (client) => symlinkInPlace(openFile(client))],
    ["group-readable", (client) => chmodSync(openFile(client), 0o644)],
    ["hard link", (client) => linkSync(openFile(client), path.join(path.dirname(client), "open-link.json"))],
    ["transactions dir 0755", (client) => chmodSync(path.dirname(openFile(client)), 0o755)],
  ];
  for (const [name, mutate] of openCases) {
    const { root, client } = mixedFixture();
    try {
      const before = read(client).profiles.find((p) => p.profile === "ghost");
      assert.equal(before.journal.openTransaction.readable, true, `${name}: fixture starts valid`);
      mutate(client);
      const ghost = read(client).profiles.find((p) => p.profile === "ghost");
      assert.equal(ghost.journal.openTransaction.readable, false, name);
      assert.equal(ghost.journal.openTransaction.reason, "unsafe_storage", name);
      assert.ok(ghost.faults.includes("unreadable_custody"), name);
      assert.equal(ghost.status, "fault", name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("enrollment origins are checked on the raw path, before URL normalization (Codex review r5)", () => {
  for (const [origin, ok] of [
    ["https://example.test", true],
    ["https://example.test/", true],
    ["https://example.test/a/..", false],
    ["https://example.test/.", false],
    ["https://example.test/%2e", false],
    ["https://example.test//", false],
    ["https://example.test/api", false],
  ]) {
    const { root, client } = mixedFixture({ journalOverrides: { gravity2: { origin } } });
    try {
      const inventory = readInstallationInventory({ clientRoot: client, now: NOW, pidAlive: () => true, advisoryHeldAt: () => true });
      const gravity = inventory.profiles.find((p) => p.profile === "gravity2");
      assert.equal(gravity.enrollment.state, ok ? "verified" : "invalid_record", origin);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

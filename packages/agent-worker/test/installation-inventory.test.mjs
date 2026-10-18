import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  readInstallationInventory,
  UNAVAILABLE,
} from "../src/installation-inventory.mjs";

const FAKE_TOKEN = "mesh_SENTINEL_TOKEN_must_never_print_0123456789";
const FAKE_BODY = "SENTINEL MESSAGE BODY must never print";
const NOW = Date.parse("2026-10-17T20:00:00.000Z");

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

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
  const root = mkdtempSync(path.join(tmpdir(), "inventory-"));
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
    const journal = journalOverrides[row.profile] ?? { state: "verified", reasonCode: "identity_verified" };
    if (journal !== "absent") {
      writeJson(path.join(app, "enrollment-journal", `profile-${Buffer.from(row.profile).toString("hex")}.json`), {
        version: 1,
        profile: row.profile,
        handle: row.profile,
        origin: "https://example.test",
        agentID: `agent_${row.profile.replace(/-/g, "")}`,
        ...journal,
      });
    }
  }
  // Backup journal files are never authoritative.
  writeFileSync(path.join(app, "enrollment-journal", `profile-${Buffer.from("bob").toString("hex")}.json.bak-old`), "{}");
  // A verified enrollment with no registry row.
  writeJson(path.join(app, "enrollment-journal", `profile-${Buffer.from("loner").toString("hex")}.json`), {
    version: 1, profile: "loner", state: "verified", reasonCode: "identity_verified", agentID: "agent_loner",
  });

  writeJson(path.join(client, "ready.json"), {
    version: 1, generation: "11111111-1111-4111-8111-111111111111", parentPid: 42, configDigest: "x", readyAtMilliseconds: NOW,
  });
  const bobState = path.join(app, "model-state", "headless-drain", "bob");
  writeJson(path.join(client, "headless-runtime-binding.json"), {
    version: 2,
    common: { adapterVersion: "1", installationId: "inst_x", workingDirectory: work, codexHome, command: codexCommand, pollIntervalMs: 30000 },
    profiles: [{ profile: "bob", instanceId: deriveClientInstanceId("bob"), stateRoot: bobState }],
  });
  writeJson(path.join(client, "cursor-acp-runtime-binding.json"), {
    version: 1,
    common: { adapterVersion: "1", installationId: "inst_x", workingDirectory: work, cursorHome: path.join(app, "cursor-home"), command: agentCommand, pollIntervalMs: 30000 },
    profiles: acpBindingProfiles.map((profile) => ({
      profile,
      instanceId: deriveClientInstanceId(profile),
      stateRoot: path.join(app, "model-state", "cursor-acp-drain", profile),
    })),
  });
  for (const adapter of workerManifests) {
    writeJson(path.join(app, "worker-runtime", `${adapter}.manifest.json`), {
      version: 1, artifacts: { "a.mjs": "0".repeat(64) }, environment: { PATH: "/usr/bin" }, nodeSHA256: "0".repeat(64), projectRoot: "/x",
    });
  }
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
  // Open transaction for ghost with a stray body field: never echoed.
  writeJson(path.join(app, "model-state", "instances", deriveClientInstanceId("ghost"), "mailbox-transactions", "open.json"), {
    version: 1, protocol: "coordinator-delivery-v1", deliveryId: 7, state: "claimed", replyRequired: true,
    claimId: FAKE_TOKEN, replyIdempotencyKey: FAKE_TOKEN, body: FAKE_BODY, failureCount: 0, createdAt: "2026-10-17T19:50:00.000Z",
  });
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
    const before = snapshot(app);
    const result = runHeadlessEngagementDoctor({ clientRoot: client, now: NOW, pidAlive: () => true, advisoryHeldAt: () => false });
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
    ["existsSync", "readFileSync", "readdirSync"],
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

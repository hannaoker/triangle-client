// D1.3: backing up and restoring the registry pair. A backup is a private directory outside the registry root holding exactly
// the two files a reader accepts; a restore replaces the live pair from such a backup under the registry lock, against a
// fingerprint of the live files, after archiving them.
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  AUDIT_FILE_NAME,
  backupIdentityRegistry,
  canonicalJson,
  IDENTITY_REGISTRY_SCHEMA,
  IDENTITY_REGISTRY_SCHEMA_V2,
  inspectIdentityRegistryRestore,
  LOCAL_PROFILE_BINDING_SCHEMA,
  readIdentityRegistry,
  REGISTRY_FILE_NAME,
  restoreIdentityRegistry,
  updateIdentityRegistry,
} from "../src/identity-registry.mjs";
import {
  agentBindingV1,
  agentBindingV2,
  appendAndCommit,
  auditEntry,
  auditLines,
  makeRoot,
  makeV1Root,
  peerBindingV2,
  readRaw,
  serverlessPairing,
  T0,
  T1,
  T2,
  upgradeThroughWriter,
} from "./identity-registry-v2-helpers.mjs";

const V1 = IDENTITY_REGISTRY_SCHEMA;
const V2 = IDENTITY_REGISTRY_SCHEMA_V2;
const T3 = "2026-11-07T10:15:00.000Z";
const T4 = "2026-11-07T10:20:00.000Z";

function withEnv(fn, names) {
  const { base, root } = makeV1Root(names);
  try {
    return fn({ base, root, backupParent: path.join(base, "identity-backups") });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const modeOf = (file) => lstatSync(file).mode & 0o777;
const bytesOf = (dir, name) => readFileSync(path.join(dir, name));
const livePair = (root) => ({ registry: bytesOf(root, REGISTRY_FILE_NAME), audit: bytesOf(root, AUDIT_FILE_NAME) });
const rootEntries = (root) => readdirSync(root).filter((name) => name !== ".registry.lock").sort();

function expectError(fn, code, reason) {
  assert.throws(fn, (err) => {
    assert.equal(err.code, code, `${err.code}/${err.reason}: ${err.message}`);
    if (reason !== undefined) assert.equal(err.reason, reason, `${err.code}/${err.reason}: ${err.message}`);
    return true;
  });
}

function bind(root, binding, now = T2) {
  const seq = readIdentityRegistry({ root }).registry.sequence;
  return updateIdentityRegistry({
    root,
    expectedSequence: seq,
    now,
    action: "bind",
    subject: binding.profile_instance_id,
    mutate: (r) => {
      r.bindings[binding.profile_instance_id] = binding;
      return r;
    },
  });
}
const bindV1 = (root, name = "codex-headless", now = T2) => bind(root, agentBindingV1(name), now);
const bindV2 = (root, name = "codex-headless", now = T2) => bind(root, agentBindingV2(name), now);

// A backup taken at the v1 sequence, then the registry upgraded and given one agent bind on top: the live registry is v2.
function upgradedWithBackup(env) {
  const backup = backupIdentityRegistry({ root: env.root, backupParent: env.backupParent, now: T1 });
  upgradeThroughWriter(env.root, { now: T2 });
  bindV2(env.root, "codex-headless", T3);
  return backup;
}

// The records the writer cannot create yet, appended by hand.
function addV2Records(root) {
  const peer = peerBindingV2("peerprof");
  const pair = serverlessPairing(1, peer.principal_id);
  const gravity = agentBindingV1("gravity2").principal_id;
  appendAndCommit(root, {
    action: "bind",
    subject: peer.profile_instance_id,
    bindingId: peer.binding_id,
    at: T4,
    change: (r) => ({
      ...r,
      bindings: { ...r.bindings, [peer.profile_instance_id]: peer },
      pairings: { [pair.pairing_id]: pair },
      aliases: { gravity: { principal_id: gravity, set_at: T0, generation: 1 } },
      destinations: { [gravity]: { harness: "claude", workspace: "/w", set_at: T0, generation: 1 } },
    }),
  });
}

function restoreWith(env, backupDir, overrides = {}) {
  const inspected = inspectIdentityRegistryRestore({ root: env.root, backupDir });
  return restoreIdentityRegistry({
    root: env.root,
    backupDir,
    archiveParent: env.backupParent,
    expectedLiveFingerprint: inspected.live.fingerprint,
    expectedBackup: { registrySha256: inspected.backup.registrySha256, auditSha256: inspected.backup.auditSha256 },
    now: T3,
    ...overrides,
  });
}

function writeBackupDir(dir, files) {
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  for (const [name, bytes] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), bytes);
    chmodSync(path.join(dir, name), 0o600);
  }
}

function breakRegistryFile(root) {
  const file = path.join(root, REGISTRY_FILE_NAME);
  writeFileSync(file, "{ not json\n");
  chmodSync(file, 0o600);
}

// ---- backups --------------------------------------------------------------------------------------------------------------------
test("a backup is a private directory outside the root with exactly the two files, and the live registry still reads and writes", () =>
  withEnv((env) => {
    const live = livePair(env.root);
    const before = readIdentityRegistry({ root: env.root }).registry;
    const backup = backupIdentityRegistry({ root: env.root, backupParent: env.backupParent, now: T1 });

    assert.equal(path.dirname(backup.dir), env.backupParent);
    assert.equal(path.basename(backup.dir), "backup-v1-20261107T100500Z");
    assert.deepEqual([modeOf(env.backupParent), modeOf(backup.dir)], [0o700, 0o700]);
    assert.deepEqual(readdirSync(backup.dir).sort(), [AUDIT_FILE_NAME, REGISTRY_FILE_NAME].sort());
    for (const name of [REGISTRY_FILE_NAME, AUDIT_FILE_NAME]) assert.equal(modeOf(path.join(backup.dir, name)), 0o600);
    assert.deepEqual({ registry: bytesOf(backup.dir, REGISTRY_FILE_NAME), audit: bytesOf(backup.dir, AUDIT_FILE_NAME) }, live);

    const read = readIdentityRegistry({ root: backup.dir });
    assert.deepEqual([read.registry.schema, read.registry.sequence, read.registry.auditHead.hash], [V1, before.sequence, before.auditHead.hash]);
    assert.deepEqual([backup.schema, backup.sequence, backup.auditHead.hash, backup.bindings, backup.takenAt], [V1, before.sequence, before.auditHead.hash, 2, T1]);

    // the point of keeping it outside the root: the live registry reads, and writes, exactly as before
    assert.deepEqual(livePair(env.root), live, "taking a backup changes no live byte");
    assert.equal(readIdentityRegistry({ root: env.root }).registry.sequence, before.sequence);
    assert.equal(bindV1(env.root).registry.sequence, before.sequence + 1);
    assert.equal(readIdentityRegistry({ root: env.root }).registry.sequence, before.sequence + 1);
  }));

test("backups taken in the same second get distinct directories, and a backup of a v2 registry is named v2", () =>
  withEnv((env) => {
    const a = backupIdentityRegistry({ root: env.root, backupParent: env.backupParent, now: T1 });
    const b = backupIdentityRegistry({ root: env.root, backupParent: env.backupParent, now: T1 });
    assert.deepEqual([path.basename(a.dir), path.basename(b.dir)], ["backup-v1-20261107T100500Z", "backup-v1-20261107T100500Z-2"]);
    upgradeThroughWriter(env.root);
    const c = backupIdentityRegistry({ root: env.root, backupParent: env.backupParent, now: T2 });
    assert.equal(path.basename(c.dir), "backup-v2-20261107T101000Z");
    assert.equal(readIdentityRegistry({ root: c.dir }).registry.schema, V2);
  }));

test("a backup leaves out an uncommitted audit line, such as a crashed upgrade", () =>
  withEnv((env) => {
    expectError(
      () => upgradeThroughWriter(env.root, { faultHook: (stage) => { if (stage === "after_audit_append") throw new Error("boom"); } }),
      undefined,
    );
    assert.equal(readIdentityRegistry({ root: env.root }).audit.uncommittedTail, 1);
    const live = livePair(env.root);
    const backup = backupIdentityRegistry({ root: env.root, backupParent: env.backupParent, now: T1 });
    const copy = readIdentityRegistry({ root: backup.dir });
    assert.deepEqual([copy.registry.schema, copy.audit.uncommittedTail], [V1, 0]);
    const lines = readFileSync(path.join(backup.dir, AUDIT_FILE_NAME), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(lines.every((e) => e.action !== "upgrade"), "the stale upgrade line is not carried into the backup");
    assert.equal(lines.length, copy.registry.sequence);
    assert.deepEqual(livePair(env.root), live, "the live files are untouched");
  }));

test("a backup refuses what it cannot make safely, and creates nothing in that case", () =>
  withEnv((env) => {
    const missing = path.join(env.base, "nowhere");
    expectError(() => backupIdentityRegistry({ root: missing, backupParent: env.backupParent, now: T1 }), "invalid_registry", "backup_requires_registry");
    assert.equal(existsSync(missing), false, "no root is created");
    assert.equal(existsSync(env.backupParent), false, "no backup parent is created");

    const bare = path.join(env.base, "bare");
    mkdirSync(bare, { mode: 0o700 });
    expectError(() => backupIdentityRegistry({ root: bare, backupParent: env.backupParent, now: T1 }), "invalid_registry", "backup_requires_registry");
    assert.deepEqual(readdirSync(bare), [], "not even a lock file appears in a directory without a registry");
    assert.equal(existsSync(env.backupParent), false);

    for (const parent of [env.root, path.join(env.root, "inside"), env.base]) {
      expectError(() => backupIdentityRegistry({ root: env.root, backupParent: parent, now: T1 }), "invalid_registry", "backup_parent_overlaps_registry_root");
    }
    expectError(() => backupIdentityRegistry({ root: env.root, backupParent: "relative/backups", now: T1 }), "registry_unsafe", "invalid_root_path");
    expectError(() => backupIdentityRegistry({ root: env.root, backupParent: env.backupParent, now: "not a time" }), "invalid_registry");

    const link = path.join(env.base, "linked-backups");
    symlinkSync(env.base, link);
    expectError(() => backupIdentityRegistry({ root: env.root, backupParent: link, now: T1 }), "registry_unsafe");
    const loose = path.join(env.base, "loose-backups");
    mkdirSync(loose, { mode: 0o755 });
    chmodSync(loose, 0o755);
    expectError(() => backupIdentityRegistry({ root: env.root, backupParent: loose, now: T1 }), "registry_unsafe", "root_wrong_mode");
    assert.deepEqual(readdirSync(loose), []);

    // a registry that does not validate is not backed up as if it were good
    const file = path.join(env.root, REGISTRY_FILE_NAME);
    writeFileSync(file, `${canonicalJson({ ...readRaw(env.root), schema: "identity_registry_v3" })}\n`);
    chmodSync(file, 0o600);
    expectError(() => backupIdentityRegistry({ root: env.root, backupParent: env.backupParent, now: T1 }), "registry_corrupt");
    assert.equal(existsSync(env.backupParent), false);
  }));

test("a copy that reads fine but is not byte for byte the live pair is refused and removed", () =>
  withEnv((env) => {
    // a trailing newline still parses and validates, so only the byte comparison can catch it
    expectError(
      () => backupIdentityRegistry({
        root: env.root,
        backupParent: env.backupParent,
        now: T1,
        faultHook: (stage, ctx) => { if (stage === "after_backup_write") appendFileSync(path.join(ctx.dir, REGISTRY_FILE_NAME), "\n"); },
      }),
      "registry_corrupt",
      "backup_verification_failed",
    );
    assert.deepEqual(readdirSync(env.backupParent), []);
  }));

test("a failed copy leaves no directory behind, and the registry lock is held until the copy is verified", () =>
  withEnv((env) => {
    expectError(
      () => backupIdentityRegistry({ root: env.root, backupParent: env.backupParent, now: T1, faultHook: (stage) => { if (stage === "after_backup_write") throw new Error("boom"); } }),
      undefined,
    );
    assert.deepEqual(readdirSync(env.backupParent), [], "the half-made backup is removed");

    let sawBusy = false;
    backupIdentityRegistry({
      root: env.root,
      backupParent: env.backupParent,
      now: T1,
      faultHook: (stage) => {
        if (stage !== "after_backup_verify") return;
        try {
          bindV1(env.root);
        } catch (err) {
          sawBusy = err.code === "registry_busy";
        }
      },
    });
    assert.equal(sawBusy, true, "a writer cannot slip in between the read and the end of the copy");
  }));

// ---- inspecting a restore ---------------------------------------------------------------------------------------------------------
test("inspecting a restore describes the live registry, the backup, their history and what would be lost, and writes nothing", () =>
  withEnv((env) => {
    const backup = upgradedWithBackup(env);
    const files = [livePair(env.root), readdirSync(env.base).sort(), readdirSync(env.backupParent).sort()];
    const inspected = inspectIdentityRegistryRestore({ root: env.root, backupDir: backup.dir });

    assert.deepEqual([inspected.live.state, inspected.live.schema, inspected.live.sequence], ["ok", V2, 5]);
    assert.deepEqual([inspected.backup.schema, inspected.backup.sequence, inspected.backup.dir], [V1, 3, backup.dir]);
    assert.equal(inspected.relation, "ahead");
    assert.deepEqual(inspected.discarded.map((e) => [e.sequence, e.action]), [[4, "upgrade"], [5, "bind"]]);
    assert.equal(inspected.willLoseV2Data, false, "agent bindings exist in v1 terms; what is lost is the later bind, listed above");
    assert.deepEqual(inspected.live.v2Data, { serverlessBindings: 0, pairings: 0, aliases: 0, destinations: 0, any: false });
    assert.match(inspected.live.fingerprint.registry, /^[a-f0-9]{64}$/);
    assert.deepEqual([livePair(env.root), readdirSync(env.base).sort(), readdirSync(env.backupParent).sort()], files, "inspecting creates and changes nothing");

    addV2Records(env.root);
    const withRecords = inspectIdentityRegistryRestore({ root: env.root, backupDir: backup.dir });
    assert.equal(withRecords.willLoseV2Data, true);
    assert.deepEqual(withRecords.live.v2Data, { serverlessBindings: 1, pairings: 1, aliases: 1, destinations: 1, any: true });
    assert.notDeepEqual(withRecords.live.fingerprint, inspected.live.fingerprint);
  }));

test("how the histories relate: same, ahead, behind, diverged, and unknown for an unreadable live registry", () =>
  withEnv((env) => {
    const backup = backupIdentityRegistry({ root: env.root, backupParent: env.backupParent, now: T1 });
    assert.equal(inspectIdentityRegistryRestore({ root: env.root, backupDir: backup.dir }).relation, "same");

    bindV1(env.root);
    const ahead = inspectIdentityRegistryRestore({ root: env.root, backupDir: backup.dir });
    assert.deepEqual([ahead.relation, ahead.discarded.map((e) => e.action)], ["ahead", ["bind"]]);

    // a backup taken later than the live registry is "behind" it
    const later = backupIdentityRegistry({ root: env.root, backupParent: env.backupParent, now: T2 });
    restoreWith(env, backup.dir);
    assert.equal(inspectIdentityRegistryRestore({ root: env.root, backupDir: later.dir }).relation, "behind");

    // a different history from the same point on is "diverged"
    bindV1(env.root, "another-profile");
    const diverged = inspectIdentityRegistryRestore({ root: env.root, backupDir: later.dir });
    assert.deepEqual([diverged.relation, diverged.discarded.length], ["diverged", 1]);

    breakRegistryFile(env.root);
    const unknown = inspectIdentityRegistryRestore({ root: env.root, backupDir: backup.dir });
    assert.deepEqual([unknown.relation, unknown.live.state, unknown.live.errorCode.split(":")[0]], ["unknown", "unreadable", "registry_corrupt"]);
    assert.deepEqual(unknown.discarded, []);
  }));

test("a backup that cannot be restored is refused with the reason", () =>
  withEnv((env) => {
    const good = backupIdentityRegistry({ root: env.root, backupParent: env.backupParent, now: T1 });
    upgradeThroughWriter(env.root);
    const v2Backup = backupIdentityRegistry({ root: env.root, backupParent: env.backupParent, now: T2 });
    expectError(() => inspectIdentityRegistryRestore({ root: env.root, backupDir: v2Backup.dir }), "invalid_registry", "restore_backup_not_v1");

    // a copy whose audit log was changed does not verify
    const damaged = path.join(env.backupParent, "damaged");
    const tampered = bytesOf(good.dir, AUDIT_FILE_NAME).toString("utf8").replace(`"at":"${T0}"`, '"at":"2026-11-07T10:00:01.000Z"');
    writeBackupDir(damaged, { [REGISTRY_FILE_NAME]: bytesOf(good.dir, REGISTRY_FILE_NAME), [AUDIT_FILE_NAME]: tampered });
    let refused = null;
    try {
      inspectIdentityRegistryRestore({ root: env.root, backupDir: damaged });
    } catch (err) {
      refused = err;
    }
    assert.ok(refused, "a damaged backup must be refused");
    assert.deepEqual([refused.code, refused.reason], ["invalid_registry", "restore_backup_unreadable"]);
    assert.match(refused.detail, /^registry_chain_broken:/);

    // an unfinished write in a backup would carry a poison line back into the live registry
    const head = readRaw(good.dir).auditHead;
    const stray = auditEntry({ sequence: head.sequence + 1, at: T2, action: "upgrade", prevHash: head.hash });
    const tailed = path.join(env.backupParent, "tailed");
    writeBackupDir(tailed, {
      [REGISTRY_FILE_NAME]: bytesOf(good.dir, REGISTRY_FILE_NAME),
      [AUDIT_FILE_NAME]: `${bytesOf(good.dir, AUDIT_FILE_NAME).toString("utf8")}${canonicalJson(stray)}\n`,
    });
    expectError(() => inspectIdentityRegistryRestore({ root: env.root, backupDir: tailed }), "invalid_registry", "restore_backup_unfinished_write");

    expectError(() => inspectIdentityRegistryRestore({ root: env.root, backupDir: path.join(env.backupParent, "missing") }), "invalid_registry", "restore_backup_unreadable");
    expectError(() => inspectIdentityRegistryRestore({ root: env.root, backupDir: env.root }), "invalid_registry", "backup_overlaps_registry_root");
    expectError(() => inspectIdentityRegistryRestore({ root: env.root, backupDir: path.join(env.root, "inner") }), "invalid_registry", "backup_overlaps_registry_root");
  }));

// ---- restoring ------------------------------------------------------------------------------------------------------------------
test("a restore puts the backup pair back byte for byte, archives the live pair first, and the registry then works", () =>
  withEnv((env) => {
    const backup = upgradedWithBackup(env);
    const live = livePair(env.root);
    const out = restoreWith(env, backup.dir);

    assert.deepEqual([out.restored.schema, out.restored.sequence, out.restored.auditHead.hash], [V1, 3, backup.auditHead.hash]);
    assert.deepEqual(livePair(env.root), { registry: bytesOf(backup.dir, REGISTRY_FILE_NAME), audit: bytesOf(backup.dir, AUDIT_FILE_NAME) });
    assert.deepEqual([out.live.state, out.live.schema, out.live.sequence, out.relation], ["ok", V2, 5, "ahead"]);
    assert.deepEqual(out.discarded.map((e) => [e.sequence, e.action]), [[4, "upgrade"], [5, "bind"]]);

    // the pair it replaced is archived whole, outside the root, and still reads
    assert.equal(path.dirname(out.archive.dir), env.backupParent);
    assert.equal(path.basename(out.archive.dir), "before-restore-v2-20261107T101500Z");
    assert.deepEqual({ registry: bytesOf(out.archive.dir, REGISTRY_FILE_NAME), audit: bytesOf(out.archive.dir, AUDIT_FILE_NAME) }, live);
    assert.deepEqual([modeOf(out.archive.dir), modeOf(path.join(out.archive.dir, REGISTRY_FILE_NAME))], [0o700, 0o600]);
    assert.equal(readIdentityRegistry({ root: out.archive.dir }).registry.schema, V2);

    // nothing but the registry's own files is left in the root, and it takes writes again
    assert.deepEqual(rootEntries(env.root), [AUDIT_FILE_NAME, REGISTRY_FILE_NAME].sort());
    const after = readIdentityRegistry({ root: env.root });
    assert.deepEqual([after.registry.schema, after.registry.sequence, after.audit.uncommittedTail], [V1, 3, 0]);
    assert.equal(bindV1(env.root).registry.sequence, 4);
    assert.equal(auditLines(env.root).length, 4);
  }));

test("a restore refuses to lose v2-only data unless told to, and then archives it", () =>
  withEnv((env) => {
    const backup = upgradedWithBackup(env);
    addV2Records(env.root);
    const live = livePair(env.root);
    const entries = readdirSync(env.backupParent).sort();
    for (const flag of [undefined, false, "yes", 1, "true"]) {
      expectError(() => restoreWith(env, backup.dir, { discardV2Data: flag }), "restore_refused", "restore_would_lose_v2_data");
    }
    assert.deepEqual([livePair(env.root), readdirSync(env.backupParent).sort()], [live, entries], "a refusal changes nothing and archives nothing");

    const out = restoreWith(env, backup.dir, { discardV2Data: true });
    assert.equal(readIdentityRegistry({ root: env.root }).registry.schema, V1);
    assert.deepEqual({ registry: bytesOf(out.archive.dir, REGISTRY_FILE_NAME), audit: bytesOf(out.archive.dir, AUDIT_FILE_NAME) }, live);
    const archived = readIdentityRegistry({ root: out.archive.dir }).registry;
    assert.deepEqual([Object.keys(archived.pairings).length, Object.keys(archived.aliases).length, Object.keys(archived.destinations).length], [1, 1, 1]);
  }));

test("a restore is a compare-and-set on the live files: if they changed since the plan, nothing is touched", () =>
  withEnv((env) => {
    const backup = upgradedWithBackup(env);
    const inspected = inspectIdentityRegistryRestore({ root: env.root, backupDir: backup.dir });
    const planned = inspected.live.fingerprint;
    bindV2(env.root, "late-arrival", T4);
    const live = livePair(env.root);
    const entries = readdirSync(env.backupParent).sort();
    expectError(
      () => restoreIdentityRegistry({ root: env.root, backupDir: backup.dir, archiveParent: env.backupParent, expectedLiveFingerprint: planned, expectedBackup: { registrySha256: inspected.backup.registrySha256, auditSha256: inspected.backup.auditSha256 }, now: T3 }),
      "registry_changed",
      "live_registry_changed_since_plan",
    );
    assert.deepEqual([livePair(env.root), readdirSync(env.backupParent).sort()], [live, entries]);

    // the fingerprint is required and has to be well formed
    for (const bad of [undefined, null, {}, { registry: "abc", audit: null }, { registry: null }, { registry: null, audit: null, extra: 1 }]) {
      expectError(() => restoreIdentityRegistry({ root: env.root, backupDir: backup.dir, archiveParent: env.backupParent, expectedLiveFingerprint: bad, now: T3 }), "invalid_registry", "expected_live_fingerprint_required");
    }
    assert.deepEqual(livePair(env.root), live);
  }));

test("a restore writes the backup bytes that were planned: a backup that changed since is refused", () =>
  withEnv((env) => {
    const backup = upgradedWithBackup(env);
    const planned = inspectIdentityRegistryRestore({ root: env.root, backupDir: backup.dir });
    const live = livePair(env.root);
    const restore = (expectedBackup) => restoreIdentityRegistry({
      root: env.root,
      backupDir: backup.dir,
      archiveParent: env.backupParent,
      expectedLiveFingerprint: planned.live.fingerprint,
      expectedBackup,
      now: T3,
    });
    for (const bad of [undefined, null, {}, { registrySha256: "abc", auditSha256: null }, { registrySha256: planned.backup.registrySha256 }, { auditSha256: planned.backup.auditSha256 }]) {
      expectError(() => restore(bad), "invalid_registry", "expected_backup_required");
    }
    // a copy that still reads and verifies, but is not the bytes that were planned (trailing newline in the registry file)
    appendFileSync(path.join(backup.dir, REGISTRY_FILE_NAME), "\n");
    expectError(() => restore({ registrySha256: planned.backup.registrySha256, auditSha256: planned.backup.auditSha256 }), "registry_changed", "backup_changed_since_plan");
    assert.deepEqual(livePair(env.root), live, "nothing was replaced");
    assert.deepEqual(readdirSync(env.backupParent).filter((n) => n.startsWith("before-restore-")), [], "nothing was archived");
  }));

test("a restore can replace an unreadable live registry, and recreate a missing one", () =>
  withEnv((env) => {
    const backup = backupIdentityRegistry({ root: env.root, backupParent: env.backupParent, now: T1 });
    bindV1(env.root);
    breakRegistryFile(env.root);
    const broken = livePair(env.root);
    const out = restoreWith(env, backup.dir);
    assert.deepEqual([out.live.state, out.relation], ["unreadable", "unknown"]);
    assert.equal(path.basename(out.archive.dir), "before-restore-unreadable-20261107T101500Z");
    assert.deepEqual({ registry: bytesOf(out.archive.dir, REGISTRY_FILE_NAME), audit: bytesOf(out.archive.dir, AUDIT_FILE_NAME) }, broken, "the broken files are kept as they were");
    assert.deepEqual([readIdentityRegistry({ root: env.root }).registry.sequence, auditLines(env.root).length], [3, 3]);

    // the whole root is gone: it is recreated private, and there is nothing to archive
    rmSync(env.root, { recursive: true, force: true });
    const again = restoreWith(env, backup.dir);
    assert.deepEqual([again.live.state, again.archive], ["absent", null]);
    assert.equal(modeOf(env.root), 0o700);
    assert.deepEqual([readIdentityRegistry({ root: env.root }).registry.sequence, rootEntries(env.root)], [3, [AUDIT_FILE_NAME, REGISTRY_FILE_NAME].sort()]);
  }));

test("what a restore changes for routing, binding by binding: undone revokes, added, removed, revoked and changed bindings", () =>
  withEnv((env) => {
    const backup = backupIdentityRegistry({ root: env.root, backupParent: env.backupParent, now: T1 });
    const ghost = agentBindingV1("ghost");
    const revokeGhost = () => updateIdentityRegistry({
      root: env.root,
      expectedSequence: readIdentityRegistry({ root: env.root }).registry.sequence,
      now: T2,
      action: "revoke",
      subject: ghost.profile_instance_id,
      mutate: (r) => { r.bindings[ghost.profile_instance_id].revoked_at = T2; return r; },
    });
    const names = (list) => list.map((x) => x.profile);
    const same = inspectIdentityRegistryRestore({ root: env.root, backupDir: backup.dir }).routing;
    assert.deepEqual(Object.values(same).map((l) => l.length), [0, 0, 0, 0, 0], "an unchanged registry changes nothing");

    // the live registry revoked a binding after the backup: restoring undoes the revoke
    revokeGhost();
    bindV1(env.root, "codex-headless");
    const routing = inspectIdentityRegistryRestore({ root: env.root, backupDir: backup.dir }).routing;
    assert.deepEqual([names(routing.reactivated), names(routing.removed), names(routing.added), names(routing.revoked), names(routing.changed)], [["ghost"], ["codex-headless"], [], [], []]);
    assert.deepEqual(routing.reactivated[0], { instanceId: ghost.profile_instance_id, profile: "ghost", principal: ghost.principal_id, trustMode: "mesh-managed", generation: 1 });
    const out = restoreWith(env, backup.dir);
    assert.deepEqual([names(out.routing.reactivated), names(out.routing.removed)], [["ghost"], ["codex-headless"]]);
    assert.equal(readIdentityRegistry({ root: env.root }).registry.bindings[ghost.profile_instance_id].revoked_at, null, "the binding routes again");

    // a backup that was taken after a revoke: restoring it revokes, and one with a binding the live registry lacks adds it
    revokeGhost();
    const later = backupIdentityRegistry({ root: env.root, backupParent: env.backupParent, now: T3 });
    restoreWith(env, backup.dir);
    const forward = inspectIdentityRegistryRestore({ root: env.root, backupDir: later.dir }).routing;
    assert.deepEqual([names(forward.revoked), names(forward.reactivated)], [["ghost"], []]);

    // another registry's backup: a binding the live one has not (added), one under another principal (changed)
    const other = makeRoot("id-reg-v2b-other-");
    try {
      updateIdentityRegistry({ root: other.root, expectedSequence: 0, now: T0, action: "init", subject: null, mutate: (r) => r });
      const swapped = agentBindingV1("ghost", { principal_id: `agent_${"9".repeat(32)}`, binding_id: `bind_${"9".repeat(32)}` });
      const extra = agentBindingV1("owner-profile");
      for (const [i, b] of [swapped, extra].entries()) {
        updateIdentityRegistry({ root: other.root, expectedSequence: i + 1, now: T0, action: "bind", subject: b.profile_instance_id, mutate: (r) => { r.bindings[b.profile_instance_id] = b; return r; } });
      }
      const foreign = backupIdentityRegistry({ root: other.root, backupParent: path.join(other.base, "identity-backups"), now: T1 });
      const crafted = inspectIdentityRegistryRestore({ root: env.root, backupDir: foreign.dir });
      assert.equal(crafted.relation, "diverged");
      // owner-profile is new, ghost is bound to another principal, gravity2 is not in the other registry
      assert.deepEqual([names(crafted.routing.added), names(crafted.routing.changed), names(crafted.routing.removed)], [["owner-profile"], ["ghost"], ["gravity2"]]);
    } finally {
      rmSync(other.base, { recursive: true, force: true });
    }

    // no readable live registry: every active binding of the backup is added
    breakRegistryFile(env.root);
    const unreadable = inspectIdentityRegistryRestore({ root: env.root, backupDir: backup.dir }).routing;
    assert.deepEqual([names(unreadable.added), unreadable.reactivated.length, unreadable.removed.length], [["ghost", "gravity2"], 0, 0]);
  }));

test("an archive that does not read back, or a restore that does not verify, is an error and not a success", () =>
  withEnv((env) => {
    const backup = upgradedWithBackup(env);
    const live = livePair(env.root);
    expectError(
      () => restoreWith(env, backup.dir, { faultHook: (stage, ctx) => { if (stage === "after_archive_write") appendFileSync(path.join(ctx.archiveDir, REGISTRY_FILE_NAME), "x"); } }),
      "registry_corrupt",
      "archive_verification_failed",
    );
    assert.deepEqual(livePair(env.root), live, "nothing was replaced");
    assert.deepEqual(readdirSync(env.backupParent).filter((n) => n.startsWith("before-restore-")), [], "the bad archive is removed");

    expectError(
      () => restoreWith(env, backup.dir, { faultHook: (stage) => { if (stage === "after_audit_replace") appendFileSync(path.join(env.root, REGISTRY_FILE_NAME), "\n"); } }),
      "registry_corrupt",
      "restore_verification_failed",
    );
  }));

test("restoring a backup of a registry with no history removes the live audit log", () =>
  withEnv((env) => {
    const empty = makeRoot("id-reg-v2b-empty-");
    try {
      mkdirSync(empty.root, { mode: 0o700 });
      const file = path.join(empty.root, REGISTRY_FILE_NAME);
      writeFileSync(file, `${canonicalJson(readRaw(env.root) && { ...readRaw(env.root), sequence: 0, auditHead: { sequence: 0, hash: "0".repeat(64) }, bindings: {} })}\n`);
      chmodSync(file, 0o600);
      const seq0 = backupIdentityRegistry({ root: empty.root, backupParent: path.join(empty.base, "identity-backups"), now: T1 });
      assert.deepEqual(readdirSync(seq0.dir), [REGISTRY_FILE_NAME]);
      const out = restoreWith(env, seq0.dir);
      assert.equal(out.restored.sequence, 0);
      assert.deepEqual(rootEntries(env.root), [REGISTRY_FILE_NAME], "the live audit log is gone with the history it belonged to");
      assert.ok(out.archive && out.archive.files.length === 2);
    } finally {
      rmSync(empty.base, { recursive: true, force: true });
    }
  }));

test("each half of the live fingerprint counts: a change to only the registry file, or only the audit log, is a change", () => {
  const attempt = (env, backup, planned) => restoreIdentityRegistry({
    root: env.root,
    backupDir: backup.dir,
    archiveParent: env.backupParent,
    expectedLiveFingerprint: planned.live.fingerprint,
    expectedBackup: { registrySha256: planned.backup.registrySha256, auditSha256: planned.backup.auditSha256 },
    now: T3,
  });
  // only the registry file changes (the audit log is the same bytes)
  withEnv((env) => {
    const backup = upgradedWithBackup(env);
    const planned = inspectIdentityRegistryRestore({ root: env.root, backupDir: backup.dir });
    appendFileSync(path.join(env.root, REGISTRY_FILE_NAME), "\n");
    expectError(() => attempt(env, backup, planned), "registry_changed", "live_registry_changed_since_plan");
  });
  // only the audit log changes (a crashed write leaves a stale line; the registry file is untouched)
  withEnv((env) => {
    const backup = upgradedWithBackup(env);
    const planned = inspectIdentityRegistryRestore({ root: env.root, backupDir: backup.dir });
    const registryBefore = readFileSync(path.join(env.root, REGISTRY_FILE_NAME));
    const binding = agentBindingV2("half-written");
    expectError(
      () => updateIdentityRegistry({
        root: env.root,
        expectedSequence: 5,
        now: T4,
        action: "bind",
        subject: binding.profile_instance_id,
        mutate: (r) => { r.bindings[binding.profile_instance_id] = binding; return r; },
        faultHook: (stage) => { if (stage === "after_audit_append") throw new Error("boom"); },
      }),
      undefined,
    );
    assert.ok(readFileSync(path.join(env.root, REGISTRY_FILE_NAME)).equals(registryBefore), "only the audit log differs");
    expectError(() => attempt(env, backup, planned), "registry_changed", "live_registry_changed_since_plan");
  });
});

test("a stale uncommitted audit line in the live registry is not counted as history that would be discarded", () =>
  withEnv((env) => {
    const backup = backupIdentityRegistry({ root: env.root, backupParent: env.backupParent, now: T1 });
    expectError(
      () => updateIdentityRegistry({
        root: env.root,
        expectedSequence: 3,
        now: T2,
        action: "bind",
        subject: agentBindingV1("codex-headless").profile_instance_id,
        mutate: (r) => { const b = agentBindingV1("codex-headless"); r.bindings[b.profile_instance_id] = b; return r; },
        faultHook: (stage) => { if (stage === "after_audit_append") throw new Error("boom"); },
      }),
      undefined,
    );
    const inspected = inspectIdentityRegistryRestore({ root: env.root, backupDir: backup.dir });
    assert.deepEqual([inspected.live.uncommittedTail, inspected.relation, inspected.discarded], [1, "same", []]);
  }));

test("backups and archives are private whatever the umask", () =>
  withEnv((env) => {
    backupIdentityRegistry({ root: env.root, backupParent: env.backupParent, now: T1 }); // the parent exists now
    const old = process.umask(0o277);
    let backup;
    try {
      backup = backupIdentityRegistry({ root: env.root, backupParent: env.backupParent, now: T2 });
    } finally {
      process.umask(old);
    }
    assert.deepEqual([modeOf(backup.dir), modeOf(path.join(backup.dir, REGISTRY_FILE_NAME)), modeOf(path.join(backup.dir, AUDIT_FILE_NAME))], [0o700, 0o600, 0o600]);
    assert.equal(readIdentityRegistry({ root: backup.dir }).registry.sequence, 3);
  }));

test("a stray directory inside the registry root stops a restore: replacing the two files would not make the registry readable", () =>
  withEnv((env) => {
    const backup = backupIdentityRegistry({ root: env.root, backupParent: env.backupParent, now: T1 });
    mkdirSync(path.join(env.root, "backup-v1-by-hand"), { mode: 0o700 });
    const live = livePair(env.root);
    expectError(() => inspectIdentityRegistryRestore({ root: env.root, backupDir: backup.dir }), "registry_unsafe");
    expectError(
      () => restoreIdentityRegistry({
        root: env.root,
        backupDir: backup.dir,
        archiveParent: env.backupParent,
        expectedLiveFingerprint: { registry: null, audit: null },
        expectedBackup: { registrySha256: backup.registrySha256, auditSha256: backup.auditSha256 },
        now: T3,
      }),
      "registry_unsafe",
    );
    assert.deepEqual(livePair(env.root), live);
    assert.deepEqual(readdirSync(env.backupParent).filter((n) => n.startsWith("before-restore-")), []);
  }));

test("a crash at any stage of a restore leaves nothing lost, and running the restore again finishes it", () => {
  const stages = ["before_archive", "after_archive", "before_registry_replace", "after_registry_replace", "after_audit_replace"];
  for (const stage of stages) {
    withEnv((env) => {
      const backup = upgradedWithBackup(env);
      const live = livePair(env.root);
      expectError(() => restoreWith(env, backup.dir, { faultHook: (s) => { if (s === stage) throw new Error(`boom_${stage}`); } }), undefined);

      // the previous pair is kept in the archive from the moment anything is replaced, and no staging file is left behind
      const archives = readdirSync(env.backupParent).filter((n) => n.startsWith("before-restore-"));
      if (stage !== "before_archive") {
        assert.equal(archives.length, 1, stage);
        assert.deepEqual({ registry: bytesOf(path.join(env.backupParent, archives[0]), REGISTRY_FILE_NAME), audit: bytesOf(path.join(env.backupParent, archives[0]), AUDIT_FILE_NAME) }, live, stage);
      }
      assert.deepEqual(rootEntries(env.root), [AUDIT_FILE_NAME, REGISTRY_FILE_NAME].sort(), stage);
      const mid = (() => { try { return readIdentityRegistry({ root: env.root }); } catch (err) { return err; } })();
      if (stage === "after_registry_replace") {
        assert.ok(mid instanceof Error, "the registry is v1 again but its audit log still has the lines of the v2 history");
      } else if (stage === "after_audit_replace") {
        assert.equal(mid.registry.schema, V1);
      } else {
        assert.equal(mid.registry.schema, V2, `${stage}: the live registry is untouched`);
        assert.deepEqual(livePair(env.root), live, stage);
      }

      // run it again from a fresh plan
      const out = restoreWith(env, backup.dir, { now: "2026-11-07T10:16:00.000Z" });
      assert.deepEqual(livePair(env.root), { registry: bytesOf(backup.dir, REGISTRY_FILE_NAME), audit: bytesOf(backup.dir, AUDIT_FILE_NAME) }, stage);
      assert.equal(readIdentityRegistry({ root: env.root }).registry.sequence, 3);
      assert.ok(out.restored.sequence === 3, stage);
    });
  }
});

test("when the live registry is only one entry past the backup, a crash between the two replacements leaves a registry the next write repairs", () =>
  withEnv((env) => {
    const backup = backupIdentityRegistry({ root: env.root, backupParent: env.backupParent, now: T1 });
    upgradeThroughWriter(env.root, { now: T2 });
    expectError(() => restoreWith(env, backup.dir, { faultHook: (s) => { if (s === "after_registry_replace") throw new Error("boom"); } }), undefined);

    const mid = readIdentityRegistry({ root: env.root });
    assert.deepEqual([mid.registry.schema, mid.registry.sequence, mid.audit.uncommittedTail], [V1, 3, 1], "readable v1 with the old upgrade line as an unfinished write");
    const bound = bindV1(env.root);
    assert.equal(bound.registry.sequence, 4);
    const after = readIdentityRegistry({ root: env.root });
    assert.deepEqual([after.audit.uncommittedTail, auditLines(env.root).every((e) => e.action !== "upgrade")], [0, true], "the next write discarded the stale upgrade line");
  }));

test("the registry lock is held through a restore", () =>
  withEnv((env) => {
    const backup = upgradedWithBackup(env);
    let sawBusy = false;
    restoreWith(env, backup.dir, {
      faultHook: (stage) => {
        if (stage !== "after_archive") return;
        try {
          bindV2(env.root, "intruder", T4);
        } catch (err) {
          sawBusy = err.code === "registry_busy";
        }
      },
    });
    assert.equal(sawBusy, true);
  }));

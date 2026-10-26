import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRegistrySnapshotProvider } from "../src/router-registry-snapshot.mjs";
import {
  REGISTRY_FILE_NAME,
  LOCAL_PROFILE_BINDING_SCHEMA,
  updateIdentityRegistry,
} from "../src/identity-registry.mjs";
import { deriveClientInstanceId } from "../src/identity-primitives.mjs";

const TMP_BASE = process.platform === "darwin" ? "/private/tmp" : fs.realpathSync("/tmp");

function makeTmpDir(prefix = "r1-snapshot-test-") {
  const dir = fs.mkdtempSync(path.join(TMP_BASE, prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
}

function hex32(seed) {
  return createHash("sha256").update(String(seed), "utf8").digest("hex").slice(0, 32);
}

function makeBinding(profileName, overrides = {}) {
  const instanceId = deriveClientInstanceId(profileName);
  return {
    schema: LOCAL_PROFILE_BINDING_SCHEMA,
    binding_id: `bind_${hex32(`bind:${profileName}`)}`,
    trust_mode: "mesh-managed",
    principal_id: `agent_${hex32(`agent:${profileName}`)}`,
    profile_name: profileName,
    profile_instance_id: instanceId,
    authority_origin: "https://mesh.example.test",
    binding_generation: 1,
    issued_at: "2026-10-25T10:00:00.000Z",
    revoked_at: null,
    proof: {
      kind: "disk_observation",
      observed_on_disk: true,
      verified_live_authority: false,
    },
    ...overrides,
  };
}

test("absent: provider returns absent snapshot with sequence 0, null errorCode, and empty lookups", () => {
  const provider = createRegistrySnapshotProvider({
    root: "/fake/root",
    readRegistry: () => ({ state: "absent" }),
    statRegistry: () => "absent",
    now: () => 1000,
  });

  const snapshot = provider.get();
  assert.equal(snapshot.state, "absent");
  assert.equal(snapshot.sequence, 0);
  assert.equal(snapshot.errorCode, null);
  assert.equal(snapshot.readAt, 1000);
  assert.deepEqual(snapshot.bindingsFor("agent_123"), []);
  assert.equal(snapshot.bindingForInstance("inst_123"), null);
});

test("ok with indexing: revoked and non-mesh-managed entries excluded, sorted output by profile_instance_id", () => {
  const p1 = "agent_target";
  const p2 = "agent_other";

  const b1 = makeBinding("charlie", {
    principal_id: p1,
    profile_instance_id: "cccc".repeat(16),
  });
  const b2 = makeBinding("alice", {
    principal_id: p1,
    profile_instance_id: "aaaa".repeat(16),
  });
  const b3 = makeBinding("bob", {
    principal_id: p1,
    profile_instance_id: "bbbb".repeat(16),
  });
  const bRevoked = makeBinding("revoked", {
    principal_id: p1,
    profile_instance_id: "0000".repeat(16),
    revoked_at: "2026-10-25T11:00:00.000Z",
  });
  const bUnmanaged = makeBinding("unmanaged", {
    principal_id: p1,
    profile_instance_id: "1111".repeat(16),
    trust_mode: "unmanaged",
  });
  const bOther = makeBinding("other", {
    principal_id: p2,
    profile_instance_id: "dddd".repeat(16),
  });

  const bindings = {
    [b1.profile_instance_id]: b1,
    [b2.profile_instance_id]: b2,
    [b3.profile_instance_id]: b3,
    [bRevoked.profile_instance_id]: bRevoked,
    [bUnmanaged.profile_instance_id]: bUnmanaged,
    [bOther.profile_instance_id]: bOther,
  };

  const provider = createRegistrySnapshotProvider({
    root: "/fake/root",
    readRegistry: () => ({
      state: "ok",
      registry: {
        sequence: 7,
        bindings,
      },
    }),
    statRegistry: () => "key-1",
    now: () => 5000,
  });

  const snapshot = provider.get();
  assert.equal(snapshot.state, "ok");
  assert.equal(snapshot.sequence, 7);
  assert.equal(snapshot.errorCode, null);
  assert.equal(snapshot.readAt, 5000);

  // Excludes revoked and unmanaged; sorted by profile_instance_id code-unit order (aaaa < bbbb < cccc)
  const p1Bindings = snapshot.bindingsFor(p1);
  assert.equal(p1Bindings.length, 3);
  assert.equal(p1Bindings[0].profile_instance_id, b2.profile_instance_id);
  assert.equal(p1Bindings[1].profile_instance_id, b3.profile_instance_id);
  assert.equal(p1Bindings[2].profile_instance_id, b1.profile_instance_id);

  // Unknown principal returns empty array
  assert.deepEqual(snapshot.bindingsFor("agent_nonexistent"), []);

  // Instance lookups
  assert.equal(snapshot.bindingForInstance(b1.profile_instance_id), b1);
  assert.equal(snapshot.bindingForInstance(b2.profile_instance_id), b2);
  assert.equal(snapshot.bindingForInstance(b3.profile_instance_id), b3);
  assert.equal(snapshot.bindingForInstance(bOther.profile_instance_id), bOther);
  assert.equal(snapshot.bindingForInstance(bRevoked.profile_instance_id), null);
  assert.equal(snapshot.bindingForInstance(bUnmanaged.profile_instance_id), null);
  assert.equal(snapshot.bindingForInstance("ffff".repeat(16)), null);
});

test("caching: two get() calls inside TTL with one key make one read, changed key makes new read, expired TTL makes new read", () => {
  let currentTime = 1000;
  let currentKey = "key-A";
  let reads = 0;

  const provider = createRegistrySnapshotProvider({
    root: "/fake/root",
    readRegistry: () => {
      reads++;
      return {
        state: "ok",
        registry: {
          sequence: reads,
          bindings: {},
        },
      };
    },
    statRegistry: () => currentKey,
    now: () => currentTime,
    ttlMs: 2000,
  });

  // Call 1: initial read
  const s1 = provider.get();
  assert.equal(reads, 1);
  assert.equal(s1.sequence, 1);
  assert.equal(s1.readAt, 1000);

  // Call 2: inside TTL (1500 - 1000 = 500 < 2000), same key -> cached
  currentTime = 1500;
  const s2 = provider.get();
  assert.equal(reads, 1);
  assert.equal(s2, s1);

  // Call 3: key changed -> re-read even inside TTL
  currentTime = 1600;
  currentKey = "key-B";
  const s3 = provider.get();
  assert.equal(reads, 2);
  assert.equal(s3.sequence, 2);
  assert.equal(s3.readAt, 1600);

  // Call 4: TTL expired (3600 - 1600 = 2000 >= ttlMs 2000), same key -> re-read
  currentTime = 3600;
  const s4 = provider.get();
  assert.equal(reads, 3);
  assert.equal(s4.sequence, 3);
  assert.equal(s4.readAt, 3600);
});

test("unreadable: cached with error code, and recovering when key changes", () => {
  let currentTime = 1000;
  let currentKey = "key-bad";
  let reads = 0;
  let shouldFail = true;

  const provider = createRegistrySnapshotProvider({
    root: "/fake/root",
    readRegistry: () => {
      reads++;
      if (shouldFail) {
        const err = new Error("registry file damaged");
        err.code = "registry_corrupt";
        throw err;
      }
      return {
        state: "ok",
        registry: { sequence: 10, bindings: {} },
      };
    },
    statRegistry: () => currentKey,
    now: () => currentTime,
    ttlMs: 2000,
  });

  // First call throws and builds unreadable snapshot
  const s1 = provider.get();
  assert.equal(reads, 1);
  assert.equal(s1.state, "unreadable");
  assert.equal(s1.sequence, 0);
  assert.equal(s1.errorCode, "registry_corrupt");
  assert.equal(s1.readAt, 1000);
  assert.deepEqual(s1.bindingsFor("agent_any"), []);
  assert.equal(s1.bindingForInstance("inst_any"), null);

  // Second call inside TTL with same key returns cached unreadable snapshot without re-reading
  currentTime = 1500;
  const s2 = provider.get();
  assert.equal(reads, 1);
  assert.equal(s2, s1);

  // Key changes and disk is restored -> recovers
  currentKey = "key-good";
  shouldFail = false;
  currentTime = 1800;
  const s3 = provider.get();
  assert.equal(reads, 2);
  assert.equal(s3.state, "ok");
  assert.equal(s3.sequence, 10);
  assert.equal(s3.errorCode, null);

  // Error without code falls back to 'unknown'
  currentTime = 5000;
  currentKey = "key-unknown-err";
  const providerUnknown = createRegistrySnapshotProvider({
    root: "/fake/root",
    readRegistry: () => {
      throw new Error("generic error");
    },
    statRegistry: () => currentKey,
    now: () => currentTime,
  });
  const sUnknown = providerUnknown.get();
  assert.equal(sUnknown.state, "unreadable");
  assert.equal(sUnknown.errorCode, "unknown");
});

test("ok-then-failed ordering: an ok snapshot is never served after a read that failed", () => {
  let currentKey = "key-1";
  let fail = false;

  const provider = createRegistrySnapshotProvider({
    root: "/fake/root",
    readRegistry: () => {
      if (fail) {
        const err = new Error("read failed");
        err.code = "registry_corrupt";
        throw err;
      }
      return {
        state: "ok",
        registry: { sequence: 1, bindings: {} },
      };
    },
    statRegistry: () => currentKey,
    now: () => 1000,
    ttlMs: 2000,
  });

  const sOk = provider.get();
  assert.equal(sOk.state, "ok");

  // Inode changes, second read fails
  currentKey = "key-2";
  fail = true;
  const sFailed = provider.get();
  assert.equal(sFailed.state, "unreadable");
  assert.equal(sFailed.errorCode, "registry_corrupt");

  // Subsequent get() serves the failed snapshot, not the old ok snapshot
  const sSubsequent = provider.get();
  assert.equal(sSubsequent.state, "unreadable");
  assert.equal(sSubsequent, sFailed);
});

test("invalid-result case: neither absent nor ok produces unreadable with invalid_registry_result", () => {
  for (const invalidResult of [
    { state: "corrupt" },
    { state: "unreadable" },
    null,
    undefined,
    "string_result",
    {},
  ]) {
    const provider = createRegistrySnapshotProvider({
      root: "/fake/root",
      readRegistry: () => invalidResult,
      statRegistry: () => "key-test",
      now: () => 1000,
    });
    const snapshot = provider.get();
    assert.equal(snapshot.state, "unreadable");
    assert.equal(snapshot.errorCode, "invalid_registry_result");
    assert.equal(snapshot.sequence, 0);
    assert.deepEqual(snapshot.bindingsFor("agent_any"), []);
    assert.equal(snapshot.bindingForInstance("inst_any"), null);
  }
});

test("deep-frozen snapshots and arrays: mutations are prevented", () => {
  const b = makeBinding("charlie");
  const provider = createRegistrySnapshotProvider({
    root: "/fake/root",
    readRegistry: () => ({
      state: "ok",
      registry: {
        sequence: 3,
        bindings: { [b.profile_instance_id]: b },
      },
    }),
    statRegistry: () => "key-1",
    now: () => 1000,
  });

  const snapshot = provider.get();
  assert.equal(Object.isFrozen(snapshot), true);
  assert.throws(() => {
    snapshot.state = "absent";
  }, TypeError);
  assert.throws(() => {
    snapshot.sequence = 999;
  }, TypeError);

  const bindings = snapshot.bindingsFor(b.principal_id);
  assert.equal(Object.isFrozen(bindings), true);
  assert.throws(() => {
    bindings.push(makeBinding("extra"));
  }, TypeError);

  const bindingItem = snapshot.bindingForInstance(b.profile_instance_id);
  assert.equal(Object.isFrozen(bindingItem), true);
  assert.throws(() => {
    bindingItem.profile_name = "mutated";
  }, TypeError);

  const emptyBindings = snapshot.bindingsFor("unknown_principal");
  assert.equal(Object.isFrozen(emptyBindings), true);
  assert.throws(() => {
    emptyBindings.push(makeBinding("extra"));
  }, TypeError);
});

test("invalidate: drops the cache and forces a re-read", () => {
  let reads = 0;
  const provider = createRegistrySnapshotProvider({
    root: "/fake/root",
    readRegistry: () => {
      reads++;
      return {
        state: "ok",
        registry: { sequence: reads, bindings: {} },
      };
    },
    statRegistry: () => "static-key",
    now: () => 1000,
    ttlMs: 5000,
  });

  const s1 = provider.get();
  assert.equal(reads, 1);
  assert.equal(s1.sequence, 1);

  provider.invalidate();

  const s2 = provider.get();
  assert.equal(reads, 2);
  assert.equal(s2.sequence, 2);
});

test("TypeError cases: invalid root, ttlMs, and helper types throw TypeError", () => {
  assert.throws(() => createRegistrySnapshotProvider({ root: 123 }), TypeError);
  assert.throws(() => createRegistrySnapshotProvider({ root: null }), TypeError);
  assert.throws(() => createRegistrySnapshotProvider({ root: "relative/path" }), TypeError);
  assert.throws(() => createRegistrySnapshotProvider({ root: "" }), TypeError);
  assert.throws(() => createRegistrySnapshotProvider(), TypeError);

  assert.throws(() => createRegistrySnapshotProvider({ root: "/abs", ttlMs: 0 }), TypeError);
  assert.throws(() => createRegistrySnapshotProvider({ root: "/abs", ttlMs: -1 }), TypeError);
  assert.throws(() => createRegistrySnapshotProvider({ root: "/abs", ttlMs: NaN }), TypeError);
  assert.throws(() => createRegistrySnapshotProvider({ root: "/abs", ttlMs: Infinity }), TypeError);
  assert.throws(() => createRegistrySnapshotProvider({ root: "/abs", ttlMs: "2000" }), TypeError);

  assert.throws(() => createRegistrySnapshotProvider({ root: "/abs", readRegistry: "not-a-fn" }), TypeError);
  assert.throws(() => createRegistrySnapshotProvider({ root: "/abs", statRegistry: "not-a-fn" }), TypeError);
  assert.throws(() => createRegistrySnapshotProvider({ root: "/abs", now: "not-a-fn" }), TypeError);
});

test("real-file lifecycle in /private/tmp: absent, updates, inode change, corrupt JSON and restore", () => {
  const base = makeTmpDir("r1-snapshot-lifecycle-");
  try {
    const root = path.join(base, "identity");

    // 1. get() on a root that does not exist leaves it not existing
    const provider = createRegistrySnapshotProvider({ root });
    const s0 = provider.get();
    assert.equal(s0.state, "absent");
    assert.equal(s0.sequence, 0);
    assert.equal(fs.existsSync(root), false);

    // 2. after updateIdentityRegistry binds alpha, get() sees it
    const t1 = "2026-10-25T12:00:00.000Z";
    updateIdentityRegistry({
      root,
      expectedSequence: 0,
      now: t1,
      action: "init",
      subject: null,
      mutate: (r) => r,
    });

    const bAlpha = makeBinding("alpha", { issued_at: "2026-10-25T12:01:00.000Z" });
    updateIdentityRegistry({
      root,
      expectedSequence: 1,
      now: "2026-10-25T12:01:00.000Z",
      action: "bind",
      subject: bAlpha.profile_instance_id,
      mutate: (r) => {
        r.bindings[bAlpha.profile_instance_id] = bAlpha;
        return r;
      },
    });

    const s1 = provider.get();
    assert.equal(s1.state, "ok");
    assert.equal(s1.sequence, 2);
    const alphaBindings = s1.bindingsFor(bAlpha.principal_id);
    assert.equal(alphaBindings.length, 1);
    assert.equal(alphaBindings[0].profile_name, "alpha");
    assert.equal(s1.bindingForInstance(bAlpha.profile_instance_id).profile_name, "alpha");

    // 3. second update binds bravo, seen by next get() without waiting for TTL (inode changes)
    const bBravo = makeBinding("bravo", { issued_at: "2026-10-25T12:02:00.000Z" });
    updateIdentityRegistry({
      root,
      expectedSequence: 2,
      now: "2026-10-25T12:02:00.000Z",
      action: "bind",
      subject: bBravo.profile_instance_id,
      mutate: (r) => {
        r.bindings[bBravo.profile_instance_id] = bBravo;
        return r;
      },
    });

    const s2 = provider.get();
    assert.equal(s2.state, "ok");
    assert.equal(s2.sequence, 3);
    const bravoBindings = s2.bindingsFor(bBravo.principal_id);
    assert.equal(bravoBindings.length, 1);
    assert.equal(bravoBindings[0].profile_name, "bravo");
    assert.equal(s2.bindingForInstance(bBravo.profile_instance_id).profile_name, "bravo");

    // 4. overwriting registry file with invalid JSON gives unreadable with registry_corrupt
    const regFile = path.join(root, REGISTRY_FILE_NAME);
    const validBytes = fs.readFileSync(regFile);
    fs.writeFileSync(regFile, "NOT_VALID_JSON{{{");

    const s3 = provider.get();
    assert.equal(s3.state, "unreadable");
    assert.equal(s3.errorCode, "registry_corrupt");
    assert.equal(s3.sequence, 0);
    assert.deepEqual(s3.bindingsFor(bBravo.principal_id), []);
    assert.equal(s3.bindingForInstance(bBravo.profile_instance_id), null);

    // 5. restoring it gives ok again
    fs.writeFileSync(regFile, validBytes);
    const s4 = provider.get();
    assert.equal(s4.state, "ok");
    assert.equal(s4.sequence, 3);
    assert.equal(s4.bindingForInstance(bBravo.profile_instance_id).profile_name, "bravo");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

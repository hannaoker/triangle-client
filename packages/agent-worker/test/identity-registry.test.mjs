import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import {
  AUDIT_FILE_NAME,
  canonicalJson,
  emptyIdentityRegistry,
  IDENTITY_REGISTRY_SCHEMA,
  LOCAL_PROFILE_BINDING_SCHEMA,
  LOCK_FILE_NAME,
  MAX_AUDIT_BYTES,
  MAX_REGISTRY_BINDINGS,
  MAX_REGISTRY_BYTES,
  readIdentityRegistry,
  REGISTRY_FILE_NAME,
  updateIdentityRegistry,
  validateIdentityRegistry,
  ZERO_HASH_64,
} from "../src/identity-registry.mjs";
import { deriveClientInstanceId } from "../src/installation-inventory.mjs";
import {
  FIXTURE_INSTALLATION_ID,
  secureRegistry,
  writeBinding,
  writeInstallationIdentity,
  writeJson,
} from "./inventory-fixture-helpers.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TMP_BASE = process.platform === "darwin" ? "/private/tmp" : realpathSync("/tmp");

function makeTmpRoot(prefix = "id-reg-test-") {
  const dir = mkdtempSync(path.join(TMP_BASE, prefix));
  chmodSync(dir, 0o700);
  return dir;
}

function hex32(seed) {
  return createHash("sha256").update(String(seed), "utf8").digest("hex").slice(0, 32);
}

function makeValidBinding(profileName = "gravity2", overrides = {}) {
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

function makeValidRegistry(overrides = {}) {
  const b = makeValidBinding("gravity2");
  return {
    schema: IDENTITY_REGISTRY_SCHEMA,
    sequence: 1,
    createdAt: "2026-10-25T10:00:00.000Z",
    updatedAt: "2026-10-25T10:05:00.000Z",
    auditHead: {
      sequence: 1,
      hash: "a".repeat(64),
    },
    bindings: {
      [b.profile_instance_id]: b,
    },
    ...overrides,
  };
}

function assertInvalidRegistry(fn, sentinel = null) {
  let caught = null;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "Expected invalid_registry error to be thrown");
  assert.equal(caught.code, "invalid_registry");
  assert.match(caught.message, /^invalid_registry: [a-z0-9_]+$/);
  if (sentinel !== null) {
    assert.ok(
      !caught.message.includes(sentinel),
      `Error message must never echo caller input (${sentinel}): ${caught.message}`,
    );
  }
}

test("Item 1: emptyIdentityRegistry, canonicalJson, and validateIdentityRegistry positive cases", () => {
  const nowIso = "2026-10-25T12:00:00.000Z";
  const empty = emptyIdentityRegistry({ now: nowIso });
  assert.equal(empty.schema, IDENTITY_REGISTRY_SCHEMA);
  assert.equal(empty.sequence, 0);
  assert.equal(empty.createdAt, nowIso);
  assert.equal(empty.updatedAt, nowIso);
  assert.deepEqual(empty.auditHead, { sequence: 0, hash: ZERO_HASH_64 });
  assert.deepEqual(empty.bindings, {});
  assert.ok(Object.isFrozen(empty));
  assert.ok(Object.isFrozen(empty.auditHead));
  assert.ok(Object.isFrozen(empty.bindings));

  // Accepts numeric epoch or Date or function for now
  const emptyFromNum = emptyIdentityRegistry({ now: Date.parse(nowIso) });
  assert.deepEqual(emptyFromNum, empty);
  const emptyFromFn = emptyIdentityRegistry({ now: () => new Date(nowIso) });
  assert.deepEqual(emptyFromFn, empty);

  // canonicalJson sorts keys at all nesting levels with zero whitespace
  const c1 = canonicalJson({ z: 1, a: { d: true, b: [3, { y: "x", m: null }] } });
  const c2 = canonicalJson({ a: { b: [3, { m: null, y: "x" }], d: true }, z: 1 });
  assert.equal(c1, '{"a":{"b":[3,{"m":null,"y":"x"}],"d":true},"z":1}');
  assert.equal(c1, c2);

  // Valid registry with binding is returned deep-frozen
  const validReg = validateIdentityRegistry(makeValidRegistry());
  assert.ok(Object.isFrozen(validReg));
  const instId = deriveClientInstanceId("gravity2");
  assert.ok(Object.isFrozen(validReg.bindings[instId]));
  assert.ok(Object.isFrozen(validReg.bindings[instId].proof));

  // Valid revoked_at equal to or after issued_at
  const bRevokedEqual = makeValidBinding("gravity2", {
    revoked_at: "2026-10-25T10:00:00.000Z",
  });
  const regEqual = validateIdentityRegistry(
    makeValidRegistry({ bindings: { [instId]: bRevokedEqual } }),
  );
  assert.equal(regEqual.bindings[instId].revoked_at, "2026-10-25T10:00:00.000Z");

  const bRevokedAfter = makeValidBinding("gravity2", {
    revoked_at: "2026-10-25T11:00:00.000Z",
  });
  const regAfter = validateIdentityRegistry(
    makeValidRegistry({ bindings: { [instId]: bRevokedAfter } }),
  );
  assert.equal(regAfter.bindings[instId].revoked_at, "2026-10-25T11:00:00.000Z");
});

test("Item 1: closed-schema and pattern negative cases (never echoing input)", () => {
  const SECRET_SENTINEL = "SENSITIVE_INPUT_PAYLOAD_DO_NOT_ECHO_999";

  // Top-level non-object
  assertInvalidRegistry(() => validateIdentityRegistry(null));
  assertInvalidRegistry(() => validateIdentityRegistry([]));
  assertInvalidRegistry(() => validateIdentityRegistry(SECRET_SENTINEL), SECRET_SENTINEL);

  // Unknown key at top level
  assertInvalidRegistry(
    () => validateIdentityRegistry({ ...makeValidRegistry(), extraKey: SECRET_SENTINEL }),
    SECRET_SENTINEL,
  );

  // Missing key at top level
  for (const key of ["schema", "sequence", "createdAt", "updatedAt", "auditHead", "bindings"]) {
    const copy = makeValidRegistry();
    delete copy[key];
    assertInvalidRegistry(() => validateIdentityRegistry(copy));
  }

  // Wrong schema
  assertInvalidRegistry(
    () => validateIdentityRegistry(makeValidRegistry({ schema: SECRET_SENTINEL })),
    SECRET_SENTINEL,
  );

  // Sequence negative, float, NaN, string
  for (const badSeq of [-1, 1.5, NaN, Infinity, "1", null]) {
    assertInvalidRegistry(() => validateIdentityRegistry(makeValidRegistry({ sequence: badSeq })));
  }

  // Timestamps invalid or updatedAt < createdAt
  for (const badTs of [
    "2026-10-25",
    "2026-02-30T10:00:00.000Z",
    "2026-10-25T10:00:00+00:00",
    SECRET_SENTINEL,
    12345,
    null,
  ]) {
    assertInvalidRegistry(
      () => validateIdentityRegistry(makeValidRegistry({ createdAt: badTs })),
      SECRET_SENTINEL,
    );
    assertInvalidRegistry(
      () => validateIdentityRegistry(makeValidRegistry({ updatedAt: badTs })),
      SECRET_SENTINEL,
    );
  }
  assertInvalidRegistry(() =>
    validateIdentityRegistry(
      makeValidRegistry({
        createdAt: "2026-10-25T12:00:00.000Z",
        updatedAt: "2026-10-25T11:59:59.000Z",
      }),
    ),
  );

  // auditHead unknown key, missing key, sequence mismatch, invalid hash
  assertInvalidRegistry(
    () =>
      validateIdentityRegistry(
        makeValidRegistry({
          auditHead: { sequence: 1, hash: "a".repeat(64), extra: SECRET_SENTINEL },
        }),
      ),
    SECRET_SENTINEL,
  );
  assertInvalidRegistry(() =>
    validateIdentityRegistry(makeValidRegistry({ auditHead: { sequence: 1 } })),
  );
  assertInvalidRegistry(() =>
    validateIdentityRegistry(
      makeValidRegistry({ sequence: 2, auditHead: { sequence: 1, hash: "a".repeat(64) } }),
    ),
  );
  assertInvalidRegistry(
    () =>
      validateIdentityRegistry(
        makeValidRegistry({ auditHead: { sequence: 1, hash: SECRET_SENTINEL } }),
      ),
    SECRET_SENTINEL,
  );
  assertInvalidRegistry(() =>
    validateIdentityRegistry(
      makeValidRegistry({ auditHead: { sequence: 1, hash: "A".repeat(64) } }),
    ),
  );
  assertInvalidRegistry(() =>
    validateIdentityRegistry(
      makeValidRegistry({ sequence: 0, auditHead: { sequence: 0, hash: "a".repeat(64) }, bindings: {} }),
    ),
  );
  assertInvalidRegistry(() =>
    validateIdentityRegistry(
      makeValidRegistry({ sequence: 1, auditHead: { sequence: 1, hash: ZERO_HASH_64 } }),
    ),
  );

  // bindings not plain object
  assertInvalidRegistry(() => validateIdentityRegistry(makeValidRegistry({ bindings: [] })));
  assertInvalidRegistry(() => validateIdentityRegistry(makeValidRegistry({ bindings: null })));

  const instId = deriveClientInstanceId("gravity2");

  // Unknown key on binding
  assertInvalidRegistry(
    () =>
      validateIdentityRegistry(
        makeValidRegistry({
          bindings: { [instId]: { ...makeValidBinding("gravity2"), unknown: SECRET_SENTINEL } },
        }),
      ),
    SECRET_SENTINEL,
  );

  // Missing key on binding
  for (const k of Object.keys(makeValidBinding("gravity2"))) {
    const b = makeValidBinding("gravity2");
    delete b[k];
    assertInvalidRegistry(() =>
      validateIdentityRegistry(makeValidRegistry({ bindings: { [instId]: b } })),
    );
  }

  // Binding schema wrong
  assertInvalidRegistry(
    () =>
      validateIdentityRegistry(
        makeValidRegistry({
          bindings: { [instId]: makeValidBinding("gravity2", { schema: SECRET_SENTINEL }) },
        }),
      ),
    SECRET_SENTINEL,
  );

  // binding_id pattern wrong (uppercase, wrong prefix, wrong length)
  for (const badId of [
    `bind_${"A".repeat(32)}`,
    `bind_${"a".repeat(31)}`,
    `bind_${"a".repeat(33)}`,
    `pair_${"a".repeat(32)}`,
    SECRET_SENTINEL,
  ]) {
    assertInvalidRegistry(
      () =>
        validateIdentityRegistry(
          makeValidRegistry({
            bindings: { [instId]: makeValidBinding("gravity2", { binding_id: badId }) },
          }),
        ),
      SECRET_SENTINEL,
    );
  }

  // trust_mode: "serverless-peer" MUST be rejected in this slice
  for (const badMode of ["serverless-peer", "local", "", null, SECRET_SENTINEL]) {
    assertInvalidRegistry(
      () =>
        validateIdentityRegistry(
          makeValidRegistry({
            bindings: { [instId]: makeValidBinding("gravity2", { trust_mode: badMode }) },
          }),
        ),
      SECRET_SENTINEL,
    );
  }

  // principal_id pattern wrong (peer_*, uppercase, wrong length)
  for (const badPrincipal of [
    `peer_${"a".repeat(32)}`,
    `agent_${"A".repeat(32)}`,
    `agent_${"a".repeat(31)}`,
    SECRET_SENTINEL,
  ]) {
    assertInvalidRegistry(
      () =>
        validateIdentityRegistry(
          makeValidRegistry({
            bindings: { [instId]: makeValidBinding("gravity2", { principal_id: badPrincipal }) },
          }),
        ),
      SECRET_SENTINEL,
    );
  }

  // profile_name invalid
  for (const badProfile of ["", "bad/slash", "bad\\slash", "bad\x00ctrl", "a".repeat(65)]) {
    assertInvalidRegistry(() =>
      validateIdentityRegistry(
        makeValidRegistry({
          bindings: { [instId]: makeValidBinding("gravity2", { profile_name: badProfile }) },
        }),
      ),
    );
  }

  // profile_instance_id not matching deriveClientInstanceId(profile_name) or invalid hex
  const otherInstId = deriveClientInstanceId("other-profile");
  assertInvalidRegistry(() =>
    validateIdentityRegistry(
      makeValidRegistry({
        bindings: {
          [otherInstId]: makeValidBinding("gravity2", { profile_instance_id: otherInstId }),
        },
      }),
    ),
  );
  assertInvalidRegistry(() =>
    validateIdentityRegistry(
      makeValidRegistry({
        bindings: {
          [instId]: makeValidBinding("gravity2", { profile_instance_id: "0".repeat(63) + "G" }),
        },
      }),
    ),
  );

  // bindings map key != binding.profile_instance_id
  assertInvalidRegistry(() =>
    validateIdentityRegistry(
      makeValidRegistry({
        bindings: {
          [otherInstId]: makeValidBinding("gravity2"),
        },
      }),
    ),
  );

  // authority_origin invalid per isValidBareHttpsOrigin
  for (const badOrigin of [
    "http://mesh.example.test",
    "https://mesh.example.test/",
    "https://mesh.example.test/path",
    "https://user:pass@mesh.example.test",
    "https://mesh.example.test?q=1",
    "https://mesh.example.test#frag",
    SECRET_SENTINEL,
  ]) {
    assertInvalidRegistry(
      () =>
        validateIdentityRegistry(
          makeValidRegistry({
            bindings: { [instId]: makeValidBinding("gravity2", { authority_origin: badOrigin }) },
          }),
        ),
      SECRET_SENTINEL,
    );
  }

  // binding_generation < 1 or non-integer
  for (const badGen of [0, -1, 1.5, "1", null]) {
    assertInvalidRegistry(() =>
      validateIdentityRegistry(
        makeValidRegistry({
          bindings: { [instId]: makeValidBinding("gravity2", { binding_generation: badGen }) },
        }),
      ),
    );
  }

  // issued_at / revoked_at invalid, or revoked_at < issued_at
  assertInvalidRegistry(
    () =>
      validateIdentityRegistry(
        makeValidRegistry({
          bindings: { [instId]: makeValidBinding("gravity2", { issued_at: SECRET_SENTINEL }) },
        }),
      ),
    SECRET_SENTINEL,
  );
  assertInvalidRegistry(
    () =>
      validateIdentityRegistry(
        makeValidRegistry({
          bindings: { [instId]: makeValidBinding("gravity2", { revoked_at: SECRET_SENTINEL }) },
        }),
      ),
    SECRET_SENTINEL,
  );
  assertInvalidRegistry(() =>
    validateIdentityRegistry(
      makeValidRegistry({
        bindings: {
          [instId]: makeValidBinding("gravity2", {
            issued_at: "2026-10-25T10:00:00.000Z",
            revoked_at: "2026-10-25T09:59:59.999Z",
          }),
        },
      }),
    ),
  );

  // proof closed schema and exact values
  assertInvalidRegistry(
    () =>
      validateIdentityRegistry(
        makeValidRegistry({
          bindings: {
            [instId]: makeValidBinding("gravity2", {
              proof: {
                kind: "disk_observation",
                observed_on_disk: true,
                verified_live_authority: false,
                extra: SECRET_SENTINEL,
              },
            }),
          },
        }),
      ),
    SECRET_SENTINEL,
  );
  assertInvalidRegistry(() =>
    validateIdentityRegistry(
      makeValidRegistry({
        bindings: {
          [instId]: makeValidBinding("gravity2", {
            proof: { kind: "disk_observation", observed_on_disk: true },
          }),
        },
      }),
    ),
  );
  assertInvalidRegistry(() =>
    validateIdentityRegistry(
      makeValidRegistry({
        bindings: {
          [instId]: makeValidBinding("gravity2", {
            proof: {
              kind: "mesh_dpop_bind_proof",
              observed_on_disk: true,
              verified_live_authority: false,
            },
          }),
        },
      }),
    ),
  );
  assertInvalidRegistry(() =>
    validateIdentityRegistry(
      makeValidRegistry({
        bindings: {
          [instId]: makeValidBinding("gravity2", {
            proof: {
              kind: "disk_observation",
              observed_on_disk: false,
              verified_live_authority: false,
            },
          }),
        },
      }),
    ),
  );
  assertInvalidRegistry(() =>
    validateIdentityRegistry(
      makeValidRegistry({
        bindings: {
          [instId]: makeValidBinding("gravity2", {
            proof: {
              kind: "disk_observation",
              observed_on_disk: true,
              verified_live_authority: true,
            },
          }),
        },
      }),
    ),
  );

  // Duplicate binding_id across two profiles
  const b1 = makeValidBinding("alpha");
  const b2 = makeValidBinding("beta", { binding_id: b1.binding_id });
  assertInvalidRegistry(() =>
    validateIdentityRegistry(
      makeValidRegistry({
        bindings: {
          [b1.profile_instance_id]: b1,
          [b2.profile_instance_id]: b2,
        },
      }),
    ),
  );
});

test("Item 1: max 1,000 bindings and max 1 MiB serialized registry limits", () => {
  // 1,001 bindings rejected
  const manyBindings = {};
  for (let i = 0; i < MAX_REGISTRY_BINDINGS + 1; i++) {
    const name = `prof-${i}`;
    const b = makeValidBinding(name);
    manyBindings[b.profile_instance_id] = b;
  }
  assertInvalidRegistry(() =>
    validateIdentityRegistry(makeValidRegistry({ bindings: manyBindings })),
  );

  // 1,000 bindings with long authority origins exceeding 1 MiB total serialized bytes rejected
  const oversizedBindings = {};
  const longHost = `https://${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(60)}.${"f".repeat(60)}.${"g".repeat(60)}.${"h".repeat(60)}.${"i".repeat(60)}.${"j".repeat(60)}.${"k".repeat(60)}.${"l".repeat(60)}.${"m".repeat(60)}.test`;
  for (let i = 0; i < MAX_REGISTRY_BINDINGS; i++) {
    const name = `p-${i}`;
    const b = makeValidBinding(name, { authority_origin: longHost });
    oversizedBindings[b.profile_instance_id] = b;
  }
  const candidate = makeValidRegistry({ bindings: oversizedBindings });
  assert.ok(Buffer.byteLength(canonicalJson(candidate), "utf8") > MAX_REGISTRY_BYTES);
  assertInvalidRegistry(() => validateIdentityRegistry(candidate));
});

test("Item 2: absent root read, init write, bind, revoke, sequence conflict, and validation prevents writes", () => {
  const base = makeTmpRoot("id-reg-crud-");
  try {
    const root = path.join(base, "identity");

    // 1. Read absent root creates nothing
    const r0 = readIdentityRegistry({ root });
    assert.deepEqual(r0, { state: "absent" });
    assert.equal(existsSync(root), false);

    // 2. Init write
    const t1 = "2026-10-25T12:00:00.000Z";
    const u1 = updateIdentityRegistry({
      root,
      expectedSequence: 0,
      now: t1,
      action: "init",
      subject: null,
      mutate: (reg) => reg,
    });
    assert.equal(u1.registry.sequence, 1);
    assert.equal(u1.registry.createdAt, t1);
    assert.equal(u1.registry.updatedAt, t1);
    assert.equal(u1.auditEntry.sequence, 1);
    assert.equal(u1.auditEntry.action, "init");
    assert.equal(u1.auditEntry.subject, null);
    assert.equal(u1.auditEntry.bindingId, null);
    assert.equal(u1.auditEntry.prevHash, ZERO_HASH_64);
    assert.equal(u1.registry.auditHead.hash, u1.auditEntry.hash);

    // Verify modes on disk
    assert.equal(lstatSync(root).mode & 0o777, 0o700);
    assert.equal(lstatSync(path.join(root, REGISTRY_FILE_NAME)).mode & 0o777, 0o600);
    assert.equal(lstatSync(path.join(root, AUDIT_FILE_NAME)).mode & 0o777, 0o600);
    assert.equal(lstatSync(path.join(root, LOCK_FILE_NAME)).mode & 0o777, 0o600);

    const r1 = readIdentityRegistry({ root });
    assert.equal(r1.state, "ok");
    assert.deepEqual(r1.registry, u1.registry);
    assert.deepEqual(r1.audit, { verifiedThrough: 1, uncommittedTail: 0 });

    // 3. Bind profile
    const t2 = "2026-10-25T12:05:00.000Z";
    const bobBinding = makeValidBinding("bob", { issued_at: t2 });
    const u2 = updateIdentityRegistry({
      root,
      expectedSequence: 1,
      now: t2,
      action: "bind",
      subject: bobBinding.profile_instance_id,
      mutate: (reg) => {
        reg.bindings[bobBinding.profile_instance_id] = bobBinding;
        return reg;
      },
    });
    assert.equal(u2.registry.sequence, 2);
    assert.equal(u2.registry.createdAt, t1);
    assert.equal(u2.registry.updatedAt, t2);
    assert.equal(u2.auditEntry.sequence, 2);
    assert.equal(u2.auditEntry.action, "bind");
    assert.equal(u2.auditEntry.subject, bobBinding.profile_instance_id);
    assert.equal(u2.auditEntry.bindingId, bobBinding.binding_id);
    assert.equal(u2.auditEntry.prevHash, u1.auditEntry.hash);

    // 4. Sequence conflict writes nothing
    const regBytesBefore = readFileSync(path.join(root, REGISTRY_FILE_NAME));
    const auditBytesBefore = readFileSync(path.join(root, AUDIT_FILE_NAME));
    assert.throws(
      () =>
        updateIdentityRegistry({
          root,
          expectedSequence: 1, // stale!
          now: "2026-10-25T12:06:00.000Z",
          action: "bind",
          subject: bobBinding.profile_instance_id,
          mutate: (reg) => reg,
        }),
      (err) => err.code === "registry_sequence_conflict",
    );
    assert.deepEqual(readFileSync(path.join(root, REGISTRY_FILE_NAME)), regBytesBefore);
    assert.deepEqual(readFileSync(path.join(root, AUDIT_FILE_NAME)), auditBytesBefore);

    // 5. Monotonic binding_generation and no-delete enforcement
    assert.throws(
      () =>
        updateIdentityRegistry({
          root,
          expectedSequence: 2,
          now: "2026-10-25T12:07:00.000Z",
          action: "bind",
          subject: bobBinding.profile_instance_id,
          mutate: (reg) => {
            delete reg.bindings[bobBinding.profile_instance_id];
            return reg;
          },
        }),
      (err) => err.code === "invalid_registry",
    );

    // Bump generation to 2, then try decreasing to 1
    const u3 = updateIdentityRegistry({
      root,
      expectedSequence: 2,
      now: "2026-10-25T12:08:00.000Z",
      action: "bind",
      subject: bobBinding.profile_instance_id,
      mutate: (reg) => {
        reg.bindings[bobBinding.profile_instance_id].binding_generation = 2;
        return reg;
      },
    });
    assert.equal(u3.registry.sequence, 3);

    const regBytesAfter3 = readFileSync(path.join(root, REGISTRY_FILE_NAME));
    const auditBytesAfter3 = readFileSync(path.join(root, AUDIT_FILE_NAME));

    assert.throws(
      () =>
        updateIdentityRegistry({
          root,
          expectedSequence: 3,
          now: "2026-10-25T12:09:00.000Z",
          action: "bind",
          subject: bobBinding.profile_instance_id,
          mutate: (reg) => {
            reg.bindings[bobBinding.profile_instance_id].binding_generation = 1;
            return reg;
          },
        }),
      (err) => err.code === "invalid_registry",
    );

    // Mutate attempting to touch sequence, updatedAt or auditHead fails without writing
    assert.throws(
      () =>
        updateIdentityRegistry({
          root,
          expectedSequence: 3,
          now: "2026-10-25T12:09:00.000Z",
          action: "bind",
          subject: bobBinding.profile_instance_id,
          mutate: (reg) => {
            reg.sequence = 99;
            return reg;
          },
        }),
      (err) => err.code === "invalid_registry",
    );
    assert.deepEqual(readFileSync(path.join(root, REGISTRY_FILE_NAME)), regBytesAfter3);
    assert.deepEqual(readFileSync(path.join(root, AUDIT_FILE_NAME)), auditBytesAfter3);

    // 6. Revoke sets revoked_at
    const t4 = "2026-10-25T12:10:00.000Z";
    const u4 = updateIdentityRegistry({
      root,
      expectedSequence: 3,
      now: t4,
      action: "revoke",
      subject: bobBinding.profile_instance_id,
      mutate: (reg) => {
        reg.bindings[bobBinding.profile_instance_id].revoked_at = t4;
        return reg;
      },
    });
    assert.equal(u4.registry.sequence, 4);
    assert.equal(u4.registry.bindings[bobBinding.profile_instance_id].revoked_at, t4);
    assert.equal(u4.auditEntry.action, "revoke");
    assert.equal(u4.auditEntry.subject, bobBinding.profile_instance_id);
    assert.equal(u4.auditEntry.bindingId, bobBinding.binding_id);

    const r4 = readIdentityRegistry({ root });
    assert.equal(r4.state, "ok");
    assert.equal(r4.registry.sequence, 4);
    assert.deepEqual(r4.audit, { verifiedThrough: 4, uncommittedTail: 0 });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("Item 2: crash injection at each point, uncommittedTail recovery, and leftover temp files ignored", () => {
  const base = makeTmpRoot("id-reg-crash-");
  try {
    const root = path.join(base, "identity");
    const t1 = "2026-10-25T13:00:00.000Z";
    const b1 = makeValidBinding("alpha", { issued_at: t1 });

    // 1. Crash BEFORE audit append on absent root -> no registry or audit written
    assert.throws(
      () =>
        updateIdentityRegistry({
          root,
          expectedSequence: 0,
          now: t1,
          action: "init",
          subject: null,
          mutate: (reg) => reg,
          faultHook: (stage) => {
            if (stage === "before_audit_append") {
              throw new Error("simulated_crash_before_audit");
            }
          },
        }),
      /simulated_crash_before_audit/,
    );
    assert.deepEqual(readIdentityRegistry({ root }), { state: "absent" });
    assert.equal(existsSync(path.join(root, AUDIT_FILE_NAME)), false);
    assert.equal(existsSync(path.join(root, REGISTRY_FILE_NAME)), false);

    // 2. Normal init to sequence 1
    updateIdentityRegistry({
      root,
      expectedSequence: 0,
      now: t1,
      action: "init",
      subject: null,
      mutate: (reg) => reg,
    });

    // 3. Crash AFTER audit append (before registry rename) on sequence 1 -> 2
    const t2 = "2026-10-25T13:05:00.000Z";
    assert.throws(
      () =>
        updateIdentityRegistry({
          root,
          expectedSequence: 1,
          now: t2,
          action: "bind",
          subject: b1.profile_instance_id,
          mutate: (reg) => {
            reg.bindings[b1.profile_instance_id] = b1;
            return reg;
          },
          faultHook: (stage) => {
            if (stage === "after_audit_append") {
              throw new Error("simulated_crash_after_audit");
            }
          },
        }),
      /simulated_crash_after_audit/,
    );

    // Read reports uncommittedTail: 1 and ignores the uncommitted line
    const readAfterCrash = readIdentityRegistry({ root });
    assert.equal(readAfterCrash.state, "ok");
    assert.equal(readAfterCrash.registry.sequence, 1);
    assert.deepEqual(readAfterCrash.registry.bindings, {});
    assert.deepEqual(readAfterCrash.audit, {
      verifiedThrough: 1,
      uncommittedTail: 1,
    });

    // Leave a stray leftover temp file in root to verify reads ignore it and never install it
    const leftoverTemp = path.join(root, `${REGISTRY_FILE_NAME}.tmp-99999-deadbeef1234`);
    writeFileSync(leftoverTemp, '{"corrupt":true}\n', { mode: 0o600 });

    const readWithLeftover = readIdentityRegistry({ root });
    assert.equal(readWithLeftover.state, "ok");
    assert.equal(readWithLeftover.registry.sequence, 1);
    assert.equal(readWithLeftover.audit.uncommittedTail, 1);

    // Next locked update truncates the uncommitted tail line and appends its own line cleanly
    const t3 = "2026-10-25T13:10:00.000Z";
    const recovered = updateIdentityRegistry({
      root,
      expectedSequence: 1,
      now: t3,
      action: "bind",
      subject: b1.profile_instance_id,
      mutate: (reg) => {
        reg.bindings[b1.profile_instance_id] = b1;
        return reg;
      },
    });
    assert.equal(recovered.registry.sequence, 2);
    assert.equal(recovered.auditEntry.sequence, 2);
    assert.equal(recovered.auditEntry.at, t3);

    const readAfterRecover = readIdentityRegistry({ root });
    assert.equal(readAfterRecover.state, "ok");
    assert.equal(readAfterRecover.registry.sequence, 2);
    assert.deepEqual(readAfterRecover.audit, {
      verifiedThrough: 2,
      uncommittedTail: 0,
    });
    const auditLines = readFileSync(path.join(root, AUDIT_FILE_NAME), "utf8")
      .trim()
      .split("\n");
    assert.equal(auditLines.length, 2);

    // 4. Crash AFTER registry rename (after commit point) -> update is committed!
    const t4 = "2026-10-25T13:15:00.000Z";
    assert.throws(
      () =>
        updateIdentityRegistry({
          root,
          expectedSequence: 2,
          now: t4,
          action: "revoke",
          subject: b1.profile_instance_id,
          mutate: (reg) => {
            reg.bindings[b1.profile_instance_id].revoked_at = t4;
            return reg;
          },
          faultHook: (stage) => {
            if (stage === "after_registry_rename") {
              throw new Error("simulated_crash_after_rename");
            }
          },
        }),
      /simulated_crash_after_rename/,
    );

    const readAfterPostCommitCrash = readIdentityRegistry({ root });
    assert.equal(readAfterPostCommitCrash.state, "ok");
    assert.equal(readAfterPostCommitCrash.registry.sequence, 3);
    assert.equal(readAfterPostCommitCrash.registry.bindings[b1.profile_instance_id].revoked_at, t4);
    assert.deepEqual(readAfterPostCommitCrash.audit, {
      verifiedThrough: 3,
      uncommittedTail: 0,
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("Item 2: concurrent writers (one wins, the other gets registry_sequence_conflict or registry_busy)", async () => {
  const base = makeTmpRoot("id-reg-concurrent-");
  try {
    const root = path.join(base, "identity");
    const t0 = "2026-10-25T14:00:00.000Z";
    updateIdentityRegistry({
      root,
      expectedSequence: 0,
      now: t0,
      action: "init",
      subject: null,
      mutate: (reg) => reg,
    });

    const workerScript = `
      import { parentPort, workerData } from "node:worker_threads";
      import { updateIdentityRegistry } from ${JSON.stringify(
        path.join(REPO_ROOT, "packages/agent-worker/src/identity-registry.mjs"),
      )};

      try {
        const res = updateIdentityRegistry({
          root: workerData.root,
          expectedSequence: 1,
          now: workerData.now,
          action: "bind",
          subject: workerData.binding.profile_instance_id,
          lockTimeoutMs: workerData.lockTimeoutMs,
          mutate: (reg) => {
            const end = Date.now() + workerData.holdMs;
            while (Date.now() < end) {}
            reg.bindings[workerData.binding.profile_instance_id] = workerData.binding;
            return reg;
          },
        });
        parentPort.postMessage({ ok: true, sequence: res.registry.sequence });
      } catch (err) {
        parentPort.postMessage({ ok: false, code: err.code });
      }
    `;

    function runWriter(profileName, holdMs, lockTimeoutMs) {
      return new Promise((resolve, reject) => {
        const worker = new Worker(workerScript, {
          eval: true,
          workerData: {
            root,
            now: "2026-10-25T14:05:00.000Z",
            binding: makeValidBinding(profileName, { issued_at: "2026-10-25T14:05:00.000Z" }),
            holdMs,
            lockTimeoutMs,
          },
        });
        worker.on("message", resolve);
        worker.on("error", reject);
      });
    }

    // Case A: Both wait long enough for lock; first commits seq 2, second sees seq 2 !== expectedSequence 1 -> registry_sequence_conflict
    const [resA1, resA2] = await Promise.all([
      runWriter("alpha", 50, 5000),
      runWriter("beta", 50, 5000),
    ]);
    const successesA = [resA1, resA2].filter((r) => r.ok);
    const failuresA = [resA1, resA2].filter((r) => !r.ok);
    assert.equal(successesA.length, 1);
    assert.equal(failuresA.length, 1);
    assert.equal(failuresA[0].code, "registry_sequence_conflict");

    // Case B: One holds the lock longer than the second writer's lock timeout -> registry_busy
    const bGamma = makeValidBinding("gamma", { issued_at: "2026-10-25T14:10:00.000Z" });
    const busyWorkerScript = `
      import { parentPort, workerData } from "node:worker_threads";
      import { updateIdentityRegistry } from ${JSON.stringify(
        path.join(REPO_ROOT, "packages/agent-worker/src/identity-registry.mjs"),
      )};
      try {
        updateIdentityRegistry({
          root: workerData.root,
          expectedSequence: 2,
          now: "2026-10-25T14:10:00.000Z",
          action: "bind",
          subject: workerData.binding.profile_instance_id,
          mutate: (reg) => {
            parentPort.postMessage({ locked: true });
            const buf = new Int32Array(workerData.sab);
            Atomics.wait(buf, 0, 0, 2000);
            reg.bindings[workerData.binding.profile_instance_id] = workerData.binding;
            return reg;
          },
        });
        parentPort.postMessage({ done: true });
      } catch (err) {
        parentPort.postMessage({ error: err.code });
      }
    `;
    const sab = new SharedArrayBuffer(4);
    const sabView = new Int32Array(sab);
    const holder = new Worker(busyWorkerScript, {
      eval: true,
      workerData: { root, binding: bGamma, sab },
    });

    await new Promise((resolve) => {
      holder.on("message", (msg) => {
        if (msg.locked) resolve();
      });
    });

    assert.throws(
      () =>
        updateIdentityRegistry({
          root,
          expectedSequence: 2,
          now: "2026-10-25T14:10:00.000Z",
          action: "bind",
          subject: bGamma.profile_instance_id,
          lockTimeoutMs: 120,
          mutate: (reg) => reg,
        }),
      (err) => err.code === "registry_busy",
    );

    // Release holder
    Atomics.store(sabView, 0, 1);
    Atomics.notify(sabView, 0);
    await new Promise((resolve) => {
      holder.on("message", (msg) => {
        if (msg.done || msg.error) resolve();
      });
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("Item 2: custody safety checks (symlink, hard link, wrong mode, non-directory root) rejected without modification", () => {
  const base = makeTmpRoot("id-reg-custody-");
  try {
    // 1. Relative path or non-normalized root path rejected
    for (const badPath of ["relative/path", "", null]) {
      assert.throws(
        () => readIdentityRegistry({ root: badPath }),
        (err) => err.code === "registry_unsafe",
      );
    }

    // 2. Non-directory root (regular file) rejected without modification
    const fileRoot = path.join(base, "not-a-dir");
    writeFileSync(fileRoot, "plain-file\n", { mode: 0o600 });
    assert.throws(
      () => readIdentityRegistry({ root: fileRoot }),
      (err) => err.code === "registry_unsafe",
    );
    assert.throws(
      () =>
        updateIdentityRegistry({
          root: fileRoot,
          expectedSequence: 0,
          now: "2026-10-25T12:00:00.000Z",
          action: "init",
          subject: null,
          mutate: (r) => r,
        }),
      (err) => err.code === "registry_unsafe",
    );
    assert.equal(readFileSync(fileRoot, "utf8"), "plain-file\n");
    assert.equal(lstatSync(fileRoot).mode & 0o777, 0o600);

    // 3. Symlink root rejected without modification
    const realTarget = path.join(base, "real-target");
    mkdirSync(realTarget, { mode: 0o700 });
    const symlinkRoot = path.join(base, "symlink-root");
    symlinkSync(realTarget, symlinkRoot);
    assert.throws(
      () => readIdentityRegistry({ root: symlinkRoot }),
      (err) => err.code === "registry_unsafe",
    );
    assert.throws(
      () =>
        updateIdentityRegistry({
          root: symlinkRoot,
          expectedSequence: 0,
          now: "2026-10-25T12:00:00.000Z",
          action: "init",
          subject: null,
          mutate: (r) => r,
        }),
      (err) => err.code === "registry_unsafe",
    );
    assert.deepEqual(readdirSync(realTarget), []);

    // 4. Wrong directory mode (0755) rejected without chmod/repair
    const modeRoot = path.join(base, "wrong-dir-mode");
    mkdirSync(modeRoot, { mode: 0o755 });
    chmodSync(modeRoot, 0o755);
    assert.throws(
      () => readIdentityRegistry({ root: modeRoot }),
      (err) => err.code === "registry_unsafe",
    );
    assert.throws(
      () =>
        updateIdentityRegistry({
          root: modeRoot,
          expectedSequence: 0,
          now: "2026-10-25T12:00:00.000Z",
          action: "init",
          subject: null,
          mutate: (r) => r,
        }),
      (err) => err.code === "registry_unsafe",
    );
    assert.equal(lstatSync(modeRoot).mode & 0o777, 0o755);

    // 5. Valid root initialized, then test file custody violations (wrong file mode, hard link, symlink)
    const root = path.join(base, "valid-root");
    updateIdentityRegistry({
      root,
      expectedSequence: 0,
      now: "2026-10-25T12:00:00.000Z",
      action: "init",
      subject: null,
      mutate: (r) => r,
    });
    const regFile = path.join(root, REGISTRY_FILE_NAME);
    const auditFile = path.join(root, AUDIT_FILE_NAME);

    // 5a. Wrong file mode (0644) -> rejected without repair
    chmodSync(regFile, 0o644);
    assert.throws(
      () => readIdentityRegistry({ root }),
      (err) => err.code === "registry_unsafe",
    );
    assert.equal(lstatSync(regFile).mode & 0o777, 0o644);
    chmodSync(regFile, 0o600);
    assert.equal(readIdentityRegistry({ root }).state, "ok");

    // 5b. Hard link on registry file (nlink === 2) -> rejected
    const hardLinkPath = path.join(base, "reg-hardlink.json");
    linkSync(regFile, hardLinkPath);
    assert.throws(
      () => readIdentityRegistry({ root }),
      (err) => err.code === "registry_unsafe",
    );
    rmSync(hardLinkPath);
    assert.equal(readIdentityRegistry({ root }).state, "ok");

    // 5c. Hard link on audit file (nlink === 2) -> rejected
    const auditHardLink = path.join(base, "audit-hardlink.jsonl");
    linkSync(auditFile, auditHardLink);
    assert.throws(
      () => readIdentityRegistry({ root }),
      (err) => err.code === "registry_unsafe",
    );
    rmSync(auditHardLink);
    assert.equal(readIdentityRegistry({ root }).state, "ok");

    // 5d. Symlink inside root -> rejected
    const straySymlink = path.join(root, "stray-link");
    symlinkSync(regFile, straySymlink);
    assert.throws(
      () => readIdentityRegistry({ root }),
      (err) => err.code === "registry_unsafe",
    );
    rmSync(straySymlink);
    assert.equal(readIdentityRegistry({ root }).state, "ok");

    // 5e. Corrupt JSON in registry file -> registry_corrupt
    const goodRegBytes = readFileSync(regFile);
    writeFileSync(regFile, "{corrupt json\n", { mode: 0o600 });
    chmodSync(regFile, 0o600);
    assert.throws(
      () => readIdentityRegistry({ root }),
      (err) => err.code === "registry_corrupt",
    );
    writeFileSync(regFile, goodRegBytes, { mode: 0o600 });
    chmodSync(regFile, 0o600);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("Item 3: audit chain verification detects edited, removed, reordered, duplicated, or truncated lines, head mismatch, and 8 MiB limit", () => {
  const base = makeTmpRoot("id-reg-audit-");
  try {
    const root = path.join(base, "identity");
    const t1 = "2026-10-25T15:00:00.000Z";
    const t2 = "2026-10-25T15:01:00.000Z";
    const t3 = "2026-10-25T15:02:00.000Z";
    const bAlpha = makeValidBinding("alpha", { issued_at: t2 });
    const bBeta = makeValidBinding("beta", { issued_at: t3 });

    updateIdentityRegistry({
      root,
      expectedSequence: 0,
      now: t1,
      action: "init",
      subject: null,
      mutate: (r) => r,
    });
    updateIdentityRegistry({
      root,
      expectedSequence: 1,
      now: t2,
      action: "bind",
      subject: bAlpha.profile_instance_id,
      mutate: (r) => {
        r.bindings[bAlpha.profile_instance_id] = bAlpha;
        return r;
      },
    });
    updateIdentityRegistry({
      root,
      expectedSequence: 2,
      now: t3,
      action: "bind",
      subject: bBeta.profile_instance_id,
      mutate: (r) => {
        r.bindings[bBeta.profile_instance_id] = bBeta;
        return r;
      },
    });

    const regPath = path.join(root, REGISTRY_FILE_NAME);
    const auditPath = path.join(root, AUDIT_FILE_NAME);
    const validAuditText = readFileSync(auditPath, "utf8");
    const validRegText = readFileSync(regPath, "utf8");
    const lines = validAuditText.trim().split("\n");
    assert.equal(lines.length, 3);

    const restore = () => {
      writeFileSync(auditPath, validAuditText, { mode: 0o600 });
      chmodSync(auditPath, 0o600);
      writeFileSync(regPath, validRegText, { mode: 0o600 });
      chmodSync(regPath, 0o600);
    };

    // 1. Edited line (timestamp modified in line 2)
    const editedLine2 = JSON.parse(lines[1]);
    editedLine2.at = "2026-10-25T15:01:01.000Z";
    writeFileSync(auditPath, `${[lines[0], canonicalJson(editedLine2), lines[2]].join("\n")}\n`, {
      mode: 0o600,
    });
    assert.throws(
      () => readIdentityRegistry({ root }),
      (err) => err.code === "registry_chain_broken",
    );
    restore();

    // 2. Removed line (line 2 removed)
    writeFileSync(auditPath, `${[lines[0], lines[2]].join("\n")}\n`, { mode: 0o600 });
    assert.throws(
      () => readIdentityRegistry({ root }),
      (err) => err.code === "registry_chain_broken",
    );
    restore();

    // 3. Reordered lines (lines 2 and 3 swapped)
    writeFileSync(auditPath, `${[lines[0], lines[2], lines[1]].join("\n")}\n`, { mode: 0o600 });
    assert.throws(
      () => readIdentityRegistry({ root }),
      (err) => err.code === "registry_chain_broken",
    );
    restore();

    // 4. Duplicated line (line 3 duplicated)
    writeFileSync(auditPath, `${[lines[0], lines[1], lines[2], lines[2]].join("\n")}\n`, {
      mode: 0o600,
    });
    assert.throws(
      () => readIdentityRegistry({ root }),
      (err) => err.code === "registry_chain_broken",
    );
    restore();

    // 5. Truncated line (missing trailing newline / cut mid-JSON)
    writeFileSync(auditPath, validAuditText.slice(0, -10), { mode: 0o600 });
    assert.throws(
      () => readIdentityRegistry({ root }),
      (err) => err.code === "registry_chain_broken",
    );
    restore();

    // 6. Head mismatch (registry auditHead.hash differs from committed audit entry)
    const regObj = JSON.parse(validRegText);
    regObj.auditHead.hash = "f".repeat(64);
    writeFileSync(regPath, `${canonicalJson(regObj)}\n`, { mode: 0o600 });
    assert.throws(
      () => readIdentityRegistry({ root }),
      (err) => err.code === "registry_chain_broken",
    );
    restore();

    // 7. Two uncommitted lines beyond auditHead -> registry_chain_broken
    const e3 = JSON.parse(lines[2]);
    const e4WithoutHash = {
      sequence: 4,
      at: "2026-10-25T15:03:00.000Z",
      action: "revoke",
      subject: bBeta.profile_instance_id,
      bindingId: bBeta.binding_id,
      prevHash: e3.hash,
    };
    const e4 = {
      ...e4WithoutHash,
      hash: createHash("sha256").update(canonicalJson(e4WithoutHash)).digest("hex"),
    };
    const e5WithoutHash = {
      sequence: 5,
      at: "2026-10-25T15:04:00.000Z",
      action: "revoke",
      subject: bAlpha.profile_instance_id,
      bindingId: bAlpha.binding_id,
      prevHash: e4.hash,
    };
    const e5 = {
      ...e5WithoutHash,
      hash: createHash("sha256").update(canonicalJson(e5WithoutHash)).digest("hex"),
    };
    writeFileSync(
      auditPath,
      `${[lines[0], lines[1], lines[2], canonicalJson(e4), canonicalJson(e5)].join("\n")}\n`,
      { mode: 0o600 },
    );
    assert.throws(
      () => readIdentityRegistry({ root }),
      (err) => err.code === "registry_chain_broken",
    );
    restore();

    // 8. Audit file 8 MiB limit -> updates fail with registry_audit_full when projected size > 8 MiB
    // Pad an uncommitted tail up to > 8 MiB is not needed; instead we test that when committedByteLength + newLine > MAX_AUDIT_BYTES,
    // or if we mock/check the exact 8 MiB boundary:
    // Let's construct a valid registry state at sequence 1 whose committedByteLength is near 8 MiB by testing the limit check.
    // Even better: in a fresh directory, create a valid 1-entry registry, or test the 8 MiB cap by appending or pre-populating.
    // Wait: every audit entry is ~260 bytes. Can we generate a valid chain or test MAX_AUDIT_BYTES?
    // Let's check how fast we can build an 8 MiB valid audit file in memory:
    // 8 MiB / 270 bytes ≈ 31,000 lines. In JS, 31,000 SHA-256 hashes take ~45ms!
    const fullRoot = path.join(base, "audit-full-root");
    mkdirSync(fullRoot, { mode: 0o700 });
    const fullChunks = [];
    let totalBytes = 0;
    let seq = 0;
    let prev = ZERO_HASH_64;
    const subj = bAlpha.profile_instance_id;
    const bindId = bAlpha.binding_id;

    while (totalBytes + 300 <= MAX_AUDIT_BYTES) {
      seq += 1;
      const action = seq === 1 ? "init" : "bind";
      const withoutHash = {
        sequence: seq,
        at: "2026-10-25T15:00:00.000Z",
        action,
        subject: seq === 1 ? null : subj,
        bindingId: seq === 1 ? null : bindId,
        prevHash: prev,
      };
      const jsonNoHash = `{"action":"${action}","at":"2026-10-25T15:00:00.000Z","bindingId":${
        seq === 1 ? "null" : `"${bindId}"`
      },"prevHash":"${prev}","sequence":${seq},"subject":${
        seq === 1 ? "null" : `"${subj}"`
      }}`;
      const h = createHash("sha256").update(jsonNoHash, "utf8").digest("hex");
      const line = `{"action":"${action}","at":"2026-10-25T15:00:00.000Z","bindingId":${
        seq === 1 ? "null" : `"${bindId}"`
      },"hash":"${h}","prevHash":"${prev}","sequence":${seq},"subject":${
        seq === 1 ? "null" : `"${subj}"`
      }}\n`;
      const len = Buffer.byteLength(line, "utf8");
      if (totalBytes + len > MAX_AUDIT_BYTES) {
        seq -= 1;
        break;
      }
      fullChunks.push(line);
      totalBytes += len;
      prev = h;
    }

    const fullAuditPath = path.join(fullRoot, AUDIT_FILE_NAME);
    const fullRegPath = path.join(fullRoot, REGISTRY_FILE_NAME);
    writeFileSync(fullAuditPath, fullChunks.join(""), { mode: 0o600 });
    chmodSync(fullAuditPath, 0o600);

    const fullReg = {
      schema: IDENTITY_REGISTRY_SCHEMA,
      sequence: seq,
      createdAt: "2026-10-25T15:00:00.000Z",
      updatedAt: "2026-10-25T15:00:00.000Z",
      auditHead: {
        sequence: seq,
        hash: prev,
      },
      bindings: {
        [subj]: bAlpha,
      },
    };
    writeFileSync(fullRegPath, `${canonicalJson(fullReg)}\n`, { mode: 0o600 });
    chmodSync(fullRegPath, 0o600);

    // Reading at <= 8 MiB succeeds
    const readFull = readIdentityRegistry({ root: fullRoot });
    assert.equal(readFull.state, "ok");
    assert.equal(readFull.registry.sequence, seq);

    // Updating past 8 MiB fails with registry_audit_full and leaves both files untouched
    const regBeforeFull = readFileSync(fullRegPath);
    const auditBeforeFull = readFileSync(fullAuditPath);
    assert.throws(
      () =>
        updateIdentityRegistry({
          root: fullRoot,
          expectedSequence: seq,
          now: "2026-10-25T16:00:00.000Z",
          action: "revoke",
          subject: subj,
          mutate: (r) => {
            r.bindings[subj].revoked_at = "2026-10-25T16:00:00.000Z";
            return r;
          },
        }),
      (err) => err.code === "registry_audit_full",
    );
    assert.deepEqual(readFileSync(fullRegPath), regBeforeFull);
    assert.deepEqual(readFileSync(fullAuditPath), auditBeforeFull);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("Item 4: boundaries (no network, no process spawn, nothing outside root, leaves profiles-v1 and client untouched, deterministic bytes)", () => {
  const base = makeTmpRoot("id-reg-boundaries-");
  try {
    // Build a combined fixture with `The Triangle/client`, `The Triangle/profiles-v1`, `triangle-home`, and `identity`
    const app = path.join(base, "The Triangle");
    const client = path.join(app, "client");
    const identityRoot = path.join(app, "identity");

    for (const profile of ["bob", "gravity2"]) {
      const instanceId = deriveClientInstanceId(profile);
      writeJson(path.join(client, "instances", `${instanceId}.json`), {
        version: 1,
        instanceId,
        profile,
        runtimeAdapter: "codex",
        enabled: true,
        deliveryMode: "worker",
      });
      writeBinding(app, profile);
    }
    writeInstallationIdentity(client, FIXTURE_INSTALLATION_ID);
    secureRegistry(app);

    function snapshotTree(dir) {
      const out = [];
      function walk(current) {
        const st = lstatSync(current);
        const rel = path.relative(dir, current) || ".";
        out.push({
          rel,
          mode: st.mode & 0o777,
          size: st.size,
          mtimeNs: st.mtimeNs,
          hash: st.isFile()
            ? createHash("sha256").update(readFileSync(current)).digest("hex")
            : null,
        });
        if (st.isDirectory()) {
          for (const entry of readdirSync(current).sort()) {
            walk(path.join(current, entry));
          }
        }
      }
      walk(dir);
      return out;
    }

    const clientBefore = snapshotTree(client);
    const profilesBefore = snapshotTree(path.join(app, "profiles-v1"));
    const homeBefore = snapshotTree(path.join(base, "triangle-home"));

    // Trap network and child_process entry points
    const origFetch = globalThis.fetch;
    const origNetConnect = net.connect;
    const origNetCreateConnection = net.createConnection;
    const origNetSocketConnect = net.Socket.prototype.connect;
    const origHttpRequest = http.request;
    const origHttpGet = http.get;
    const origHttpsRequest = https.request;
    const origHttpsGet = https.get;
    const origSpawn = childProcess.spawn;
    const origSpawnSync = childProcess.spawnSync;
    const origExec = childProcess.exec;
    const origExecSync = childProcess.execSync;
    const origExecFile = childProcess.execFile;
    const origExecFileSync = childProcess.execFileSync;
    const origFork = childProcess.fork;

    const trap = (name) => () => {
      throw new Error(`Forbidden boundary call: ${name}`);
    };

    globalThis.fetch = trap("fetch");
    net.connect = trap("net.connect");
    net.createConnection = trap("net.createConnection");
    net.Socket.prototype.connect = trap("net.Socket.prototype.connect");
    http.request = trap("http.request");
    http.get = trap("http.get");
    https.request = trap("https.request");
    https.get = trap("https.get");
    childProcess.spawn = trap("child_process.spawn");
    childProcess.spawnSync = trap("child_process.spawnSync");
    childProcess.exec = trap("child_process.exec");
    childProcess.execSync = trap("child_process.execSync");
    childProcess.execFile = trap("child_process.execFile");
    childProcess.execFileSync = trap("child_process.execFileSync");
    childProcess.fork = trap("child_process.fork");

    try {
      const bBob = makeValidBinding("bob", { issued_at: "2026-10-25T16:00:00.000Z" });
      const bGrav = makeValidBinding("gravity2", { issued_at: "2026-10-25T16:01:00.000Z" });

      assert.deepEqual(readIdentityRegistry({ root: identityRoot }), { state: "absent" });

      updateIdentityRegistry({
        root: identityRoot,
        expectedSequence: 0,
        now: "2026-10-25T16:00:00.000Z",
        action: "init",
        subject: null,
        mutate: (r) => r,
      });
      updateIdentityRegistry({
        root: identityRoot,
        expectedSequence: 1,
        now: "2026-10-25T16:00:00.000Z",
        action: "bind",
        subject: bBob.profile_instance_id,
        mutate: (r) => {
          r.bindings[bBob.profile_instance_id] = bBob;
          return r;
        },
      });
      updateIdentityRegistry({
        root: identityRoot,
        expectedSequence: 2,
        now: "2026-10-25T16:01:00.000Z",
        action: "bind",
        subject: bGrav.profile_instance_id,
        mutate: (r) => {
          r.bindings[bGrav.profile_instance_id] = bGrav;
          return r;
        },
      });

      const readRes = readIdentityRegistry({ root: identityRoot });
      assert.equal(readRes.state, "ok");
      assert.equal(readRes.registry.sequence, 3);

      // Replicate the exact same sequence in a second root with reversed object key insertion order
      const identityRoot2 = path.join(base, "identity-replica");
      updateIdentityRegistry({
        root: identityRoot2,
        expectedSequence: 0,
        now: "2026-10-25T16:00:00.000Z",
        action: "init",
        subject: null,
        mutate: (r) => r,
      });
      updateIdentityRegistry({
        root: identityRoot2,
        expectedSequence: 1,
        now: "2026-10-25T16:00:00.000Z",
        action: "bind",
        subject: bBob.profile_instance_id,
        mutate: (r) => {
          // Insert keys in reverse order to test deterministic canonical serialization
          r.bindings[bBob.profile_instance_id] = Object.fromEntries(
            Object.entries(bBob).reverse(),
          );
          return r;
        },
      });
      updateIdentityRegistry({
        root: identityRoot2,
        expectedSequence: 2,
        now: "2026-10-25T16:01:00.000Z",
        action: "bind",
        subject: bGrav.profile_instance_id,
        mutate: (r) => {
          r.bindings[bGrav.profile_instance_id] = Object.fromEntries(
            Object.entries(bGrav).reverse(),
          );
          return r;
        },
      });

      // Deterministic byte-identical files
      assert.deepEqual(
        readFileSync(path.join(identityRoot, REGISTRY_FILE_NAME)),
        readFileSync(path.join(identityRoot2, REGISTRY_FILE_NAME)),
      );
      assert.deepEqual(
        readFileSync(path.join(identityRoot, AUDIT_FILE_NAME)),
        readFileSync(path.join(identityRoot2, AUDIT_FILE_NAME)),
      );
    } finally {
      globalThis.fetch = origFetch;
      net.connect = origNetConnect;
      net.createConnection = origNetCreateConnection;
      net.Socket.prototype.connect = origNetSocketConnect;
      http.request = origHttpRequest;
      http.get = origHttpGet;
      https.request = origHttpsRequest;
      https.get = origHttpsGet;
      childProcess.spawn = origSpawn;
      childProcess.spawnSync = origSpawnSync;
      childProcess.exec = origExec;
      childProcess.execSync = origExecSync;
      childProcess.execFile = origExecFile;
      childProcess.execFileSync = origExecFileSync;
      childProcess.fork = origFork;
    }

    // Verify client, profiles-v1, and triangle-home are 100% untouched (including mtimeNs)
    assert.deepEqual(snapshotTree(client), clientBefore);
    assert.deepEqual(snapshotTree(path.join(app, "profiles-v1")), profilesBefore);
    assert.deepEqual(snapshotTree(path.join(base, "triangle-home")), homeBefore);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("Item 4: source-level isolation — no file under packages/*/src other than identity-registry.mjs imports it", () => {
  const packagesDir = path.join(REPO_ROOT, "packages");
  const selfFile = path.join(REPO_ROOT, "packages/agent-worker/src/identity-registry.mjs");
  const offending = [];

  function walkSrc(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkSrc(full);
      } else if (entry.isFile() && /\.(mjs|cjs|js|ts)$/.test(entry.name)) {
        if (full === selfFile) continue;
        const content = readFileSync(full, "utf8");
        if (content.includes("identity-registry")) {
          offending.push(path.relative(REPO_ROOT, full));
        }
      }
    }
  }

  for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
    if (pkg.isDirectory()) {
      walkSrc(path.join(packagesDir, pkg.name, "src"));
    }
  }

  assert.deepEqual(
    offending,
    [],
    `No production source file may import identity-registry.mjs in this slice, found: ${offending.join(", ")}`,
  );
});

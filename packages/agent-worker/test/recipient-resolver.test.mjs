import assert from "node:assert/strict";
import test from "node:test";

import { resolveRecipient } from "../src/recipient-resolver.mjs";

function deepFreeze(obj) {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  for (const val of Object.values(obj)) {
    if (val !== null && typeof val === "object") {
      deepFreeze(val);
    }
  }
  return Object.freeze(obj);
}

const INSTANCE_A = "1111111111111111111111111111111111111111111111111111111111111111";
const INSTANCE_B = "2222222222222222222222222222222222222222222222222222222222222222";
const INSTANCE_C = "3333333333333333333333333333333333333333333333333333333333333333";
const INSTANCE_FOREIGN = "9999999999999999999999999999999999999999999999999999999999999999";

const AGENT_ID_1 = "agent_0123456789abcdef0123456789abcdef";
const AGENT_ID_2 = "agent_fedcba9876543210fedcba9876543210";
const PEER_ID_1 = "peer_0123456789abcdef0123456789abcdef";

const SAMPLE_RECIPIENTS = [
  { id: INSTANCE_A, label: "profile-alpha" },
  { id: INSTANCE_B, label: "profile-beta" },
  { id: INSTANCE_C, label: "profile-gamma" },
];

test("Rule 1: non-principal-shaped to passes through (table-driven)", () => {
  const nonPrincipals = [
    // profile names
    "gravity2",
    "main",
    "worker-1",
    "Profile_With.Dots-And_Underscores",
    // 64-hex instance id
    INSTANCE_A,
    INSTANCE_B,
    // session address
    `session-${INSTANCE_A}`,
    // malformed / look-alikes
    "agent_abc",
    "agent_0123456789abcdef0123456789abcdef0", // 33 hex
    "agent_0123456789abcdef0123456789abcde", // 31 hex
    "agent_0123456789abcdef0123456789abcdeg", // invalid hex character 'g'
    "agent_0123456789ABCDEF0123456789abcdef", // uppercase hex
    "AGENT_0123456789abcdef0123456789abcdef", // uppercase prefix
    "agent_",
    "peer_abc",
    "peer_0123456789abcdef0123456789abcdef0",
    "peer_0123456789abcdef0123456789abcde",
    "peer_0123456789ABCDEF0123456789abcdef",
    "PEER_0123456789abcdef0123456789abcdef",
    "peer_",
    "",
    "   ",
  ];

  for (const to of nonPrincipals) {
    const res = resolveRecipient({
      to,
      recipients: SAMPLE_RECIPIENTS,
      snapshot: { state: "unreadable" }, // snapshot state must not matter
    });
    assert.deepEqual(res, { kind: "pass_through" });
    assert.equal(Object.isFrozen(res), true);
  }
});

test("Rule 2: peer_ IDs fail with recipient_not_found (peer_not_supported) and never touch snapshot", () => {
  let snapshotTouched = false;
  const throwingSnapshot = {
    get state() {
      snapshotTouched = true;
      throw new Error("snapshot accessed for peer ID!");
    },
    bindingsFor() {
      snapshotTouched = true;
      throw new Error("snapshot accessed for peer ID!");
    },
  };

  const res = resolveRecipient({
    to: PEER_ID_1,
    recipients: SAMPLE_RECIPIENTS,
    snapshot: throwingSnapshot,
  });

  assert.equal(snapshotTouched, false, "snapshot must not be accessed for peer IDs");
  assert.deepEqual(res, {
    kind: "error",
    code: "recipient_not_found",
    reason: "peer_not_supported",
    candidates: [],
  });
  assert.equal(Object.isFrozen(res), true);
  assert.equal(Object.isFrozen(res.candidates), true);
});

test("Rule 3: agent_ ID with snapshot state 'absent' fails with recipient_not_found (registry_absent)", () => {
  const res = resolveRecipient({
    to: AGENT_ID_1,
    recipients: SAMPLE_RECIPIENTS,
    snapshot: { state: "absent" },
  });

  assert.deepEqual(res, {
    kind: "error",
    code: "recipient_not_found",
    reason: "registry_absent",
    candidates: [],
  });
  assert.equal(Object.isFrozen(res), true);
  assert.equal(Object.isFrozen(res.candidates), true);
});

test("Rule 4: snapshot state unreadable, invalid, missing or throwing fails closed (route_unavailable, registry_unreadable)", () => {
  const invalidSnapshots = [
    { state: "unreadable" },
    { state: "corrupt" },
    { state: "pending" },
    { state: "error" },
    { state: null },
    { state: undefined },
    {},
    null,
    undefined,
    {
      state: "ok",
      // bindingsFor is missing
    },
    {
      state: "ok",
      bindingsFor: "not-a-function",
    },
    {
      state: "ok",
      bindingsFor() {
        throw new Error("fs or lock error during bindingsFor");
      },
    },
  ];

  for (const snapshot of invalidSnapshots) {
    const res = resolveRecipient({
      to: AGENT_ID_1,
      recipients: SAMPLE_RECIPIENTS,
      snapshot,
    });
    assert.deepEqual(
      res,
      {
        kind: "error",
        code: "route_unavailable",
        reason: "registry_unreadable",
        candidates: [],
      },
      `failed closed for snapshot: ${JSON.stringify(snapshot)}`
    );
    assert.equal(Object.isFrozen(res), true);
    assert.equal(Object.isFrozen(res.candidates), true);
  }
});

test("Rule 5: state ok with no bindings gives recipient_not_found (no_binding)", () => {
  const resEmpty = resolveRecipient({
    to: AGENT_ID_1,
    recipients: SAMPLE_RECIPIENTS,
    snapshot: {
      state: "ok",
      bindingsFor: () => [],
    },
  });

  assert.deepEqual(resEmpty, {
    kind: "error",
    code: "recipient_not_found",
    reason: "no_binding",
    candidates: [],
  });
});

test("Rule 5: revoked or non-mesh-managed bindings are defensively ignored", () => {
  const snapshotWithRevokedOrUntrusted = {
    state: "ok",
    bindingsFor: (principalId) => [
      {
        schema: "local_profile_binding_v1",
        binding_id: "bind_11111111111111111111111111111111",
        trust_mode: "mesh-managed",
        principal_id: principalId,
        profile_instance_id: INSTANCE_A,
        revoked_at: "2026-10-25T12:00:00Z", // revoked!
      },
      {
        schema: "local_profile_binding_v1",
        binding_id: "bind_22222222222222222222222222222222",
        trust_mode: "pinned", // not mesh-managed!
        principal_id: principalId,
        profile_instance_id: INSTANCE_B,
        revoked_at: null,
      },
    ],
  };

  const res = resolveRecipient({
    to: AGENT_ID_1,
    recipients: SAMPLE_RECIPIENTS,
    snapshot: snapshotWithRevokedOrUntrusted,
  });

  // Since all candidate bindings are ignored, outcome is no_binding
  assert.deepEqual(res, {
    kind: "error",
    code: "recipient_not_found",
    reason: "no_binding",
    candidates: [],
  });
});

test("Rule 5: unrevoked binding whose profile is not a local recipient gives route_unavailable (not_a_local_recipient)", () => {
  const snapshotForeign = {
    state: "ok",
    bindingsFor: (principalId) => [
      {
        schema: "local_profile_binding_v1",
        binding_id: "bind_99999999999999999999999999999999",
        trust_mode: "mesh-managed",
        principal_id: principalId,
        profile_instance_id: INSTANCE_FOREIGN, // not in SAMPLE_RECIPIENTS
        revoked_at: null,
      },
    ],
  };

  const res = resolveRecipient({
    to: AGENT_ID_1,
    recipients: SAMPLE_RECIPIENTS,
    snapshot: snapshotForeign,
  });

  assert.deepEqual(res, {
    kind: "error",
    code: "route_unavailable",
    reason: "not_a_local_recipient",
    candidates: [],
  });
});

test("Rule 5: exactly one valid binding for a local recipient resolves successfully", () => {
  const snapshot = {
    state: "ok",
    bindingsFor: (principalId) => [
      {
        schema: "local_profile_binding_v1",
        binding_id: "bind_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        trust_mode: "mesh-managed",
        principal_id: principalId,
        profile_instance_id: INSTANCE_A,
        profile_name: "ignored_raw_profile_name_from_registry",
        revoked_at: null,
      },
      // along with a foreign profile binding that doesn't match local recipients
      {
        schema: "local_profile_binding_v1",
        binding_id: "bind_ffffffffffffffffffffffffffffffff",
        trust_mode: "mesh-managed",
        principal_id: principalId,
        profile_instance_id: INSTANCE_FOREIGN,
        revoked_at: null,
      },
      // and a revoked binding for instance B
      {
        schema: "local_profile_binding_v1",
        binding_id: "bind_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        trust_mode: "mesh-managed",
        principal_id: principalId,
        profile_instance_id: INSTANCE_B,
        revoked_at: "2026-10-25T10:00:00Z",
      },
    ],
  };

  const res = resolveRecipient({
    to: AGENT_ID_1,
    recipients: SAMPLE_RECIPIENTS,
    snapshot,
  });

  assert.deepEqual(res, {
    kind: "resolved",
    via: "principal",
    recipientId: INSTANCE_A,
    principalId: AGENT_ID_1,
    profile: "profile-alpha", // from recipients[0].label
    bindingId: "bind_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  assert.equal(Object.isFrozen(res), true);
});

test("Rule 5: multiple local recipient bindings give recipient_ambiguous with sorted candidates", () => {
  const snapshot = {
    state: "ok",
    bindingsFor: (principalId) => [
      // Provided in non-sorted order (B then A)
      {
        schema: "local_profile_binding_v1",
        binding_id: "bind_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        trust_mode: "mesh-managed",
        principal_id: principalId,
        profile_instance_id: INSTANCE_B,
        revoked_at: null,
      },
      {
        schema: "local_profile_binding_v1",
        binding_id: "bind_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        trust_mode: "mesh-managed",
        principal_id: principalId,
        profile_instance_id: INSTANCE_A,
        revoked_at: null,
      },
      // and foreign non-recipient binding
      {
        schema: "local_profile_binding_v1",
        binding_id: "bind_ffffffffffffffffffffffffffffffff",
        trust_mode: "mesh-managed",
        principal_id: principalId,
        profile_instance_id: INSTANCE_FOREIGN,
        revoked_at: null,
      },
    ],
  };

  const res = resolveRecipient({
    to: AGENT_ID_1,
    recipients: SAMPLE_RECIPIENTS,
    snapshot,
  });

  assert.deepEqual(res, {
    kind: "error",
    code: "recipient_ambiguous",
    reason: "ambiguous_binding",
    candidates: [
      { id: INSTANCE_A, label: "profile-alpha" },
      { id: INSTANCE_B, label: "profile-beta" },
    ],
  });
  assert.equal(Object.isFrozen(res), true);
  assert.equal(Object.isFrozen(res.candidates), true);
  assert.equal(Object.isFrozen(res.candidates[0]), true);
  assert.equal(Object.isFrozen(res.candidates[1]), true);
});

test("Determinism when recipients list is shuffled", () => {
  const bindingA = {
    schema: "local_profile_binding_v1",
    binding_id: "bind_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    trust_mode: "mesh-managed",
    principal_id: AGENT_ID_1,
    profile_instance_id: INSTANCE_A,
    revoked_at: null,
  };
  const bindingB = {
    schema: "local_profile_binding_v1",
    binding_id: "bind_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    trust_mode: "mesh-managed",
    principal_id: AGENT_ID_1,
    profile_instance_id: INSTANCE_B,
    revoked_at: null,
  };
  const bindingC = {
    schema: "local_profile_binding_v1",
    binding_id: "bind_cccccccccccccccccccccccccccccccc",
    trust_mode: "mesh-managed",
    principal_id: AGENT_ID_1,
    profile_instance_id: INSTANCE_C,
    revoked_at: null,
  };

  const snapshot = {
    state: "ok",
    bindingsFor: () => [bindingC, bindingA, bindingB],
  };

  const permutation1 = [
    { id: INSTANCE_A, label: "profile-alpha" },
    { id: INSTANCE_B, label: "profile-beta" },
    { id: INSTANCE_C, label: "profile-gamma" },
  ];
  const permutation2 = [
    { id: INSTANCE_C, label: "profile-gamma" },
    { id: INSTANCE_A, label: "profile-alpha" },
    { id: INSTANCE_B, label: "profile-beta" },
  ];
  const permutation3 = [
    { id: INSTANCE_B, label: "profile-beta" },
    { id: INSTANCE_C, label: "profile-gamma" },
    { id: INSTANCE_A, label: "profile-alpha" },
  ];

  const res1 = resolveRecipient({ to: AGENT_ID_1, recipients: permutation1, snapshot });
  const res2 = resolveRecipient({ to: AGENT_ID_1, recipients: permutation2, snapshot });
  const res3 = resolveRecipient({ to: AGENT_ID_1, recipients: permutation3, snapshot });

  assert.deepEqual(res1, res2);
  assert.deepEqual(res2, res3);
  assert.deepEqual(res1.candidates, [
    { id: INSTANCE_A, label: "profile-alpha" },
    { id: INSTANCE_B, label: "profile-beta" },
    { id: INSTANCE_C, label: "profile-gamma" },
  ]);
});

test("Immutability: inputs deep-frozen by test and never mutated", () => {
  const frozenRecipients = deepFreeze([
    { id: INSTANCE_A, label: "profile-alpha" },
    { id: INSTANCE_B, label: "profile-beta" },
  ]);

  const frozenBindings = deepFreeze([
    {
      schema: "local_profile_binding_v1",
      binding_id: "bind_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      trust_mode: "mesh-managed",
      principal_id: AGENT_ID_1,
      profile_instance_id: INSTANCE_A,
      revoked_at: null,
    },
    {
      schema: "local_profile_binding_v1",
      binding_id: "bind_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      trust_mode: "mesh-managed",
      principal_id: AGENT_ID_1,
      profile_instance_id: INSTANCE_B,
      revoked_at: null,
    },
  ]);

  const frozenSnapshot = deepFreeze({
    state: "ok",
    bindingsFor: () => frozenBindings,
  });

  const res = resolveRecipient({
    to: AGENT_ID_1,
    recipients: frozenRecipients,
    snapshot: frozenSnapshot,
  });

  assert.equal(res.kind, "recipient_ambiguous" in res ? "recipient_ambiguous" : "error");
  assert.equal(res.code, "recipient_ambiguous");
  assert.equal(res.reason, "ambiguous_binding");
});

test("Freshness: every call produces a distinct new deep-frozen object", () => {
  const snapshot = {
    state: "ok",
    bindingsFor: () => [
      {
        binding_id: "bind_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        trust_mode: "mesh-managed",
        principal_id: AGENT_ID_1,
        profile_instance_id: INSTANCE_A,
        revoked_at: null,
      },
    ],
  };

  const res1 = resolveRecipient({ to: AGENT_ID_1, recipients: SAMPLE_RECIPIENTS, snapshot });
  const res2 = resolveRecipient({ to: AGENT_ID_1, recipients: SAMPLE_RECIPIENTS, snapshot });

  assert.notEqual(res1, res2);
  assert.deepEqual(res1, res2);

  const pt1 = resolveRecipient({ to: "legacy", recipients: [] });
  const pt2 = resolveRecipient({ to: "legacy", recipients: [] });
  assert.notEqual(pt1, pt2);
  assert.deepEqual(pt1, pt2);

  const err1 = resolveRecipient({ to: PEER_ID_1, recipients: [] });
  const err2 = resolveRecipient({ to: PEER_ID_1, recipients: [] });
  assert.notEqual(err1, err2);
  assert.notEqual(err1.candidates, err2.candidates);
  assert.deepEqual(err1, err2);
});

test("Result purity: never leaks registry free text or to value", () => {
  const snapshot = {
    state: "ok",
    bindingsFor: () => [
      {
        binding_id: "bind_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        trust_mode: "mesh-managed",
        principal_id: AGENT_ID_1,
        profile_instance_id: INSTANCE_A,
        profile_name: "should_not_leak_profile_name",
        authority_origin: "https://mesh.example.com/secret",
        proof: { secret_signature: "secret_data" },
        revoked_at: null,
      },
    ],
  };

  const res = resolveRecipient({
    to: AGENT_ID_1,
    recipients: [{ id: INSTANCE_A, label: "local-label" }],
    snapshot,
  });

  const keys = Object.keys(res).sort();
  assert.deepEqual(keys, ["bindingId", "kind", "principalId", "profile", "recipientId", "via"].sort());
  assert.equal(res.profile, "local-label");
  assert.equal("to" in res, false);
  assert.equal("profile_name" in res, false);
  assert.equal("authority_origin" in res, false);
  assert.equal("proof" in res, false);
});

test("Invalid arguments throw TypeError (table-driven)", () => {
  const invalidOptions = [
    undefined,
    null,
    123,
    "string",
    // non-string to
    { to: undefined, recipients: [] },
    { to: null, recipients: [] },
    { to: 123, recipients: [] },
    { to: {}, recipients: [] },
    { to: [], recipients: [] },
    // non-array recipients
    { to: "legacy", recipients: undefined },
    { to: "legacy", recipients: null },
    { to: "legacy", recipients: {} },
    { to: "legacy", recipients: "not-array" },
    { to: "legacy", recipients: 123 },
    // invalid recipient entries
    { to: "legacy", recipients: [null] },
    { to: "legacy", recipients: [undefined] },
    { to: "legacy", recipients: ["not-an-object"] },
    { to: "legacy", recipients: [123] },
    // id not 64-hex lowercase
    { to: "legacy", recipients: [{ id: 123, label: "lbl" }] },
    { to: "legacy", recipients: [{ id: null, label: "lbl" }] },
    { to: "legacy", recipients: [{ id: "short", label: "lbl" }] },
    { to: "legacy", recipients: [{ id: "A".repeat(64), label: "lbl" }] }, // uppercase
    { to: "legacy", recipients: [{ id: "1".repeat(63), label: "lbl" }] }, // 63 chars
    { to: "legacy", recipients: [{ id: "1".repeat(65), label: "lbl" }] }, // 65 chars
    { to: "legacy", recipients: [{ id: "g".repeat(64), label: "lbl" }] }, // invalid hex
    // label not string
    { to: "legacy", recipients: [{ id: INSTANCE_A, label: 123 }] },
    { to: "legacy", recipients: [{ id: INSTANCE_A, label: null }] },
    { to: "legacy", recipients: [{ id: INSTANCE_A, label: undefined }] },
    { to: "legacy", recipients: [{ id: INSTANCE_A, label: {} }] },
    { to: "legacy", recipients: [{ id: INSTANCE_A }] }, // label missing
  ];

  for (const opts of invalidOptions) {
    assert.throws(
      () => resolveRecipient(opts),
      { name: "TypeError" },
      `Expected TypeError for options: ${JSON.stringify(opts)}`
    );
  }
});

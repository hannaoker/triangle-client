import test from "node:test";
import assert from "node:assert/strict";
import { buildIdentityInventory } from "../src/identity-inventory.mjs";
import { buildIdentityView } from "../src/identity-view.mjs";
import { deriveClientInstanceId } from "../src/installation-inventory.mjs";

function makeInventory({
  identities = [],
  unmappedProfiles = [],
  diagnostics = [],
} = {}) {
  return {
    schema: "identity_inventory_v1",
    scope: "host-local",
    summary: {
      identityCount: identities.length,
      unmappedProfileCount: unmappedProfiles.length,
      sessionCount: 0,
      faultCount: diagnostics.filter((d) => d.severity === "fault").length,
      warningCount: diagnostics.filter((d) => d.severity === "warning").length,
      omittedHealthDiagnosticCount: 0,
    },
    identities,
    unmappedProfiles,
    sessions: [],
    diagnostics,
  };
}

test("Item 3: row states — recorded, not_recorded, blocked, local_only, recorded_only", () => {
  const bobInst = deriveClientInstanceId("bob");
  const aliceInst = deriveClientInstanceId("alice");
  const charlieInst = deriveClientInstanceId("charlie");
  const localInst = deriveClientInstanceId("local-one");
  const orphanInst = "3333333333333333333333333333333333333333333333333333333333333333";

  const inventory = makeInventory({
    identities: [
      {
        principalId: "agent_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        authorityOrigin: "https://example.test",
        kind: "mesh-managed",
        profiles: [
          {
            profile: "bob",
            instanceId: bobInst,
            enabled: true,
            status: "ok",
          },
        ],
      },
      {
        principalId: "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        authorityOrigin: "https://example.test",
        kind: "mesh-managed",
        profiles: [
          {
            profile: "alice",
            instanceId: aliceInst,
            enabled: true,
            status: "ok",
          },
        ],
      },
      {
        principalId: "agent_cccccccccccccccccccccccccccccccc",
        authorityOrigin: "https://example.test",
        kind: "mesh-managed",
        profiles: [
          {
            profile: "charlie",
            instanceId: charlieInst,
            enabled: true,
            status: "ok",
          },
        ],
      },
    ],
    unmappedProfiles: [
      {
        profile: "local-one",
        instanceId: localInst,
        enabled: true,
        status: "ok",
        reason: "unbound_local_profile",
      },
    ],
    diagnostics: [
      {
        severity: "fault",
        code: "custody_fault",
        profile: "charlie",
        message: "Custody fault on charlie",
      },
    ],
  });

  const registry = {
    state: "ok",
    registry: {
      sequence: 5,
      bindings: {
        [bobInst]: {
          schema: "local_profile_binding_v1",
          binding_id: "bind_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          trust_mode: "mesh-managed",
          principal_id: "agent_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          profile_name: "bob",
          profile_instance_id: bobInst,
          authority_origin: "https://example.test",
          binding_generation: 2,
          revoked_at: null,
          proof: { kind: "disk_observation", observed_on_disk: true, verified_live_authority: false },
        },
        [orphanInst]: {
          schema: "local_profile_binding_v1",
          binding_id: "bind_oooooooooooooooooooooooooooooooo",
          trust_mode: "mesh-managed",
          principal_id: "agent_oooooooooooooooooooooooooooooooo",
          profile_name: "orphan-recorded",
          profile_instance_id: orphanInst,
          authority_origin: "https://example.test",
          binding_generation: 1,
          revoked_at: null,
          proof: { kind: "disk_observation", observed_on_disk: true, verified_live_authority: false },
        },
      },
    },
    audit: {
      verifiedThrough: 5,
      uncommittedTail: 0,
    },
  };

  const view = buildIdentityView({ inventory, registry });

  assert.equal(view.schema, "identity_view_v1");
  assert.equal(view.registry.state, "ok");
  assert.equal(view.registry.sequence, 5);
  assert.equal(view.registry.auditVerifiedThrough, 5);
  assert.equal(view.registry.auditUncommittedTail, 0);
  assert.equal(view.registry.errorCode, null);

  assert.equal(view.summary.profiles, 5);
  assert.equal(view.summary.recorded, 1);
  assert.equal(view.summary.notRecorded, 1);
  assert.equal(view.summary.blocked, 1);
  assert.equal(view.summary.localOnly, 1);
  assert.equal(view.summary.recordedOnly, 1);

  // Rows sorted by profile, then profileInstanceId
  assert.deepEqual(
    view.profiles.map((p) => ({ profile: p.profile, state: p.state })),
    [
      { profile: "alice", state: "not_recorded" },
      { profile: "bob", state: "recorded" },
      { profile: "charlie", state: "blocked" },
      { profile: "local-one", state: "local_only" },
      { profile: "orphan-recorded", state: "recorded_only" },
    ]
  );

  // recorded row fields
  const bobRow = view.profiles.find((p) => p.profile === "bob");
  assert.equal(bobRow.principalId, "agent_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(bobRow.authorityOrigin, "https://example.test");
  assert.equal(bobRow.bindingId, "bind_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(bobRow.generation, 2);
  assert.equal(bobRow.reason, null);

  // not_recorded row fields
  const aliceRow = view.profiles.find((p) => p.profile === "alice");
  assert.equal(aliceRow.principalId, "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(aliceRow.authorityOrigin, "https://example.test");
  assert.equal(aliceRow.bindingId, null);
  assert.equal(aliceRow.generation, null);
  assert.equal(aliceRow.reason, null);

  // blocked row fields
  const charlieRow = view.profiles.find((p) => p.profile === "charlie");
  assert.equal(charlieRow.principalId, "agent_cccccccccccccccccccccccccccccccc");
  assert.equal(charlieRow.authorityOrigin, "https://example.test");
  assert.equal(charlieRow.reason, "custody_fault");

  // local_only row fields
  const localRow = view.profiles.find((p) => p.profile === "local-one");
  assert.equal(localRow.principalId, null);
  assert.equal(localRow.authorityOrigin, null);
  assert.equal(localRow.bindingId, null);
  assert.equal(localRow.generation, null);
  assert.equal(localRow.reason, null);

  // recorded_only row fields
  const orphanRow = view.profiles.find((p) => p.profile === "orphan-recorded");
  assert.equal(orphanRow.principalId, "agent_oooooooooooooooooooooooooooooooo");
  assert.equal(orphanRow.authorityOrigin, "https://example.test");
  assert.equal(orphanRow.bindingId, "bind_oooooooooooooooooooooooooooooooo");
  assert.equal(orphanRow.generation, 1);
  assert.equal(orphanRow.reason, null);
});

test("Item 3: diagnostics — registry unreadable, unfinished write, not recorded, blocked, recorded missing, and passthrough", () => {
  const aliceInst = deriveClientInstanceId("alice");
  const bobInst = deriveClientInstanceId("bob");
  const charlieInst = deriveClientInstanceId("charlie");
  const orphanInst = "4444444444444444444444444444444444444444444444444444444444444444";

  // Unreadable registry
  const inv1 = makeInventory({
    identities: [
      {
        principalId: "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        authorityOrigin: "https://example.test",
        kind: "mesh-managed",
        profiles: [{ profile: "alice", instanceId: aliceInst, enabled: true }],
      },
    ],
    diagnostics: [
      {
        severity: "warning",
        code: "unregistered_binding",
        profile: "ghost",
        message: "Ghost binding on disk",
      },
    ],
  });

  const unreadableRegistry = {
    state: "unreadable",
    code: "registry_corrupt",
  };

  const view1 = buildIdentityView({ inventory: inv1, registry: unreadableRegistry });
  assert.equal(view1.registry.state, "unreadable");
  assert.equal(view1.registry.errorCode, "registry_corrupt");

  const unreadableDiag = view1.diagnostics.find((d) => d.code === "registry_unreadable");
  assert.ok(unreadableDiag);
  assert.equal(unreadableDiag.severity, "fault");
  assert.equal(unreadableDiag.profile, null);
  assert.equal(unreadableDiag.message, "The identity registry could not be read (registry_corrupt).");
  assert.equal(unreadableDiag.action, "Do not edit the files by hand. Restore the registry directory from a backup.");

  // Passthrough diagnostic (unregistered_binding)
  const passDiag = view1.diagnostics.find((d) => d.code === "unregistered_binding");
  assert.ok(passDiag);
  assert.equal(passDiag.severity, "warning");
  assert.equal(passDiag.profile, "ghost");
  assert.equal(passDiag.message, "Ghost binding on disk");
  assert.equal(passDiag.action, null);

  // Unfinished write warning + not_recorded warning + blocked fault/warning + recorded_only warning
  const inv2 = makeInventory({
    identities: [
      {
        principalId: "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        authorityOrigin: "https://example.test",
        kind: "mesh-managed",
        profiles: [{ profile: "alice", instanceId: aliceInst, enabled: true }],
      },
      {
        principalId: "agent_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        authorityOrigin: "https://example.test",
        kind: "mesh-managed",
        profiles: [{ profile: "bob", instanceId: bobInst, enabled: true }],
      },
      {
        principalId: "agent_cccccccccccccccccccccccccccccccc",
        authorityOrigin: "https://example.test",
        kind: "mesh-managed",
        profiles: [{ profile: "charlie", instanceId: charlieInst, enabled: true }],
      },
    ],
    diagnostics: [
      {
        severity: "fault",
        code: "malformed_record",
        profile: "bob",
        message: "Malformed bob",
      },
      {
        severity: "warning",
        code: "ambiguous_mapping",
        profile: "charlie",
        message: "Ambiguous charlie",
      },
    ],
  });

  const registry2 = {
    state: "ok",
    registry: {
      sequence: 1,
      bindings: {
        [orphanInst]: {
          schema: "local_profile_binding_v1",
          binding_id: "bind_44444444444444444444444444444444",
          trust_mode: "mesh-managed",
          principal_id: "agent_44444444444444444444444444444444",
          profile_name: "missing-local",
          profile_instance_id: orphanInst,
          authority_origin: "https://example.test",
          binding_generation: 1,
          revoked_at: null,
          proof: { kind: "disk_observation", observed_on_disk: true, verified_live_authority: false },
        },
      },
    },
    audit: {
      verifiedThrough: 1,
      uncommittedTail: 1,
    },
  };

  const view2 = buildIdentityView({ inventory: inv2, registry: registry2 });

  // registry_unfinished_write
  const unfinishedDiag = view2.diagnostics.find((d) => d.code === "registry_unfinished_write");
  assert.ok(unfinishedDiag);
  assert.equal(unfinishedDiag.severity, "warning");
  assert.equal(unfinishedDiag.profile, null);
  assert.equal(unfinishedDiag.message, "An interrupted write left an unfinished audit line.");
  assert.equal(unfinishedDiag.action, "The next registry update repairs it.");

  // identity_not_recorded
  const notRecDiag = view2.diagnostics.find((d) => d.code === "identity_not_recorded");
  assert.ok(notRecDiag);
  assert.equal(notRecDiag.severity, "warning");
  assert.equal(notRecDiag.profile, null);
  assert.equal(notRecDiag.message, "1 profile(s) have a valid MESH binding on disk and no recorded identity binding.");
  assert.equal(notRecDiag.action, "Run triangle identity migrate and review the plan.");

  // identity_blocked for bob (fault for malformed_record)
  const bobBlockedDiag = view2.diagnostics.find((d) => d.code === "identity_blocked" && d.profile === "bob");
  assert.ok(bobBlockedDiag);
  assert.equal(bobBlockedDiag.severity, "fault");
  assert.equal(bobBlockedDiag.message, "Profile bob is blocked: malformed_record.");

  // identity_blocked for charlie (warning for ambiguous_mapping)
  const charlieBlockedDiag = view2.diagnostics.find((d) => d.code === "identity_blocked" && d.profile === "charlie");
  assert.ok(charlieBlockedDiag);
  assert.equal(charlieBlockedDiag.severity, "warning");
  assert.equal(charlieBlockedDiag.message, "Profile charlie is blocked: ambiguous_mapping.");

  // recorded_profile_missing
  const recMissingDiag = view2.diagnostics.find((d) => d.code === "recorded_profile_missing");
  assert.ok(recMissingDiag);
  assert.equal(recMissingDiag.severity, "warning");
  assert.equal(recMissingDiag.message, "A recorded binding has no local profile.");

  // Verify diagnostic sorting: faults first, then code, then profile, then message
  for (let i = 0; i < view2.diagnostics.length - 1; i += 1) {
    const cur = view2.diagnostics[i];
    const nxt = view2.diagnostics[i + 1];
    const curSev = cur.severity === "fault" ? 0 : 1;
    const nxtSev = nxt.severity === "fault" ? 0 : 1;
    assert.ok(curSev <= nxtSev, "Faults must sort before warnings");
  }
});

test("Item 3: determinism under reordered inputs, deep-frozen, no mutation, secret-free", () => {
  const SECRET_KEY = "SECRET_ED25519_KEY_SHOULD_NEVER_APPEAR_IN_VIEW";
  const SECRET_TOKEN = "BEARER_TOKEN_SHOULD_NEVER_APPEAR_IN_VIEW";

  const p1Inst = deriveClientInstanceId("p1");
  const p2Inst = deriveClientInstanceId("p2");

  const invA = makeInventory({
    identities: [
      {
        principalId: "agent_11111111111111111111111111111111",
        authorityOrigin: "https://example.test",
        kind: "mesh-managed",
        profiles: [{ profile: "p1", instanceId: p1Inst, enabled: true }],
      },
      {
        principalId: "agent_22222222222222222222222222222222",
        authorityOrigin: "https://example.test",
        kind: "mesh-managed",
        profiles: [{ profile: "p2", instanceId: p2Inst, enabled: true }],
      },
    ],
  });

  const invB = makeInventory({
    identities: [
      {
        principalId: "agent_22222222222222222222222222222222",
        authorityOrigin: "https://example.test",
        kind: "mesh-managed",
        profiles: [{ profile: "p2", instanceId: p2Inst, enabled: true }],
      },
      {
        principalId: "agent_11111111111111111111111111111111",
        authorityOrigin: "https://example.test",
        kind: "mesh-managed",
        profiles: [{ profile: "p1", instanceId: p1Inst, enabled: true }],
      },
    ],
  });

  // Inject accidental secret fields in inputs
  invA.privateKey = SECRET_KEY;
  invB.token = SECRET_TOKEN;

  const invASnapshot = JSON.stringify(invA);
  const invBSnapshot = JSON.stringify(invB);

  const viewA = buildIdentityView({ inventory: invA, registry: { state: "absent" } });
  const viewB = buildIdentityView({ inventory: invB, registry: { state: "absent" } });

  // Determinism
  assert.equal(JSON.stringify(viewA), JSON.stringify(viewB));

  // Immutability of inputs
  assert.equal(JSON.stringify(invA), invASnapshot);
  assert.equal(JSON.stringify(invB), invBSnapshot);

  // Deep-frozen output
  assert.ok(Object.isFrozen(viewA));
  assert.ok(Object.isFrozen(viewA.registry));
  assert.ok(Object.isFrozen(viewA.summary));
  assert.ok(Object.isFrozen(viewA.profiles));
  assert.ok(Object.isFrozen(viewA.profiles[0]));
  assert.ok(Object.isFrozen(viewA.diagnostics));

  assert.throws(() => {
    viewA.summary.profiles = 999;
  }, TypeError);
  assert.throws(() => {
    viewA.profiles.push({});
  }, TypeError);

  // Secret-free
  const serialized = JSON.stringify(viewA);
  assert.ok(!serialized.includes(SECRET_KEY));
  assert.ok(!serialized.includes(SECRET_TOKEN));
});

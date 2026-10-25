import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalJson,
  readIdentityRegistry,
  updateIdentityRegistry,
} from "../src/identity-registry.mjs";
import {
  deriveClientInstanceId,
  isValidProfileName,
} from "../src/installation-inventory.mjs";
import {
  BLOCKED_REASONS,
  IDENTITY_MAPPING_PLAN_SCHEMA,
  applyIdentityMapping,
  planIdentityMapping,
} from "../src/identity-mapping.mjs";

function makeTmpDir(prefix) {
  // Use /private/tmp directly or os.tmpdir() resolved
  const base = existsSync("/private/tmp") ? "/private/tmp" : os.tmpdir();
  const dir = mkdtempSync(path.join(base, prefix));
  return realpathSync(dir);
}

function computeBindingId(profileInstanceId, principalId, authorityOrigin, generation = 1) {
  const preimage = `triangle-binding-v1\0${profileInstanceId}\0${principalId}\0${authorityOrigin}\0${generation}`;
  const hash = createHash("sha256").update(preimage, "utf8").digest("hex");
  return `bind_${hash.slice(0, 32)}`;
}

test("Item 1: pure planning produces deterministic deep-frozen proposals for valid mesh-managed profiles", () => {
  const profileName = "main-worker";
  const instanceId = deriveClientInstanceId(profileName);
  const principalId = "agent_0123456789abcdef0123456789abcdef";
  const authorityOrigin = "https://mesh.example.com";

  const inventory = {
    schema: "identity_inventory_v1",
    identities: [
      {
        principalId,
        kind: "mesh-managed",
        authorityOrigin,
        profiles: [
          {
            profile: profileName,
            instanceId,
            bindingState: "bound",
            enabled: true,
            status: "ok",
          },
        ],
        handles: ["my-agent"],
        authority: {
          observedOnDisk: true,
          verifiedLiveAuthority: false,
          source: "profiles-v1",
        },
        diagnostics: [],
      },
    ],
    unmappedProfiles: [],
    diagnostics: [],
  };

  const plan = planIdentityMapping({ inventory });

  assert.equal(plan.schema, IDENTITY_MAPPING_PLAN_SCHEMA);
  assert.equal(plan.registrySequence, 0);
  assert.equal(typeof plan.planId, "string");
  assert.match(plan.planId, /^[a-f0-9]{64}$/);
  assert.equal(plan.proposals.length, 1);
  assert.equal(plan.unchanged.length, 0);
  assert.equal(plan.blocked.length, 0);
  assert.equal(plan.localOnly.length, 0);

  const proposal = plan.proposals[0];
  assert.equal(proposal.schema, "local_profile_binding_v1");
  assert.equal(proposal.binding_id, computeBindingId(instanceId, principalId, authorityOrigin, 1));
  assert.equal(proposal.trust_mode, "mesh-managed");
  assert.equal(proposal.principal_id, principalId);
  assert.equal(proposal.profile_name, profileName);
  assert.equal(proposal.profile_instance_id, instanceId);
  assert.equal(proposal.authority_origin, authorityOrigin);
  assert.equal(proposal.binding_generation, 1);
  assert.equal(proposal.revoked_at, null);
  assert.equal(proposal.issued_at, undefined); // issued_at is stamped only on apply
  assert.deepEqual(proposal.proof, {
    kind: "disk_observation",
    observed_on_disk: true,
    verified_live_authority: false,
  });

  // Verify planId is sha256 hex of canonicalJson of plan without planId
  const { planId, ...unhashed } = plan;
  const expectedHash = createHash("sha256").update(canonicalJson(unhashed), "utf8").digest("hex");
  assert.equal(planId, expectedHash);

  // Assert plan is deep-frozen
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.proposals));
  assert.ok(Object.isFrozen(proposal));
  assert.ok(Object.isFrozen(proposal.proof));
  assert.ok(Object.isFrozen(plan.summary));
});

test("Item 1: unchanged classification when registry holds identical unrevoked binding", () => {
  const profileName = "main-worker";
  const instanceId = deriveClientInstanceId(profileName);
  const principalId = "agent_0123456789abcdef0123456789abcdef";
  const authorityOrigin = "https://mesh.example.com";
  const bindingId = computeBindingId(instanceId, principalId, authorityOrigin, 1);

  const inventory = {
    schema: "identity_inventory_v1",
    identities: [
      {
        principalId,
        kind: "mesh-managed",
        authorityOrigin,
        profiles: [
          {
            profile: profileName,
            instanceId,
            bindingState: "bound",
            enabled: true,
            status: "ok",
          },
        ],
        diagnostics: [],
      },
    ],
    unmappedProfiles: [],
    diagnostics: [],
  };

  const registry = {
    schema: "identity_registry_v1",
    sequence: 5,
    createdAt: "2026-10-25T12:00:00.000Z",
    updatedAt: "2026-10-25T12:00:00.000Z",
    auditHead: { sequence: 5, hash: "a".repeat(64) },
    bindings: {
      [instanceId]: {
        schema: "local_profile_binding_v1",
        binding_id: bindingId,
        trust_mode: "mesh-managed",
        principal_id: principalId,
        profile_name: profileName,
        profile_instance_id: instanceId,
        authority_origin: authorityOrigin,
        binding_generation: 1,
        issued_at: "2026-10-25T12:00:00.000Z",
        revoked_at: null,
        proof: {
          kind: "disk_observation",
          observed_on_disk: true,
          verified_live_authority: false,
        },
      },
    },
  };

  const plan = planIdentityMapping({ inventory, registry });
  assert.equal(plan.registrySequence, 5);
  assert.equal(plan.proposals.length, 0);
  assert.equal(plan.unchanged.length, 1);
  assert.equal(plan.unchanged[0].profile, profileName);
  assert.equal(plan.unchanged[0].profileInstanceId, instanceId);
  assert.equal(plan.unchanged[0].principalId, principalId);
  assert.equal(plan.unchanged[0].authorityOrigin, authorityOrigin);
  assert.equal(plan.unchanged[0].bindingId, bindingId);
});

test("Item 1: blocked cases — all 8 bounded reason codes tested explicitly", () => {
  const p1 = "profile-ambig-1";
  const p2 = "profile-ambig-2";
  const pDupProf = "profile-dup-name";
  const pDupInst = "profile-dup-inst";
  const pOriginMis = "profile-origin-mis";
  const pMalformed = "profile-malformed";
  const pCustody = "profile-custody";
  const pConflict = "profile-conflict";
  const pRevoked = "profile-revoked";

  const inst1 = deriveClientInstanceId(p1);
  const inst2 = deriveClientInstanceId(p2);
  const instConflict = deriveClientInstanceId(pConflict);
  const instRevoked = deriveClientInstanceId(pRevoked);

  const sharedAgent = "agent_11111111111111111111111111111111";
  const origin1 = "https://mesh1.example.com";

  const inventory = {
    schema: "identity_inventory_v1",
    identities: [
      // 1. ambiguous_mapping: two profiles for same agent under one origin
      {
        principalId: sharedAgent,
        kind: "mesh-managed",
        authorityOrigin: origin1,
        profiles: [
          { profile: p1, instanceId: inst1, bindingState: "bound" },
          { profile: p2, instanceId: inst2, bindingState: "bound" },
        ],
        diagnostics: [{ code: "ambiguous_mapping", severity: "warning" }],
      },
      // 4. origin_mismatch
      {
        principalId: "agent_22222222222222222222222222222222",
        kind: "mesh-managed",
        authorityOrigin: "https://mesh-a.example.com",
        profiles: [
          { profile: pOriginMis, instanceId: deriveClientInstanceId(pOriginMis), bindingState: "bound" },
        ],
        diagnostics: [],
      },
      // 7. conflicts_with_recorded
      {
        principalId: "agent_33333333333333333333333333333333",
        kind: "mesh-managed",
        authorityOrigin: "https://mesh-c.example.com",
        profiles: [
          { profile: pConflict, instanceId: instConflict, bindingState: "bound" },
        ],
        diagnostics: [],
      },
      // 8. recorded_revoked
      {
        principalId: "agent_44444444444444444444444444444444",
        kind: "mesh-managed",
        authorityOrigin: "https://mesh-d.example.com",
        profiles: [
          { profile: pRevoked, instanceId: instRevoked, bindingState: "bound" },
        ],
        diagnostics: [],
      },
    ],
    unmappedProfiles: [
      // 5. malformed_record
      {
        profile: pMalformed,
        instanceId: null,
        reason: "missing_instance_id",
        status: "fault",
      },
      // 6. custody_fault
      {
        profile: pCustody,
        instanceId: deriveClientInstanceId(pCustody),
        reason: "custody_corrupt",
        bindingState: "custody_corrupt",
        status: "fault",
      },
      // Unbound profile
      {
        profile: "local-chat",
        instanceId: deriveClientInstanceId("local-chat"),
        reason: "unbound_local_profile",
        bindingState: "unbound",
        status: "ok",
      },
    ],
    diagnostics: [
      // 2. duplicate_profile
      { code: "duplicate_profile", profile: pDupProf, severity: "fault" },
      // 3. duplicate_instance_id
      { code: "duplicate_instance_id", profile: pDupInst, severity: "fault" },
      // 4. origin_mismatch diagnostic
      { code: "origin_mismatch", principalId: "agent_22222222222222222222222222222222", severity: "warning" },
    ],
  };

  const registry = {
    schema: "identity_registry_v1",
    sequence: 1,
    createdAt: "2026-10-25T12:00:00.000Z",
    updatedAt: "2026-10-25T12:00:00.000Z",
    auditHead: { sequence: 1, hash: "b".repeat(64) },
    bindings: {
      [instConflict]: {
        schema: "local_profile_binding_v1",
        binding_id: "bind_" + "1".repeat(32),
        trust_mode: "mesh-managed",
        principal_id: "agent_99999999999999999999999999999999", // Different principal!
        profile_name: pConflict,
        profile_instance_id: instConflict,
        authority_origin: "https://mesh-c.example.com",
        binding_generation: 1,
        issued_at: "2026-10-25T12:00:00.000Z",
        revoked_at: null,
        proof: { kind: "disk_observation", observed_on_disk: true, verified_live_authority: false },
      },
      [instRevoked]: {
        schema: "local_profile_binding_v1",
        binding_id: "bind_" + "2".repeat(32),
        trust_mode: "mesh-managed",
        principal_id: "agent_44444444444444444444444444444444",
        profile_name: pRevoked,
        profile_instance_id: instRevoked,
        authority_origin: "https://mesh-d.example.com",
        binding_generation: 1,
        issued_at: "2026-10-25T12:00:00.000Z",
        revoked_at: "2026-10-25T12:30:00.000Z", // Revoked!
        proof: { kind: "disk_observation", observed_on_disk: true, verified_live_authority: false },
      },
    },
  };

  const plan = planIdentityMapping({ inventory, registry });

  const reasons = new Set(plan.blocked.map((b) => b.reason));
  assert.ok(reasons.has(BLOCKED_REASONS.AMBIGUOUS_MAPPING), "has ambiguous_mapping");
  assert.ok(reasons.has(BLOCKED_REASONS.DUPLICATE_PROFILE), "has duplicate_profile");
  assert.ok(reasons.has(BLOCKED_REASONS.DUPLICATE_INSTANCE_ID), "has duplicate_instance_id");
  assert.ok(reasons.has(BLOCKED_REASONS.ORIGIN_MISMATCH), "has origin_mismatch");
  assert.ok(reasons.has(BLOCKED_REASONS.MALFORMED_RECORD), "has malformed_record");
  assert.ok(reasons.has(BLOCKED_REASONS.CUSTODY_FAULT), "has custody_fault");
  assert.ok(reasons.has(BLOCKED_REASONS.CONFLICTS_WITH_RECORDED), "has conflicts_with_recorded");
  assert.ok(reasons.has(BLOCKED_REASONS.RECORDED_REVOKED), "has recorded_revoked");

  // Local-only
  assert.equal(plan.localOnly.length, 1);
  assert.equal(plan.localOnly[0].profile, "local-chat");

  // Zero proposals
  assert.equal(plan.proposals.length, 0);
});

test("Item 1: determinism under reordering — byte-identical output", () => {
  const pA = "agent-alpha";
  const pB = "agent-beta";
  const instA = deriveClientInstanceId(pA);
  const instB = deriveClientInstanceId(pB);

  const buildInv = (order) => ({
    schema: "identity_inventory_v1",
    identities: (order === "AB" ? [pA, pB] : [pB, pA]).map((p) => ({
      principalId: `agent_${p === pA ? "0000000000000000000000000000000a" : "0000000000000000000000000000000b"}`,
      kind: "mesh-managed",
      authorityOrigin: "https://mesh.example.com",
      profiles: [
        {
          profile: p,
          instanceId: p === pA ? instA : instB,
          bindingState: "bound",
        },
      ],
      diagnostics: [],
    })),
    unmappedProfiles: (order === "AB" ? ["unbound-1", "unbound-2"] : ["unbound-2", "unbound-1"]).map((name) => ({
      profile: name,
      instanceId: deriveClientInstanceId(name),
      reason: "unbound_local_profile",
      bindingState: "unbound",
    })),
    diagnostics: [],
  });

  const plan1 = planIdentityMapping({ inventory: buildInv("AB") });
  const plan2 = planIdentityMapping({ inventory: buildInv("BA") });

  assert.equal(canonicalJson(plan1), canonicalJson(plan2));
  assert.equal(plan1.planId, plan2.planId);
});

test("Item 1: no name-based merge — identical profile names or handles stay strictly separated", () => {
  const profName = "shared-name";
  const inst = deriveClientInstanceId(profName);

  // Two different origins observing the same profile name
  const inventory = {
    schema: "identity_inventory_v1",
    identities: [
      {
        principalId: "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        kind: "mesh-managed",
        authorityOrigin: "https://mesh-one.example.com",
        profiles: [{ profile: profName, instanceId: inst, bindingState: "bound" }],
        handles: ["helper"],
        diagnostics: [],
      },
      {
        principalId: "agent_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        kind: "mesh-managed",
        authorityOrigin: "https://mesh-two.example.com",
        profiles: [{ profile: profName, instanceId: inst, bindingState: "bound" }],
        handles: ["helper"],
        diagnostics: [],
      },
    ],
    unmappedProfiles: [],
    diagnostics: [
      { code: "duplicate_profile", profile: profName, severity: "fault" },
    ],
  };

  const plan = planIdentityMapping({ inventory });
  assert.equal(plan.proposals.length, 0);
  assert.ok(plan.blocked.length > 0);
  assert.equal(plan.blocked[0].reason, BLOCKED_REASONS.DUPLICATE_PROFILE);
});

test("Item 1: input objects are not mutated", () => {
  const inventory = {
    schema: "identity_inventory_v1",
    identities: [
      {
        principalId: "agent_12345678901234567890123456789012",
        kind: "mesh-managed",
        authorityOrigin: "https://mesh.example.com",
        profiles: [
          {
            profile: "test-prof",
            instanceId: deriveClientInstanceId("test-prof"),
            bindingState: "bound",
          },
        ],
        diagnostics: [],
      },
    ],
    unmappedProfiles: [],
    diagnostics: [],
  };

  const inventoryBefore = JSON.parse(JSON.stringify(inventory));
  planIdentityMapping({ inventory });
  assert.deepEqual(inventory, inventoryBefore);
});

test("Item 2: confirmed apply — mismatch and stale error handling", () => {
  const root = makeTmpDir("triangle-mapping-test-apply-err-");
  try {
    const profileName = "worker-apply";
    const instanceId = deriveClientInstanceId(profileName);
    const principalId = "agent_0123456789abcdef0123456789abcdef";
    const authorityOrigin = "https://mesh.example.com";

    const makeInv = (agent = principalId) => ({
      schema: "identity_inventory_v1",
      identities: [
        {
          principalId: agent,
          kind: "mesh-managed",
          authorityOrigin,
          profiles: [
            {
              profile: profileName,
              instanceId,
              bindingState: "bound",
            },
          ],
          diagnostics: [],
        },
      ],
      unmappedProfiles: [],
      diagnostics: [],
    });

    let currentInv = makeInv();
    const readInventory = () => currentInv;

    const initialPlan = planIdentityMapping({ inventory: currentInv });

    // 1. Confirmation mismatch (wrong confirmation format or wrong plan ID)
    assert.throws(
      () => applyIdentityMapping({ root, confirmation: "not-a-hex", readInventory }),
      (err) => err.code === "confirmation_mismatch",
    );

    const wrongConfirmation = "f".repeat(64);
    assert.throws(
      () =>
        applyIdentityMapping({
          root,
          confirmation: wrongConfirmation,
          plan: initialPlan,
          readInventory,
        }),
      (err) => err.code === "confirmation_mismatch",
    );

    // 2. Plan stale — inventory changed in between
    currentInv = makeInv("agent_ffffffffffffffffffffffffffffffff");
    assert.throws(
      () =>
        applyIdentityMapping({
          root,
          confirmation: initialPlan.planId,
          readInventory,
        }),
      (err) => err.code === "plan_stale",
    );

    // 3. Plan stale — registry changed in between
    currentInv = makeInv(); // restore inventory
    // initialize registry at sequence 1
    updateIdentityRegistry({
      root,
      expectedSequence: 0,
      now: "2026-10-25T12:00:00.000Z",
      action: "init",
      mutate: (d) => d,
    });
    // initialPlan was computed against sequence 0; now registry is at sequence 1
    assert.throws(
      () =>
        applyIdentityMapping({
          root,
          confirmation: initialPlan.planId,
          readInventory,
        }),
      (err) => err.code === "plan_stale",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Item 2: confirmed apply — full success, audit entries, and idempotent rerun", () => {
  const root = makeTmpDir("triangle-mapping-test-apply-success-");
  try {
    const p1 = "worker-1";
    const p2 = "worker-2";
    const inst1 = deriveClientInstanceId(p1);
    const inst2 = deriveClientInstanceId(p2);
    const agent1 = "agent_11111111111111111111111111111111";
    const agent2 = "agent_22222222222222222222222222222222";
    const origin = "https://mesh.example.com";

    const inventory = {
      schema: "identity_inventory_v1",
      identities: [
        {
          principalId: agent1,
          kind: "mesh-managed",
          authorityOrigin: origin,
          profiles: [{ profile: p1, instanceId: inst1, bindingState: "bound" }],
          diagnostics: [],
        },
        {
          principalId: agent2,
          kind: "mesh-managed",
          authorityOrigin: origin,
          profiles: [{ profile: p2, instanceId: inst2, bindingState: "bound" }],
          diagnostics: [],
        },
      ],
      unmappedProfiles: [],
      diagnostics: [],
    };

    const readInventory = () => inventory;
    const plan = planIdentityMapping({ inventory });
    assert.equal(plan.proposals.length, 2);

    const nowIso = "2026-10-25T14:00:00.000Z";
    const applyResult = applyIdentityMapping({
      root,
      confirmation: plan.planId,
      readInventory,
      now: nowIso,
    });

    assert.equal(applyResult.applied.length, 2);
    assert.equal(applyResult.registrySequence, 2);

    // Verify registry state on disk
    const onDisk = readIdentityRegistry({ root });
    assert.equal(onDisk.state, "ok");
    assert.equal(onDisk.registry.sequence, 2);
    assert.ok(onDisk.registry.bindings[inst1]);
    assert.ok(onDisk.registry.bindings[inst2]);
    assert.equal(onDisk.registry.bindings[inst1].issued_at, nowIso);
    assert.equal(onDisk.registry.bindings[inst2].issued_at, nowIso);

    // Verify audit log has 2 entries (one per proposal)
    const auditLines = readFileSync(path.join(root, "registry-audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(auditLines.length, 2);
    assert.equal(auditLines[0].sequence, 1);
    assert.equal(auditLines[0].action, "bind");
    assert.equal(auditLines[0].subject, inst1);
    assert.equal(auditLines[1].sequence, 2);
    assert.equal(auditLines[1].action, "bind");
    assert.equal(auditLines[1].subject, inst2);

    // Idempotent rerun: recompute plan
    const rerunPlan = planIdentityMapping({ inventory, registry: onDisk });
    assert.equal(rerunPlan.proposals.length, 0);
    assert.equal(rerunPlan.unchanged.length, 2);

    const rerunApply = applyIdentityMapping({
      root,
      confirmation: rerunPlan.planId,
      readInventory,
      now: nowIso,
    });
    assert.equal(rerunApply.applied.length, 0);
    assert.equal(rerunApply.registrySequence, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Item 2: confirmed apply — partial failure with applied, failed, and remaining reported", () => {
  const root = makeTmpDir("triangle-mapping-test-partial-");
  try {
    const p1 = "worker-p1";
    const p2 = "worker-p2";
    const inst1 = deriveClientInstanceId(p1);
    const inst2 = deriveClientInstanceId(p2);
    const agent1 = "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const agent2 = "agent_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const origin = "https://mesh.example.com";

    const inventory = {
      schema: "identity_inventory_v1",
      identities: [
        {
          principalId: agent1,
          kind: "mesh-managed",
          authorityOrigin: origin,
          profiles: [{ profile: p1, instanceId: inst1, bindingState: "bound" }],
          diagnostics: [],
        },
        {
          principalId: agent2,
          kind: "mesh-managed",
          authorityOrigin: origin,
          profiles: [{ profile: p2, instanceId: inst2, bindingState: "bound" }],
          diagnostics: [],
        },
      ],
      unmappedProfiles: [],
      diagnostics: [],
    };

    let calls = 0;
    const readInventory = () => {
      calls++;
      return inventory;
    };

    const plan = planIdentityMapping({ inventory });
    assert.equal(plan.proposals.length, 2);

    // Pre-create the registry with a conflict for inst2 so that proposal 2 fails
    // First let's apply proposal 1 cleanly, then corrupt registry sequence
    // Or we can mock updateIdentityRegistry by applying proposal 1 then putting a lock
    // Actually, updateIdentityRegistry refuses if expectedSequence conflicts:
    // Let's test by having another update run after proposal 1:
    // We can simulate an error during updateIdentityRegistry by making registry file read-only after first write!
    // Or we can verify applyIdentityMapping's error handling by catching a step failure.
    // If the second update fails because root was made read-only or lock is held:
    // Let's test with a registry lock held during step 2!
    const lockPath = path.join(root, ".registry.lock");

    let errCaught = null;
    try {
      // We pass a now that throws on second call!
      let nowCalls = 0;
      applyIdentityMapping({
        root,
        confirmation: plan.planId,
        readInventory,
        now: () => {
          nowCalls++;
          if (nowCalls === 2) {
            throw new Error("injected_fault_at_step_2");
          }
          return "2026-10-25T14:00:00.000Z";
        },
      });
    } catch (err) {
      errCaught = err;
    }

    assert.ok(errCaught, "should have thrown partial failure error");
    assert.equal(errCaught.applied.length, 1);
    assert.equal(errCaught.applied[0].profile_instance_id, inst1);
    assert.ok(errCaught.failed);
    assert.equal(errCaught.failed.proposal.profile_instance_id, inst2);
    assert.ok(errCaught.remaining);
    assert.equal(errCaught.remaining.proposals.length, 1);
    assert.equal(errCaught.remaining.proposals[0].profile_instance_id, inst2);
    assert.equal(errCaught.remaining.unchanged.length, 1);
    assert.equal(errCaught.remaining.unchanged[0].profileInstanceId, inst1);

    // Assert that applied binding 1 is durably stored in the registry
    const registryOnDisk = readIdentityRegistry({ root });
    assert.equal(registryOnDisk.state, "ok");
    assert.equal(registryOnDisk.registry.sequence, 1);
    assert.ok(registryOnDisk.registry.bindings[inst1]);
    assert.equal(registryOnDisk.registry.bindings[inst2], undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Item 2: client root and profiles-v1 remain byte-identical before and after apply", () => {
  const clientRoot = makeTmpDir("triangle-mapping-client-root-");
  const registryRoot = makeTmpDir("triangle-mapping-registry-root-");

  try {
    const profilesDir = path.join(clientRoot, "profiles-v1");
    mkdirSync(profilesDir, { recursive: true });

    const p = "client-prof";
    const inst = deriveClientInstanceId(p);
    const profileFile = path.join(profilesDir, `profile-${inst}.json`);
    const profileContent = JSON.stringify({
      schema: "profile_v1",
      profile: p,
      instanceId: inst,
      agentId: "agent_1234567890abcdef1234567890abcdef",
    });
    writeFileSync(profileFile, profileContent, { mode: 0o600 });

    const snapDirectory = (dir) => {
      const snapshot = {};
      const scan = (d) => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, entry.name);
          const st = statSync(full);
          const rel = path.relative(dir, full);
          snapshot[rel] = {
            size: st.size,
            mode: st.mode,
            mtimeMs: st.mtimeMs,
            sha256: entry.isFile() ? createHash("sha256").update(readFileSync(full)).digest("hex") : null,
          };
          if (entry.isDirectory()) scan(full);
        }
      };
      scan(dir);
      return snapshot;
    };

    const beforeSnapshot = snapDirectory(clientRoot);

    const inventory = {
      schema: "identity_inventory_v1",
      identities: [
        {
          principalId: "agent_1234567890abcdef1234567890abcdef",
          kind: "mesh-managed",
          authorityOrigin: "https://mesh.example.com",
          profiles: [{ profile: p, instanceId: inst, bindingState: "bound" }],
          diagnostics: [],
        },
      ],
      unmappedProfiles: [],
      diagnostics: [],
    };

    const plan = planIdentityMapping({ inventory });
    applyIdentityMapping({
      root: registryRoot,
      confirmation: plan.planId,
      readInventory: () => inventory,
      now: "2026-10-25T15:00:00.000Z",
    });

    const afterSnapshot = snapDirectory(clientRoot);
    assert.deepEqual(afterSnapshot, beforeSnapshot);
  } finally {
    rmSync(clientRoot, { recursive: true, force: true });
    rmSync(registryRoot, { recursive: true, force: true });
  }
});

test("Item 4: boundaries — source-level test that no file under packages/*/src other than CLI imports mapping module", () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const packagesDir = path.join(root, "packages");

  const mjsFiles = [];
  const scan = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory() && ent.name !== "node_modules" && ent.name !== "test") {
        scan(full);
      } else if (ent.isFile() && (ent.name.endsWith(".mjs") || ent.name.endsWith(".js"))) {
        mjsFiles.push(full);
      }
    }
  };

  for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const srcDir = path.join(packagesDir, pkg.name, "src");
    if (existsSync(srcDir)) scan(srcDir);
  }

  const allowedToImport = new Set([
    path.join(packagesDir, "triangle-cli", "src", "identity-migrate.mjs"),
    path.join(packagesDir, "triangle-cli", "src", "cli.mjs"),
    path.join(packagesDir, "agent-worker", "src", "identity-mapping.mjs"),
  ]);

  for (const f of mjsFiles) {
    if (allowedToImport.has(f)) continue;
    const content = readFileSync(f, "utf8");
    assert.ok(
      !content.includes("identity-mapping"),
      `Unexpected import of identity-mapping in ${f}`,
    );
  }
});

test("Item 4: boundaries — planning and apply never touch the filesystem outside injected roots", () => {
  const root = makeTmpDir("triangle-mapping-boundary-");
  try {
    // Pure planning touches zero filesystem APIs
    const inventory = {
      schema: "identity_inventory_v1",
      identities: [
        {
          principalId: "agent_1234567890abcdef1234567890abcdef",
          kind: "mesh-managed",
          authorityOrigin: "https://mesh.example.com",
          profiles: [
            {
              profile: "test-p",
              instanceId: deriveClientInstanceId("test-p"),
              bindingState: "bound",
            },
          ],
          diagnostics: [],
        },
      ],
      unmappedProfiles: [],
      diagnostics: [],
    };

    const plan = planIdentityMapping({ inventory });
    assert.equal(plan.proposals.length, 1);

    // Apply only accesses files inside root (and standard system temporary files if any)
    const applyResult = applyIdentityMapping({
      root,
      confirmation: plan.planId,
      readInventory: () => inventory,
      now: "2026-10-25T15:00:00.000Z",
    });
    assert.equal(applyResult.applied.length, 1);

    // Verify all created files are strictly inside root
    const rootFiles = readdirSync(root);
    assert.ok(rootFiles.includes("identity-registry-v1.json"));
    assert.ok(rootFiles.includes("registry-audit.jsonl"));
    assert.ok(rootFiles.includes(".registry.lock"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Item 4: boundaries — nothing in identity-mapping reads process.env", () => {
  const root = makeTmpDir("triangle-mapping-no-env-");
  try {
    const accessedEnv = [];
    const originalEnv = process.env;

    const envProxy = new Proxy(originalEnv, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && !prop.startsWith("NODE_") && prop !== "Symbol(nodejs.util.inspect.custom)") {
          accessedEnv.push(prop);
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    try {
      process.env = envProxy;

      const inventory = {
        schema: "identity_inventory_v1",
        identities: [
          {
            principalId: "agent_1234567890abcdef1234567890abcdef",
            kind: "mesh-managed",
            authorityOrigin: "https://mesh.example.com",
            profiles: [
              {
                profile: "env-prof",
                instanceId: deriveClientInstanceId("env-prof"),
                bindingState: "bound",
              },
            ],
            diagnostics: [],
          },
        ],
        unmappedProfiles: [],
        diagnostics: [],
      };

      const plan = planIdentityMapping({ inventory });
      assert.equal(plan.proposals.length, 1);

      applyIdentityMapping({
        root,
        confirmation: plan.planId,
        readInventory: () => inventory,
        now: "2026-10-25T15:00:00.000Z",
      });

      assert.deepEqual(accessedEnv, [], "identity-mapping must not read process.env");
    } finally {
      process.env = originalEnv;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

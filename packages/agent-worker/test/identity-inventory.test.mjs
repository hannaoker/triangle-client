import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildIdentityInventory,
  projectIdentityInventory,
  AGENT_ID_PATTERN,
  DIAGNOSTIC_CODES,
  UNAVAILABLE,
} from "../src/identity-inventory.mjs";
import {
  deriveClientInstanceId,
  readInstallationInventory,
} from "../src/installation-inventory.mjs";
import {
  FIXTURE_INSTALLATION_ID,
  boundAgentId,
  writeBinding,
  writeInstallationIdentity,
  writeJson,
} from "./inventory-fixture-helpers.mjs";

const NOW = Date.parse("2026-10-25T12:00:00.000Z");

/**
 * Creates a disposable multi-profile fixture using the real inventory fixture helpers.
 */
function createTestFixture({
  profiles = [
    { profile: "bob", runtimeAdapter: "codex", deliveryMode: "headless-app-server", enabled: true, bind: true },
    { profile: "ghost", runtimeAdapter: "cursor-acp", deliveryMode: "headless-cursor-acp", enabled: true, bind: true },
    { profile: "gravity2", runtimeAdapter: "antigravity", deliveryMode: "worker", enabled: true, bind: true },
    { profile: "hermes-off", runtimeAdapter: "hermes", deliveryMode: "worker", enabled: false, bind: true },
  ],
  extraUnregisteredBindings = [],
} = {}) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "id-inventory-test-"));
  const app = path.join(root, "The Triangle");
  const client = path.join(app, "client");

  for (const p of profiles) {
    const instanceId = deriveClientInstanceId(p.profile);
    writeJson(path.join(client, "instances", `${instanceId}.json`), {
      version: 1,
      instanceId,
      profile: p.profile,
      runtimeAdapter: p.runtimeAdapter,
      enabled: p.enabled,
      ...(p.deliveryMode ? { deliveryMode: p.deliveryMode } : {}),
    });
    if (p.bind !== false) {
      writeBinding(app, p.profile, p.bindingOpts ?? {});
    }
  }

  for (const unreg of extraUnregisteredBindings) {
    writeBinding(app, unreg);
  }

  writeInstallationIdentity(client, FIXTURE_INSTALLATION_ID);

  return { root, app, client };
}

test("representative valid managed bindings from real existing inventory fixtures", () => {
  const { root, client } = createTestFixture();
  try {
    const rawInventory = readInstallationInventory({
      clientRoot: client,
      now: NOW,
      pidAlive: () => false,
      advisoryHeldAt: () => null,
    });

    const report = buildIdentityInventory(rawInventory);

    assert.equal(report.schema, "identity_inventory_v1");
    assert.equal(report.scope, "host-local");
    assert.equal(report.summary.identityCount, 4);
    assert.equal(report.summary.unmappedProfileCount, 0);

    // Verify identities are mapped and structured
    for (const ident of report.identities) {
      assert.equal(ident.kind, "mesh-managed");
      assert.match(ident.principalId, AGENT_ID_PATTERN);
      assert.equal(ident.authorityOrigin, "https://example.test");
      assert.equal(ident.authority.observedOnDisk, true);
      assert.equal(ident.authority.verifiedLiveAuthority, false);
      assert.equal(ident.authority.source, "profiles-v1");
      assert.equal(ident.profiles.length, 1);

      const boundProfile = ident.profiles[0];
      assert.equal(boundProfile.instanceId, deriveClientInstanceId(boundProfile.profile));
      assert.equal(boundProfile.bindingState, "bound");
      assert.ok(boundProfile.workloadId.startsWith("workload_"));
    }

    // Alias projectIdentityInventory behaves identically
    const reportAlias = projectIdentityInventory(rawInventory);
    assert.deepEqual(report, reportAlias);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unbound profile remains local-only", () => {
  const { root, client } = createTestFixture({
    profiles: [
      { profile: "bob", runtimeAdapter: "codex", deliveryMode: "headless-app-server", enabled: true, bind: true },
      { profile: "local-chat", runtimeAdapter: "codex", deliveryMode: "worker", enabled: true, bind: false },
    ],
  });

  try {
    const rawInventory = readInstallationInventory({
      clientRoot: client,
      now: NOW,
      pidAlive: () => false,
      advisoryHeldAt: () => null,
    });

    const report = buildIdentityInventory(rawInventory);

    assert.equal(report.summary.identityCount, 1);
    assert.equal(report.summary.unmappedProfileCount, 1);

    // Bob is bound
    assert.equal(report.identities[0].profiles[0].profile, "bob");

    // local-chat is unmapped and remains local-only
    const unmapped = report.unmappedProfiles.find((p) => p.profile === "local-chat");
    assert.ok(unmapped);
    assert.equal(unmapped.isPrincipal, false);
    assert.equal(unmapped.bindingState, "unbound");
    assert.equal(unmapped.reason, "unbound_local_profile");
    assert.equal(unmapped.instanceId, deriveClientInstanceId("local-chat"));

    // Verify no serverless principal (peer_*) is fabricated
    for (const ident of report.identities) {
      assert.ok(!ident.principalId.startsWith("peer_"));
      assert.notEqual(ident.profiles[0].profile, "local-chat");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("disabled profile retained", () => {
  const { root, client } = createTestFixture({
    profiles: [
      { profile: "active-agent", runtimeAdapter: "codex", deliveryMode: "worker", enabled: true, bind: true },
      { profile: "dormant-bound", runtimeAdapter: "hermes", deliveryMode: "worker", enabled: false, bind: true },
      { profile: "dormant-unbound", runtimeAdapter: "hermes", deliveryMode: "worker", enabled: false, bind: false },
    ],
  });

  try {
    const rawInventory = readInstallationInventory({
      clientRoot: client,
      now: NOW,
      pidAlive: () => false,
      advisoryHeldAt: () => null,
    });

    const report = buildIdentityInventory(rawInventory);

    // Dormant bound profile is retained in identities with enabled: false
    const boundDormant = report.identities.find((i) => i.profiles.some((p) => p.profile === "dormant-bound"));
    assert.ok(boundDormant);
    const dormantProfile = boundDormant.profiles.find((p) => p.profile === "dormant-bound");
    assert.equal(dormantProfile.enabled, false);
    assert.equal(dormantProfile.status, "disabled");

    // Dormant unbound profile is retained in unmappedProfiles with enabled: false
    const unboundDormant = report.unmappedProfiles.find((p) => p.profile === "dormant-unbound");
    assert.ok(unboundDormant);
    assert.equal(unboundDormant.enabled, false);
    assert.equal(unboundDormant.status, "disabled");
    assert.equal(unboundDormant.isPrincipal, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same display name never merges identities", () => {
  // Construct an inventory where two distinct profiles have distinct agent IDs but share the same handle
  const rawInventory = {
    profiles: [
      {
        profile: "agent-alpha",
        instanceId: deriveClientInstanceId("agent-alpha"),
        enabled: true,
        status: "ok",
        lane: "worker",
        runtimeAdapter: "antigravity",
        deliveryMode: "worker",
        identity: {
          state: "bound",
          agentId: "agent_11111111111111111111111111111111",
          handle: "shared-assistant",
          origin: "https://example.test",
          workloadId: "workload_11111111111111111111111111111111",
        },
      },
      {
        profile: "agent-beta",
        instanceId: deriveClientInstanceId("agent-beta"),
        enabled: true,
        status: "ok",
        lane: "worker",
        runtimeAdapter: "codex",
        deliveryMode: "worker",
        identity: {
          state: "bound",
          agentId: "agent_22222222222222222222222222222222",
          handle: "shared-assistant", // Same display name / handle!
          origin: "https://example.test",
          workloadId: "workload_22222222222222222222222222222222",
        },
      },
    ],
  };

  const report = buildIdentityInventory(rawInventory);

  // Exactly two identities must be projected; display name must NEVER merge them!
  assert.equal(report.identities.length, 2);
  assert.equal(report.identities[0].principalId, "agent_11111111111111111111111111111111");
  assert.equal(report.identities[1].principalId, "agent_22222222222222222222222222222222");

  // Handle collision diagnostic must be recorded
  const collisionDiag = report.diagnostics.find((d) => d.code === DIAGNOSTIC_CODES.HANDLE_COLLISION);
  assert.ok(collisionDiag);
  assert.match(collisionDiag.message, /Handle collision: handle "shared-assistant"/);
  assert.equal(collisionDiag.severity, "warning");

  // Both identities must record the collision diagnostic
  assert.ok(report.identities[0].diagnostics.some((d) => d.code === DIAGNOSTIC_CODES.HANDLE_COLLISION));
  assert.ok(report.identities[1].diagnostics.some((d) => d.code === DIAGNOSTIC_CODES.HANDLE_COLLISION));
});

test("different origins never merge agent IDs", () => {
  // Construct an inventory where two profiles have the same agentId but different authority origins
  const rawInventory = {
    profiles: [
      {
        profile: "profile-mesh-primary",
        instanceId: deriveClientInstanceId("profile-mesh-primary"),
        enabled: true,
        status: "ok",
        lane: "worker",
        runtimeAdapter: "antigravity",
        deliveryMode: "worker",
        identity: {
          state: "bound",
          agentId: "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          handle: "mesh-agent",
          origin: "https://mesh-primary.thetriangle.dev",
          workloadId: "workload_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      },
      {
        profile: "profile-mesh-secondary",
        instanceId: deriveClientInstanceId("profile-mesh-secondary"),
        enabled: true,
        status: "ok",
        lane: "worker",
        runtimeAdapter: "antigravity",
        deliveryMode: "worker",
        identity: {
          state: "bound",
          agentId: "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          handle: "mesh-agent",
          origin: "https://mesh-secondary.thetriangle.dev",
          workloadId: "workload_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      },
    ],
  };

  const report = buildIdentityInventory(rawInventory);

  // Different origins must NOT be merged together into one identity
  assert.equal(report.identities.length, 2);
  assert.equal(report.identities[0].authorityOrigin, "https://mesh-primary.thetriangle.dev");
  assert.equal(report.identities[1].authorityOrigin, "https://mesh-secondary.thetriangle.dev");

  // Origin mismatch diagnostic must be recorded
  const originDiag = report.diagnostics.find((d) => d.code === DIAGNOSTIC_CODES.ORIGIN_MISMATCH);
  assert.ok(originDiag);
  assert.equal(originDiag.principalId, "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.match(originDiag.message, /multiple distinct authority origins/);
});

test("malformed or conflicting records diagnosed", () => {
  const instanceBob = deriveClientInstanceId("valid-bob");
  const rawInventory = {
    profiles: [
      // 1. Invalid profile name (control char)
      {
        profile: "bad\x01name",
        instanceId: "1234",
        enabled: true,
      },
      // 2. Malformed instanceId (not 64-hex)
      {
        profile: "bad-instance",
        instanceId: "not-64-hex",
        enabled: true,
      },
      // 3. InstanceId mismatch (computed hash does not match claimed instanceId)
      {
        profile: "mismatch-profile",
        instanceId: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        enabled: true,
      },
      // 4. Invalid bound agentId format
      {
        profile: "bad-agent-id",
        instanceId: deriveClientInstanceId("bad-agent-id"),
        enabled: true,
        identity: {
          state: "bound",
          agentId: "invalid_agent_prefix",
          origin: "https://example.test",
        },
      },
      // 5. Custody failure (key_missing)
      {
        profile: "custody-missing",
        instanceId: deriveClientInstanceId("custody-missing"),
        enabled: true,
        identity: {
          state: "key_missing",
          agentId: null,
        },
      },
      // 6 & 7. Duplicate instance ID claimed by two different profiles
      {
        profile: "valid-bob",
        instanceId: instanceBob,
        enabled: true,
        identity: {
          state: "bound",
          agentId: "agent_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          origin: "https://example.test",
        },
      },
      {
        profile: "impostor-bob",
        instanceId: instanceBob, // Reusing bob's instanceId!
        enabled: true,
        identity: {
          state: "bound",
          agentId: "agent_cccccccccccccccccccccccccccccccc",
          origin: "https://example.test",
        },
      },
      // 8 & 9. Ambiguous mapping: two distinct profiles binding to the SAME (origin, agentId)
      {
        profile: "shared-profile-1",
        instanceId: deriveClientInstanceId("shared-profile-1"),
        enabled: true,
        identity: {
          state: "bound",
          agentId: "agent_dddddddddddddddddddddddddddddddd",
          origin: "https://example.test",
        },
      },
      {
        profile: "shared-profile-2",
        instanceId: deriveClientInstanceId("shared-profile-2"),
        enabled: true,
        identity: {
          state: "bound",
          agentId: "agent_dddddddddddddddddddddddddddddddd",
          origin: "https://example.test",
        },
      },
    ],
    boundUnregistered: ["orphan-in-custody"],
    orphanBindings: [{ kind: "codex-headless", profile: "phantom-lane" }],
  };

  const report = buildIdentityInventory(rawInventory);

  // Check malformed record diagnostics
  const malformedDiags = report.diagnostics.filter((d) => d.code === DIAGNOSTIC_CODES.MALFORMED_RECORD);
  assert.ok(malformedDiags.length >= 4);

  // Check duplicate instance ID diagnostic
  const dupInstDiag = report.diagnostics.find((d) => d.code === DIAGNOSTIC_CODES.DUPLICATE_INSTANCE);
  assert.ok(dupInstDiag);
  assert.match(dupInstDiag.message, /Duplicate instanceId/);

  // Check ambiguous mapping diagnostic
  const ambigDiag = report.diagnostics.find((d) => d.code === DIAGNOSTIC_CODES.AMBIGUOUS_MAPPING);
  assert.ok(ambigDiag);
  assert.match(ambigDiag.message, /Ambiguous profile mapping/);

  // Check custody fault diagnostic
  const custodyDiag = report.diagnostics.find((d) => d.code === DIAGNOSTIC_CODES.CUSTODY_FAULT);
  assert.ok(custodyDiag);
  assert.match(custodyDiag.message, /custody check failed/);

  // Check unregistered binding diagnostic
  const unregDiag = report.diagnostics.find((d) => d.code === DIAGNOSTIC_CODES.UNREGISTERED_BINDING);
  assert.ok(unregDiag);
  assert.equal(unregDiag.profile, "orphan-in-custody");

  // Check orphan lane binding diagnostic
  const orphanDiag = report.diagnostics.find((d) => d.code === DIAGNOSTIC_CODES.ORPHAN_BINDING);
  assert.ok(orphanDiag);
  assert.equal(orphanDiag.profile, "phantom-lane");
});

test("injected secrets never appear", () => {
  const SENTINEL_TOKEN = "mesh_SECRET_TOKEN_must_not_leak_9876543210";
  const SENTINEL_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nMIGEAgEAMBAGByqGSM49AgEGBSuBBAAKBG0wawIBAQQgSECRETKEY\n-----END PRIVATE KEY-----";
  const SENTINEL_PASSWORD = "SuperSecretPassword123!";
  const SENTINEL_BEARER = "bearer_jwt_unauthorized_token";

  const dirtyInventory = {
    secretToken: SENTINEL_TOKEN,
    privateKey: SENTINEL_PRIVATE_KEY,
    nestedSecrets: {
      password: SENTINEL_PASSWORD,
      bearer: SENTINEL_BEARER,
      credentials: {
        key: "secret-key-material",
      },
    },
    profiles: [
      {
        profile: "bob",
        instanceId: deriveClientInstanceId("bob"),
        enabled: true,
        status: "ok",
        lane: "worker",
        runtimeAdapter: "codex",
        deliveryMode: "worker",
        injectedPrivateField: SENTINEL_PRIVATE_KEY,
        secretApiKey: "sk-ant-api03-secret",
        token: SENTINEL_TOKEN,
        identity: {
          state: "bound",
          agentId: "agent_00000000000000000000000000000000",
          origin: "https://example.test",
          workloadId: "workload_00000000000000000000000000000000",
          workloadKey: {
            d: "private-seed-value-must-never-leak",
            secret: SENTINEL_PASSWORD,
          },
        },
      },
    ],
  };

  const report = buildIdentityInventory(dirtyInventory, {
    injectedOptionSecret: "bearer_secret_option",
  });

  const serialized = JSON.stringify(report);

  // Assert sentinels are completely absent from output
  assert.ok(!serialized.includes(SENTINEL_TOKEN));
  assert.ok(!serialized.includes(SENTINEL_PRIVATE_KEY));
  assert.ok(!serialized.includes(SENTINEL_PASSWORD));
  assert.ok(!serialized.includes(SENTINEL_BEARER));
  assert.ok(!serialized.includes("secret-key-material"));
  assert.ok(!serialized.includes("private-seed-value"));
  assert.ok(!serialized.includes("sk-ant-api03-secret"));
  assert.ok(!serialized.includes("injectedOptionSecret"));

  // Check that no secret-like property keys exist in serialized JSON
  const secretKeyRegex = /"(?:token|secret|password|private|bearer|credential|key|apiKey)"\s*:/i;
  assert.ok(!secretKeyRegex.test(serialized), `Found secret-like key in: ${serialized}`);
});

test("deterministic output", () => {
  const makeInventory = () => ({
    profiles: [
      {
        profile: "charlie",
        instanceId: deriveClientInstanceId("charlie"),
        enabled: true,
        status: "ok",
        lane: "worker",
        runtimeAdapter: "codex",
        deliveryMode: "worker",
        identity: {
          state: "bound",
          agentId: "agent_33333333333333333333333333333333",
          handle: "charlie-handle",
          origin: "https://example.test",
        },
      },
      {
        profile: "alice",
        instanceId: deriveClientInstanceId("alice"),
        enabled: true,
        status: "ok",
        lane: "worker",
        runtimeAdapter: "antigravity",
        deliveryMode: "worker",
        identity: {
          state: "bound",
          agentId: "agent_11111111111111111111111111111111",
          handle: "alice-handle",
          origin: "https://example.test",
        },
      },
      {
        profile: "bob",
        instanceId: deriveClientInstanceId("bob"),
        enabled: true,
        status: "ok",
        lane: "worker",
        runtimeAdapter: "hermes",
        deliveryMode: "worker",
        identity: {
          state: "unbound",
        },
      },
    ],
  });

  // Re-ordering the input profiles should result in identical sorted outputs
  const inv1 = makeInventory();
  const inv2 = makeInventory();
  inv2.profiles.reverse();

  const report1 = buildIdentityInventory(inv1);
  const report2 = buildIdentityInventory(inv2);

  const json1 = JSON.stringify(report1, null, 2);
  const json2 = JSON.stringify(report2, null, 2);

  assert.equal(json1, json2);

  // Identities are sorted deterministically: agent_111... before agent_333...
  assert.equal(report1.identities[0].principalId, "agent_11111111111111111111111111111111");
  assert.equal(report1.identities[1].principalId, "agent_33333333333333333333333333333333");

  // Output is frozen (read-only)
  assert.ok(Object.isFrozen(report1));
  assert.ok(Object.isFrozen(report1.identities));
  assert.ok(Object.isFrozen(report1.unmappedProfiles));
  assert.throws(() => {
    report1.identities.push({});
  }, TypeError);
});

test("local sessions remain local-only", () => {
  const validSessionId = "session-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const invalidSessionId = "session-bad";

  const rawInventory = {
    profiles: [],
  };

  const report = buildIdentityInventory(rawInventory, {
    sessions: [
      { sessionId: validSessionId, profile: "bob", observedOnDisk: true },
      { sessionId: invalidSessionId, profile: null },
    ],
  });

  assert.equal(report.sessions.length, 2);

  const validSession = report.sessions.find((s) => s.sessionId === validSessionId);
  assert.ok(validSession);
  assert.equal(validSession.isPrincipal, false);
  assert.equal(validSession.scope, "host-local");
  assert.equal(validSession.principalId, null);
  assert.equal(validSession.profile, "bob");
  assert.equal(validSession.observedOnDisk, true);

  // Malformed session ID format is diagnosed
  assert.ok(report.diagnostics.some((d) => d.code === DIAGNOSTIC_CODES.MALFORMED_RECORD && d.message.includes("Invalid session ID format")));
});

test("conflicting mappings: deterministic output under reversal and explicit ambiguity preservation", () => {
  const rowAlpha = {
    profile: "alpha",
    instanceId: deriveClientInstanceId("alpha"),
    enabled: true,
    status: "ok",
    lane: "worker",
    runtimeAdapter: "antigravity",
    deliveryMode: "worker",
    identity: {
      state: "bound",
      agentId: "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      handle: "first",
      origin: "https://example.test",
      workloadId: "workload_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  };

  const rowBeta = {
    profile: "beta",
    instanceId: deriveClientInstanceId("beta"),
    enabled: true,
    status: "ok",
    lane: "worker",
    runtimeAdapter: "codex",
    deliveryMode: "worker",
    identity: {
      state: "bound",
      agentId: "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      handle: "second",
      origin: "https://example.test",
      workloadId: "workload_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  };

  const report1 = buildIdentityInventory({ profiles: [rowAlpha, rowBeta] });
  const report2 = buildIdentityInventory({ profiles: [rowBeta, rowAlpha] });

  // 1. Output must be 100% deterministic and byte-equal regardless of input traversal order
  assert.equal(JSON.stringify(report1), JSON.stringify(report2));
  assert.deepEqual(report1, report2);

  // 2. Both observations are preserved and explicit ambiguity is maintained (no arbitrary handle winner)
  assert.equal(report1.identities.length, 1);
  const ident = report1.identities[0];
  assert.equal(ident.principalId, "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(ident.authorityOrigin, "https://example.test");
  assert.equal(ident.handle, null); // Neither "first" nor "second" arbitrarily chosen!
  assert.deepEqual(ident.handles, ["first", "second"]); // Both observations preserved!

  // Profile bindings preserve their respective observed handles
  assert.equal(ident.profiles.length, 2);
  const alphaBinding = ident.profiles.find((p) => p.profile === "alpha");
  const betaBinding = ident.profiles.find((p) => p.profile === "beta");
  assert.ok(alphaBinding);
  assert.ok(betaBinding);
  assert.equal(alphaBinding.handle, "first");
  assert.equal(betaBinding.handle, "second");

  // Diagnostics must NOT embed traversal order
  const ambigDiag = report1.diagnostics.find((d) => d.code === DIAGNOSTIC_CODES.AMBIGUOUS_MAPPING);
  assert.ok(ambigDiag);
  assert.match(ambigDiag.message, /Ambiguous profile mapping/);
  // Identity diagnostics list both profiles in stable deterministic order
  assert.ok(ident.diagnostics.some((d) => d.code === DIAGNOSTIC_CODES.AMBIGUOUS_MAPPING && d.message.includes('"alpha" and "beta"')));
});

test("stability under reordered duplicate records and session ties", () => {
  const rowAlpha1 = {
    profile: "alpha",
    instanceId: deriveClientInstanceId("alpha"),
    enabled: true,
    status: "ok",
    lane: "worker",
    runtimeAdapter: "antigravity",
    deliveryMode: "worker",
    identity: {
      state: "bound",
      agentId: "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      origin: "https://example.test",
    },
  };

  const rowAlpha2 = {
    profile: "alpha", // Duplicate profile record!
    instanceId: deriveClientInstanceId("alpha"),
    enabled: false,
    status: "disabled",
    lane: "worker",
    runtimeAdapter: "codex",
    deliveryMode: "worker",
    identity: {
      state: "unbound",
    },
  };

  const repProf1 = buildIdentityInventory({ profiles: [rowAlpha1, rowAlpha2] });
  const repProf2 = buildIdentityInventory({ profiles: [rowAlpha2, rowAlpha1] });
  assert.equal(JSON.stringify(repProf1), JSON.stringify(repProf2));
  assert.deepEqual(repProf1, repProf2);

  // Duplicate instance IDs claimed by different profiles
  const instShared = deriveClientInstanceId("alpha");
  const rowInst1 = {
    profile: "alpha",
    instanceId: instShared,
    enabled: true,
    status: "ok",
  };
  const rowInst2 = {
    profile: "beta",
    instanceId: instShared, // Claims alpha's instanceId!
    enabled: true,
    status: "ok",
  };

  const repInst1 = buildIdentityInventory({ profiles: [rowInst1, rowInst2] });
  const repInst2 = buildIdentityInventory({ profiles: [rowInst2, rowInst1] });
  assert.equal(JSON.stringify(repInst1), JSON.stringify(repInst2));
  assert.deepEqual(repInst1, repInst2);

  // Session ties with identical sessionId
  const validSessionId = "session-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const sess1 = { sessionId: validSessionId, profile: "alpha", observedOnDisk: true };
  const sess2 = { sessionId: validSessionId, profile: "beta", observedOnDisk: false };

  const repSess1 = buildIdentityInventory({ profiles: [] }, { sessions: [sess1, sess2] });
  const repSess2 = buildIdentityInventory({ profiles: [] }, { sessions: [sess2, sess1] });
  assert.equal(JSON.stringify(repSess1), JSON.stringify(repSess2));
  assert.deepEqual(repSess1, repSess2);
});

test("invalid and missing origin evidence remains unmapped fault without scoped managed identity", () => {
  const validAgentId = "agent_" + "a".repeat(32);
  const validInstId = deriveClientInstanceId("test-agent");

  // 1. Missing origin: valid profile row with identity:{state:'bound', agentId:...}
  const missingOriginReport = buildIdentityInventory({
    profiles: [
      {
        profile: "test-agent",
        instanceId: validInstId,
        enabled: true,
        identity: {
          state: "bound",
          agentId: validAgentId,
          // origin omitted!
        },
      },
    ],
  });

  // Must remain unmapped/fault, NOT an accepted scoped managed identity (never under unavailable)
  assert.equal(missingOriginReport.summary.identityCount, 0);
  assert.equal(missingOriginReport.identities.length, 0);
  assert.equal(missingOriginReport.summary.unmappedProfileCount, 1);
  assert.equal(missingOriginReport.summary.faultCount, 1);

  const unmappedMissing = missingOriginReport.unmappedProfiles[0];
  assert.equal(unmappedMissing.profile, "test-agent");
  assert.equal(unmappedMissing.status, "fault");
  assert.equal(unmappedMissing.isPrincipal, false);
  assert.equal(unmappedMissing.reason, "missing_authority_origin");
  assert.ok(missingOriginReport.diagnostics.some(
    (d) => d.code === DIAGNOSTIC_CODES.MALFORMED_RECORD
      && d.severity === "fault"
      && d.message.includes("missing required authority origin")
  ));

  // 2. Credential-bearing origin: https://user:secretpass@example.test
  const credOriginReport = buildIdentityInventory({
    profiles: [
      {
        profile: "test-agent",
        instanceId: validInstId,
        enabled: true,
        identity: {
          state: "bound",
          agentId: validAgentId,
          origin: "https://user:secretpass@example.test",
        },
      },
    ],
  });
  assert.equal(credOriginReport.summary.identityCount, 0);
  assert.equal(credOriginReport.identities.length, 0);
  assert.equal(credOriginReport.unmappedProfiles[0].status, "fault");
  // Credentials must not be echoed in diagnostics!
  assert.ok(!JSON.stringify(credOriginReport).includes("secretpass"));
  assert.ok(!JSON.stringify(credOriginReport).includes("user:"));

  // 3. Invalid origins: non-https, path, query, fragment
  const invalidOrigins = [
    "http://example.test",
    "https://example.test/path",
    "https://example.test/",
    "https://example.test?param=1",
    "https://example.test#fragment",
    "unavailable",
    "ftp://example.test",
  ];

  for (const origin of invalidOrigins) {
    const report = buildIdentityInventory({
      profiles: [
        {
          profile: "test-agent",
          instanceId: validInstId,
          enabled: true,
          identity: {
            state: "bound",
            agentId: validAgentId,
            origin,
          },
        },
      ],
    });
    assert.equal(report.summary.identityCount, 0, `Accepted invalid origin: ${origin}`);
    assert.equal(report.identities.length, 0);
    assert.equal(report.unmappedProfiles[0].status, "fault");
  }

  // 4. Missing instanceId on bound profile
  const missingInstanceReport = buildIdentityInventory({
    profiles: [
      {
        profile: "test-agent",
        // instanceId omitted!
        enabled: true,
        identity: {
          state: "bound",
          agentId: validAgentId,
          origin: "https://example.test",
        },
      },
    ],
  });
  assert.equal(missingInstanceReport.summary.identityCount, 0);
  assert.equal(missingInstanceReport.identities.length, 0);
  assert.equal(missingInstanceReport.unmappedProfiles[0].status, "fault");
  assert.equal(missingInstanceReport.unmappedProfiles[0].reason, "missing_instance_id");
  assert.ok(missingInstanceReport.diagnostics.some(
    (d) => d.code === DIAGNOSTIC_CODES.MALFORMED_RECORD
      && d.severity === "fault"
      && d.message.includes("requires a valid derived instance ID")
  ));
});

test("diagnostics exclude arbitrary underlying messages and mask malformed string payloads", () => {
  const SENTINEL_WARNING = "SENTINEL_CREDENTIAL_IN_WARNING_99999";
  const SENTINEL_BLOCKER = "SENTINEL_CREDENTIAL_IN_BLOCKER_88888";
  const MALFORMED_TOKEN_PAYLOAD = "sk-secret-payload-in-agent-id-77777";
  const MALFORMED_SESSION_SECRET = "secret-session-hex-payload-66666";

  const rawInventory = {
    warnings: [
      { code: "test_warning_code", message: SENTINEL_WARNING, profile: "bob" },
    ],
    blockers: [
      { code: "test_blocker_code", message: SENTINEL_BLOCKER, profile: "alice" },
    ],
    profiles: [
      // Valid profile with normal display labels and valid identifiers
      {
        profile: "bob",
        instanceId: deriveClientInstanceId("bob"),
        enabled: true,
        status: "ok",
        lane: "worker",
        runtimeAdapter: "codex",
        deliveryMode: "worker",
        identity: {
          state: "bound",
          agentId: "agent_11111111111111111111111111111111",
          handle: "bob-display-label",
          origin: "https://example.test",
        },
      },
      // Profile with malformed agentId string containing secret payload
      {
        profile: "alice",
        instanceId: deriveClientInstanceId("alice"),
        enabled: true,
        status: "ok",
        lane: "worker",
        runtimeAdapter: "antigravity",
        deliveryMode: "worker",
        identity: {
          state: "bound",
          agentId: MALFORMED_TOKEN_PAYLOAD,
          origin: "https://example.test",
        },
      },
    ],
  };

  const report = buildIdentityInventory(rawInventory, {
    sessions: [
      { sessionId: MALFORMED_SESSION_SECRET, profile: "bob" },
    ],
  });

  const serialized = JSON.stringify(report);

  // 1. Sentinels in underlying warning/blocker messages must NOT be copied into diagnostics
  assert.ok(!serialized.includes(SENTINEL_WARNING), "Warning sentinel message was copied into report");
  assert.ok(!serialized.includes(SENTINEL_BLOCKER), "Blocker sentinel message was copied into report");

  // Valid bounded codes and profiles are retained with fixed diagnostic text
  assert.ok(report.diagnostics.some((d) => d.code === "test_warning_code" && d.profile === "bob" && d.message.includes("Underlying installation warning (test_warning_code)")));
  assert.ok(report.diagnostics.some((d) => d.code === "test_blocker_code" && d.profile === "alice" && d.message.includes("Underlying installation blocker (test_blocker_code)")));

  // 2. Malformed payload strings in agentId and sessionId must NOT be echoed in diagnostic messages
  assert.ok(!serialized.includes(MALFORMED_TOKEN_PAYLOAD), "Malformed agent ID payload echoed in diagnostic message");
  assert.ok(!serialized.includes(MALFORMED_SESSION_SECRET), "Malformed session ID payload echoed in diagnostic message");

  // 3. Valid identifiers and normal display labels remain intact as metadata
  assert.ok(serialized.includes("agent_11111111111111111111111111111111"));
  assert.ok(serialized.includes("bob-display-label"));
  assert.ok(serialized.includes("https://example.test"));
  assert.ok(serialized.includes("bob"));
  assert.ok(serialized.includes("alice"));
});

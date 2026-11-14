// AD.5: identity view projects destination rules, validates readiness against bindings/runners, and emits diagnostics.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { deriveClientInstanceId } from "../src/identity-primitives.mjs";
import { readIdentityRegistry, setIdentityDestination, updateIdentityRegistry } from "../src/identity-registry.mjs";
import { buildIdentityView, describeDestinations } from "../src/identity-view.mjs";
import { agentBindingV1, makeRoot, makeV1Root, peerBindingV2, T2, upgradeThroughWriter } from "./identity-registry-v2-helpers.mjs";

const T3 = "2026-11-07T10:15:00.000Z";
const T4 = "2026-11-07T10:20:00.000Z";
const GRAVITY = agentBindingV1("gravity2").principal_id;
const GHOST = agentBindingV1("ghost").principal_id;
const GHOST_ID = deriveClientInstanceId("ghost");
const GRAVITY_ID = deriveClientInstanceId("gravity2");

function makeInventory(identities = []) {
  return {
    schema: "identity_inventory_v1",
    scope: "host-local",
    summary: { identityCount: identities.length, unmappedProfileCount: 0, sessionCount: 0, faultCount: 0, warningCount: 0, omittedHealthDiagnosticCount: 0 },
    identities,
    unmappedProfiles: [],
    sessions: [],
    diagnostics: [],
  };
}

const recipients = (...names) => names.map((profile) => ({ profile, instanceId: deriveClientInstanceId(profile) }));

function withRegistry(dests, fn) {
  const { base, root } = makeV1Root(["gravity2", "ghost"]);
  try {
    upgradeThroughWriter(root);
    for (const [principalId, [harness, workspace]] of Object.entries(dests)) {
      setIdentityDestination({
        root,
        expectedSequence: readIdentityRegistry({ root }).registry.sequence,
        now: T3,
        principalId,
        harness,
        workspace,
      });
    }
    return fn(root, () => structuredClone(readIdentityRegistry({ root })));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const destWarnings = (view) => view.diagnostics.filter((d) => d.code.startsWith("destination_"));

test("v2 destinations produce sorted frozen rows without warnings when active and non-runner", () => {
  withRegistry({ [GRAVITY]: ["claude", "/w/g"], [GHOST]: ["codex", "/w/gh"] }, (root, read) => {
    const view = buildIdentityView({
      inventory: makeInventory([
        { principalId: GRAVITY, authorityOrigin: "https://mesh.example.test", kind: "mesh-managed", profiles: [{ profile: "gravity2", instanceId: GRAVITY_ID, deliveryMode: "router", enabled: true, status: "ok" }] },
      ]),
      registry: read(),
      localRecipients: [],
    });
    assert.deepEqual(view.destinations.map((d) => d.state), ["active", "active"]);
    const expectedIds = [GHOST, GRAVITY].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    assert.deepEqual(view.destinations.map((d) => d.principalId), expectedIds);
    assert.deepEqual(destWarnings(view), []);
    assert.ok(Object.isFrozen(view.destinations));
    assert.ok(Object.isFrozen(view.destinations[0]));
  });
});

test("dangling and shadowed_by_runner states produce clear warnings", () => {
  withRegistry({ [GRAVITY]: ["claude", "/w/g"], [GHOST]: ["codex", "/w/gh"] }, (root, read) => {
    updateIdentityRegistry({
      root,
      expectedSequence: read().registry.sequence,
      now: T4,
      action: "revoke",
      subject: GHOST_ID,
      mutate: (r) => { r.bindings[GHOST_ID].revoked_at = T4; return r; },
    });
    const view = buildIdentityView({
      inventory: makeInventory([
        { principalId: GRAVITY, authorityOrigin: "https://mesh.example.test", kind: "mesh-managed", profiles: [{ profile: "gravity2", instanceId: GRAVITY_ID, deliveryMode: "worker", enabled: true, status: "ok" }] },
      ]),
      registry: read(),
      localRecipients: recipients("gravity2"),
    });
    const byId = Object.fromEntries(view.destinations.map((d) => [d.principalId, d]));
    assert.equal(byId[GHOST].state, "dangling");
    assert.equal(byId[GRAVITY].state, "shadowed_by_runner");
    assert.deepEqual([...byId[GRAVITY].runnerProfiles], ["gravity2"]);

    const codes = destWarnings(view).map((d) => d.code).sort();
    assert.deepEqual(codes, ["destination_dangling", "destination_shadowed_by_runner"]);
    assert.match(destWarnings(view).find((d) => d.code === "destination_shadowed_by_runner").message, /shadowed by an active runner/);
  });
});

test("disabled runner profile or router profile does not shadow destination", () => {
  withRegistry({ [GRAVITY]: ["claude", "/w/g"] }, (root, read) => {
    const view = buildIdentityView({
      inventory: makeInventory([
        {
          principalId: GRAVITY,
          authorityOrigin: "https://mesh.example.test",
          kind: "mesh-managed",
          profiles: [
            { profile: "gravity2", instanceId: GRAVITY_ID, deliveryMode: "worker", enabled: false, status: "disabled" },
            { profile: "gravity-router", instanceId: deriveClientInstanceId("gravity-router"), deliveryMode: "router", enabled: true, status: "ok" },
          ],
        },
      ]),
      registry: read(),
      localRecipients: [],
    });
    assert.equal(view.destinations[0].state, "active");
    assert.deepEqual(destWarnings(view), []);
  });
});

test("v1, absent, and unreadable registries omit destinations key; null localRecipients warns when destinations exist", () => {
  const { base, root } = makeV1Root(["gravity2"]);
  try {
    const v1 = buildIdentityView({ inventory: makeInventory(), registry: readIdentityRegistry({ root }), localRecipients: [] });
    assert.equal(Object.hasOwn(v1, "destinations"), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  const abs = makeRoot();
  try {
    assert.equal(Object.hasOwn(buildIdentityView({ inventory: makeInventory(), registry: readIdentityRegistry({ root: abs.root }) }), "destinations"), false);
  } finally {
    rmSync(abs.base, { recursive: true, force: true });
  }
  withRegistry({ [GRAVITY]: ["claude", "/w/g"] }, (root, read) => {
    const view = buildIdentityView({ inventory: makeInventory(), registry: read(), localRecipients: null });
    assert.equal(destWarnings(view).map((d) => d.code).join(","), "destination_routing_unchecked");
  });
});

test("describeDestinations tolerates damaged data and detects serverless not_mesh_managed", () => {
  assert.deepEqual(describeDestinations(), []);
  const peer = peerBindingV2("peerprof");
  const rows = describeDestinations({
    destinations: { [peer.principal_id]: { harness: "claude", workspace: "/w", set_at: T2, generation: 1 }, __proto__x: null },
    bindings: { [peer.profile_instance_id]: peer },
  });
  assert.deepEqual(rows.map((r) => [r.principalId, r.state]), [["__proto__x", "dangling"], [peer.principal_id, "not_mesh_managed"]]);
});

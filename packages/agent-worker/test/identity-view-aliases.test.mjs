// AD.2: the identity view shows the aliases of a v2 registry, one row each with a state, and a warning for every row that does not
// simply work (docs/plans/2026-11-10-identity-aliases-and-destination-rules-plan.md, 3.7). Registries are built with the real writer;
// states the writer refuses to create (a legacy duplicate binding, a binding issued after the alias) are made on a clone of the read.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { deriveClientInstanceId } from "../src/identity-primitives.mjs";
import { readIdentityRegistry, setIdentityAlias, updateIdentityRegistry } from "../src/identity-registry.mjs";
import { buildIdentityView, describeAliases } from "../src/identity-view.mjs";
import { agentBindingV1, agentBindingV2, makeRoot, makeV1Root, T2, upgradeThroughWriter } from "./identity-registry-v2-helpers.mjs";

const T3 = "2026-11-07T10:15:00.000Z";
const T4 = "2026-11-07T10:20:00.000Z";
const GRAVITY = agentBindingV1("gravity2").principal_id;
const GHOST = agentBindingV1("ghost").principal_id;
const GHOST_ID = deriveClientInstanceId("ghost");
const GRAVITY_ID = deriveClientInstanceId("gravity2");

const INVENTORY = Object.freeze({
  schema: "identity_inventory_v1",
  scope: "host-local",
  summary: { identityCount: 0, unmappedProfileCount: 0, sessionCount: 0, faultCount: 0, warningCount: 0, omittedHealthDiagnosticCount: 0 },
  identities: [],
  unmappedProfiles: [],
  sessions: [],
  diagnostics: [],
});

const recipients = (...names) => names.map((profile) => ({ profile, instanceId: deriveClientInstanceId(profile) }));

// A v2 registry with gravity2 and ghost bound and the given aliases set (name -> principal), read back and cloned so a test may bend it.
function withRegistry(aliases, fn) {
  const { base, root } = makeV1Root(["gravity2", "ghost"]);
  try {
    upgradeThroughWriter(root);
    for (const [alias, principalId] of Object.entries(aliases)) {
      setIdentityAlias({ root, expectedSequence: readIdentityRegistry({ root }).registry.sequence, now: T3, alias, principalId });
    }
    return fn(root, () => structuredClone(readIdentityRegistry({ root })));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const viewOf = (registry, localRecipients) => buildIdentityView({ inventory: INVENTORY, registry, localRecipients });
const aliasWarnings = (view) => view.diagnostics.filter((d) => d.code.startsWith("alias_"));
const states = (view) => Object.fromEntries(view.aliases.map((row) => [row.name, row.state]));

test("a v2 registry's aliases become rows sorted by code unit, active when their profile is a local recipient", () => {
  withRegistry({ builder: GRAVITY, a_b: GHOST, "a-b": GRAVITY }, (root, read) => {
    const view = viewOf(read(), recipients("gravity2", "ghost"));
    assert.deepEqual(view.aliases.map((row) => row.name), ["a-b", "a_b", "builder"]);
    assert.deepEqual(states(view), { "a-b": "active", a_b: "active", builder: "active" });
    const builder = view.aliases.find((row) => row.name === "builder");
    assert.deepEqual(
      { ...builder, profiles: [...builder.profiles] },
      { name: "builder", principalId: GRAVITY, profile: "gravity2", profiles: ["gravity2"], profileInstanceId: GRAVITY_ID, state: "active", setAt: T3, generation: builder.generation },
    );
    assert.ok(Number.isSafeInteger(builder.generation) && builder.generation > 0);
    assert.deepEqual(aliasWarnings(view), [], "an alias that works raises no warning");
    assert.equal(view.registry.collections.aliases, 3, "the count in the registry block is unchanged");
  });
});

test("dangling: the principal's only binding is revoked, so the alias resolves to nothing", () => {
  withRegistry({ ghosty: GHOST }, (root, read) => {
    updateIdentityRegistry({ root, expectedSequence: read().registry.sequence, now: T4, action: "revoke", subject: GHOST_ID, mutate: (r) => { r.bindings[GHOST_ID].revoked_at = T4; return r; } });
    const view = viewOf(read(), recipients("gravity2", "ghost"));
    assert.deepEqual(states(view), { ghosty: "dangling" });
    assert.deepEqual([view.aliases[0].profile, [...view.aliases[0].profiles], view.aliases[0].profileInstanceId], [null, [], null]);
    const [warning] = aliasWarnings(view);
    assert.deepEqual([warning.severity, warning.code], ["warning", "alias_dangling"]);
    assert.match(warning.message, /Alias ghosty points at a principal that has no active binding/);
    assert.match(warning.action, /triangle identity alias clear ghosty/);
  });
});

test("unroutable: the principal is bound, but its profile is not a local recipient of this client configuration", () => {
  withRegistry({ ghosty: GHOST, builder: GRAVITY }, (root, read) => {
    const view = viewOf(read(), recipients("gravity2"));
    assert.deepEqual(states(view), { builder: "active", ghosty: "unroutable" });
    const [warning] = aliasWarnings(view);
    assert.equal(warning.code, "alias_unroutable");
    assert.equal(warning.profile, "ghost");
    assert.match(warning.message, /ghost that is not a local recipient/);
  });
});

test("ambiguous: a principal bound to two local profiles (a legacy duplicate) is flagged, and only if both are local recipients", () => {
  withRegistry({ builder: GRAVITY }, (root, read) => {
    const registry = read();
    const twin = agentBindingV2("gravity3", { principal_id: GRAVITY });
    registry.registry.bindings[twin.profile_instance_id] = twin;
    const both = viewOf(registry, recipients("gravity2", "gravity3"));
    assert.equal(states(both).builder, "ambiguous");
    assert.deepEqual([...both.aliases[0].profiles], ["gravity2", "gravity3"]);
    assert.equal(both.aliases[0].profile, null, "no single profile to name");
    assert.equal(aliasWarnings(both)[0].code, "alias_ambiguous");
    assert.match(aliasWarnings(both)[0].message, /gravity2, gravity3/);
    // with only one of them a local recipient, a send can still reach exactly one
    assert.equal(states(viewOf(registry, recipients("gravity2"))).builder, "active");
  });
});

test("collides: a local profile has exactly the alias's name; one that differs only in case is no collision, because the router compares exactly", () => {
  withRegistry({ ghost: GRAVITY }, (root, read) => {
    const view = viewOf(read(), [...recipients("gravity2"), { profile: "ghost", instanceId: deriveClientInstanceId("ghost") }]);
    assert.equal(states(view).ghost, "collides");
    assert.equal(aliasWarnings(view)[0].code, "alias_collides");
    for (const profile of ["Ghost", "GHOST", "ghosts"]) {
      const other = viewOf(read(), [...recipients("gravity2"), { profile, instanceId: deriveClientInstanceId(profile) }]);
      assert.equal(states(other).ghost, "active", profile);
    }
  });
});

test("moved: the principal is active on another profile than its revoked binding, issued after the alias was set", () => {
  withRegistry({ builder: GRAVITY }, (root, read) => {
    const moved = (issuedAt) => {
      const registry = read();
      registry.registry.bindings[GRAVITY_ID].revoked_at = T3; // gravity2 revoked ...
      const successor = agentBindingV2("gravity3", { principal_id: GRAVITY, issued_at: issuedAt }); // ... the principal bound again elsewhere
      registry.registry.bindings[successor.profile_instance_id] = successor;
      return viewOf(registry, recipients("gravity2", "gravity3"));
    };
    const after = moved(T4);
    assert.equal(states(after).builder, "moved");
    assert.deepEqual([after.aliases[0].profile, aliasWarnings(after)[0].code], ["gravity3", "alias_moved"]);
    assert.match(aliasWarnings(after)[0].message, /now reaches gravity3/);
    assert.equal(states(moved(T2)).builder, "active", "bound there before the alias was set: the owner set it knowing");
    assert.equal(states(moved("not a time")).builder, "moved", "a time that cannot be read is flagged, not trusted");
  });
});

test("the first matching state wins: dangling, unroutable, ambiguous, collides, moved, active", () => {
  withRegistry({ ghost: GHOST, builder: GRAVITY }, (root, read) => {
    const registry = read();
    registry.registry.bindings[GHOST_ID].revoked_at = T4; // ghost: collides with the profile "ghost", but dangling
    const view = viewOf(registry, recipients("gravity2", "ghost"));
    assert.deepEqual(states(view), { builder: "active", ghost: "dangling" });
    // unroutable before collides: ghost active but not local, while a profile named like the alias exists
    const other = read();
    assert.equal(states(viewOf(other, recipients("gravity2", "ghost"))).ghost, "collides");
    assert.equal(states(viewOf(other, [...recipients("gravity2"), { profile: "ghost", instanceId: "f".repeat(64) }])).ghost, "unroutable", "a profile named ghost exists, but it is not the one the principal is bound to: unroutable outranks collides");
  });
});

test("ambiguous outranks collides, and collides outranks moved", () => {
  withRegistry({ ghost: GRAVITY }, (root, read) => {
    // two local profiles for one principal, and a local profile named like the alias
    const twin = read();
    const second = agentBindingV2("gravity3", { principal_id: GRAVITY });
    twin.registry.bindings[second.profile_instance_id] = second;
    assert.equal(states(viewOf(twin, recipients("gravity2", "gravity3", "ghost"))).ghost, "ambiguous");
    // moved, and a local profile named like the alias
    const moved = read();
    moved.registry.bindings[GRAVITY_ID].revoked_at = T3;
    const successor = agentBindingV2("gravity3", { principal_id: GRAVITY, issued_at: T4 });
    moved.registry.bindings[successor.profile_instance_id] = successor;
    assert.equal(states(viewOf(moved, recipients("gravity2", "gravity3"))).ghost, "moved");
    assert.equal(states(viewOf(moved, recipients("gravity2", "gravity3", "ghost"))).ghost, "collides");
  });
});

test("a serverless binding is no MESH-managed binding: an alias whose principal only a peer binding names is dangling", () => {
  const peer = agentBindingV2("peerone", { trust_mode: "serverless-peer", principal_id: `peer_${"1".repeat(32)}` });
  const rows = describeAliases({
    aliases: { odd: { principal_id: peer.principal_id, set_at: T3, generation: 2 } },
    bindings: { [peer.profile_instance_id]: peer },
    localRecipients: recipients("peerone"),
  });
  assert.deepEqual(rows.map((row) => [row.name, row.state, row.profile]), [["odd", "dangling", null]]);
});

test("an alias reaches the one local profile of its principal, whatever other profiles the principal has", () => {
  withRegistry({ builder: GRAVITY }, (root, read) => {
    const registry = read();
    const elsewhere = agentBindingV2("zeta", { principal_id: GRAVITY });
    registry.registry.bindings[elsewhere.profile_instance_id] = elsewhere;
    // gravity2 is local, zeta is not: a send reaches gravity2 only
    const view = viewOf(registry, recipients("gravity2"));
    const [row] = view.aliases;
    assert.deepEqual([row.state, row.profile, row.profileInstanceId, [...row.profiles]], ["active", "gravity2", GRAVITY_ID, ["gravity2", "zeta"]]);
    // with neither local, the alias is unroutable and there are two profiles to name
    const none = viewOf(registry, recipients("someone"));
    assert.deepEqual([none.aliases[0].state, none.aliases[0].profile], ["unroutable", null]);
    // with both local it is ambiguous, and no single profile is named
    const both = viewOf(registry, recipients("gravity2", "zeta"));
    assert.deepEqual([both.aliases[0].state, both.aliases[0].profile, [...both.aliases[0].profiles]], ["ambiguous", null, ["gravity2", "zeta"]]);
  });
});

test("moved needs the successor to be issued strictly after the alias was set, and says it may reach another profile, not that it does", () => {
  withRegistry({ builder: GRAVITY }, (root, read) => {
    const movedAt = (issuedAt) => {
      const registry = read();
      registry.registry.bindings[GRAVITY_ID].revoked_at = T3;
      const successor = agentBindingV2("gravity3", { principal_id: GRAVITY, issued_at: issuedAt });
      registry.registry.bindings[successor.profile_instance_id] = successor;
      return viewOf(registry, recipients("gravity2", "gravity3"));
    };
    assert.equal(states(movedAt(T3)).builder, "active", "issued at the very time the alias was set: not after");
    assert.equal(states(movedAt("2026-11-07T10:15:00.001Z")).builder, "moved");
    const [warning] = aliasWarnings(movedAt(T4));
    assert.match(warning.message, /was bound again after the alias was set, and now reaches gravity3/);
    assert.match(warning.action, /triangle identity alias clear builder --client-root DIR/);
  });
});

test("the profiles of a row are in code-unit order whatever order the registry holds them in", () => {
  withRegistry({ builder: GRAVITY }, (root, read) => {
    const registry = read();
    for (const name of ["zeta", "Alpha", "beta"]) {
      const twin = agentBindingV2(name, { principal_id: GRAVITY });
      registry.registry.bindings[twin.profile_instance_id] = twin;
    }
    assert.deepEqual([...viewOf(registry, null).aliases[0].profiles], ["Alpha", "beta", "gravity2", "zeta"]);
  });
});

test("without the client configuration's recipients only the registry's own states are judged, and one warning says so", () => {
  withRegistry({ ghosty: GHOST, ghost: GRAVITY }, (root, read) => {
    for (const unknown of [null, undefined]) {
      const view = buildIdentityView({ inventory: INVENTORY, registry: read(), ...(unknown === null ? { localRecipients: null } : {}) });
      assert.deepEqual(states(view), { ghost: "active", ghosty: "active" }, "unroutable and collides are not evaluated");
      assert.deepEqual(aliasWarnings(view).map((d) => d.code), ["alias_routing_unchecked"]);
    }
  });
  withRegistry({}, (root, read) => {
    assert.deepEqual(aliasWarnings(viewOf(read(), null)), [], "no aliases, nothing to check");
    assert.deepEqual(viewOf(read(), null).aliases, []);
  });
});

test("a registry that is not a readable v2 registry has no aliases key at all, so its view is what it always was", () => {
  const { base, root } = makeV1Root(["gravity2"]);
  try {
    const v1 = viewOf(readIdentityRegistry({ root }), recipients("gravity2"));
    assert.equal(Object.hasOwn(v1, "aliases"), false);
    assert.deepEqual(Object.keys(v1), ["schema", "registry", "summary", "profiles", "diagnostics"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  const absent = makeRoot();
  try {
    assert.equal(Object.hasOwn(viewOf(readIdentityRegistry({ root: absent.root }), []), "aliases"), false);
  } finally {
    rmSync(absent.base, { recursive: true, force: true });
  }
  assert.equal(Object.hasOwn(viewOf({ state: "unreadable", code: "EACCES" }, []), "aliases"), false);
  withRegistry({ builder: GRAVITY }, (root, read) => {
    assert.deepEqual(Object.keys(viewOf(read(), recipients("gravity2"))), ["schema", "registry", "summary", "profiles", "aliases", "diagnostics"]);
  });
});

test("the view is deterministic, deeply frozen, counts the alias warnings and shows no secret", () => {
  withRegistry({ ghosty: GHOST, builder: GRAVITY }, (root, read) => {
    const a = viewOf(read(), recipients("gravity2"));
    const b = viewOf(read(), recipients("gravity2"));
    assert.deepEqual(a, b);
    assert.ok(Object.isFrozen(a) && Object.isFrozen(a.aliases) && Object.isFrozen(a.aliases[0]) && Object.isFrozen(a.aliases[0].profiles));
    const alias = a.diagnostics.filter((d) => d.code === "alias_unroutable");
    assert.equal(alias.length, 1);
    assert.equal(a.summary.warnings, a.diagnostics.filter((d) => d.severity === "warning").length, "the summary counts them");
    assert.equal(JSON.stringify(a).includes("principal_public_key"), false);
    assert.deepEqual(Object.keys(a.aliases[0]).sort(), ["generation", "name", "principalId", "profile", "profileInstanceId", "profiles", "setAt", "state"]);
  });
});

test("describeAliases tolerates what a damaged or hostile file might hold", () => {
  assert.deepEqual(describeAliases(), []);
  assert.deepEqual(describeAliases({ aliases: null, bindings: null }), []);
  assert.deepEqual(describeAliases({ aliases: [], bindings: [] }), []);
  const rows = describeAliases({
    aliases: { constructor: { principal_id: GRAVITY, set_at: T3, generation: 3 }, odd: null, bare: {}, __proto__x: "x" },
    bindings: { x: null, y: "text", [GRAVITY_ID]: agentBindingV2("gravity2") },
    localRecipients: recipients("gravity2"),
  });
  assert.deepEqual(rows.map((row) => [row.name, row.state]), [["__proto__x", "dangling"], ["bare", "dangling"], ["constructor", "active"], ["odd", "dangling"]]);
  assert.equal(rows.find((row) => row.name === "constructor").generation, 3);
  assert.equal(rows.find((row) => row.name === "bare").principalId, null);
});

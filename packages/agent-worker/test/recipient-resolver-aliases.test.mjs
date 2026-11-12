// AD.1: the pure alias functions of the recipient resolver (docs/plans/2026-11-10-identity-aliases-and-destination-rules-plan.md,
// 3.2 and 3.3). An alias is visible to a sender only if it may message a recipient the alias resolves to; for anyone else the name is
// not an alias at all. `findAliasTargets` says what a name could mean, `decideAlias` and `resolveAliasFor` apply the sender's
// permission, and `resolveRecipient` itself is unchanged.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ALIAS_PATTERN } from "../src/identity-primitives.mjs";
import { decideAlias, findAliasTargets, resolveAliasFor, resolveRecipient } from "../src/recipient-resolver.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const hex = (char) => char.repeat(64);
const BOB = hex("b");
const CHARLIE = hex("c");
const DAVE = hex("d");
const ERIN = hex("f");
const REMOTE = hex("e"); // bound in the registry but not a local recipient
const P_BOB = `agent_${"1".repeat(32)}`;
const P_CHARLIE = `agent_${"2".repeat(32)}`;
const P_REMOTE = `agent_${"3".repeat(32)}`;
const P_SHARED = `agent_${"4".repeat(32)}`;
const P_REVOKED = `agent_${"5".repeat(32)}`;
const P_PEER = `peer_${"6".repeat(32)}`;
const RECIPIENTS = [
  { id: BOB, label: "bob" },
  { id: CHARLIE, label: "charlie" },
  { id: DAVE, label: "dave" },
];

const binding = (instance, principal, over = {}) => ({
  binding_id: `bind_${instance.slice(0, 32)}`,
  principal_id: principal,
  profile_instance_id: instance,
  trust_mode: "mesh-managed",
  revoked_at: null,
  ...over,
});

// A snapshot as the router's provider hands it out: bindings by principal and instance, and the alias names (Maps, so a name
// such as `constructor` is an ordinary key).
function snapshot({ bindings = [], aliases = {}, state = "ok" } = {}) {
  const byPrincipal = new Map();
  for (const item of bindings) byPrincipal.set(item.principal_id, [...(byPrincipal.get(item.principal_id) ?? []), item]);
  const aliasMap = new Map(Object.entries(aliases));
  return {
    state,
    sequence: 3,
    bindingsFor: (principal) => byPrincipal.get(principal) ?? [],
    bindingForInstance: (instance) => bindings.find((item) => item.profile_instance_id === instance) ?? null,
    aliasFor: (name) => aliasMap.get(name) ?? null,
    aliasesFor: (principal) => [...aliasMap].filter(([, target]) => target === principal).map(([name]) => name).sort(),
  };
}

const plain = (value) => JSON.parse(JSON.stringify(value));
const BASE = () => snapshot({
  bindings: [binding(BOB, P_BOB), binding(CHARLIE, P_CHARLIE), binding(REMOTE, P_REMOTE), binding(DAVE, P_REVOKED, { revoked_at: "2026-11-07T10:00:00.000Z" })],
  aliases: { builder: P_BOB, reviewer: P_CHARLIE, faraway: P_REMOTE, retired: P_REVOKED, constructor: P_BOB },
});

// ---- findAliasTargets ----------------------------------------------------------------------------------------------------------
test("findAliasTargets: nothing to decide for names that are not aliases, aliases that do not exist, and snapshots that cannot answer", () => {
  const snap = BASE();
  const none = (label, args) => assert.equal(findAliasTargets({ recipients: RECIPIENTS, snapshot: snap, ...args }), null, label);
  // not alias-shaped: ids, principals, labels with capitals, anything over 32 characters or with a space
  for (const name of ["Builder", "", `agent_${"1".repeat(32)}`, `peer_${"1".repeat(32)}`, BOB, `session-${BOB}`, "x".repeat(33), "a b", ".a", "-a", 5, null, undefined]) {
    none(`name ${JSON.stringify(name)}`, { name });
  }
  none("no such alias", { name: "nobody" });
  none("a name from the Object prototype that is not an alias", { name: "valueof" });
  for (const state of ["absent", "unreadable", "disabled"]) none(`snapshot ${state}`, { name: "builder", snapshot: { ...snap, state } });
  none("a double without alias support", { name: "builder", snapshot: { state: "ok", bindingsFor: () => [], bindingForInstance: () => null } });
  none("no snapshot", { name: "builder", snapshot: null });
  none("a snapshot that throws", { name: "builder", snapshot: { ...snap, aliasFor() { throw new Error("boom"); } } });
  none("recipients that are not a list", { name: "builder", recipients: null });
  none("a directory entry the resolver cannot read", { name: "builder", recipients: [{ id: "short", label: "x" }] });
});

test("findAliasTargets decides by shape itself: a snapshot that answers for any name makes nothing but an alias-shaped name an alias", () => {
  const greedy = { ...BASE(), aliasFor: () => P_BOB };
  for (const name of ["Builder", BOB, `session-${BOB}`, `agent_${"1".repeat(32)}`, "x".repeat(33), " ", "a b"]) {
    assert.equal(findAliasTargets({ name, recipients: RECIPIENTS, snapshot: greedy }), null, JSON.stringify(name));
  }
  assert.equal(findAliasTargets({ name: "anything", recipients: RECIPIENTS, snapshot: greedy }).principalId, P_BOB);
});

test("findAliasTargets compares a name with the directory labels exactly: case and affixes matter", () => {
  const recipients = [{ id: BOB, label: "bob" }, { id: CHARLIE, label: "Charlie" }, { id: DAVE, label: "charlie-2" }];
  const snap = snapshot({ bindings: [binding(BOB, P_BOB)], aliases: { charlie: P_BOB } });
  assert.deepEqual(findAliasTargets({ name: "charlie", recipients, snapshot: snap }).labelMatches, []);
  const exact = findAliasTargets({ name: "charlie", recipients: [...recipients, { id: ERIN, label: "charlie" }], snapshot: snap });
  assert.deepEqual(plain(exact.labelMatches), [{ id: ERIN, label: "charlie" }]);
});

test("findAliasTargets: an alias whose principal nothing local serves is nothing to decide", () => {
  const snap = BASE();
  const none = (name, snapshotOverride = snap) => assert.equal(findAliasTargets({ name, recipients: RECIPIENTS, snapshot: snapshotOverride }), null, name);
  none("faraway"); // bound, but the profile is not a local recipient
  none("retired"); // its only binding is revoked
  none("builder", snapshot({ bindings: [], aliases: { builder: P_BOB } })); // no binding at all
  none("builder", snapshot({ bindings: [binding(BOB, P_BOB, { trust_mode: "serverless-peer" })], aliases: { builder: P_BOB } }));
  none("builder", snapshot({ bindings: [binding(BOB, P_BOB)], aliases: { builder: P_PEER } })); // a paired remote principal never routes
  none("builder", snapshot({ bindings: [binding(BOB, P_BOB)], aliases: { builder: "not-a-principal" } }));
});

test("findAliasTargets: a bound local target is found, with the directory recipients labelled like the name", () => {
  const found = findAliasTargets({ name: "builder", recipients: RECIPIENTS, snapshot: BASE() });
  assert.deepEqual(plain(found), {
    name: "builder",
    principalId: P_BOB,
    targets: [{ id: BOB, label: "bob", bindingId: `bind_${BOB.slice(0, 32)}` }],
    labelMatches: [],
  });
  for (const part of [found, found.targets, found.labelMatches, found.targets[0]]) assert.equal(Object.isFrozen(part), true);

  // an alias named like a directory label: the label's recipient is reported, whichever recipient the alias points at
  const same = findAliasTargets({ name: "charlie", recipients: RECIPIENTS, snapshot: snapshot({ bindings: [binding(BOB, P_BOB)], aliases: { charlie: P_BOB } }) });
  assert.deepEqual(plain(same.labelMatches), [{ id: CHARLIE, label: "charlie" }]);
  assert.deepEqual(same.targets.map((target) => target.id), [BOB]);

  // a name from the Object prototype is an ordinary alias name when the owner set it
  assert.equal(findAliasTargets({ name: "constructor", recipients: RECIPIENTS, snapshot: BASE() }).principalId, P_BOB);

  // several recipients share the principal (a legacy duplicate binding): every target, in the resolver's order
  const shared = findAliasTargets({
    name: "twin",
    recipients: RECIPIENTS,
    snapshot: snapshot({ bindings: [binding(CHARLIE, P_SHARED), binding(BOB, P_SHARED)], aliases: { twin: P_SHARED } }),
  });
  assert.deepEqual(shared.targets.map((target) => target.id), [BOB, CHARLIE]);
});

// ---- decideAlias ---------------------------------------------------------------------------------------------------------------
function found(name, aliases, bindings, recipients = RECIPIENTS) {
  return findAliasTargets({ name, recipients, snapshot: snapshot({ bindings, aliases }) });
}

test("decideAlias: an alias the sender may not use is not an alias", () => {
  const unique = found("builder", { builder: P_BOB }, [binding(BOB, P_BOB)]);
  assert.deepEqual(plain(decideAlias(null, new Set([BOB]))), { kind: "pass_through" });
  assert.deepEqual(plain(decideAlias(undefined, new Set([BOB]))), { kind: "pass_through" });
  assert.deepEqual(plain(decideAlias(unique, new Set())), { kind: "pass_through" });
  assert.deepEqual(plain(decideAlias(unique, new Set([CHARLIE, DAVE]))), { kind: "pass_through" }, "permission for other recipients is not permission for the target");
  // a label match the sender may message does not make an invisible alias visible
  const collides = found("charlie", { charlie: P_BOB }, [binding(BOB, P_BOB)]);
  assert.deepEqual(plain(decideAlias(collides, new Set([CHARLIE]))), { kind: "pass_through" });
});

test("decideAlias: a visible alias resolves to its one recipient", () => {
  const unique = found("builder", { builder: P_BOB }, [binding(BOB, P_BOB)]);
  const decision = decideAlias(unique, new Set([BOB]));
  assert.deepEqual(plain(decision), {
    kind: "resolved",
    via: "alias",
    alias: "builder",
    recipientId: BOB,
    principalId: P_BOB,
    profile: "bob",
    bindingId: `bind_${BOB.slice(0, 32)}`,
  });
  assert.equal(Object.isFrozen(decision), true);
  // permission may arrive as a list as well as a set
  assert.equal(decideAlias(unique, [BOB]).kind, "resolved");
});

test("decideAlias: a name that is also the label of a recipient the sender may message never wins silently", () => {
  const collides = found("charlie", { charlie: P_BOB }, [binding(BOB, P_BOB)]);
  const both = decideAlias(collides, new Set([BOB, CHARLIE]));
  assert.deepEqual(plain(both), { kind: "error", code: "alias_unresolved", reason: "alias_collides_with_label", candidates: [] });
  assert.equal(Object.isFrozen(both), true);
  assert.equal(Object.isFrozen(both.candidates), true);
  // a label the sender cannot message is a label the sender cannot see: no collision for this sender
  assert.equal(decideAlias(collides, new Set([BOB])).kind, "resolved");
});

test("decideAlias: a principal bound to several local profiles is ambiguous for a sender that can see the alias", () => {
  const twin = found("twin", { twin: P_SHARED }, [binding(BOB, P_SHARED), binding(CHARLIE, P_SHARED)]);
  assert.deepEqual(plain(decideAlias(twin, new Set([BOB]))), { kind: "error", code: "alias_unresolved", reason: "ambiguous_binding", candidates: [] });
  assert.deepEqual(plain(decideAlias(twin, new Set([BOB, CHARLIE]))), { kind: "error", code: "alias_unresolved", reason: "ambiguous_binding", candidates: [] });
  assert.deepEqual(plain(decideAlias(twin, new Set())), { kind: "pass_through" });
  assert.deepEqual(plain(decideAlias(twin, new Set([DAVE]))), { kind: "pass_through" });
  // a collision is reported before an ambiguity
  const both = found("charlie", { charlie: P_SHARED }, [binding(BOB, P_SHARED), binding(DAVE, P_SHARED)]);
  assert.equal(decideAlias(both, new Set([BOB, CHARLIE])).reason, "alias_collides_with_label");
});

// ---- resolveAliasFor -------------------------------------------------------------------------------------------------------------
test("resolveAliasFor decides like decideAlias for a caller that answers permission synchronously", () => {
  const snap = snapshot({
    bindings: [binding(BOB, P_BOB), binding(CHARLIE, P_CHARLIE), binding(BOB, P_SHARED), binding(DAVE, P_SHARED)],
    aliases: { builder: P_BOB, reviewer: P_CHARLIE, charlie: P_BOB, twin: P_SHARED },
  });
  const via = (name, allowed) => {
    const calls = [];
    const decision = resolveAliasFor({ name, recipients: RECIPIENTS, snapshot: snap, permitted: (id) => { calls.push(id); return allowed.includes(id); } });
    return { decision: plain(decision), calls };
  };
  assert.equal(via("builder", [BOB]).decision.kind, "resolved");
  assert.equal(via("builder", [CHARLIE]).decision.kind, "pass_through");
  assert.equal(via("reviewer", [BOB]).decision.kind, "pass_through");
  assert.equal(via("charlie", [BOB, CHARLIE]).decision.reason, "alias_collides_with_label");
  assert.equal(via("charlie", [BOB]).decision.kind, "resolved");
  assert.equal(via("twin", [BOB]).decision.reason, "ambiguous_binding");
  assert.equal(via("nobody", [BOB]).decision.kind, "pass_through");
  // an unknown name asks nobody; an invisible alias asks only about its own targets
  assert.deepEqual(via("nobody", [BOB]).calls, []);
  assert.deepEqual(via("reviewer", [BOB]).calls, [CHARLIE]);
  // only an answer of exactly true is permission
  for (const answer of [1, "yes", {}, undefined, null]) {
    const decision = resolveAliasFor({ name: "builder", recipients: RECIPIENTS, snapshot: snap, permitted: () => answer });
    assert.equal(decision.kind, "pass_through", String(answer));
  }
  // and the same for the label's recipient: a truthy answer about it is no permission, so no collision
  for (const answer of [1, "yes", {}]) {
    const decision = resolveAliasFor({ name: "charlie", recipients: RECIPIENTS, snapshot: snap, permitted: (id) => (id === BOB ? true : id === CHARLIE ? answer : false) });
    assert.equal(decision.kind, "resolved", String(answer));
  }
});

// ---- what stays as it was --------------------------------------------------------------------------------------------------------
test("resolveRecipient is unchanged: an alias-shaped name still passes through it, whatever the snapshot holds", () => {
  const snap = BASE();
  for (const to of ["builder", "constructor", "nobody", "gravity2"]) {
    assert.deepEqual(resolveRecipient({ to, recipients: RECIPIENTS, snapshot: snap }), { kind: "pass_through" }, to);
  }
  assert.equal(resolveRecipient({ to: P_BOB, recipients: RECIPIENTS, snapshot: snap }).kind, "resolved");
});

test("the alias functions do not mutate their inputs and return frozen results", () => {
  const snap = BASE();
  const recipients = RECIPIENTS.map((item) => Object.freeze({ ...item }));
  Object.freeze(recipients);
  const result = findAliasTargets({ name: "builder", recipients, snapshot: snap });
  assert.equal(Object.isFrozen(result), true);
  decideAlias(result, Object.freeze(new Set([BOB])));
  assert.deepEqual(plain(recipients), RECIPIENTS);
});

// ---- the inline copies of the alias pattern ----------------------------------------------------------------------------------------
test("the alias pattern copied into the client and the owner CLI is the primitive's", () => {
  for (const file of ["../src/local-messaging-client.mjs", "../src/local-messaging-cli.mjs"]) {
    const source = fs.readFileSync(path.join(HERE, file), "utf8");
    const match = /const ALIAS(?:_NAME)?_PATTERN\s*=\s*(\/\^.*?\$\/);/.exec(source);
    assert.ok(match, `${file} declares its alias pattern`);
    assert.equal(match[1], `/${ALIAS_PATTERN.source}/`, file);
  }
});

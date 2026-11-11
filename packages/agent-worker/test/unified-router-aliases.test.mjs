// AD.1: the router's alias path (docs/plans/2026-11-10-identity-aliases-and-destination-rules-plan.md, 3.2 to 3.5 and section 5).
// An alias is visible to a sender only if it may message a recipient the alias resolves to. For anyone else the name is not an
// alias: it passes through as an exact id exactly as an unknown name does. send and discovery decide with the same rule.
import assert from "node:assert/strict";
import test from "node:test";

import { createUnifiedRouter, RouterResolutionError } from "../src/unified-router.mjs";

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
const SENDER = "a".repeat(64);
const RECIPIENTS = [
  { id: BOB, label: "bob" },
  { id: CHARLIE, label: "charlie" },
  { id: DAVE, label: "dave" },
  { id: ERIN, label: "erin" },
];

const binding = (instance, principal, over = {}) => ({
  binding_id: `bind_${instance.slice(0, 32)}`,
  principal_id: principal,
  profile_instance_id: instance,
  trust_mode: "mesh-managed",
  revoked_at: null,
  ...over,
});

function snapshot({ bindings, aliases, state = "ok" }) {
  const byPrincipal = new Map();
  for (const item of bindings) byPrincipal.set(item.principal_id, [...(byPrincipal.get(item.principal_id) ?? []), item]);
  const aliasMap = new Map(Object.entries(aliases));
  return {
    state,
    sequence: 5,
    bindingsFor: (principal) => byPrincipal.get(principal) ?? [],
    bindingForInstance: (instance) => bindings.find((item) => item.profile_instance_id === instance) ?? null,
    aliasFor: (name) => aliasMap.get(name) ?? null,
    aliasesFor: (principal) => [...aliasMap].filter(([, target]) => target === principal).map(([name]) => name).sort(),
  };
}

const BINDINGS = [
  binding(BOB, P_BOB),
  binding(CHARLIE, P_CHARLIE),
  binding(DAVE, P_SHARED),
  binding(ERIN, P_SHARED), // a legacy duplicate binding: two local profiles for one principal
  binding(REMOTE, P_REMOTE),
  binding(hex("9"), P_REVOKED, { revoked_at: "2026-11-07T10:00:00.000Z" }),
];
const ALIASES = {
  builder: P_BOB,
  reviewer: P_CHARLIE,
  charlie: P_BOB, // also the label of a recipient
  twin: P_SHARED, // two recipients
  faraway: P_REMOTE, // not a local recipient
  retired: P_REVOKED, // its only binding is revoked
};

function routerWith({ enabled = true, snap = snapshot({ bindings: BINDINGS, aliases: ALIASES }), canMessage = null, recipients = RECIPIENTS, onGet = () => {} } = {}) {
  return createUnifiedRouter({
    enabled,
    snapshotProvider: {
      get() {
        onGet();
        if (snap instanceof Error) throw snap;
        return snap;
      },
    },
    recipients,
    ...(canMessage ? { canMessage } : {}),
  });
}

const allow = (...ids) => async (_sender, id) => ids.includes(id);
const send = (router, to, options = {}) => router.resolveSend({ senderId: SENDER, to }, { throwOnError: false, ...options });
const plain = (value) => JSON.parse(JSON.stringify(value));
const PASS = (to) => ({ ok: true, resolvedTo: to, to, resolved: false, via: "id", principal: null, profile: null, bindingId: null, route: "local" });
const ZERO_ERRORS = { recipient_not_found: 0, route_unavailable: 0, recipient_ambiguous: 0, alias_unresolved: 0 };

// ---- invariant 1: with no aliases nothing changes ---------------------------------------------------------------------------------
test("with no aliases in the registry an alias-shaped name resolves exactly as it always did, and canMessage is never asked", async () => {
  const names = ["gravity2", "main", "worker-1", "builder", "constructor", "a.b_c-d", "x".repeat(32)];
  const doubles = {
    "a registry without aliases": snapshot({ bindings: BINDINGS, aliases: {} }),
    "a snapshot double that knows nothing of aliases": (() => {
      const { aliasFor, aliasesFor, ...legacy } = snapshot({ bindings: BINDINGS, aliases: {} });
      return legacy;
    })(),
  };
  for (const [label, snap] of Object.entries(doubles)) {
    const asked = [];
    const router = routerWith({ snap, canMessage: async (sender, id) => { asked.push(id); return true; } });
    for (const name of names) assert.deepEqual(plain(await send(router, name)), PASS(name), `${label}: ${name}`);
    assert.deepEqual(asked, [], label);
    assert.deepEqual(plain(router.getCounters()), { resolved: { principal: 0, id: names.length, alias: 0 }, errors: ZERO_ERRORS }, label);
  }
});

test("exact ids, principals and peer ids are unchanged when the registry holds aliases", async () => {
  const router = routerWith({ canMessage: allow(BOB, CHARLIE, DAVE, ERIN) });
  const exact = await send(router, BOB);
  assert.deepEqual([exact.ok, exact.via, exact.resolvedTo, exact.principal, exact.profile], [true, "id", BOB, P_BOB, "bob"]);
  const principal = await send(router, P_BOB);
  assert.deepEqual([principal.ok, principal.via, principal.resolved, principal.resolvedTo], [true, "principal", true, BOB]);
  const peer = await send(router, `peer_${"1".repeat(32)}`);
  assert.deepEqual([peer.ok, peer.code, peer.reason], [false, "recipient_not_found", "peer_not_supported"]);
  const session = await send(router, `session-${"7".repeat(64)}`);
  assert.deepEqual([session.ok, session.via], [true, "id"]);
});

// ---- a visible alias ---------------------------------------------------------------------------------------------------------------
test("an alias the sender can see resolves to its recipient, counted as an alias", async () => {
  const asked = [];
  const router = routerWith({ canMessage: async (sender, id) => { asked.push([sender, id]); return id === BOB; } });
  const result = await send(router, "builder");
  assert.deepEqual(plain(result), {
    ok: true,
    resolvedTo: BOB,
    to: "builder",
    resolved: true,
    via: "alias",
    principal: P_BOB,
    profile: "bob",
    bindingId: `bind_${BOB.slice(0, 32)}`,
    route: "local",
  });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(asked, [[SENDER, BOB]]);
  assert.deepEqual(plain(router.getCounters()), { resolved: { principal: 0, id: 0, alias: 1 }, errors: ZERO_ERRORS });
  // throwing is the default, and a success does not throw
  assert.equal((await router.resolveSend({ senderId: SENDER, to: "builder" })).via, "alias");
});

test("callOptions.canMessage and callOptions.recipients override the router's own", async () => {
  const router = routerWith({ canMessage: allow(), recipients: [] });
  assert.equal((await send(router, "builder")).via, "id", "nothing is permitted and nothing is local");
  const result = await send(router, "builder", { canMessage: allow(BOB), recipients: RECIPIENTS });
  assert.deepEqual([result.via, result.resolvedTo], ["alias", BOB]);
});

// ---- an alias the sender cannot use is not an alias ---------------------------------------------------------------------------------
test("an alias the sender may not use is treated exactly as an unknown name is: same result, same counters", async () => {
  const reference = routerWith({ canMessage: allow(BOB) });
  const unknown = plain(await send(reference, "nobody"));
  assert.deepEqual(unknown, PASS("nobody"));
  const referenceCounters = plain(reference.getCounters());
  assert.deepEqual(referenceCounters, { resolved: { principal: 0, id: 1, alias: 0 }, errors: ZERO_ERRORS });

  const cases = {
    "an alias to a recipient the sender may not message": { name: "reviewer", canMessage: allow(BOB) },
    "no canMessage at all": { name: "builder", canMessage: null },
    "a canMessage that throws": { name: "builder", canMessage: async () => { throw new Error("acl down"); } },
    "a canMessage that denies": { name: "builder", canMessage: async () => false },
    "a canMessage that answers null": { name: "builder", canMessage: async () => null },
    "an alias to a principal that is not a local recipient": { name: "faraway", canMessage: allow(BOB, CHARLIE, REMOTE) },
    "an alias to a revoked principal": { name: "retired", canMessage: allow(BOB, CHARLIE) },
    "an alias of a registry that cannot be read": { name: "builder", canMessage: allow(BOB), snap: snapshot({ bindings: BINDINGS, aliases: ALIASES, state: "unreadable" }) },
    "an alias of an absent registry": { name: "builder", canMessage: allow(BOB), snap: snapshot({ bindings: [], aliases: {}, state: "absent" }) },
    "a registry provider that throws": { name: "builder", canMessage: allow(BOB), snap: new Error("EACCES") },
    "an ambiguous alias none of whose recipients the sender may message": { name: "twin", canMessage: allow(BOB, CHARLIE) },
  };
  for (const [label, { name, canMessage, snap }] of Object.entries(cases)) {
    const router = routerWith({ canMessage, ...(snap ? { snap } : {}) });
    const result = plain(await send(router, name));
    assert.deepEqual(result, PASS(name), label);
    assert.deepEqual(plain(router.getCounters()), referenceCounters, label);
  }
});

test("canMessage is asked only about what decides the alias: nothing for an unknown name, an id or a principal", async () => {
  const run = async (to, permitted) => {
    const asked = [];
    const router = routerWith({ canMessage: async (sender, id) => { asked.push(id); return permitted.includes(id); } });
    await send(router, to);
    return asked;
  };
  assert.deepEqual(await run("nobody", [BOB]), []);
  assert.deepEqual(await run(BOB, [BOB]), []);
  assert.deepEqual(await run(`session-${"7".repeat(64)}`, [BOB]), []);
  assert.deepEqual(await run("reviewer", [BOB]), [CHARLIE], "an invisible alias costs one question per recipient it resolves to");
  assert.deepEqual(await run("builder", [BOB]), [BOB]);
  assert.deepEqual(await run("charlie", [BOB, CHARLIE]), [BOB, CHARLIE], "the targets first, then the label's recipient");
  assert.deepEqual(await run("charlie", []), [BOB], "a label is asked about only once the alias is visible");
  assert.deepEqual(await run("twin", [DAVE]), [DAVE, ERIN]);
});

// ---- a visible alias that cannot be used as it stands ------------------------------------------------------------------------------------
test("a visible alias that is also the label of a recipient the sender may message fails as alias_unresolved", async () => {
  const router = routerWith({ canMessage: allow(BOB, CHARLIE) });
  const failure = await send(router, "charlie");
  assert.deepEqual([failure.ok, failure.code, failure.reason], [false, "alias_unresolved", "alias_collides_with_label"]);
  assert.deepEqual(plain(failure.candidates), []);
  assert.ok(failure.error instanceof RouterResolutionError);
  await assert.rejects(router.resolveSend({ senderId: SENDER, to: "charlie" }), (error) => {
    assert.ok(error instanceof RouterResolutionError);
    assert.deepEqual([error.code, error.reason, error.message, error.candidates.length], ["alias_unresolved", "alias_collides_with_label", "alias_collides_with_label", 0]);
    return true;
  });
  assert.deepEqual(plain(router.getCounters()), { resolved: { principal: 0, id: 0, alias: 0 }, errors: { ...ZERO_ERRORS, alias_unresolved: 2 } });

  // a label the sender cannot message is a label it cannot see: for this sender there is no collision
  const narrower = routerWith({ canMessage: allow(BOB) });
  const ok = await send(narrower, "charlie");
  assert.deepEqual([ok.ok, ok.via, ok.resolvedTo], [true, "alias", BOB]);
});

test("a visible alias whose principal is bound to several local profiles fails as alias_unresolved", async () => {
  const router = routerWith({ canMessage: allow(DAVE) });
  const failure = await send(router, "twin");
  assert.deepEqual([failure.ok, failure.code, failure.reason], [false, "alias_unresolved", "ambiguous_binding"]);
  assert.equal(router.getCounters().errors.alias_unresolved, 1);
  assert.equal(router.getCounters().resolved.id, 0);
});

test("a disabled router passes every name through untouched and reads nothing", async () => {
  let reads = 0;
  const asked = [];
  const router = routerWith({ enabled: false, onGet: () => reads++, canMessage: async (sender, id) => { asked.push(id); return true; } });
  const result = await send(router, "builder");
  assert.deepEqual(plain(result), { ok: true, resolvedTo: "builder", to: "builder", resolved: false, via: null, principal: null, profile: null, bindingId: null, route: null });
  assert.deepEqual([reads, asked], [0, []]);
  assert.deepEqual(plain(router.getCounters()), { resolved: { principal: 0, id: 0, alias: 0 }, errors: ZERO_ERRORS });
});

// ---- what the receipt and the status say ------------------------------------------------------------------------------------------------
test("an alias send is reported as the principal it resolved to, and the raw journal columns never show", async () => {
  const router = routerWith({ canMessage: allow(BOB) });
  const resolution = await send(router, "builder");
  const record = { recipient: BOB, to_principal: P_BOB, resolved_via: "alias", phase: "queued_local" };
  const receipt = router.decorateSend({ accepted: true, messageId: "m1", to_principal: P_BOB, resolved_via: "alias" }, { resolution, record });
  assert.deepEqual(plain(receipt.target), { via: "principal", principal: P_BOB, profile: "bob" });
  assert.equal(Object.hasOwn(receipt, "resolved_via"), false);
  assert.equal(Object.hasOwn(receipt, "to_principal"), false);
  // with only the resolution (no stored record) it is the same
  const bare = router.decorateSend({ accepted: true, messageId: "m1" }, { resolution });
  assert.deepEqual(plain(bare.target), { via: "principal", principal: P_BOB, profile: "bob" });
  // and a stored alias row reports the same later
  const status = router.decorateStatus({ phase: "queued_local", messageId: "m1", to_principal: P_BOB, resolved_via: "alias" }, { record });
  assert.deepEqual(plain(status.target), { via: "principal", principal: P_BOB, profile: "bob" });
  assert.equal(Object.hasOwn(status, "resolved_via"), false);
  const fromResolution = router.decorateStatus({ phase: "queued_local", messageId: "m1" }, { resolution });
  assert.deepEqual(plain(fromResolution.target), { via: "principal", principal: P_BOB, profile: "bob" });
});

test("the status block says which address forms this process resolves, and counts aliases", async () => {
  const on = routerWith({ canMessage: allow(BOB) });
  assert.deepEqual(plain(on.statusBlock()).registry.addressForms, ["alias", "id", "principal"]);
  assert.deepEqual(plain(on.statusBlock()).resolved, { principal: 0, id: 0, alias: 0 });
  await send(on, "builder");
  await send(on, "reviewer");
  assert.deepEqual(plain(on.statusBlock()).resolved, { principal: 0, id: 1, alias: 1 });
  on.resetCounters();
  assert.deepEqual(plain(on.statusBlock()).resolved, { principal: 0, id: 0, alias: 0 });
  assert.deepEqual(plain(on.statusBlock()).errors, ZERO_ERRORS);

  const off = routerWith({ enabled: false });
  assert.deepEqual(plain(off.statusBlock()).registry.addressForms, ["id"]);
  assert.equal(Object.isFrozen(on.statusBlock().registry.addressForms), true);
});

// ---- discovery ---------------------------------------------------------------------------------------------------------------------------
const byId = (list) => new Map(list.map((entry) => [entry.id, entry]));

test("discovery lists the aliases that would reach exactly an entry the caller may message, sorted, and leaves addressKinds alone", () => {
  const router = routerWith();
  const permitted = (id) => id === BOB || id === CHARLIE;
  const explained = byId(plain(router.describeAddresses([BOB, CHARLIE, DAVE, ERIN], { permitted })));
  // bob: builder resolves; charlie is also the label of a recipient the caller may message, so it is not usable
  assert.deepEqual(explained.get(BOB).send, { permitted: true, addressKinds: ["id", "principal"], aliases: ["builder"] });
  assert.deepEqual(explained.get(CHARLIE).send, { permitted: true, addressKinds: ["id", "principal"], aliases: ["reviewer"] });
  // an entry the caller may not message shows no alias, and no key for it
  assert.deepEqual(explained.get(DAVE).send, { permitted: false, addressKinds: [] });
  // a principal shared by two local profiles names neither of them, so its alias is listed for neither
  assert.equal(Object.hasOwn(explained.get(ERIN).send, "aliases"), false);
  for (const entry of explained.values()) assert.ok(entry.send.addressKinds.every((kind) => kind === "id" || kind === "principal"));
});

test("discovery shows no alias key when there is nothing to list, and none without a permission gate", () => {
  const router = routerWith({ snap: snapshot({ bindings: BINDINGS, aliases: {} }) });
  const explained = plain(router.describeAddresses([BOB], { permitted: () => true }))[0];
  assert.deepEqual(explained.send, { permitted: true, addressKinds: ["id", "principal"] });
  const noGate = plain(routerWith().describeAddresses([BOB]))[0];
  assert.equal(Object.hasOwn(noGate, "send"), false);
});

test("discovery lists at most eight names, the first eight in order", () => {
  const aliases = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`n${String(i).padStart(2, "0")}`, P_BOB]));
  const router = routerWith({ snap: snapshot({ bindings: BINDINGS, aliases }) });
  const entry = plain(router.describeAddresses([BOB], { permitted: () => true }))[0];
  assert.deepEqual(entry.send.aliases, ["n00", "n01", "n02", "n03", "n04", "n05", "n06", "n07"]);
});

test("a permission gate that throws lists nothing, and an unreadable registry lists nothing", () => {
  const throwing = routerWith().describeAddresses([BOB], { permitted: () => { throw new Error("gate down"); } });
  assert.deepEqual(plain(throwing[0].send), { permitted: false, addressKinds: [] });
  const unreadable = routerWith({ snap: snapshot({ bindings: BINDINGS, aliases: ALIASES, state: "unreadable" }) });
  const entry = plain(unreadable.describeAddresses([BOB], { permitted: () => true }))[0];
  assert.deepEqual(entry.send, { permitted: true, addressKinds: ["id"] });
  const double = (() => {
    const { aliasFor, aliasesFor, ...legacy } = snapshot({ bindings: BINDINGS, aliases: ALIASES });
    return legacy;
  })();
  assert.deepEqual(plain(routerWith({ snap: double }).describeAddresses([BOB], { permitted: () => true }))[0].send, { permitted: true, addressKinds: ["id", "principal"] });
});

test("discovery does not move the send counters", () => {
  const router = routerWith();
  router.describeAddresses([BOB, CHARLIE], { permitted: () => true });
  assert.deepEqual(plain(router.getCounters()), { resolved: { principal: 0, id: 0, alias: 0 }, errors: ZERO_ERRORS });
});

// ---- send and discovery decide the same way ------------------------------------------------------------------------------------------------
test("for every combination of permissions, the names discovery lists are exactly the aliases a send resolves to that entry", async () => {
  const ids = [BOB, CHARLIE, DAVE, ERIN];
  for (let mask = 0; mask < 1 << ids.length; mask += 1) {
    const allowed = new Set(ids.filter((_, bit) => (mask >> bit) & 1));
    const router = routerWith({ canMessage: async (sender, id) => allowed.has(id) });
    const resolvedPairs = [];
    for (const name of Object.keys(ALIASES)) {
      const result = await send(router, name);
      if (result.via === "alias") resolvedPairs.push(`${name}->${result.resolvedTo}`);
    }
    const listedPairs = [];
    for (const entry of plain(router.describeAddresses(ids, { permitted: (id) => allowed.has(id) }))) {
      for (const name of entry.send.aliases ?? []) listedPairs.push(`${name}->${entry.id}`);
    }
    assert.deepEqual(listedPairs.sort(), resolvedPairs.sort(), `permissions ${[...allowed].map((id) => id[0]).join("") || "none"}`);
  }
});

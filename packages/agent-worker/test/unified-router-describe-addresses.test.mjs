import test from "node:test";
import assert from "node:assert/strict";
import { createUnifiedRouter } from "../src/unified-router.mjs";

// describeAddresses is the read-only, caller-relative explanation of local addresses behind `sessions` and `discover`:
// route, principal (with whether "none" is known), and the address forms that reach exactly that recipient for this
// caller. It must agree with what send resolves and must not move the router's send counters.

const hex = (char) => char.repeat(64);
const BOB = hex("b");
const CHARLIE = hex("c");
const DAVE = hex("d");
const REMOTE = hex("e"); // bound in the registry but not a local recipient
const SESSION = `session-${hex("5")}`;
const P_BOB = `agent_${"1".repeat(32)}`;
const P_SHARED = `agent_${"2".repeat(32)}`;
const P_REMOTE_PAIR = `agent_${"3".repeat(32)}`;

const binding = (instance, principal) => ({
  binding_id: `bind_${instance.slice(0, 32)}`,
  principal_id: principal,
  profile_instance_id: instance,
  trust_mode: "mesh-managed",
  revoked_at: null,
});

function okSnapshot(bindings) {
  const byInstance = new Map(bindings.map((item) => [item.profile_instance_id, item]));
  const byPrincipal = new Map();
  for (const item of bindings) byPrincipal.set(item.principal_id, [...(byPrincipal.get(item.principal_id) ?? []), item]);
  return {
    state: "ok",
    sequence: 4,
    bindingForInstance: (id) => byInstance.get(id) ?? null,
    bindingsFor: (principal) => byPrincipal.get(principal) ?? [],
  };
}

const recipients = [
  { id: BOB, label: "bob" },
  { id: CHARLIE, label: "charlie" },
  { id: DAVE, label: "dave" },
];

function routerWith({ enabled = true, snapshot, directory = recipients, onGet = () => {} } = {}) {
  return createUnifiedRouter({
    enabled,
    snapshotProvider: {
      get() {
        onGet();
        if (snapshot instanceof Error) throw snapshot;
        return snapshot;
      },
    },
    recipients: directory,
  });
}

const allowAll = () => true;
const byId = (list) => new Map(list.map((item) => [item.id, item]));

test("a disabled router explains nothing and does not read the registry", () => {
  let reads = 0;
  const router = routerWith({ enabled: false, snapshot: okSnapshot([]), onGet: () => reads++ });
  assert.equal(router.describeAddresses([BOB], { permitted: allowAll }), null);
  assert.equal(reads, 0);
});

test("principal state keeps unknown as unknown: bound, unbound (known none) or unknown (registry unreadable)", () => {
  const ok = routerWith({ snapshot: okSnapshot([binding(BOB, P_BOB)]) }).describeAddresses([BOB, CHARLIE, SESSION], { permitted: allowAll });
  assert.deepEqual(ok.map(({ id, principal, principalState }) => ({ id, principal, principalState })), [
    { id: BOB, principal: P_BOB, principalState: "bound" },
    { id: CHARLIE, principal: null, principalState: "unbound" },
    { id: SESSION, principal: null, principalState: "unbound" },
  ]);

  const absent = routerWith({ snapshot: { state: "absent", sequence: 0, bindingForInstance: () => null, bindingsFor: () => [] } })
    .describeAddresses([BOB], { permitted: allowAll });
  assert.deepEqual([absent[0].principal, absent[0].principalState], [null, "unbound"], "no registry means nothing is bound");

  const unreadableState = routerWith({ snapshot: { state: "unreadable", sequence: 0, bindingForInstance: () => null, bindingsFor: () => [] } })
    .describeAddresses([BOB], { permitted: allowAll });
  assert.deepEqual([unreadableState[0].principal, unreadableState[0].principalState], [null, "unknown"]);

  const throwing = routerWith({ snapshot: Object.assign(new Error("EACCES"), { code: "EACCES" }) }).describeAddresses([BOB], { permitted: allowAll });
  assert.deepEqual([throwing[0].principal, throwing[0].principalState], [null, "unknown"], "a provider failure is unknown, never unbound");
  assert.ok(!JSON.stringify(throwing).includes("EACCES"), "no error text reaches the explanation");
});

test("the exact id is always an address kind for a permitted caller; a principal only when it names exactly this recipient", () => {
  const snapshot = okSnapshot([
    binding(BOB, P_BOB),
    binding(CHARLIE, P_SHARED),
    binding(DAVE, P_SHARED), // shared with charlie: ambiguous
    binding(REMOTE, P_REMOTE_PAIR),
  ]);
  const router = routerWith({ snapshot });
  const byAddress = byId(router.describeAddresses([BOB, CHARLIE, SESSION], { permitted: allowAll }));
  assert.deepEqual(byAddress.get(BOB).send, { permitted: true, addressKinds: ["id", "principal"] });
  assert.deepEqual(byAddress.get(CHARLIE).send, { permitted: true, addressKinds: ["id"] }, "a shared principal is not an address for either recipient");
  assert.equal(byAddress.get(CHARLIE).principal, P_SHARED, "the principal itself is still reported");
  assert.deepEqual(byAddress.get(SESSION).send, { permitted: true, addressKinds: ["id"] });

  // Only local recipients count: a principal also bound to a profile that is not local still names one local recipient.
  const withRemote = routerWith({ snapshot: okSnapshot([binding(BOB, P_REMOTE_PAIR), binding(REMOTE, P_REMOTE_PAIR)]) });
  assert.deepEqual(withRemote.describeAddresses([BOB], { permitted: allowAll })[0].send.addressKinds, ["id", "principal"]);
});

test("a caller that may not send gets no address kinds, and the explanation never names other candidates", () => {
  const snapshot = okSnapshot([binding(BOB, P_SHARED), binding(DAVE, P_SHARED), binding(CHARLIE, P_BOB)]);
  const router = routerWith({ snapshot });
  const explained = router.describeAddresses([BOB, CHARLIE], { permitted: (id) => id === BOB });
  assert.deepEqual(explained[0].send, { permitted: true, addressKinds: ["id"] });
  assert.deepEqual(explained[1].send, { permitted: false, addressKinds: [] });
  assert.equal(explained[1].principal, P_BOB);
  const text = JSON.stringify(explained);
  for (const hidden of [DAVE, "dave"]) assert.ok(!text.includes(hidden), `${hidden} must not appear`);
});

test("without a send gate the router claims nothing about sending", () => {
  const [row] = routerWith({ snapshot: okSnapshot([binding(BOB, P_BOB)]) }).describeAddresses([BOB]);
  assert.equal(Object.hasOwn(row, "send"), false);
  assert.equal(row.route, "local");
  assert.equal(row.principal, P_BOB);
});

test("a malformed local directory makes the principal form unavailable instead of throwing", () => {
  const router = routerWith({
    snapshot: okSnapshot([binding(BOB, P_BOB)]),
    directory: [{ id: BOB, label: "bob" }, { id: "grok-recipient", label: "Grok test" }],
  });
  const [row] = router.describeAddresses([BOB], { permitted: allowAll });
  assert.deepEqual(row.send, { permitted: true, addressKinds: ["id"] });
});

test("explanations are frozen, ordered like the request, and read-only", () => {
  const router = routerWith({ snapshot: okSnapshot([binding(BOB, P_BOB), binding(CHARLIE, P_SHARED), binding(DAVE, P_SHARED)]) });
  const before = JSON.stringify([router.getCounters(), router.statusBlock()]);
  const explained = router.describeAddresses([CHARLIE, BOB, SESSION], { permitted: allowAll });
  assert.deepEqual(explained.map((row) => row.id), [CHARLIE, BOB, SESSION]);
  assert.ok(Object.isFrozen(explained) && explained.every((row) => Object.isFrozen(row) && Object.isFrozen(row.send) && Object.isFrozen(row.send.addressKinds)));
  assert.deepEqual(Object.keys(explained[0]).sort(), ["id", "principal", "principalState", "route", "send"]);
  assert.equal(JSON.stringify([router.getCounters(), router.statusBlock()]), before, "no send counter or error counter moved");
});

test("the explanation agrees with what send resolves", async () => {
  const snapshot = okSnapshot([binding(BOB, P_BOB), binding(CHARLIE, P_SHARED), binding(DAVE, P_SHARED)]);
  const router = routerWith({ snapshot });
  for (const row of router.describeAddresses([BOB, CHARLIE, DAVE], { permitted: allowAll })) {
    if (row.principal === null) continue;
    const resolution = await router.resolveSend({ senderId: hex("a"), to: row.principal }, { throwOnError: false, canMessage: allowAll });
    assert.equal(resolution.ok && resolution.resolvedTo === row.id, row.send.addressKinds.includes("principal"), row.id);
  }
});

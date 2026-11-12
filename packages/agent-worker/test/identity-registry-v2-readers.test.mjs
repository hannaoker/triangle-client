// D1.2: the readers understand registry v2. The snapshot provider and the router status block report the schema; the resolver,
// the router, the status view and the mapping planner answer a v2 registry exactly as they answer its v1 original; nothing else
// in a v2 file (serverless bindings, pairings, aliases, destinations) reaches a send; and migrate plans in the shape of the
// registry it writes to.
import assert from "node:assert/strict";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { applyIdentityMapping, planIdentityMapping } from "../src/identity-mapping.mjs";
import { deriveClientInstanceId } from "../src/identity-primitives.mjs";
import { buildIdentityView } from "../src/identity-view.mjs";
import {
  canonicalJson,
  IDENTITY_REGISTRY_SCHEMA,
  IDENTITY_REGISTRY_SCHEMA_V2,
  LOCAL_PROFILE_BINDING_SCHEMA,
  LOCAL_PROFILE_BINDING_SCHEMA_V2,
  readIdentityRegistry,
  REGISTRY_FILE_NAME,
  SUPPORTED_REGISTRY_SCHEMAS,
} from "../src/identity-registry.mjs";
import { resolveRecipient } from "../src/recipient-resolver.mjs";
import { createRegistrySnapshotProvider } from "../src/router-registry-snapshot.mjs";
import { createUnifiedRouter } from "../src/unified-router.mjs";
import {
  agentBindingV1,
  appendAndCommit,
  auditLines,
  makeV1Root,
  peerBindingV2,
  readRaw,
  serverlessPairing,
  T0,
  T2,
  upgradeThroughWriter,
} from "./identity-registry-v2-helpers.mjs";

const V1 = IDENTITY_REGISTRY_SCHEMA;
const V2 = IDENTITY_REGISTRY_SCHEMA_V2;
const NAMES = ["gravity2", "ghost", "codex-headless"];
const ORIGIN = "https://mesh.example.test";
const instanceOf = deriveClientInstanceId;
const principalOf = (name) => agentBindingV1(name).principal_id;
// gravity2 and ghost are local recipients; codex-headless is bound in the registry but not local; scratch is local and unbound
const RECIPIENTS = ["gravity2", "ghost", "scratch"].map((name) => ({ id: instanceOf(name), label: name }));
const SESSION = `session-${"5".repeat(64)}`;
const TARGETS = [
  principalOf("gravity2"),
  principalOf("ghost"),
  principalOf("codex-headless"),
  `agent_${"0".repeat(32)}`,
  `peer_${"0".repeat(32)}`,
  instanceOf("gravity2"),
  instanceOf("scratch"),
  "f".repeat(64),
  "gravity2",
];
const plain = (value) => JSON.parse(JSON.stringify(value));

function withRoots(count, fn, names = NAMES) {
  const roots = Array.from({ length: count }, () => makeV1Root(names));
  const run = async () => fn(...roots.map((entry) => entry.root));
  return run().finally(() => {
    for (const { base } of roots) rmSync(base, { recursive: true, force: true });
  });
}

function readersFor(root, { enabled = true, recipients = RECIPIENTS } = {}) {
  const provider = createRegistrySnapshotProvider({ root });
  const router = createUnifiedRouter({ enabled, snapshotProvider: provider, recipients: () => recipients });
  return { provider, router };
}

// A serverless binding, a pairing, an alias and a destination: the records the writer cannot create yet.
function seedExtras(root, { revoked = false } = {}) {
  const peer = peerBindingV2("peerprof", revoked ? { revoked_at: T2 } : {});
  const pair = serverlessPairing(1, peer.principal_id);
  appendAndCommit(root, {
    action: "bind",
    subject: peer.profile_instance_id,
    bindingId: peer.binding_id,
    change: (registry) => ({
      ...registry,
      bindings: { ...registry.bindings, [peer.profile_instance_id]: peer },
      ...(revoked
        ? {}
        : {
            pairings: { [pair.pairing_id]: pair },
            aliases: { gravity: { principal_id: principalOf("gravity2"), set_at: T0, generation: 1 } },
            destinations: { [principalOf("gravity2")]: { harness: "claude", workspace: "/w", set_at: T0, generation: 1 } },
          }),
    }),
  });
  return { peer, pair };
}

function inventoryFor({ extraUnmapped = [], extraNew = [] } = {}) {
  const mesh = (name, principal = principalOf(name)) => ({
    principalId: principal,
    authorityOrigin: ORIGIN,
    kind: "mesh-managed",
    profiles: [{ profile: name, instanceId: instanceOf(name), enabled: true, status: "ok" }],
  });
  return {
    schema: "identity_inventory_v1",
    scope: "host-local",
    summary: { identityCount: 3, unmappedProfileCount: 1 + extraUnmapped.length, sessionCount: 0, faultCount: 0, warningCount: 0, omittedHealthDiagnosticCount: 0 },
    identities: [
      mesh("gravity2"),
      mesh("ghost"),
      mesh("newbie", `agent_${"7".repeat(32)}`),
      ...extraNew.map((name, i) => mesh(name, `agent_${String(i + 1).repeat(32)}`)),
    ],
    unmappedProfiles: [
      { profile: "scratch", instanceId: instanceOf("scratch"), enabled: true, status: "ok", reason: "unbound_local_profile" },
      ...extraUnmapped.map((profile) => ({ profile, instanceId: instanceOf(profile), enabled: true, status: "ok", reason: "unbound_local_profile" })),
    ],
    sessions: [],
    diagnostics: [],
  };
}

async function sendTranscript(router, targets) {
  const out = [];
  for (const to of targets) {
    const { error, ...rest } = await router.resolveSend({ senderId: "s1", to }, { throwOnError: false });
    out.push(plain(rest));
  }
  return out;
}

function routerTranscript(router, provider, { targets = TARGETS, recipients = RECIPIENTS } = {}) {
  return (async () => {
    const snapshot = provider.get();
    const sends = await sendTranscript(router, targets);
    const addresses = plain(router.describeAddresses([...recipients.map((r) => r.id), SESSION], { permitted: () => true }));
    const status = plain(router.statusBlock());
    delete status.registry.schema; // the schema and the sequence are what a v2 registry is allowed to differ in
    delete status.registry.sequence;
    const resolver = targets.map((to) => plain(resolveRecipient({ to, recipients, snapshot })));
    return { sends, addresses, status, resolver };
  })();
}

function viewAndPlan(root) {
  const inventory = inventoryFor();
  const registry = readIdentityRegistry({ root });
  const view = plain(buildIdentityView({ inventory, registry }));
  const plan = planIdentityMapping({ inventory, registry });
  return {
    registry,
    view: {
      profiles: view.profiles,
      diagnostics: view.diagnostics,
      summary: view.summary,
      registry: { state: view.registry.state, errorCode: view.registry.errorCode, auditUncommittedTail: view.registry.auditUncommittedTail },
    },
    plan: {
      unchanged: plain(plan.unchanged),
      blocked: plain(plan.blocked),
      localOnly: plain(plan.localOnly),
      summary: plain(plan.summary),
      // the proposed records differ in shape on purpose; everything else about them is the same
      proposals: plan.proposals.map((proposal) => {
        const { schema, principal_public_key, ...rest } = plain(proposal);
        return rest;
      }),
    },
  };
}

function writeSchema(root, schema) {
  const file = path.join(root, REGISTRY_FILE_NAME);
  writeFileSync(file, `${canonicalJson({ ...readRaw(root), schema })}\n`);
  chmodSync(file, 0o600);
}

// ---- the schema is reported -----------------------------------------------------------------------------------------------------
test("the supported schema list is exactly what the reader accepts", () =>
  withRoots(1, (root) => {
    assert.deepEqual([...SUPPORTED_REGISTRY_SCHEMAS], [V1, V2]);
    assert.equal(readIdentityRegistry({ root }).registry.schema, V1);
    upgradeThroughWriter(root);
    assert.equal(readIdentityRegistry({ root }).registry.schema, V2);
    // a schema that is not on the list is refused loudly, never read best effort
    writeSchema(root, "identity_registry_v3");
    assert.throws(() => readIdentityRegistry({ root }), (err) => err.code === "registry_corrupt");
  }));

test("the snapshot reports the schema it read: v1, v2, none and unreadable", () =>
  withRoots(1, (root) => {
    const provider = createRegistrySnapshotProvider({ root });
    const before = provider.get();
    assert.deepEqual([before.state, before.schema], ["ok", V1]);
    upgradeThroughWriter(root);
    const after = provider.get(); // the replaced file has a new stat key, so the provider reads again
    assert.deepEqual([after.state, after.schema, after.sequence], ["ok", V2, before.sequence + 1]);
    // the snapshot hands out agent bindings and, since AD.1, the alias names of a v2 file, and nothing else
    assert.deepEqual(Object.keys(after).sort(), ["aliasFor", "aliasesFor", "bindingForInstance", "bindingsFor", "errorCode", "readAt", "schema", "sequence", "state"]);

    const absent = createRegistrySnapshotProvider({ root: path.join(root, "nowhere") }).get();
    assert.deepEqual([absent.state, absent.schema], ["absent", null]);

    writeSchema(root, "identity_registry_v3");
    const unreadable = createRegistrySnapshotProvider({ root }).get();
    assert.deepEqual([unreadable.state, unreadable.schema, unreadable.errorCode], ["unreadable", null, "registry_corrupt"]);
  }));

test("local_status reports the schema and the schemas this process can read, also while the router is disabled", () =>
  withRoots(1, (root) => {
    const { router } = readersFor(root);
    const forms = ["alias", "id", "principal"]; // AD.1: the address forms an enabled router resolves
    assert.deepEqual(plain(router.statusBlock()).registry, { state: "ok", sequence: 4, schema: V1, supportedSchemas: [V1, V2], addressForms: forms });
    upgradeThroughWriter(root);
    assert.deepEqual(plain(router.statusBlock()).registry, { state: "ok", sequence: 5, schema: V2, supportedSchemas: [V1, V2], addressForms: forms });

    // the upgrade asks the running process what it can read, so a disabled router still answers
    const disabled = plain(readersFor(root, { enabled: false }).router.statusBlock());
    assert.equal(disabled.enabled, false);
    assert.deepEqual(disabled.registry, { state: "disabled", sequence: 0, schema: null, supportedSchemas: [V1, V2], addressForms: ["id"] });

    const none = plain(readersFor(path.join(root, "nowhere")).router.statusBlock());
    assert.deepEqual(none.registry, { state: "absent", sequence: 0, schema: null, supportedSchemas: [V1, V2], addressForms: forms });

    const failing = createUnifiedRouter({ enabled: true, snapshotProvider: { get() { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } }, recipients: () => RECIPIENTS });
    assert.deepEqual(plain(failing.statusBlock()).registry, { state: "unreadable", sequence: 0, schema: null, supportedSchemas: [V1, V2], addressForms: forms });
  }));

// ---- golden: v1 and its upgraded v2 form -----------------------------------------------------------------------------------------
test("golden: a v1 registry and its upgraded v2 form give the same resolver, router, status, view and mapping plan", () =>
  withRoots(2, async (v1Root, v2Root) => {
    upgradeThroughWriter(v2Root);
    const a = readersFor(v1Root);
    const b = readersFor(v2Root);
    const routerV1 = await routerTranscript(a.router, a.provider);
    const routerV2 = await routerTranscript(b.router, b.provider);
    assert.deepEqual(routerV2, routerV1);

    // the transcript covers every kind of answer, so equality means something
    assert.deepEqual(
      routerV1.sends.map((s) => (s.ok ? `${s.via}:${s.principal ? "bound" : "none"}` : `${s.code}/${s.reason}`)),
      [
        "principal:bound",
        "principal:bound",
        "route_unavailable/not_a_local_recipient",
        "recipient_not_found/no_binding",
        "recipient_not_found/peer_not_supported",
        "id:bound",
        "id:none",
        "id:none",
        "id:none",
      ],
    );

    const first = viewAndPlan(v1Root);
    const second = viewAndPlan(v2Root);
    assert.deepEqual(second.view, first.view);
    assert.deepEqual(second.plan, first.plan);
    assert.deepEqual(
      first.view.profiles.map((p) => `${p.profile}:${p.state}`),
      ["codex-headless:recorded_only", "ghost:recorded", "gravity2:recorded", "newbie:not_recorded", "scratch:local_only"],
    );
    // what a v2 registry may differ in
    assert.deepEqual([first.registry.registry.schema, second.registry.registry.schema], [V1, V2]);
    assert.equal(second.registry.registry.sequence, first.registry.registry.sequence + 1);
  }));

// ---- nothing else in a v2 file reaches a send ------------------------------------------------------------------------------------
test("serverless bindings, pairings and destinations change no send, an alias only what AD.1 says; peer ids stay unsupported", () =>
  withRoots(2, async (plainRoot, extrasRoot) => {
    upgradeThroughWriter(plainRoot);
    upgradeThroughWriter(extrasRoot);
    const { peer, pair } = seedExtras(extrasRoot);
    // the serverless profile is a local recipient too: an exact-id send can reach it, but it has no principal
    const recipients = [...RECIPIENTS, { id: peer.profile_instance_id, label: "peerprof" }];
    const extraTargets = [peer.principal_id, pair.remote_principal_id, "gravity", peer.profile_instance_id];

    const a = readersFor(plainRoot, { recipients });
    const b = readersFor(extrasRoot, { recipients });
    const plainTranscript = await routerTranscript(a.router, a.provider, { targets: TARGETS, recipients });
    const extrasTranscript = await routerTranscript(b.router, b.provider, { targets: TARGETS, recipients });
    // every answer is unchanged, even the address explanation of the serverless profile itself, except what AD.1 adds on purpose:
    // the alias names the owner set for an entry
    const withoutAliasNames = (transcript) => ({
      ...transcript,
      addresses: transcript.addresses.map((entry) => {
        if (!entry.send) return entry;
        const { aliases, ...send } = entry.send;
        return { ...entry, send };
      }),
    });
    assert.deepEqual(withoutAliasNames(extrasTranscript), withoutAliasNames(plainTranscript));
    const listedAliases = (transcript, id) => transcript.addresses.find((entry) => entry.id === id).send.aliases;
    assert.deepEqual(listedAliases(extrasTranscript, instanceOf("gravity2")), ["gravity"]);
    assert.equal(listedAliases(plainTranscript, instanceOf("gravity2")), undefined);

    const extraSends = await sendTranscript(b.router, extraTargets);
    const [peerSend, remoteSend, aliasSend, exactSend] = extraSends;
    assert.deepEqual([peerSend.ok, peerSend.code, peerSend.reason], [false, "recipient_not_found", "peer_not_supported"]);
    assert.deepEqual([remoteSend.ok, remoteSend.code, remoteSend.reason], [false, "recipient_not_found", "peer_not_supported"]);
    // a router that cannot ask whether the sender may message the target sees an alias as any other name; with the permission it
    // resolves, to the principal's recipient, and the registry still holds nothing else a send could use
    assert.deepEqual([aliasSend.ok, aliasSend.via, aliasSend.resolved, aliasSend.principal], [true, "id", false, null]);
    const permitting = createUnifiedRouter({ enabled: true, snapshotProvider: b.provider, recipients, canMessage: () => true });
    const viaAlias = plain(await permitting.resolveSend({ senderId: "s1", to: "gravity" }, { throwOnError: false }));
    assert.deepEqual(
      [viaAlias.ok, viaAlias.via, viaAlias.resolved, viaAlias.resolvedTo, viaAlias.principal],
      [true, "alias", true, instanceOf("gravity2"), principalOf("gravity2")],
    );
    // the serverless profile's exact id carries no principal: the router skips the binding
    assert.deepEqual([exactSend.ok, exactSend.via, exactSend.principal, exactSend.profile], [true, "id", null, "peerprof"]);
    const explained = plain(b.router.describeAddresses([peer.profile_instance_id], { permitted: () => true }))[0];
    assert.deepEqual([explained.principal, explained.principalState], [null, "unbound"]);

    const snapshot = b.provider.get();
    assert.equal(snapshot.bindingForInstance(peer.profile_instance_id), null);
    assert.deepEqual([...snapshot.bindingsFor(peer.principal_id)], []);
    assert.equal(snapshot.bindingsFor(principalOf("gravity2")).length, 1);
    assert.equal(canonicalJson(snapshot.bindingsFor(principalOf("gravity2"))[0]), canonicalJson(a.provider.get().bindingsFor(principalOf("gravity2"))[0]));
    assert.ok(!JSON.stringify(plain(snapshot)).includes(pair.pairing_id), "no pairing reaches the snapshot");
  }));

test("the resolver skips a serverless-peer binding even when a snapshot hands one over, and never reads the snapshot for a peer id", () => {
  const principal = principalOf("gravity2");
  const serverless = { ...agentBindingV1("gravity2"), schema: LOCAL_PROFILE_BINDING_SCHEMA_V2, trust_mode: "serverless-peer", principal_public_key: null };
  const handedOver = { state: "ok", sequence: 1, bindingsFor: () => [serverless], bindingForInstance: () => serverless };
  const skipped = resolveRecipient({ to: principal, recipients: RECIPIENTS, snapshot: handedOver });
  assert.deepEqual([skipped.kind, skipped.code, skipped.reason], ["error", "recipient_not_found", "no_binding"]);

  const touched = new Proxy({}, { get() { throw new Error("the snapshot must not be read for a peer id"); } });
  const peer = resolveRecipient({ to: `peer_${"1".repeat(32)}`, recipients: RECIPIENTS, snapshot: touched });
  assert.deepEqual([peer.kind, peer.code, peer.reason], ["error", "recipient_not_found", "peer_not_supported"]);
});

// ---- the identity view -----------------------------------------------------------------------------------------------------------
test("the identity view shows the schema and the record counts, and a serverless binding is a row of its own", () =>
  withRoots(1, (root) => {
    const v1 = buildIdentityView({ inventory: inventoryFor(), registry: readIdentityRegistry({ root }) });
    assert.deepEqual([v1.registry.schema, v1.registry.collections, v1.summary.serverless], [V1, null, 0]);

    upgradeThroughWriter(root);
    const upgraded = buildIdentityView({ inventory: inventoryFor(), registry: readIdentityRegistry({ root }) });
    assert.deepEqual([upgraded.registry.schema, plain(upgraded.registry.collections)], [V2, { pairings: 0, aliases: 0, destinations: 0 }]);

    const { peer } = seedExtras(root);
    // the serverless profile is also an unmapped local profile on disk: it is shown once, as serverless
    const view = buildIdentityView({ inventory: inventoryFor({ extraUnmapped: ["peerprof"] }), registry: readIdentityRegistry({ root }) });
    assert.deepEqual(plain(view.registry.collections), { pairings: 1, aliases: 1, destinations: 1 });
    assert.equal(view.registry.schema, V2);
    const rows = view.profiles.filter((p) => p.profile === "peerprof");
    assert.deepEqual(plain(rows), [{
      profile: "peerprof",
      profileInstanceId: peer.profile_instance_id,
      state: "serverless",
      principalId: peer.principal_id,
      authorityOrigin: null,
      bindingId: peer.binding_id,
      generation: 1,
      reason: null,
    }]);
    assert.equal(view.summary.serverless, 1);
    assert.equal(view.summary.localOnly, 1, "only scratch is local-only");
    assert.ok(!view.diagnostics.some((d) => d.profile === "peerprof"), "no missing-profile warning for a serverless binding");
    // `identity migrate` agrees with `identity status`: the profile with a live serverless binding is not local-only there either
    const plan = planIdentityMapping({ inventory: inventoryFor({ extraUnmapped: ["peerprof"] }), registry: readIdentityRegistry({ root }) });
    assert.deepEqual(plan.localOnly.map((l) => l.profile), ["scratch"]);
    assert.equal(plan.summary.localOnly, 1);
    // the agent rows are what they were without the extras
    const agentRows = (v) => plain(v.profiles.filter((p) => p.profile !== "peerprof"));
    assert.deepEqual(agentRows(view), agentRows(upgraded));

    // without any local profile for it the binding is still not "recorded_only" with a missing-profile warning
    const noLocal = buildIdentityView({ inventory: inventoryFor(), registry: readIdentityRegistry({ root }) });
    assert.equal(noLocal.profiles.find((p) => p.profile === "peerprof").state, "serverless");
    assert.ok(!noLocal.diagnostics.some((d) => d.code === "recorded_profile_missing" && d.profile === "peerprof"));
  }));

test("a revoked serverless binding is shown as such and warns about nothing", () =>
  withRoots(1, (root) => {
    upgradeThroughWriter(root);
    seedExtras(root, { revoked: true });
    const view = buildIdentityView({ inventory: inventoryFor(), registry: readIdentityRegistry({ root }) });
    const row = view.profiles.find((p) => p.profile === "peerprof");
    assert.deepEqual([row.state, row.reason, row.authorityOrigin], ["serverless", "revoked", null]);
    assert.ok(!view.diagnostics.some((d) => d.profile === "peerprof"));

    // when its profile is still on disk without an identity it is local-only, as a profile with a revoked agent binding is
    const inventory = inventoryFor({ extraUnmapped: ["peerprof"] });
    const again = buildIdentityView({ inventory, registry: readIdentityRegistry({ root }) });
    assert.deepEqual(again.profiles.filter((p) => p.profile === "peerprof").map((p) => p.state), ["local_only"]);
    assert.deepEqual(planIdentityMapping({ inventory, registry: readIdentityRegistry({ root }) }).localOnly.map((l) => l.profile), ["peerprof", "scratch"]);
  }));

// ---- migrate ---------------------------------------------------------------------------------------------------------------------
test("migrate proposes records in the shape of the registry it writes to, and applies them on v2", () =>
  withRoots(1, (root) => {
    const inventory = inventoryFor();
    const onV1 = planIdentityMapping({ inventory, registry: readIdentityRegistry({ root }) });
    assert.deepEqual(onV1.proposals.map((p) => [p.schema, Object.hasOwn(p, "principal_public_key")]), [[LOCAL_PROFILE_BINDING_SCHEMA, false]]);
    // a registry that does not exist yet is created as v1
    for (const none of [null, undefined, { state: "absent" }]) {
      assert.equal(planIdentityMapping({ inventory, registry: none }).proposals.every((p) => p.schema === LOCAL_PROFILE_BINDING_SCHEMA), true);
    }

    upgradeThroughWriter(root);
    const registry = readIdentityRegistry({ root });
    const plan = planIdentityMapping({ inventory, registry });
    assert.deepEqual(plan.proposals.map((p) => [p.schema, p.principal_public_key, p.profile_name]), [[LOCAL_PROFILE_BINDING_SCHEMA_V2, null, "newbie"]]);

    const out = applyIdentityMapping({ root, confirmation: plan.planId, readInventory: () => inventory, now: T2 });
    assert.equal(out.registrySequence, registry.registry.sequence + 1);
    const after = readIdentityRegistry({ root });
    const added = after.registry.bindings[instanceOf("newbie")];
    assert.deepEqual([after.registry.schema, added.schema, added.principal_public_key, added.issued_at, added.revoked_at], [V2, LOCAL_PROFILE_BINDING_SCHEMA_V2, null, T2, null]);
    assert.equal(auditLines(root).at(-1).action, "bind");
    assert.equal(after.audit.uncommittedTail, 0);
    // nothing is left to propose
    assert.equal(planIdentityMapping({ inventory, registry: after }).proposals.length, 0);
  }));

test("an upgrade in the middle of a multi-record apply stops it cleanly; the remaining plan is v2 shaped and finishes", () =>
  withRoots(1, (root) => {
    const inventory = inventoryFor({ extraNew: ["newbie2"] });
    const plan = planIdentityMapping({ inventory, registry: readIdentityRegistry({ root }) });
    assert.deepEqual(plan.proposals.map((p) => [p.profile_name, p.schema]), [["newbie", LOCAL_PROFILE_BINDING_SCHEMA], ["newbie2", LOCAL_PROFILE_BINDING_SCHEMA]]);

    // the clock is read once up front and once per record: upgrade the registry just before the second record is written
    let reads = 0;
    const now = () => {
      reads += 1;
      if (reads === 3) upgradeThroughWriter(root);
      return T2;
    };
    let failure = null;
    try {
      applyIdentityMapping({ root, confirmation: plan.planId, readInventory: () => inventory, now });
    } catch (err) {
      failure = err;
    }
    assert.ok(failure, "the apply must stop");
    assert.equal(failure.code, "registry_sequence_conflict");
    assert.deepEqual(failure.applied.map((b) => b.profile_name), ["newbie"]);
    assert.equal(failure.failed.proposal.profile_name, "newbie2");
    // what was done stays, converted by the upgrade; what is left is planned in the new shape
    const mid = readIdentityRegistry({ root });
    assert.deepEqual([mid.registry.schema, mid.registry.bindings[instanceOf("newbie")].schema, mid.audit.uncommittedTail], [V2, LOCAL_PROFILE_BINDING_SCHEMA_V2, 0]);
    assert.deepEqual(failure.remaining.proposals.map((p) => [p.profile_name, p.schema]), [["newbie2", LOCAL_PROFILE_BINDING_SCHEMA_V2]]);

    applyIdentityMapping({ root, confirmation: failure.remaining.planId, readInventory: () => inventory, now: T2 });
    const done = readIdentityRegistry({ root });
    assert.deepEqual([done.registry.schema, done.registry.bindings[instanceOf("newbie2")].schema], [V2, LOCAL_PROFILE_BINDING_SCHEMA_V2]);
  }));

test("a mapping plan made against v1 is stale once the registry is v2, and nothing is written", () =>
  withRoots(1, (root) => {
    const inventory = inventoryFor();
    const plan = planIdentityMapping({ inventory, registry: readIdentityRegistry({ root }) });
    upgradeThroughWriter(root);
    const files = [readRaw(root), auditLines(root).length];
    assert.throws(
      () => applyIdentityMapping({ root, confirmation: plan.planId, readInventory: () => inventory, now: T2 }),
      (err) => err.code === "plan_stale",
    );
    assert.deepEqual([readRaw(root), auditLines(root).length], files);
  }));

test("migrate never touches a serverless binding, a pairing, an alias or a destination", () =>
  withRoots(1, (root) => {
    upgradeThroughWriter(root);
    const { peer } = seedExtras(root);
    // the same local profile also has a MESH identity on disk: it is blocked, not proposed and not rewritten
    const inventory = inventoryFor();
    inventory.identities.push({
      principalId: `agent_${"8".repeat(32)}`,
      authorityOrigin: ORIGIN,
      kind: "mesh-managed",
      profiles: [{ profile: "peerprof", instanceId: peer.profile_instance_id, enabled: true, status: "ok" }],
    });
    const registry = readIdentityRegistry({ root });
    const plan = planIdentityMapping({ inventory, registry });
    assert.deepEqual(plan.proposals.map((p) => p.profile_name), ["newbie"]);
    assert.deepEqual(plan.blocked.map((b) => [b.profile, b.reason]), [["peerprof", "conflicts_with_recorded"]]);

    const before = readRaw(root);
    applyIdentityMapping({ root, confirmation: plan.planId, readInventory: () => inventory, now: T2 });
    const after = readRaw(root);
    for (const key of ["pairings", "aliases", "destinations"]) assert.equal(canonicalJson(after[key]), canonicalJson(before[key]), key);
    assert.equal(canonicalJson(after.bindings[peer.profile_instance_id]), canonicalJson(before.bindings[peer.profile_instance_id]));
    assert.equal(Object.keys(after.bindings).length, Object.keys(before.bindings).length + 1);
  }));

test("a registry object naming a schema the planner does not know is refused, not planned against", () => {
  const inventory = inventoryFor();
  for (const schema of ["identity_registry_v3", "", 7]) {
    assert.throws(
      () => planIdentityMapping({ inventory, registry: { sequence: 0, bindings: {}, schema } }),
      (err) => err.code === "invalid_registry" && err.reason === "unrecognized_registry_shape",
      String(schema),
    );
  }
  // a raw object that names no schema is read as v1, as before
  assert.equal(planIdentityMapping({ inventory, registry: { sequence: 0, bindings: {} } }).proposals.every((p) => p.schema === LOCAL_PROFILE_BINDING_SCHEMA), true);
});

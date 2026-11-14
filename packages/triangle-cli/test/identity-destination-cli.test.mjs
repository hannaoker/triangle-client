// AD.5: `triangle identity destination set|clear`, registry adapter, and `status --identity` destination rows.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { main } from "../src/cli.mjs";
import { applyIdentityDestination, MAX_DESTINATIONS } from "../src/identity-destination.mjs";
import { createRegistryDestinationAdapter } from "../src/owner-approval-registry.mjs";
import { deriveClientInstanceId } from "../../agent-worker/src/identity-primitives.mjs";
import { readIdentityRegistry, setIdentityDestination } from "../../agent-worker/src/identity-registry.mjs";
import { bindProfileInRegistry, initIdentityRegistry, makeMeshManagedBinding } from "../../agent-worker/test/local-messaging-identity-fixtures.mjs";
import { peerBindingV2, upgradeThroughWriter } from "../../agent-worker/test/identity-registry-v2-helpers.mjs";

const principalOf = (profile) => makeMeshManagedBinding(profile).principal_id;
const recipientsOf = (...profiles) => profiles.map((profile) => ({ profile, instanceId: deriveClientInstanceId(profile) }));

function configFor(recipients, extra = {}) {
  return {
    version: 1,
    enabled: true,
    stateRoot: "/tmp/dest-cli-state",
    bindingPath: "/tmp/dest-cli-state/binding.json",
    integrationPath: "/tmp/dest-cli-state/integration.json",
    recipients,
    ...extra,
  };
}

function makeFakeProvider(decision = "approved", seen = []) {
  return {
    async authenticate(challenge, { signal } = {}) {
      seen.push(challenge);
      if (signal?.aborted) return "cancelled";
      return decision;
    },
  };
}

function fixture(t, { profiles = ["alpha", "beta"], recipients = [], config = "ok", registry = "v2", inventoryIdentities = null } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dest-cli-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "The Triangle");
  fs.mkdirSync(app, { mode: 0o700 });
  const client = path.join(app, "client");
  fs.mkdirSync(client, { mode: 0o700 });
  const reg = path.join(app, "identity");
  const ws = path.join(root, "workspace-main");
  fs.mkdirSync(ws, { mode: 0o700 });

  const configFile = path.join(client, "local-messaging.json");
  if (config === "ok" && recipients.length > 0) {
    fs.writeFileSync(configFile, JSON.stringify(configFor(recipientsOf(...recipients))), { mode: 0o600 });
  } else if (config === "loose") {
    fs.writeFileSync(configFile, JSON.stringify(configFor(recipientsOf(...recipients))), { mode: 0o644 });
  } else if (config === "missing") {
    // intentionally omitted
  } else if (config === "empty-ok") {
    // valid file requires >=1 recipient; omit file unless recipients given
  }

  if (registry !== "absent") {
    initIdentityRegistry(reg);
    profiles.forEach((profile, index) => bindProfileInRegistry(reg, profile, index + 1));
    if (registry === "v2") upgradeThroughWriter(reg, { now: new Date(Date.now() + 1000).toISOString() });
  }

  const start = Date.now() + 60_000;
  let tick = 0;
  const state = { terminal: true, provider: makeFakeProvider("approved"), seen: [] };
  const dependencies = (extra = {}) => ({
    isTerminal: () => state.terminal,
    now: () => new Date(start + ++tick * 1000).toISOString(),
    ownerApprovalProvider: extra.ownerApprovalProvider ?? {
      authenticate: (challenge, opts) => {
        state.seen.push(challenge);
        return state.provider.authenticate(challenge, opts);
      },
    },
    ...(inventoryIdentities ? {
      identityInventory: async () => ({
        schema: "identity_inventory_v1",
        scope: "host-local",
        summary: { identityCount: inventoryIdentities.length, unmappedProfileCount: 0, sessionCount: 0, faultCount: 0, warningCount: 0, omittedHealthDiagnosticCount: 0 },
        identities: inventoryIdentities,
        unmappedProfiles: [],
        sessions: [],
        diagnostics: [],
      }),
    } : {}),
    ...extra,
  });

  const run = async (args, { env = {}, ...extra } = {}) => {
    const out = [];
    const err = [];
    const code = await main(
      ["identity", "destination", ...args, "--client-root", client, ...(extra.registryRoot ? ["--registry-root", extra.registryRoot] : [])],
      {
        env,
        io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) },
        identityDependencies: dependencies(extra.identityDependencies),
      },
    );
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  const plan = async (...args) => JSON.parse((await run([...args, "--json"])).out);
  return { root, app, client, reg, ws, state, run, plan, dependencies };
}

test("destination set & clear end-to-end through D5-C provider, create-only, and clear after deleted workspace", async (t) => {
  const f = fixture(t);
  const p = await f.plan("set", "alpha", "--harness", "claude", "--workspace", f.ws);
  assert.equal(p.ready, true);
  assert.equal(p.target.principalId, principalOf("alpha"));
  assert.equal(p.harness, "claude");
  assert.equal(p.workspace, f.ws);

  const applied = await f.run(["set", "alpha", "--harness", "claude", "--workspace", f.ws, "--confirm", p.planId, "--json"]);
  assert.equal(applied.code, 0, applied.err);
  const res = JSON.parse(applied.out);
  assert.equal(res.action, "set");
  assert.equal(res.auditEntry, "destination_set");
  assert.equal(f.state.seen.length, 1);
  assert.equal(f.state.seen[0].request.action, "destination.set");
  assert.match(f.state.seen[0].summary, /destination\.set: agent_/);

  // Create-only: second set refuses with destination_exists
  const p2 = await f.plan("set", principalOf("alpha"), "--harness", "codex", "--workspace", f.ws);
  assert.equal(p2.ready, false);
  assert.ok(p2.refusals.includes("destination_exists"));

  // Delete workspace from disk; clear still succeeds via syntax-only check on clear.
  fs.rmSync(f.ws, { recursive: true, force: true });
  const clearPlan = await f.plan("clear", "alpha");
  assert.equal(clearPlan.ready, true);
  assert.equal(clearPlan.existing.workspace, f.ws);

  const cleared = await f.run(["clear", "alpha", "--confirm", clearPlan.planId]);
  assert.equal(cleared.code, 0, cleared.err);
  assert.match(cleared.out, /Cleared the destination rule for alpha/);
  assert.equal(f.state.seen.length, 2);
  assert.equal(f.state.seen[1].request.action, "destination.clear");
  assert.deepEqual(readIdentityRegistry({ root: f.reg }).registry.destinations, {});
});

test("workspace canonicalization, harness validation, target validation, and runner overlap refusals (CD-2)", async (t) => {
  const f = fixture(t, { recipients: ["alpha"] });
  const sym = path.join(f.root, "ws-link");
  fs.symlinkSync(f.ws, sym);
  const filePath = path.join(f.root, "a-file");
  fs.writeFileSync(filePath, "hi");

  assert.ok((await f.plan("set", "beta", "--harness", "grok", "--workspace", f.ws)).refusals.includes("destination_harness_invalid"));
  assert.ok((await f.plan("set", "beta", "--harness", "claude", "--workspace", "rel/dir")).refusals.includes("destination_workspace_invalid"));
  assert.ok((await f.plan("set", "beta", "--harness", "claude", "--workspace", path.join(f.root, "missing"))).refusals.includes("destination_workspace_not_found"));
  assert.ok((await f.plan("set", "beta", "--harness", "claude", "--workspace", filePath)).refusals.includes("destination_workspace_not_directory"));
  assert.ok((await f.plan("set", "beta", "--harness", "claude", "--workspace", sym)).refusals.includes("destination_workspace_not_canonical"));

  // Runner overlap via local-messaging.json recipients refuses alpha while allowing beta.
  const runnerPlan = await f.plan("set", "alpha", "--harness", "claude", "--workspace", f.ws);
  assert.equal(runnerPlan.ready, false);
  assert.ok(runnerPlan.refusals.includes("destination_target_has_runner"));
  assert.deepEqual(runnerPlan.runnerProfiles, ["alpha"]);
  assert.equal((await f.plan("set", "beta", "--harness", "claude", "--workspace", f.ws)).ready, true);

  // peer_ target refused
  const peer = peerBindingV2("peerprof");
  assert.ok((await f.plan("set", peer.principal_id, "--harness", "codex", "--workspace", f.ws)).refusals.includes("destination_target_not_mesh_managed"));

  // Inventory-based mcp-interactive / worker overlap refuses even without local-messaging.json.
  const f2 = fixture(t, {
    inventoryIdentities: [
      {
        principalId: principalOf("beta"),
        authorityOrigin: "https://mesh.example.test",
        kind: "mesh-managed",
        profiles: [{ profile: "beta", instanceId: deriveClientInstanceId("beta"), deliveryMode: "mcp-interactive", enabled: true, status: "ok" }],
      },
    ],
  });
  const pairedPlan = await f2.plan("set", "beta", "--harness", "codex", "--workspace", f2.ws);
  assert.ok(pairedPlan.refusals.includes("destination_target_has_runner"));
});

test("terminal / SSH gate, D5-C denials/unavailability, plan staleness, and revocation clearing", async (t) => {
  const f = fixture(t);
  const p = await f.plan("set", "alpha", "--harness", "codex", "--workspace", f.ws);
  assert.equal(p.ready, true);

  // Non-TTY rejected
  f.state.terminal = false;
  const noTty = await f.run(["set", "alpha", "--harness", "codex", "--workspace", f.ws, "--confirm", p.planId]);
  assert.equal(noTty.code, 2);
  assert.match(noTty.err, /local owner terminal/);
  f.state.terminal = true;

  // SSH rejected
  const ssh = await f.run(["set", "alpha", "--harness", "codex", "--workspace", f.ws, "--confirm", p.planId], { env: { SSH_CONNECTION: "1 2 3 4" } });
  assert.equal(ssh.code, 2);
  assert.match(ssh.err, /SSH\/headless/);

  // Provider denial / cancel leaves registry untouched
  f.state.provider = makeFakeProvider("denied");
  const denied = await f.run(["set", "alpha", "--harness", "codex", "--workspace", f.ws, "--confirm", p.planId, "--json"]);
  assert.equal(denied.code, 1);
  assert.equal(JSON.parse(denied.err).error, "owner_approval_denied");
  assert.deepEqual(readIdentityRegistry({ root: f.reg }).registry.destinations, {});

  // Plan becomes stale if registry changes before apply
  f.state.provider = makeFakeProvider("approved");
  const seq = readIdentityRegistry({ root: f.reg }).registry.sequence;
  setIdentityDestination({ root: f.reg, expectedSequence: seq, now: new Date(Date.now() + 5000).toISOString(), principalId: principalOf("beta"), harness: "claude", workspace: f.ws });
  const stale = await f.run(["set", "alpha", "--harness", "codex", "--workspace", f.ws, "--confirm", p.planId]);
  assert.equal(stale.code, 2);
  assert.match(stale.err, /plan_stale/);

  // Unavailable packaged provider when no fake provider injected
  const pFresh = await f.plan("set", "alpha", "--harness", "codex", "--workspace", f.ws);
  await assert.rejects(
    () => applyIdentityDestination({
      action: "set",
      target: "alpha",
      harness: "codex",
      workspace: f.ws,
      clientRoot: f.client,
      registryRoot: f.reg,
      confirm: pFresh.planId,
      platform: "darwin",
      releaseRoot: path.join(f.root, "missing-release"),
    }),
    (err) => err.code === "owner_approval_unavailable",
  );
});

test("createRegistryDestinationAdapter enforces sequence, before snapshot, single-use commit, and sync contract", async (t) => {
  const f = fixture(t);
  const seq = readIdentityRegistry({ root: f.reg }).registry.sequence;
  const op = {
    action: "destination.set",
    registryRoot: f.reg,
    expectedSequence: seq,
    principalId: principalOf("alpha"),
    harness: "claude",
    workspace: f.ws,
    before: null,
  };
  const lockAdapter = createRegistryDestinationAdapter(op, { now: () => Date.now() + 2000 });
  assert.throws(
    () => lockAdapter(f.reg, () => Promise.resolve()),
    (err) => err.code === "owner_approval_unavailable",
  );
  assert.throws(
    () => lockAdapter(f.reg, (state) => { state.commit({ ...op, harness: "codex" }); }),
    (err) => err.code === "owner_approval_stale",
  );
  assert.throws(
    () => lockAdapter(f.reg, (state) => { state.commit(op); state.commit(op); }),
    (err) => err.code === "owner_approval_replayed",
  );
});

test("isolated CLI package without agent-worker reports incomplete package cleanly", async () => {
  const tmp = fs.mkdtempSync("/private/tmp/dest-isolated-cli-");
  try {
    fs.cpSync(path.resolve(import.meta.dirname, "../src"), path.join(tmp, "src"), { recursive: true });
    const { main: isolatedMain } = await import(pathToFileURL(path.join(tmp, "src", "cli.mjs")).href);
    const err = [];
    const code = await isolatedMain(
      ["identity", "destination", "clear", "alpha", "--client-root", "/private/tmp/client", "--registry-root", "/private/tmp/identity"],
      { io: { stdout: () => {}, stderr: (s) => err.push(s) } },
    );
    assert.equal(code, 1);
    assert.equal(err.length, 1);
    assert.match(err[0], /is unavailable because this CLI package is incomplete/);
    assert.ok(!err[0].includes("\n") && !err[0].includes("at "));

    const jsonErr = [];
    const jsonCode = await isolatedMain(
      ["identity", "destination", "clear", "alpha", "--client-root", "/private/tmp/client", "--registry-root", "/private/tmp/identity", "--json"],
      { io: { stdout: () => {}, stderr: (s) => jsonErr.push(s) } },
    );
    assert.equal(jsonCode, 1);
    assert.equal(jsonErr.length, 1);
    assert.equal(JSON.parse(jsonErr[0]).error, "owner_approval_unavailable");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("status --identity displays Destinations rows in human and JSON output cleanly", async (t) => {
  const f = fixture(t);
  const p = await f.plan("set", "alpha", "--harness", "claude", "--workspace", f.ws);
  const app = await f.run(["set", "alpha", "--harness", "claude", "--workspace", f.ws, "--confirm", p.planId]);
  assert.equal(app.code, 0);
  const { renderDoctor } = await import("../src/doctor.mjs");
  const text = renderDoctor({
    authority: null,
    transport: null,
    device: null,
    owner: null,
    devices: [],
    agents: [],
    warnings: [],
    identityRegistryRoot: f.reg,
    identity: {
      registry: { state: "ok", schema: "identity_registry_v2", sequence: 5, collections: { pairings: 0, aliases: 0, destinations: 1 } },
      profiles: [],
      destinations: [{ state: "active", principalId: principalOf("alpha"), profile: "alpha", profiles: ["alpha"], harness: "claude", workspace: f.ws }],
      diagnostics: [],
    },
  });
  assert.match(text, /Destinations \(owner-set chat routing rules\):/);
  assert.match(text, /active · agent_.* \(alpha\) → claude in/);
  assert.ok(MAX_DESTINATIONS === 256);
});

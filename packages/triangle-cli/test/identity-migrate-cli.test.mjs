import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { main } from "../src/cli.mjs";
import {
  FIXTURE_INSTALLATION_ID,
  writeBinding,
  writeInstallationIdentity,
  writeJson,
} from "../../agent-worker/test/inventory-fixture-helpers.mjs";
import { deriveClientInstanceId } from "../../agent-worker/src/installation-inventory.mjs";
import { readIdentityRegistry } from "../../agent-worker/src/identity-registry.mjs";

function createRealInventoryFixture({
  profiles = [
    { profile: "alice", runtimeAdapter: "codex", deliveryMode: "worker", enabled: true },
  ],
} = {}) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "migrate-cli-test-"));
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
    writeBinding(app, p.profile, {
      binding: { origin: "https://mesh.example.com" },
      agent: { handle: p.profile, name: p.profile },
    });
  }

  writeInstallationIdentity(client, FIXTURE_INSTALLATION_ID);

  return { root, app, client, profiles };
}

test("identity migrate CLI: usage errors", async () => {
  const f = createRealInventoryFixture();
  const regRoot = path.join(f.root, "registry");
  try {
    const run = async (args) => {
      const out = [];
      const err = [];
      const code = await main(args, {
        io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) },
      });
      return { code, out: out.join("\n"), err: err.join("\n") };
    };

    // 1. Missing client-root
    let r = await run(["identity", "migrate", "--registry-root", regRoot]);
    assert.equal(r.code, 2);
    assert.match(r.err, /requires --client-root/);

    // 2. Missing registry-root
    r = await run(["identity", "migrate", "--client-root", f.client]);
    assert.equal(r.code, 2);
    assert.match(r.err, /requires --registry-root/);

    // 3. Relative client-root
    r = await run(["identity", "migrate", "--client-root", "relative/path", "--registry-root", regRoot]);
    assert.equal(r.code, 2);
    assert.match(r.err, /--client-root must be an absolute path/);

    // 4. Relative registry-root
    r = await run(["identity", "migrate", "--client-root", f.client, "--registry-root", "relative/reg"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /--registry-root must be an absolute path/);

    // 5. Registry root equals client root
    r = await run(["identity", "migrate", "--client-root", f.client, "--registry-root", f.client]);
    assert.equal(r.code, 2);
    assert.match(r.err, /registry root must not equal client root/);

    // 6. Registry root contains client root
    const parentRoot = path.dirname(f.client);
    r = await run(["identity", "migrate", "--client-root", f.client, "--registry-root", parentRoot]);
    assert.equal(r.code, 2);
    assert.match(r.err, /registry root must not contain client root/);

    // 7. Unknown option
    r = await run(["identity", "migrate", "--client-root", f.client, "--registry-root", regRoot, "--invalid-flag=foo"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /unknown option --invalid-flag/);

    // 8. Repeated option
    r = await run(["identity", "migrate", "--client-root", f.client, "--client-root", f.client, "--registry-root", regRoot]);
    assert.equal(r.code, 2);
    assert.match(r.err, /--client-root given twice/);

    // 9. Extra positional args
    r = await run(["identity", "migrate", "extra-arg", "--client-root", f.client, "--registry-root", regRoot]);
    assert.equal(r.code, 2);
    assert.match(r.err, /takes no positional arguments/);

    // 10. Unknown identity subcommand
    r = await run(["identity", "unknown-sub", "--client-root", f.client]);
    assert.equal(r.code, 2);
    assert.match(r.err, /unknown identity command unknown-sub/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("identity migrate CLI: plan output in both formats", async () => {
  const f = createRealInventoryFixture();
  const regRoot = path.join(f.root, "registry");
  try {
    // 1. JSON plan
    const jsonOut = [];
    const jsonErr = [];
    const jsonCode = await main(
      ["identity", "migrate", "--client-root", f.client, "--registry-root", regRoot, "--json"],
      { io: { stdout: (s) => jsonOut.push(s), stderr: (s) => jsonErr.push(s) } }
    );

    assert.equal(jsonCode, 0, jsonErr.join("\n"));
    const plan = JSON.parse(jsonOut.join("\n"));
    assert.equal(plan.schema, "identity_mapping_plan_v1");
    assert.equal(typeof plan.planId, "string");
    assert.match(plan.planId, /^[a-f0-9]{64}$/);
    assert.equal(plan.registrySequence, 0);
    assert.equal(plan.proposals.length, 1);
    assert.equal(plan.proposals[0].profile_name, "alice");

    // 2. Human plan
    const humanOut = [];
    const humanErr = [];
    const humanCode = await main(
      ["identity", "migrate", "--client-root", f.client, "--registry-root", regRoot],
      { io: { stdout: (s) => humanOut.push(s), stderr: (s) => humanErr.push(s) } }
    );

    assert.equal(humanCode, 0, humanErr.join("\n"));
    const text = humanOut.join("\n");
    assert.match(text, /Identity Migration Plan/);
    assert.match(text, /Summary: 1 proposal\(s\), 0 unchanged, 0 blocked, 0 local-only/);
    assert.match(text, /Profile: alice/);
    assert.match(text, /Origin: https:\/\/mesh\.example\.com/);
    assert.match(text, new RegExp(`Plan ID: ${plan.planId}`));
    assert.match(text, new RegExp(`--confirm ${plan.planId}`));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("identity migrate CLI: plan mode leaves a nonexistent registry root nonexistent", async () => {
  const f = createRealInventoryFixture();
  const regRoot = path.join(f.root, "nonexistent-registry-dir");
  try {
    assert.equal(existsSync(regRoot), false);
    const out = [];
    const err = [];
    const code = await main(
      ["identity", "migrate", "--client-root", f.client, "--registry-root", regRoot],
      { io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) } }
    );
    assert.equal(code, 0, err.join("\n"));
    assert.equal(existsSync(regRoot), false, "registryRoot must remain nonexistent in plan mode");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("identity migrate CLI: --confirm without a terminal refuses with exit 2 and writes nothing", async () => {
  const f = createRealInventoryFixture();
  const regRoot = path.join(f.root, "registry");
  try {
    const validPlanId = "a".repeat(64);
    const out = [];
    const err = [];
    const code = await main(
      ["identity", "migrate", "--client-root", f.client, "--registry-root", regRoot, "--confirm", validPlanId],
      {
        io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) },
        identityDependencies: { isTerminal: false },
      }
    );
    assert.equal(code, 2);
    assert.match(err.join("\n"), /requires standard input and output to be a terminal/);
    assert.equal(existsSync(regRoot), false, "no writes performed");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("identity migrate CLI: wrong or malformed plan id refuses with exit 2", async () => {
  const f = createRealInventoryFixture();
  const regRoot = path.join(f.root, "registry");
  try {
    // 1. Malformed plan id (too short)
    let out = [];
    let err = [];
    let code = await main(
      ["identity", "migrate", "--client-root", f.client, "--registry-root", regRoot, "--confirm", "short-id"],
      {
        io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) },
        identityDependencies: { isTerminal: true },
      }
    );
    assert.equal(code, 2);
    assert.match(err.join("\n"), /--confirm must be 64 lowercase hex characters/);

    // 2. Wrong plan id (64 hex characters but wrong hash)
    out = [];
    err = [];
    code = await main(
      ["identity", "migrate", "--client-root", f.client, "--registry-root", regRoot, "--confirm", "0".repeat(64)],
      {
        io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) },
        identityDependencies: { isTerminal: true },
      }
    );
    assert.equal(code, 2);
    assert.match(err.join("\n"), /identity migrate failed:/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("identity migrate CLI: full success with a fake terminal and idempotent second run", async () => {
  const f = createRealInventoryFixture();
  const regRoot = path.join(f.root, "registry");
  try {
    // 1. Get plan
    const planOut = [];
    const planCode = await main(
      ["identity", "migrate", "--client-root", f.client, "--registry-root", regRoot, "--json"],
      { io: { stdout: (s) => planOut.push(s), stderr: () => {} } }
    );
    assert.equal(planCode, 0);
    const plan = JSON.parse(planOut.join("\n"));

    // 2. Confirm and apply
    const applyOut = [];
    const applyErr = [];
    const applyCode = await main(
      ["identity", "migrate", "--client-root", f.client, "--registry-root", regRoot, "--confirm", plan.planId],
      {
        io: { stdout: (s) => applyOut.push(s), stderr: (s) => applyErr.push(s) },
        identityDependencies: { isTerminal: true },
      }
    );

    assert.equal(applyCode, 0, applyErr.join("\n"));
    const applyText = applyOut.join("\n");
    assert.match(applyText, /Recorded 1 identity binding\(s\) to registry \(sequence 1\):/);
    assert.match(applyText, /Profile: alice/);

    // Check registry on disk
    const onDisk = readIdentityRegistry({ root: regRoot });
    assert.equal(onDisk.state, "ok");
    assert.equal(onDisk.registry.sequence, 1);
    const instId = deriveClientInstanceId("alice");
    assert.ok(onDisk.registry.bindings[instId]);

    // Check audit log
    const auditLines = readFileSync(path.join(regRoot, "registry-audit.jsonl"), "utf8").trim().split("\n");
    assert.equal(auditLines.length, 1);

    // 3. Second run: plan mode should show 0 proposals and 1 unchanged
    const plan2Out = [];
    const plan2Code = await main(
      ["identity", "migrate", "--client-root", f.client, "--registry-root", regRoot, "--json"],
      { io: { stdout: (s) => plan2Out.push(s), stderr: () => {} } }
    );
    assert.equal(plan2Code, 0);
    const plan2 = JSON.parse(plan2Out.join("\n"));
    assert.equal(plan2.proposals.length, 0);
    assert.equal(plan2.unchanged.length, 1);
    assert.equal(plan2.registrySequence, 1);

    // Confirm rerun
    const rerunOut = [];
    const rerunErr = [];
    const rerunCode = await main(
      ["identity", "migrate", "--client-root", f.client, "--registry-root", regRoot, "--confirm", plan2.planId],
      {
        io: { stdout: (s) => rerunOut.push(s), stderr: (s) => rerunErr.push(s) },
        identityDependencies: { isTerminal: true },
      }
    );
    assert.equal(rerunCode, 0, rerunErr.join("\n"));
    assert.match(rerunOut.join("\n"), /Recorded 0 identity binding\(s\)/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("identity migrate CLI: network trap (globalThis.fetch) is never called", async () => {
  const f = createRealInventoryFixture();
  const regRoot = path.join(f.root, "registry");
  try {
    let fetchCalled = false;
    const fetchTrap = () => {
      fetchCalled = true;
      throw new Error("Network call prohibited in identity migrate CLI");
    };

    // Plan mode
    const codePlan = await main(
      ["identity", "migrate", "--client-root", f.client, "--registry-root", regRoot, "--json"],
      {
        fetchImpl: fetchTrap,
        io: { stdout: () => {}, stderr: () => {} },
      }
    );
    assert.equal(codePlan, 0);
    assert.equal(fetchCalled, false, "fetch must not be called during plan");

    // Apply mode
    const planOut = [];
    await main(
      ["identity", "migrate", "--client-root", f.client, "--registry-root", regRoot, "--json"],
      {
        fetchImpl: fetchTrap,
        io: { stdout: (s) => planOut.push(s), stderr: () => {} },
      }
    );
    const plan = JSON.parse(planOut.join("\n"));

    const codeApply = await main(
      ["identity", "migrate", "--client-root", f.client, "--registry-root", regRoot, "--confirm", plan.planId],
      {
        fetchImpl: fetchTrap,
        io: { stdout: () => {}, stderr: () => {} },
        identityDependencies: { isTerminal: true },
      }
    );
    assert.equal(codeApply, 0);
    assert.equal(fetchCalled, false, "fetch must not be called during apply");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

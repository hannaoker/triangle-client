import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";

import { main } from "../src/cli.mjs";
import { createFakeAuthority } from "./fake-authority.mjs";
import {
  writeBinding,
  writeInstallationIdentity,
  writeJson,
  FIXTURE_INSTALLATION_ID,
} from "../../agent-worker/test/inventory-fixture-helpers.mjs";
import {
  deriveClientInstanceId,
  readInstallationInventory,
} from "../../agent-worker/src/installation-inventory.mjs";
import { buildIdentityInventory } from "../../agent-worker/src/identity-inventory.mjs";
import {
  planIdentityMapping,
  applyIdentityMapping,
} from "../../agent-worker/src/identity-mapping.mjs";
import { readIdentityRegistry } from "../../agent-worker/src/identity-registry.mjs";

function setupJoinedFakeFixture({ profiles = ["bob"] } = {}) {
  const fake = createFakeAuthority({ authority: "https://mesh.test" });
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "status-cli-test-"));
  const home = path.join(root, "home");
  const app = path.join(root, "The Triangle");
  const client = path.join(app, "client");
  const registry = path.join(app, "identity");

  for (const prof of profiles) {
    const instanceId = deriveClientInstanceId(prof);
    writeJson(path.join(client, "instances", `${instanceId}.json`), {
      version: 1,
      instanceId,
      profile: prof,
      runtimeAdapter: "codex",
      enabled: true,
    });
    writeBinding(app, prof, {
      binding: { origin: "https://mesh.test" },
      agent: { handle: prof, name: prof },
    });
  }
  writeInstallationIdentity(client, FIXTURE_INSTALLATION_ID);

  return { fake, root, home, app, client, registry };
}

async function joinAndMakeHealthy(fake, home) {
  const out = [];
  const err = [];
  const code = await main(
    ["join", fake.mintInvite().link, "--name", "Owner", "--handle", "alpha", "--device-label", "Desk", "--home", home],
    {
      env: {},
      fetchImpl: fake.fetchImpl,
      io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) },
    }
  );
  assert.equal(code, 0, err.join("\n"));

  // Add 2nd active controller so doctor has no missing backup device warning
  const ownerId = [...fake.state.owners.keys()][0];
  fake.state.controllers.set("controller_second", {
    owner_id: ownerId,
    jwk: {},
    jkt: "jkt_backup",
    state: "active",
    device_label: "Laptop",
    kind: "device-owner",
  });
}

test("status and doctor without --identity behave unchanged", async () => {
  const f = setupJoinedFakeFixture();
  try {
    await joinAndMakeHealthy(f.fake, f.home);

    const outStatus = [];
    const codeStatus = await main(["status", "--home", f.home], {
      env: {},
      fetchImpl: f.fake.fetchImpl,
      io: { stdout: (s) => outStatus.push(s), stderr: () => {} },
    });
    assert.equal(codeStatus, 0);
    const textStatus = outStatus.join("\n");
    assert.ok(!textStatus.includes("Identity (host-local"));

    const outDoctor = [];
    const codeDoctor = await main(["doctor", "--home", f.home], {
      env: {},
      fetchImpl: f.fake.fetchImpl,
      io: { stdout: (s) => outDoctor.push(s), stderr: () => {} },
    });
    assert.equal(codeDoctor, 0);
    const textDoctor = outDoctor.join("\n");
    assert.ok(!textDoctor.includes("Identity (host-local"));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("doctor --identity: absent registry shows not_recorded, Identity: warning, and doctor exits 1", async () => {
  const f = setupJoinedFakeFixture();
  try {
    await joinAndMakeHealthy(f.fake, f.home);

    const out = [];
    const err = [];
    const code = await main(
      ["doctor", "--identity", "--client-root", f.client, "--registry-root", f.registry, "--home", f.home],
      {
        env: {},
        fetchImpl: f.fake.fetchImpl,
        io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) },
      }
    );

    assert.equal(code, 1, "doctor --identity must exit 1 when there are identity warnings");
    const text = out.join("\n");
    assert.match(text, /Identity \(host-local; disk observations, not live authority verification\)/);
    assert.match(text, /not_recorded/);
    assert.match(text, /! Identity:/);
    assert.match(text, /\[warn\] 1 profile\(s\) have a valid MESH binding on disk and no recorded identity binding\./);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("status --identity: absent registry shows not_recorded, exits 0", async () => {
  const f = setupJoinedFakeFixture();
  try {
    await joinAndMakeHealthy(f.fake, f.home);

    const out = [];
    const err = [];
    const code = await main(
      ["status", "--identity", "--client-root", f.client, "--registry-root", f.registry, "--home", f.home],
      {
        env: {},
        fetchImpl: f.fake.fetchImpl,
        io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) },
      }
    );

    assert.equal(code, 0, "status --identity must exit 0");
    const text = out.join("\n");
    assert.match(text, /Identity \(host-local; disk observations, not live authority verification\)/);
    assert.match(text, /not_recorded/);
    assert.ok(!text.includes("! Identity:"), "status must not report Identity warning");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("doctor --identity: after applyIdentityMapping, profile is recorded, no Identity: warning, doctor exits 0", async () => {
  const f = setupJoinedFakeFixture();
  try {
    await joinAndMakeHealthy(f.fake, f.home);

    // Apply mapping directly
    const syncReadInv = () =>
      buildIdentityInventory(
        readInstallationInventory({
          clientRoot: f.client,
          pidAlive: () => "unknown",
          advisoryHeldAt: () => "unknown",
        })
      );
    const inv = syncReadInv();
    const reg = readIdentityRegistry({ root: f.registry });
    const plan = planIdentityMapping({ inventory: inv, registry: reg });
    applyIdentityMapping({
      root: f.registry,
      confirmation: plan.planId,
      readInventory: syncReadInv,
    });

    const out = [];
    const err = [];
    const code = await main(
      ["doctor", "--identity", "--client-root", f.client, "--registry-root", f.registry, "--home", f.home],
      {
        env: {},
        fetchImpl: f.fake.fetchImpl,
        io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) },
      }
    );

    assert.equal(code, 0, `doctor --identity should exit 0 after mapping applied: ${err.join("\n")}`);
    const text = out.join("\n");
    assert.match(text, /Identity \(host-local; disk observations, not live authority verification\)/);
    assert.match(text, /recorded/);
    assert.ok(!text.includes("! Identity:"), "No Identity warning after apply");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("identity status CLI: usage errors", async () => {
  const f = setupJoinedFakeFixture();
  try {
    // --client-root without --identity
    const err1 = [];
    const code1 = await main(["status", "--client-root", f.client], {
      io: { stdout: () => {}, stderr: (s) => err1.push(s) },
    });
    assert.equal(code1, 2);
    assert.match(err1.join("\n"), /unknown option --client-root/);

    // --registry-root without --identity
    const err2 = [];
    const code2 = await main(["doctor", "--registry-root", f.registry], {
      io: { stdout: () => {}, stderr: (s) => err2.push(s) },
    });
    assert.equal(code2, 2);
    assert.match(err2.join("\n"), /unknown option --registry-root/);

    // Relative --client-root with --identity
    const err3 = [];
    const code3 = await main(["status", "--identity", "--client-root", "relative/path"], {
      io: { stdout: () => {}, stderr: (s) => err3.push(s) },
    });
    assert.equal(code3, 2);
    assert.match(err3.join("\n"), /--client-root must be an absolute path/);

    // Relative --registry-root with --identity
    const err4 = [];
    const code4 = await main(["doctor", "--identity", "--client-root", f.client, "--registry-root", "relative/path"], {
      io: { stdout: () => {}, stderr: (s) => err4.push(s) },
    });
    assert.equal(code4, 2);
    assert.match(err4.join("\n"), /--registry-root must be an absolute path/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("identity status CLI: --json puts view in report.identity", async () => {
  const f = setupJoinedFakeFixture();
  try {
    await joinAndMakeHealthy(f.fake, f.home);

    const out = [];
    const code = await main(
      ["status", "--identity", "--client-root", f.client, "--registry-root", f.registry, "--home", f.home, "--json"],
      {
        env: {},
        fetchImpl: f.fake.fetchImpl,
        io: { stdout: (s) => out.push(s), stderr: () => {} },
      }
    );

    assert.equal(code, 0);
    const report = JSON.parse(out.join("\n"));
    assert.ok(report.identity, "report.identity must be present");
    assert.equal(report.identity.schema, "identity_view_v1");
    assert.equal(report.identity.summary.profiles, 1);
    assert.equal(report.identity.profiles[0].profile, "bob");
    assert.equal(report.identity.profiles[0].state, "not_recorded");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("identity status CLI: identity part makes no network call", async () => {
  const f = setupJoinedFakeFixture();
  try {
    // Network trap on global fetch
    let globalFetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      globalFetchCalled = true;
      throw new Error("globalThis.fetch invoked unexpectedly!");
    };

    try {
      // Run status with fake session and client fixture
      const out = [];
      const code = await main(
        ["status", "--identity", "--client-root", f.client, "--registry-root", f.registry, "--home", f.home],
        {
          env: {},
          fetchImpl: f.fake.fetchImpl,
          io: { stdout: (s) => out.push(s), stderr: () => {} },
        }
      );
      assert.equal(code, 0);
      assert.equal(globalFetchCalled, false, "globalThis.fetch must never be called");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("identity status CLI: missing agent-worker modules throws LocalStateError (exit 1, no stack, no path)", async () => {
  const tmp = mkdtempSync("/private/tmp/id-status-missing-worker-");
  try {
    const srcDir = path.resolve(import.meta.dirname, "../src");
    cpSync(srcDir, path.join(tmp, "src"), { recursive: true });
    const isolatedCliUrl = pathToFileURL(path.join(tmp, "src", "cli.mjs")).href;
    const { main: isolatedMain } = await import(isolatedCliUrl);

    const out = [];
    const err = [];
    const code = await isolatedMain(
      ["status", "--identity", "--client-root", "/private/tmp/client", "--registry-root", "/private/tmp/registry", "--home", path.join(tmp, "home")],
      { io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) } }
    );

    assert.equal(code, 1);
    assert.equal(err.length, 1);
    assert.ok(
      err[0].includes("is not available in this installation."),
      `Unexpected error: ${err[0]}`
    );
    assert.ok(!err[0].includes("\n"), "stderr must be a single line");
    assert.ok(!err[0].includes("at "), "stderr must not contain stack trace");
    assert.ok(!err[0].includes("/private/"), "stderr must not contain absolute paths");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

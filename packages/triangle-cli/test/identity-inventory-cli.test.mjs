import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";

import { main } from "../src/cli.mjs";
import {
  boundAgentId,
  FIXTURE_INSTALLATION_ID,
  writeBinding,
  writeInstallationIdentity,
  writeJson,
} from "../../agent-worker/test/inventory-fixture-helpers.mjs";
import { deriveClientInstanceId } from "../../agent-worker/src/installation-inventory.mjs";

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function snapshotTree(dir, base = dir) {
  const map = new Map();
  if (!existsSync(dir)) return map;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(base, fullPath);
    const stat = lstatSync(fullPath);
    const info = {
      mode: stat.mode,
      isDir: stat.isDirectory(),
      hash: stat.isFile() ? sha256(readFileSync(fullPath)) : null,
    };
    map.set(relPath, info);
    if (stat.isDirectory()) {
      const sub = snapshotTree(fullPath, base);
      for (const [k, v] of sub) map.set(k, v);
    }
  }
  return map;
}

function createRealInventoryFixture({
  profiles = [
    { profile: "bob", runtimeAdapter: "codex", deliveryMode: "headless-app-server", enabled: true },
    { profile: "ghost", runtimeAdapter: "cursor-acp", deliveryMode: "headless-cursor-acp", enabled: true },
    { profile: "gravity", runtimeAdapter: "antigravity", deliveryMode: "worker", enabled: true },
    { profile: "hermes-off", runtimeAdapter: "hermes", deliveryMode: "worker", enabled: false },
  ],
} = {}) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "id-cli-test-"));
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
      binding: { origin: "https://example.test" },
      agent: { handle: p.profile, name: p.profile },
    });
  }

  writeInstallationIdentity(client, FIXTURE_INSTALLATION_ID);

  return { root, app, client, profiles };
}

test("identity inventory CLI: valid report JSON and human output", async () => {
  const f = createRealInventoryFixture();
  try {
    // 1. JSON report
    const jsonOut = [];
    const jsonErr = [];
    const jsonCode = await main(
      ["identity", "inventory", "--client-root", f.client, "--json"],
      { io: { stdout: (s) => jsonOut.push(s), stderr: (s) => jsonErr.push(s) } }
    );

    assert.equal(jsonCode, 0, jsonErr.join("\n"));
    assert.equal(jsonErr.length, 0);

    const report = JSON.parse(jsonOut.join("\n"));
    assert.equal(report.schema, "identity_inventory_v1");
    assert.equal(report.scope, "host-local");
    assert.equal(report.summary.identityCount, 4);
    assert.equal(report.summary.unmappedProfileCount, 0);
    assert.equal(report.identities.length, 4);

    for (const p of f.profiles) {
      const expectedAgentId = boundAgentId(p.profile);
      const identity = report.identities.find((i) => i.principalId === expectedAgentId);
      assert.ok(identity, `Missing identity for ${p.profile}`);
      assert.equal(identity.kind, "mesh-managed");
      assert.equal(identity.authorityOrigin, "https://example.test");
      assert.equal(identity.authority.observedOnDisk, true);
      assert.equal(identity.authority.verifiedLiveAuthority, false);
      assert.equal(identity.handle, p.profile);

      const pb = identity.profiles.find((pr) => pr.profile === p.profile);
      assert.ok(pb, `Missing profile binding for ${p.profile}`);
      assert.equal(pb.instanceId, deriveClientInstanceId(p.profile));
      assert.equal(pb.enabled, p.enabled);
    }

    // 2. Human-readable report
    const humanOut = [];
    const humanErr = [];
    const humanCode = await main(
      ["identity", "inventory", "--client-root", f.client],
      { io: { stdout: (s) => humanOut.push(s), stderr: (s) => humanErr.push(s) } }
    );

    assert.equal(humanCode, 0, humanErr.join("\n"));
    assert.equal(humanErr.length, 0);

    const text = humanOut.join("\n");
    assert.match(text, /Identity Inventory \(host-local; disk observations only, not live authority verification\)/);
    assert.match(text, /Summary: 4 identity\(ies\)/);
    assert.match(text, /observed on disk; not live verified/);

    for (const p of f.profiles) {
      const expectedAgentId = boundAgentId(p.profile);
      assert.ok(text.includes(expectedAgentId), `Report should contain principal ID ${expectedAgentId}`);
      assert.ok(text.includes(p.profile), `Report should contain profile name ${p.profile}`);
      assert.ok(text.includes(deriveClientInstanceId(p.profile)), `Report should contain instance ID for ${p.profile}`);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("identity inventory CLI: required absolute explicit root", async () => {
  const f = createRealInventoryFixture();
  try {
    // Missing --client-root flag
    const out1 = [];
    const err1 = [];
    const code1 = await main(["identity", "inventory"], {
      io: { stdout: (s) => out1.push(s), stderr: (s) => err1.push(s) },
    });
    assert.equal(code1, 2);
    assert.match(err1.join("\n"), /requires --client-root ABSOLUTE_PATH/);

    // Relative path (without leading slash)
    const out2 = [];
    const err2 = [];
    const code2 = await main(["identity", "inventory", "--client-root", "relative/path"], {
      io: { stdout: (s) => out2.push(s), stderr: (s) => err2.push(s) },
    });
    assert.equal(code2, 2);
    assert.match(err2.join("\n"), /--client-root must be an absolute path/);

    // Relative dot-slash path
    const out3 = [];
    const err3 = [];
    const code3 = await main(["identity", "inventory", "--client-root", "./relative/path"], {
      io: { stdout: (s) => out3.push(s), stderr: (s) => err3.push(s) },
    });
    assert.equal(code3, 2);
    assert.match(err3.join("\n"), /--client-root must be an absolute path/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("identity inventory CLI: unknown subcommands, options, and extra positional args", async () => {
  const f = createRealInventoryFixture();
  try {
    // Missing subcommand
    const out1 = [];
    const err1 = [];
    const code1 = await main(["identity"], {
      io: { stdout: (s) => out1.push(s), stderr: (s) => err1.push(s) },
    });
    assert.equal(code1, 2);
    assert.match(err1.join("\n"), /unknown identity command/);

    // Unknown subcommand
    const out2 = [];
    const err2 = [];
    const code2 = await main(["identity", "doctor", "--client-root", f.client], {
      io: { stdout: (s) => out2.push(s), stderr: (s) => err2.push(s) },
    });
    assert.equal(code2, 2);
    assert.match(err2.join("\n"), /unknown identity command doctor/);

    // Extra positional arguments
    const out3 = [];
    const err3 = [];
    const code3 = await main(["identity", "inventory", "extra-arg", "--client-root", f.client], {
      io: { stdout: (s) => out3.push(s), stderr: (s) => err3.push(s) },
    });
    assert.equal(code3, 2);
    assert.match(err3.join("\n"), /identity inventory takes no positional arguments/);

    // Unknown option flag
    const out4 = [];
    const err4 = [];
    const code4 = await main(
      ["identity", "inventory", "--client-root", f.client, "--unsupported-option=val"],
      { io: { stdout: (s) => out4.push(s), stderr: (s) => err4.push(s) } }
    );
    assert.equal(code4, 2);
    assert.match(err4.join("\n"), /unknown option --unsupported-option/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("identity inventory CLI: missing installation graceful report", async () => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "missing-install-"));
  const nonexistentClient = path.join(root, "nonexistent-client-dir");
  try {
    // JSON mode
    const jsonOut = [];
    const jsonErr = [];
    const jsonCode = await main(
      ["identity", "inventory", "--client-root", nonexistentClient, "--json"],
      { io: { stdout: (s) => jsonOut.push(s), stderr: (s) => jsonErr.push(s) } }
    );
    assert.equal(jsonCode, 0, jsonErr.join("\n"));
    assert.equal(jsonErr.length, 0);

    const report = JSON.parse(jsonOut.join("\n"));
    assert.equal(report.schema, "identity_inventory_v1");
    assert.equal(report.summary.identityCount, 0);
    assert.ok(report.summary.faultCount >= 1);
    assert.ok(report.diagnostics.some((d) => d.code === "registry_absent"));

    // Human mode
    const humanOut = [];
    const humanErr = [];
    const humanCode = await main(
      ["identity", "inventory", "--client-root", nonexistentClient],
      { io: { stdout: (s) => humanOut.push(s), stderr: (s) => humanErr.push(s) } }
    );
    assert.equal(humanCode, 0, humanErr.join("\n"));
    assert.equal(humanErr.length, 0);

    const text = humanOut.join("\n");
    assert.match(text, /Identities: none/);
    assert.match(text, /registry_absent/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("identity inventory CLI: duplicate and fault reporting", async () => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "fault-test-"));
  const app = path.join(root, "The Triangle");
  const client = path.join(app, "client");
  try {
    // Two distinct instance files claiming the same profile name ("bob")
    const instA = "a".repeat(64);
    const instB = "b".repeat(64);
    writeJson(path.join(client, "instances", `${instA}.json`), {
      version: 1,
      instanceId: instA,
      profile: "bob",
      runtimeAdapter: "codex",
      enabled: true,
      deliveryMode: "headless-app-server",
    });
    writeJson(path.join(client, "instances", `${instB}.json`), {
      version: 1,
      instanceId: instB,
      profile: "bob",
      runtimeAdapter: "codex",
      enabled: true,
      deliveryMode: "headless-app-server",
    });
    // Missing origin in binding -> invalid origin fault
    writeBinding(app, "bob", { binding: { origin: "invalid-scheme://mesh.local" } });
    writeInstallationIdentity(client, FIXTURE_INSTALLATION_ID);

    // JSON mode
    const jsonOut = [];
    const jsonErr = [];
    const jsonCode = await main(
      ["identity", "inventory", "--client-root", client, "--json"],
      { io: { stdout: (s) => jsonOut.push(s), stderr: (s) => jsonErr.push(s) } }
    );
    assert.equal(jsonCode, 0, jsonErr.join("\n"));
    const report = JSON.parse(jsonOut.join("\n"));

    assert.ok(report.summary.faultCount >= 1);
    assert.ok(report.diagnostics.some((d) => d.code === "duplicate_profile"));

    // Human mode
    const humanOut = [];
    const humanErr = [];
    const humanCode = await main(
      ["identity", "inventory", "--client-root", client],
      { io: { stdout: (s) => humanOut.push(s), stderr: (s) => humanErr.push(s) } }
    );
    assert.equal(humanCode, 0, humanErr.join("\n"));
    const text = humanOut.join("\n");
    assert.match(text, /duplicate_profile/);
    assert.match(text, /! \[fault\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("identity inventory CLI: no writes to nonexistent root or custody home", async () => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "no-write-test-"));
  const nonexistentClient = path.join(root, "nonexistent-client");
  const nonexistentHome = path.join(root, "nonexistent-home");
  try {
    assert.equal(existsSync(nonexistentClient), false);
    assert.equal(existsSync(nonexistentHome), false);

    const out = [];
    const err = [];
    const code = await main(
      ["identity", "inventory", "--client-root", nonexistentClient, "--home", nonexistentHome],
      { io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) } }
    );

    assert.equal(code, 0, err.join("\n"));
    assert.equal(existsSync(nonexistentClient), false, "clientRoot must not be created");
    assert.equal(existsSync(nonexistentHome), false, "home custody root must not be created");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("identity inventory CLI: before/after filesystem hashes and modes unchanged", async () => {
  const f = createRealInventoryFixture();
  try {
    const before = snapshotTree(f.root);

    // Run human output
    const out1 = [];
    const err1 = [];
    const code1 = await main(["identity", "inventory", "--client-root", f.client], {
      io: { stdout: (s) => out1.push(s), stderr: (s) => err1.push(s) },
    });
    assert.equal(code1, 0, err1.join("\n"));

    // Run JSON output
    const out2 = [];
    const err2 = [];
    const code2 = await main(["identity", "inventory", "--client-root", f.client, "--json"], {
      io: { stdout: (s) => out2.push(s), stderr: (s) => err2.push(s) },
    });
    assert.equal(code2, 0, err2.join("\n"));

    const after = snapshotTree(f.root);

    assert.equal(before.size, after.size, "File count must match exactly");
    for (const [relPath, beforeStat] of before) {
      const afterStat = after.get(relPath);
      assert.ok(afterStat, `Missing path after execution: ${relPath}`);
      assert.equal(afterStat.mode, beforeStat.mode, `Mode changed for ${relPath}`);
      assert.equal(afterStat.hash, beforeStat.hash, `Hash changed for ${relPath}`);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("identity inventory CLI: network fetch trap is never called", async () => {
  const f = createRealInventoryFixture();
  try {
    let trapCalled = false;
    const fetchTrap = () => {
      trapCalled = true;
      throw new Error("Network fetch trap invoked: identity inventory must not call network!");
    };

    const out = [];
    const err = [];
    const code = await main(
      ["identity", "inventory", "--client-root", f.client, "--json"],
      {
        fetchImpl: fetchTrap,
        io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) },
      }
    );

    assert.equal(code, 0, err.join("\n"));
    assert.equal(trapCalled, false, "fetchImpl must never be called by identity inventory");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("identity inventory CLI: render omitted health diagnostic count", async () => {
  const { renderIdentityInventory } = await import("../src/identity-inventory.mjs");
  const reportWithOmitted = {
    summary: {
      identityCount: 1,
      unmappedProfileCount: 0,
      faultCount: 0,
      warningCount: 0,
      omittedHealthDiagnosticCount: 3,
    },
    identities: [],
  };
  const textWithOmitted = renderIdentityInventory(reportWithOmitted);
  assert.match(
    textWithOmitted,
    /Installation-health diagnostics omitted: 3 \(see triangle-local status\)\./
  );

  const reportZeroOmitted = {
    summary: {
      identityCount: 1,
      unmappedProfileCount: 0,
      faultCount: 0,
      warningCount: 0,
      omittedHealthDiagnosticCount: 0,
    },
    identities: [],
  };
  const textZeroOmitted = renderIdentityInventory(reportZeroOmitted);
  assert.doesNotMatch(textZeroOmitted, /Installation-health diagnostics omitted:/);
});

test("identity inventory CLI: missing agent-worker modules throws LocalStateError (exit 1, no stack, no path)", async () => {
  const tmp = mkdtempSync("/private/tmp/id-inv-missing-worker-");
  try {
    const srcDir = path.resolve(import.meta.dirname, "../src");
    cpSync(srcDir, path.join(tmp, "src"), { recursive: true });
    const isolatedCliUrl = pathToFileURL(path.join(tmp, "src", "cli.mjs")).href;
    const { main: isolatedMain } = await import(isolatedCliUrl);

    const out = [];
    const err = [];
    const code = await isolatedMain(
      ["identity", "inventory", "--client-root", "/private/tmp/nonexistent"],
      { io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) } }
    );

    assert.equal(code, 1);
    assert.equal(err.length, 1);
    assert.equal(
      err[0],
      "Installation inventory foundation (@the-triangle/agent-worker) is not available in this installation."
    );
    assert.ok(!err[0].includes("\n"), "stderr must be a single line");
    assert.ok(!err[0].includes("at "), "stderr must not contain stack trace");
    assert.ok(!err[0].includes("/private/"), "stderr must not contain absolute paths");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

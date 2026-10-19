import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  lstatSync,
  symlinkSync,
  writeFileSync,
  rmSync,
  realpathSync,
  chmodSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  linuxPaths,
  safeDirectory,
  safeFile,
  atomicPrivateJSON,
  readPrivateJSON,
  profilePath,
  readProfile,
  writeProfile,
} from "../src/paths.mjs";
const make = () =>
  realpathSync(mkdtempSync(path.join(os.tmpdir(), "triangle-linux-path-")));
test("XDG profile paths keep credentials separate and profile files remain private", () => {
  const home = make();
  try {
    const opts = { accountHome: home, env: {} };
    const p = linuxPaths(opts);
    assert.equal(
      p.stateRoot,
      path.join(home, ".local/state/triangle/runtime-v1"),
    );
    assert.equal(p.unitsRoot, path.join(home, ".config/systemd/user"));
    const config = {
      schema: 1,
      profile: "linux-agent",
      agentId: "agent_" + "a".repeat(32),
      identityHome: path.join(home, ".local/state/triangle/v1"),
      authority: "https://thetriangle.dev",
      via: null,
      harness: "codex",
      command: "/usr/bin/codex",
      bwrap: "/usr/bin/bwrap",
      node: "/opt/triangle/bin/node",
      releaseRoot: "/opt/triangle",
      workdir: path.join(p.workspacesRoot, "linux-agent"),
      modelHome: path.join(p.modelsRoot, "linux-agent"),
      stateRoot: path.join(p.stateRoot, "agents", "agent_" + "a".repeat(32)),
      pollIntervalMs: 30000,
      runnerTimeoutMs: 600000,
    };
    writeProfile(config, opts);
    assert.deepEqual(readProfile(config.profile, opts), config);
    assert.equal(
      lstatSync(profilePath(config.profile, opts)).mode & 0o777,
      0o600,
    );
    assert.throws(() => profilePath("../escape", opts), /profile/i);
    assert.throws(
      () => writeProfile({ ...config, ownerKey: "secret" }, opts),
      /profile|schema/i,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test("private files reject symlink ancestors, unsafe modes and extra links", () => {
  const home = make();
  try {
    const root = path.join(home, "private");
    safeDirectory(root, { create: true });
    atomicPrivateJSON(path.join(root, "safe.json"), { ready: true });
    assert.deepEqual(readPrivateJSON(path.join(root, "safe.json")), {
      ready: true,
    });
    symlinkSync(root, path.join(home, "alias"));
    assert.throws(
      () => readPrivateJSON(path.join(home, "alias/safe.json")),
      /symlink|canonical/i,
    );
    chmodSync(path.join(root, "safe.json"), 0o644);
    assert.throws(
      () => readPrivateJSON(path.join(root, "safe.json")),
      /private|permission/i,
    );
    assert.equal(
      readPrivateJSON(path.join(root, "missing"), { missing: true }),
      null,
    );
    assert.throws(
      () =>
        linuxPaths({ env: { XDG_STATE_HOME: "relative" }, accountHome: home }),
      /absolute|XDG/i,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

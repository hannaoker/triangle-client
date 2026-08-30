import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/triangle-worker-service.sh", import.meta.url));

function mode(file) { return fs.statSync(file).mode & 0o777; }

function makeFixture(t, prefix = "triangle-worker-contract-") {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const applicationRoot = path.join(home, "Library", "Application Support", "The Triangle");
  const bin = path.join(applicationRoot, "bin");
  const integrity = path.join(applicationRoot, "install-manifest");
  const credentials = path.join(applicationRoot, "credentials");
  for (const directory of [applicationRoot, bin, integrity, credentials]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }
  const helper = path.join(bin, "triangle-mailbox");
  const helperBytes = Buffer.from("#!/bin/sh\nexit 0\n");
  fs.writeFileSync(helper, helperBytes, { mode: 0o700 });
  fs.chmodSync(helper, 0o700);
  fs.writeFileSync(
    path.join(integrity, "triangle-mailbox.sha256"),
    `${crypto.createHash("sha256").update(helperBytes).digest("hex")}\n`,
    { mode: 0o600 },
  );

  const nodeDirectory = path.join(home, "node-bin");
  fs.mkdirSync(nodeDirectory, { mode: 0o700 });
  fs.symlinkSync(fs.realpathSync(process.execPath), path.join(nodeDirectory, "node"));
  const codexCLI = path.join(bin, "codex-test-cli");
  fs.writeFileSync(codexCLI, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  fs.chmodSync(codexCLI, 0o700);

  const hermesVenv = path.join(home, "hermes-agent", "venv");
  const hermesBin = path.join(hermesVenv, "bin");
  fs.mkdirSync(hermesBin, { recursive: true, mode: 0o700 });
  const hermesEntry = path.join(hermesBin, "hermes");
  fs.writeFileSync(hermesEntry, `#!${fs.realpathSync(process.execPath)}\nprocess.exit(0);\n`, { mode: 0o700 });
  fs.chmodSync(hermesEntry, 0o700);
  const hermesCLI = path.join(bin, "hermes-test-cli");
  fs.writeFileSync(hermesCLI, `#!/bin/bash\nexec "${hermesEntry}" "$@"\n`, { mode: 0o700 });
  fs.chmodSync(hermesCLI, 0o700);

  const launchctlLog = path.join(home, "launchctl.log");
  const launchctl = path.join(home, "launchctl-stub");
  fs.writeFileSync(launchctl, `#!/bin/bash\nprintf '%s\\n' "$*" >> "$LAUNCHCTL_LOG"\nexit 0\n`, { mode: 0o700 });
  fs.chmodSync(launchctl, 0o700);
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${nodeDirectory}:${process.env.PATH}`,
    TRIANGLE_MAILBOX_HELPER: helper,
    TRIANGLE_MAILBOX_PROFILE: "codex-mailbox-live",
    CODEX_CLI: codexCLI,
    HERMES_CLI: hermesCLI,
    TRIANGLE_TEST_MODE: "1",
    TRIANGLE_LAUNCHCTL: launchctl,
    LAUNCHCTL_LOG: launchctlLog,
  };
  return { home, applicationRoot, helper, env, launchctlLog, codexCLI, hermesCLI };
}

function run(action, agent, env) {
  return spawnSync("/bin/bash", [script, action, agent], { encoding: "utf8", env });
}

function prepare(fixture, agent = "codex") {
  const result = run("prepare-runtime", agent, fixture.env);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(fs.readFileSync(path.join(fixture.applicationRoot, "worker-runtime", `${agent}.manifest.json`), "utf8"));
}

test("worker service safely renders an escaped Keychain profile without credentials", (t) => {
  const fixture = makeFixture(t, 'triangle service & "home"-');
  prepare(fixture);
  const result = run("render", "codex", { ...fixture.env, TRIANGLE_MAILBOX_PROFILE: 'codex & "mailbox"' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /codex &amp; &quot;mailbox&quot;/);
  assert.match(result.stdout, /<string>run-worker<\/string>/);
  assert.match(result.stdout, /<string>codex<\/string>/);
  assert.doesNotMatch(result.stdout, /MESH_|mesh_|--env-file|\.env/);
  assert.doesNotMatch(result.stdout, /__[A-Z_]+__/);
  assert.equal(spawnSync("/usr/bin/plutil", ["-lint", "-"], { input: result.stdout, encoding: "utf8" }).status, 0);
});

test("worker service rejects helper paths outside the application root and symlink aliases", (t) => {
  const fixture = makeFixture(t);
  prepare(fixture);
  const outside = path.join(fixture.home, "triangle-mailbox-outside");
  fs.copyFileSync(fixture.helper, outside); fs.chmodSync(outside, 0o700);
  let result = run("render", "codex", { ...fixture.env, TRIANGLE_MAILBOX_HELPER: outside });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fixed application-owned helper/);
  fs.renameSync(fixture.helper, `${fixture.helper}.real`);
  fs.symlinkSync(`${fixture.helper}.real`, fixture.helper);
  result = run("render", "codex", fixture.env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /canonical|symlink/i);
});

test("worker service fails closed for missing, permissive, or integrity-mismatched helpers", (t) => {
  const fixture = makeFixture(t);
  prepare(fixture);
  fs.chmodSync(fixture.helper, 0o755);
  let result = run("render", "codex", fixture.env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe ownership or permissions/);
  fs.chmodSync(fixture.helper, 0o700);
  fs.appendFileSync(fixture.helper, "# changed\n");
  result = run("render", "codex", fixture.env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /integrity verification/);
  fs.rmSync(fixture.helper);
  result = run("render", "codex", fixture.env);
  assert.notEqual(result.status, 0);
});

test("runtime preparation canonicalizes Node and Codex CLI inputs into a strict bundle", (t) => {
  const fixture = makeFixture(t, "triangle canonical home ");
  const cliAlias = path.join(fixture.home, "codex-alias");
  fs.symlinkSync(fixture.codexCLI, cliAlias);
  const manifest = prepare({ ...fixture, env: { ...fixture.env, CODEX_CLI: cliAlias } });
  assert.equal(manifest.environment.CODEX_CLI, fs.realpathSync(fixture.codexCLI));
  assert.equal(path.basename(manifest.environment.PATH.split(path.delimiter)[0]), "bin");
  assert.equal(path.basename(manifest.projectRoot).length, 64);
  assert.equal(mode(path.join(manifest.projectRoot, "bin", "node")), 0o500);
});

test("runtime preparation ignores hostile model overrides and rejects a symlinked application root", (t) => {
  const fixture = makeFixture(t);
  const outside = path.join(fixture.home, "outside-model"); fs.mkdirSync(outside);
  const manifest = prepare({
    ...fixture,
    env: {
      ...fixture.env,
      CODEX_HOME: outside,
      TRIANGLE_MODEL_STATE_BASE: outside,
      TRIANGLE_MODEL_ROOTS: outside,
      TRIANGLE_RUNTIME_ROOTS: outside,
    },
  });
  assert.deepEqual(
    Object.keys(manifest.environment).sort(),
    ["CODEX_CLI", "LANG", "LC_ALL", "PATH", "TRIANGLE_PROJECT_ROOT", "TRIANGLE_RUNTIME_ROOTS"].sort(),
  );
  for (const mutableName of [
    "CODEX_HOME", "HERMES_HOME", "TRIANGLE_MODEL_STATE_BASE", "TRIANGLE_MODEL_ROOTS",
    "TRIANGLE_INSTANCE_ID", "TRIANGLE_INSTANCE_TEMP_ROOT",
  ]) {
    assert.equal(manifest.environment[mutableName], undefined, `shared runtime manifest contains ${mutableName}`);
  }
  assert.doesNotMatch(JSON.stringify(manifest.environment), new RegExp(outside.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const escapedHome = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "triangle-model-symlink-"));
  t.after(() => fs.rmSync(escapedHome, { recursive: true, force: true }));
  fs.mkdirSync(path.join(escapedHome, "Library", "Application Support"), { recursive: true });
  const escapedRoot = path.join(escapedHome, "outside-triangle"); fs.mkdirSync(escapedRoot);
  fs.symlinkSync(escapedRoot, path.join(escapedHome, "Library", "Application Support", "The Triangle"));
  const result = run("prepare-runtime", "codex", { ...fixture.env, HOME: escapedHome });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /canonical|symlink|directory/i);
});

test("Hermes runtime preparation records its verified wrapper chain without ambient PYTHONPATH", (t) => {
  const fixture = makeFixture(t);
  const ambientPython = path.join(fixture.home, "ambient-python"); fs.mkdirSync(ambientPython);
  const manifest = prepare({ ...fixture, env: { ...fixture.env, PYTHONPATH: ambientPython } }, "hermes");
  assert.equal(manifest.environment.HERMES_CLI, fs.realpathSync(fixture.hermesCLI));
  assert.deepEqual(
    Object.keys(manifest.environment).sort(),
    ["HERMES_CLI", "LANG", "LC_ALL", "PATH", "TRIANGLE_PROJECT_ROOT", "TRIANGLE_RUNTIME_ROOTS"].sort(),
  );
  for (const mutableName of [
    "CODEX_HOME", "HERMES_HOME", "TRIANGLE_MODEL_STATE_BASE", "TRIANGLE_MODEL_ROOTS",
    "TRIANGLE_INSTANCE_ID", "TRIANGLE_INSTANCE_TEMP_ROOT",
  ]) {
    assert.equal(manifest.environment[mutableName], undefined, `shared runtime manifest contains ${mutableName}`);
  }
  assert.match(manifest.environment.TRIANGLE_RUNTIME_ROOTS, /hermes-agent/);
  assert.doesNotMatch(JSON.stringify(manifest.environment), /ambient-python/);
});

test("status stop and uninstall use the bounded launchctl seam without live custody", (t) => {
  const fixture = makeFixture(t, "triangle lifecycle home ");
  for (const action of ["status", "stop", "uninstall"]) {
    const result = run(action, "codex", { ...fixture.env, TRIANGLE_MAILBOX_PROFILE: "", TRIANGLE_MAILBOX_HELPER: "" });
    assert.equal(result.status, 0, `${action}: ${result.stderr}`);
  }
  const calls = fs.readFileSync(fixture.launchctlLog, "utf8");
  assert.match(calls, /print gui\//);
  assert.match(calls, /bootout gui\//);
});

test("worker install defers per-instance model homes and creates a secret-free plist", (t) => {
  const fixture = makeFixture(t);
  const result = run("install", "codex", fixture.env);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const modelState = path.join(fixture.applicationRoot, "model-state");
  assert.equal(fs.realpathSync(modelState), modelState);
  assert.equal(mode(modelState), 0o700);
  assert.equal(fs.existsSync(path.join(modelState, "codex")), false);
  assert.equal(fs.existsSync(path.join(modelState, "hermes")), false);
  const plistPath = path.join(fixture.home, "Library", "LaunchAgents", "dev.thetriangle.codex.worker.plist");
  const plist = fs.readFileSync(plistPath, "utf8");
  assert.match(plist, /codex-mailbox-live/);
  assert.match(plist, /run-worker/);
  assert.doesNotMatch(plist, /MESH_|mesh_|credential|--env-file|\.env/);
  assert.equal(mode(plistPath), 0o600);
});

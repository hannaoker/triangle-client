import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const template = fs.readFileSync(path.join(root, "deploy/launchd/dev.thetriangle.agent-worker.plist.template"), "utf8");
const service = fs.readFileSync(path.join(root, "scripts/triangle-worker-service.sh"), "utf8");
const servicePath = path.join(root, "scripts/triangle-worker-service.sh");

function mode(file) { return fs.statSync(file).mode & 0o777; }

function makeInstallFixture(t) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "triangle-worker-install-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const applicationRoot = path.join(home, "Library", "Application Support", "The Triangle");
  const bin = path.join(applicationRoot, "bin");
  const integrity = path.join(applicationRoot, "install-manifest");
  const credentials = path.join(applicationRoot, "credentials");
  for (const directory of [applicationRoot, bin, integrity, credentials]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700);
  }
  const helper = path.join(bin, "triangle-mailbox");
  const helperBytes = Buffer.from("#!/bin/sh\nexit 0\n");
  fs.writeFileSync(helper, helperBytes, { mode: 0o700 }); fs.chmodSync(helper, 0o700);
  fs.writeFileSync(path.join(integrity, "triangle-mailbox.sha256"), `${crypto.createHash("sha256").update(helperBytes).digest("hex")}\n`, { mode: 0o600 });
  const fakeCLI = path.join(bin, "codex-test-cli");
  fs.writeFileSync(fakeCLI, "#!/bin/sh\nexit 0\n", { mode: 0o700 }); fs.chmodSync(fakeCLI, 0o700);
  const nodeSourceDirectory = path.join(home, "mutable-node-source");
  fs.mkdirSync(nodeSourceDirectory, { mode: 0o700 }); fs.chmodSync(nodeSourceDirectory, 0o700);
  const nodeSource = path.join(nodeSourceDirectory, "node");
  fs.writeFileSync(nodeSource, "#!/bin/sh\nif [ \"${1:-}\" = --check ]; then exit 0; fi\nif [ \"${1:-}\" = --input-type=module ]; then printf 'triangle-node-ok\\n'; exit 0; fi\nexit 64\n", { mode: 0o700 }); fs.chmodSync(nodeSource, 0o700);
  const hermesVenv = path.join(home, "hermes-venv");
  const hermesBin = path.join(hermesVenv, "bin");
  fs.mkdirSync(hermesBin, { recursive: true, mode: 0o700 }); fs.chmodSync(hermesVenv, 0o700); fs.chmodSync(hermesBin, 0o700);
  const hermesEntry = path.join(hermesBin, "hermes");
  fs.writeFileSync(hermesEntry, `#!${fs.realpathSync(process.execPath)}\nprocess.exit(0);\n`, { mode: 0o700 }); fs.chmodSync(hermesEntry, 0o700);
  const hermesCLI = path.join(bin, "hermes-test-cli");
  fs.writeFileSync(hermesCLI, `#!/bin/bash\nexec "${hermesEntry}" "$@"\n`, { mode: 0o700 }); fs.chmodSync(hermesCLI, 0o700);
  const launchctlLog = path.join(home, "launchctl.log");
  const launchctl = path.join(home, "launchctl-stub");
  fs.writeFileSync(launchctl, `#!/bin/bash\nset -eu\necho "$*" >> "$LAUNCHCTL_LOG"\ncase "$1" in\n print) [[ -f "$LAUNCHCTL_PRIOR_LOADED" ]];;\n bootstrap) if [[ -f "$LAUNCHCTL_FAIL_ONCE" ]]; then rm -f "$LAUNCHCTL_FAIL_ONCE"; exit 71; fi;;\nesac\n`, { mode: 0o700 });
  fs.chmodSync(launchctl, 0o700);
  const env = {
    ...process.env, HOME: home, PATH: `${nodeSourceDirectory}:${process.env.PATH}`,
    TRIANGLE_MAILBOX_HELPER: helper,
    TRIANGLE_MAILBOX_PROFILE: "codex-mailbox-live", CODEX_CLI: fakeCLI, HERMES_CLI: hermesCLI,
    TRIANGLE_TEST_MODE: "1", TRIANGLE_LAUNCHCTL: launchctl,
    LAUNCHCTL_LOG: launchctlLog, LAUNCHCTL_PRIOR_LOADED: path.join(home, "prior-loaded"),
    LAUNCHCTL_FAIL_ONCE: path.join(home, "fail-once"),
  };
  return { home, applicationRoot, helper, env, launchctlLog, nodeSource };
}

test("LaunchAgent invokes only the Keychain helper profile and closed worker kind", () => {
  assert.match(template, /<string>__HELPER__<\/string>[\s\S]*<string>run-worker<\/string>[\s\S]*<string>--profile<\/string>[\s\S]*<string>__PROFILE__<\/string>[\s\S]*<string>--worker<\/string>[\s\S]*<string>__AGENT__<\/string>/);
  assert.doesNotMatch(template, /--env-file|CREDENTIAL_FILE|CREDENTIAL_ROOT|__NODE__|cli\.mjs/);
  assert.doesNotMatch(template, /MESH_AGENT_TOKEN|MESH_ORIGIN|CODEX_AGENT_ID|HERMES_AGENT_ID/);
});

test("service validates helper and profile and documents explicit legacy rollback", () => {
  assert.match(service, /TRIANGLE_MAILBOX_HELPER/);
  assert.match(service, /TRIANGLE_MAILBOX_PROFILE/);
  assert.match(service, /legacy-file rollback/i);
  assert.doesNotMatch(service, /--env-file=.*CREDENTIAL/);
});

test("service renders secret-free valid Codex and Hermes Keychain LaunchAgents", (t) => {
  const fixture = makeInstallFixture(t);
  for (const agent of ["codex", "hermes"]) {
    const prepared = spawnSync("/bin/bash", [servicePath, "prepare-runtime", agent], { encoding: "utf8", env: fixture.env });
    assert.equal(prepared.status, 0, prepared.stderr);
    const rendered = spawnSync("/bin/bash", [servicePath, "render", agent], {
      encoding: "utf8",
      env: fixture.env,
    });
    assert.equal(rendered.status, 0, rendered.stderr);
    const linted = spawnSync("/usr/bin/plutil", ["-lint", "-"], { input: rendered.stdout, encoding: "utf8" });
    assert.equal(linted.status, 0, linted.stderr);
    assert.match(rendered.stdout, new RegExp(`<string>${fixture.helper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</string>`));
    assert.match(rendered.stdout, new RegExp(`<string>${agent}</string>`));
    assert.doesNotMatch(rendered.stdout, /MESH_|mesh_|credential|--env-file|\.env/);
  }
  const unsafeProfile = spawnSync("/bin/bash", [servicePath, "render", "codex"], {
    encoding: "utf8", env: { ...fixture.env, TRIANGLE_MAILBOX_PROFILE: "../escape" },
  });
  assert.notEqual(unsafeProfile.status, 0);
  fs.renameSync(fixture.helper, `${fixture.helper}.real`);
  fs.symlinkSync(`${fixture.helper}.real`, fixture.helper);
  const symlinked = spawnSync("/bin/bash", [servicePath, "render", "codex"], {
    encoding: "utf8", env: fixture.env,
  });
  assert.notEqual(symlinked.status, 0);
});

test("clean runtime preparation installs a complete strict application-owned bundle", (t) => {
  const fixture = makeInstallFixture(t);
  const prepared = spawnSync("/bin/bash", [servicePath, "prepare-runtime", "codex"], { encoding: "utf8", env: fixture.env });
  assert.equal(prepared.status, 0, prepared.stderr);
  const runtime = path.join(fixture.applicationRoot, "worker-runtime");
  const manifestPath = path.join(runtime, "codex.manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.version, 4);
  assert.equal(mode(runtime), 0o700);
  assert.equal(mode(manifestPath), 0o600);
  assert.deepEqual(Object.keys(manifest).sort(), ["artifacts", "environment", "nodeSHA256", "projectRoot", "version"].sort());
  for (const mutableName of ["TRIANGLE_MODEL_STATE_BASE", "TRIANGLE_MODEL_ROOTS", "TRIANGLE_INSTANCE_ID", "TRIANGLE_INSTANCE_TEMP_ROOT", "CODEX_HOME", "HERMES_HOME"]) {
    assert.equal(manifest.environment[mutableName], undefined, `shared runtime manifest contains ${mutableName}`);
  }
  assert.deepEqual(Object.keys(manifest.artifacts).sort(), [
    "agents/codex/worker/agent-worker.json",
    "packages/agent-worker/runners/codex-runner.mjs",
    "packages/agent-worker/runners/runner-common.mjs",
    "packages/agent-worker/src/cli.mjs",
    "packages/agent-worker/src/client-supervisor-cli.mjs",
    "packages/agent-worker/src/client-supervisor.mjs",
    "packages/agent-worker/src/command-runner.mjs",
    "packages/agent-worker/src/concurrency-gate.mjs",
    "packages/agent-worker/src/mailbox-client.mjs",
    "packages/agent-worker/src/runtime.mjs",
  ]);
  for (const [relative, digest] of Object.entries(manifest.artifacts)) {
    const installed = path.join(manifest.projectRoot, relative);
    assert.equal(fs.lstatSync(installed).isFile(), true);
    assert.equal(mode(installed), 0o600);
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(installed)).digest("hex"), digest);
    assert.equal(fs.realpathSync(installed), installed);
  }
  const bundledNode = path.join(manifest.projectRoot, "bin", "node");
  assert.equal(fs.realpathSync(bundledNode), bundledNode);
  assert.equal(mode(bundledNode), 0o500);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(bundledNode)).digest("hex"), manifest.nodeSHA256);
  const addressInput = ["codex", manifest.nodeSHA256, ...Object.keys(manifest.artifacts).sort().map((name) => `${name}=${manifest.artifacts[name]}`)].join("\n") + "\n";
  assert.equal(path.basename(manifest.projectRoot), crypto.createHash("sha256").update(addressInput).digest("hex"));
  fs.renameSync(fixture.nodeSource, `${fixture.nodeSource}.original`);
  fs.writeFileSync(fixture.nodeSource, "#!/bin/sh\nexit 97\n", { mode: 0o700 }); fs.chmodSync(fixture.nodeSource, 0o700);
  const smoke = spawnSync(bundledNode, ["--check", path.join(manifest.projectRoot, "packages/agent-worker/src/cli.mjs")], { encoding: "utf8", env: {} });
  assert.equal(smoke.status, 0, smoke.stderr);
  assert.doesNotMatch(`${prepared.stdout}${prepared.stderr}${smoke.stdout}${smoke.stderr}`, /mesh_[a-f0-9]{64}|MESH_AGENT_TOKEN=/);
});

test("helper-only upgrade validates and renders an exact legacy version-3 runtime", (t) => {
  const fixture = makeInstallFixture(t);
  const prepared = spawnSync("/bin/bash", [servicePath, "prepare-runtime", "codex"], { encoding: "utf8", env: fixture.env });
  assert.equal(prepared.status, 0, prepared.stderr);
  const manifestPath = path.join(fixture.applicationRoot, "worker-runtime", "codex.manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const removed = [
    "packages/agent-worker/src/client-supervisor-cli.mjs",
    "packages/agent-worker/src/client-supervisor.mjs",
    "packages/agent-worker/src/concurrency-gate.mjs",
  ];
  for (const relative of removed) {
    delete manifest.artifacts[relative];
    fs.rmSync(path.join(manifest.projectRoot, relative));
  }
  const addressInput = ["codex", manifest.nodeSHA256, ...Object.keys(manifest.artifacts).sort().map((name) => `${name}=${manifest.artifacts[name]}`)].join("\n") + "\n";
  const legacyRoot = path.join(path.dirname(manifest.projectRoot), crypto.createHash("sha256").update(addressInput).digest("hex"));
  const priorRoot = manifest.projectRoot;
  fs.renameSync(priorRoot, legacyRoot);
  manifest.version = 3;
  manifest.projectRoot = legacyRoot;
  for (const [name, value] of Object.entries(manifest.environment)) {
    manifest.environment[name] = value.replaceAll(priorRoot, legacyRoot);
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  fs.chmodSync(manifestPath, 0o600);

  const rendered = spawnSync("/bin/bash", [servicePath, "render", "codex"], { encoding: "utf8", env: fixture.env });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /dev\.thetriangle\.codex\.worker/);
});

test("LaunchAgent install is atomic and restores runtime and loaded prior service on bootstrap failure", (t) => {
  const fixture = makeInstallFixture(t);
  const launchAgents = path.join(fixture.home, "Library", "LaunchAgents");
  fs.mkdirSync(launchAgents, { recursive: true, mode: 0o700 }); fs.chmodSync(launchAgents, 0o700);
  const target = path.join(launchAgents, "dev.thetriangle.codex.worker.plist");
  const oldBytes = Buffer.from("<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>Label</key><string>old.worker</string></dict></plist>\n");
  fs.writeFileSync(target, oldBytes, { mode: 0o600 }); fs.chmodSync(target, 0o600);
  let result = spawnSync("/bin/bash", [servicePath, "install", "codex"], { encoding: "utf8", env: { ...fixture.env, TRIANGLE_MAILBOX_PROFILE: "../bad" } });
  assert.notEqual(result.status, 0);
  assert.deepEqual(fs.readFileSync(target), oldBytes, "invalid render truncated live plist");

  fs.writeFileSync(fixture.env.LAUNCHCTL_PRIOR_LOADED, "yes");
  fs.writeFileSync(fixture.env.LAUNCHCTL_FAIL_ONCE, "yes");
  const initiallyPrepared = spawnSync("/bin/bash", [servicePath, "prepare-runtime", "codex"], { encoding: "utf8", env: fixture.env });
  assert.equal(initiallyPrepared.status, 0, initiallyPrepared.stderr);
  const beforeBundles = fs.readdirSync(path.join(fixture.applicationRoot, "worker-runtime", "bundles")).sort();
  const beforeRuntime = fs.existsSync(path.join(fixture.applicationRoot, "worker-runtime", "codex.manifest.json"))
    ? fs.readFileSync(path.join(fixture.applicationRoot, "worker-runtime", "codex.manifest.json")) : null;
  result = spawnSync("/bin/bash", [servicePath, "install", "codex"], { encoding: "utf8", env: fixture.env });
  assert.notEqual(result.status, 0);
  assert.deepEqual(fs.readFileSync(target), oldBytes, "bootstrap failure did not restore exact plist bytes");
  const afterManifest = path.join(fixture.applicationRoot, "worker-runtime", "codex.manifest.json");
  if (beforeRuntime) assert.deepEqual(fs.readFileSync(afterManifest), beforeRuntime);
  else assert.equal(fs.existsSync(afterManifest), false, "failed clean install left active runtime manifest");
  assert.deepEqual(fs.readdirSync(path.join(fixture.applicationRoot, "worker-runtime", "bundles")).sort(), beforeBundles, "failed install retained staged runtime bundle");
  const calls = fs.readFileSync(fixture.launchctlLog, "utf8");
  assert.match(calls, /print gui\/\d+\/dev\.thetriangle\.codex\.worker/);
  assert.equal((calls.match(/bootstrap/g) || []).length, 2, calls);

  fs.rmSync(fixture.launchctlLog, { force: true });
  result = spawnSync("/bin/bash", [servicePath, "install", "codex"], { encoding: "utf8", env: fixture.env });
  assert.equal(result.status, 0, result.stderr);
  assert.notDeepEqual(fs.readFileSync(target), oldBytes);
  assert.equal(mode(target), 0o600);
  assert.equal(spawnSync("/usr/bin/plutil", ["-lint", target]).status, 0);
});

test("LaunchAgent install rejects an existing symlink target without touching its destination", (t) => {
  const fixture = makeInstallFixture(t);
  const launchAgents = path.join(fixture.home, "Library", "LaunchAgents");
  fs.mkdirSync(launchAgents, { recursive: true, mode: 0o700 }); fs.chmodSync(launchAgents, 0o700);
  const destination = path.join(fixture.home, "outside.plist");
  fs.writeFileSync(destination, "outside\n", { mode: 0o600 });
  fs.symlinkSync(destination, path.join(launchAgents, "dev.thetriangle.codex.worker.plist"));
  const result = spawnSync("/bin/bash", [servicePath, "install", "codex"], { encoding: "utf8", env: fixture.env });
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(destination, "utf8"), "outside\n");
});

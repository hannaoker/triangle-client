import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = path.join(root, "scripts/triangle-client-service.sh");

function mode(file) { return fs.statSync(file).mode & 0o777; }

function fixture(t) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "triangle-client-service-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.chmodSync(home, 0o700);
  const app = path.join(home, "Library", "Application Support", "The Triangle");
  const bin = path.join(app, "bin");
  const manifest = path.join(app, "install-manifest");
  for (const directory of [bin, manifest]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }
  const helper = path.join(bin, "triangle-mailbox");
  const helperBytes = Buffer.from("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"${TRIANGLE_HELPER_LOG:-/dev/null}\"\n[ -z \"${MESH_AGENT_TOKEN+x}${TRIANGLE_MAILBOX_PROFILE+x}${CODEX_AGENT_ID+x}${HERMES_AGENT_ID+x}\" ] || exit 90\n[ \"${TRIANGLE_TEST_PREFLIGHT_RESULT:-ok}\" = ok ]\n");
  fs.writeFileSync(helper, helperBytes, { mode: 0o700 });
  fs.chmodSync(helper, 0o700);
  fs.writeFileSync(path.join(manifest, "triangle-mailbox.sha256"), `${crypto.createHash("sha256").update(helperBytes).digest("hex")}\n`, { mode: 0o600 });

  const tools = path.join(home, "tools");
  fs.mkdirSync(tools, { mode: 0o700 });
  fs.symlinkSync(fs.realpathSync(process.execPath), path.join(tools, "node"));
  const codex = path.join(bin, "codex-test-cli");
  fs.writeFileSync(codex, "#!/bin/sh\nexit 0\n", { mode: 0o700 }); fs.chmodSync(codex, 0o700);
  const hermesRoot = path.join(home, "hermes", "venv");
  const hermesBin = path.join(hermesRoot, "bin"); fs.mkdirSync(hermesBin, { recursive: true, mode: 0o700 });
  const hermesEntry = path.join(hermesBin, "hermes");
  fs.writeFileSync(hermesEntry, `#!${fs.realpathSync(process.execPath)}\nprocess.exit(0);\n`, { mode: 0o700 }); fs.chmodSync(hermesEntry, 0o700);
  const hermes = path.join(bin, "hermes-test-cli");
  fs.writeFileSync(hermes, `#!/bin/bash\nexec "${hermesEntry}" "$@"\n`, { mode: 0o700 }); fs.chmodSync(hermes, 0o700);

  const launchctlLog = path.join(home, "launchctl.log");
  const helperLog = path.join(home, "helper.log");
  const state = path.join(home, "launchctl-state"); fs.mkdirSync(state, { mode: 0o700 });
  const launchctl = path.join(tools, "launchctl");
  fs.writeFileSync(launchctl, `#!/bin/bash
set -eu
printf '%s\\n' "$*" >> "$TRIANGLE_LAUNCHCTL_LOG"
command=$1
target=\${2:-}
if [[ "$command" == kickstart ]]; then target=\${3:-}; fi
label=\${target##*/}
if [[ "$command" == bootstrap ]]; then
  plist=$3
  label=$(/usr/bin/plutil -extract Label raw -o - "$plist")
  [[ "\${TRIANGLE_LAUNCHCTL_FAIL_BOOTSTRAP_LABEL:-}" != "$label" ]] || exit 71
  if [[ "\${TRIANGLE_LAUNCHCTL_FAIL_BOOTSTRAP_ONCE_LABEL:-}" == "$label" && ! -f "$TRIANGLE_LAUNCHCTL_STATE/.failed-$label" ]]; then
    /usr/bin/touch "$TRIANGLE_LAUNCHCTL_STATE/.failed-$label"
    exit 71
  fi
  /usr/bin/touch "$TRIANGLE_LAUNCHCTL_STATE/$label"
  if [[ "$label" == dev.thetriangle.client && "\${TRIANGLE_TEST_READY_MODE:-valid}" != missing ]]; then
    /bin/mkdir -p "$(/usr/bin/dirname "$TRIANGLE_READY_MARKER_PATH")"
    now=$(/usr/bin/python3 -c 'import time; print(int(time.time()*1000))')
    printf '{"version":1,"generation":"11111111-1111-4111-8111-111111111111","parentPid":4242,"configDigest":"%064d","readyAtMilliseconds":%s}\n' 0 "$now" > "$TRIANGLE_READY_MARKER_PATH"
    /bin/chmod 600 "$TRIANGLE_READY_MARKER_PATH"
  fi
elif [[ "$command" == bootout ]]; then
  [[ "\${TRIANGLE_LAUNCHCTL_FAIL_BOOTOUT_LABEL:-}" != "$label" ]] || exit 72
  [[ "\${TRIANGLE_LAUNCHCTL_FAIL_CLIENT_BOOTOUT:-0}" != 1 || "$label" != dev.thetriangle.client ]] || exit 72
  [[ "\${TRIANGLE_LAUNCHCTL_STICKY_BOOTOUT_LABEL:-}" != "$label" ]] || exit 0
  /bin/rm -f "$TRIANGLE_LAUNCHCTL_STATE/$label"
elif [[ "$command" == print ]]; then
  [[ -f "$TRIANGLE_LAUNCHCTL_STATE/$label" ]] || exit 113
  if [[ "$label" == dev.thetriangle.client ]]; then
    if [[ "\${TRIANGLE_TEST_READY_MODE:-valid}" == crash-after-ready && -f "$TRIANGLE_LAUNCHCTL_STATE/.printed-ready" ]]; then
      /bin/rm -f "$TRIANGLE_LAUNCHCTL_STATE/$label"
      exit 113
    fi
    /usr/bin/touch "$TRIANGLE_LAUNCHCTL_STATE/.printed-ready"
    printf 'state = running\npid = 4242\n'
  fi
elif [[ "$command" == kickstart ]]; then
  [[ -f "$TRIANGLE_LAUNCHCTL_STATE/$label" ]] || exit 113
  if [[ "$label" == dev.thetriangle.client && "\${TRIANGLE_TEST_READY_MODE:-valid}" != missing ]]; then
    /bin/rm -f "$TRIANGLE_READY_MARKER_PATH"
    now=$(/usr/bin/python3 -c 'import time; print(int(time.time()*1000))')
    printf '{"version":1,"generation":"22222222-2222-4222-8222-222222222222","parentPid":4242,"configDigest":"%064d","readyAtMilliseconds":%s}\n' 0 "$now" > "$TRIANGLE_READY_MARKER_PATH"
    /bin/chmod 600 "$TRIANGLE_READY_MARKER_PATH"
  fi
fi
`, { mode: 0o700 }); fs.chmodSync(launchctl, 0o700);
  const env = {
    ...process.env, HOME: home, PATH: tools,
    CODEX_CLI: codex, HERMES_CLI: "",
    TRIANGLE_TEST_MODE: "1", TRIANGLE_LAUNCHCTL: launchctl,
    TRIANGLE_LAUNCHCTL_LOG: launchctlLog, TRIANGLE_LAUNCHCTL_STATE: state, TRIANGLE_HELPER_LOG: helperLog,
  };
  return { home, app, env, state, launchctlLog, helperLog, helper, hermes };
}

function run(action, env) {
  return spawnSync("/bin/bash", [script, action], { env, encoding: "utf8" });
}

function legacy(f, agent, loaded = true) {
  const label = `dev.thetriangle.${agent}.worker`;
  const directory = path.join(f.home, "Library", "LaunchAgents");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const plist = path.join(directory, `${label}.plist`);
  fs.writeFileSync(plist, `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${label}</string></dict></plist>`, { mode: 0o600 });
  fs.chmodSync(plist, 0o600);
  if (loaded) fs.writeFileSync(path.join(f.state, label), "");
  return { label, plist };
}

function enabledProfile(f, digit = "a", deliveryMode) {
  const instances = path.join(f.app, "client", "instances");
  fs.mkdirSync(instances, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(f.app, "client"), 0o700);
  fs.chmodSync(instances, 0o700);
  const profile = `profile-${digit}`;
  const id = crypto.createHash("sha256").update(Buffer.concat([
    Buffer.from("triangle-client-instance-v1\0"), Buffer.from(profile),
  ])).digest("hex");
  const file = path.join(instances, `${id}.json`);
  const record = { version: 1, profile, instanceId: id, runtimeAdapter: "codex", enabled: true };
  if (deliveryMode !== undefined) record.deliveryMode = deliveryMode;
  fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function duplicateEnabledProfile(f) {
  const instances = path.join(f.app, "client", "instances");
  fs.mkdirSync(instances, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(f.app, "client"), 0o700); fs.chmodSync(instances, 0o700);
  const profile = "duplicate-enabled";
  const id = crypto.createHash("sha256").update(Buffer.concat([
    Buffer.from("triangle-client-instance-v1\0"), Buffer.from(profile),
  ])).digest("hex");
  const raw = `{"version":1,"profile":"${profile}","instanceId":"${id}","runtimeAdapter":"codex","enabled":true,"enabled":false}`;
  const file = path.join(instances, `${id}.json`);
  fs.writeFileSync(file, raw, { mode: 0o600 }); fs.chmodSync(file, 0o600);
}

test("client plist is one fixed secret-free supervisor service", (t) => {
  const f = fixture(t);
  let result = run("prepare-runtime", f.env);
  assert.equal(result.status, 0, result.stderr);
  result = run("render", { ...f.env, TRIANGLE_MAILBOX_PROFILE: "must-not-leak", MESH_AGENT_TOKEN: "must-not-leak" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /<string>dev\.thetriangle\.client<\/string>/);
  assert.match(result.stdout, /<string>run-supervisor<\/string>/);
  assert.doesNotMatch(result.stdout, /profile|token|agent[_-]?id|run-worker|codex-test-cli|hermes/i);
  const args = [...result.stdout.matchAll(/<string>([^<]+)<\/string>/g)].map((match) => match[1]);
  assert.deepEqual(args.slice(1, 3), [f.helper, "run-supervisor"]);
  assert.equal(spawnSync("/usr/bin/plutil", ["-lint", "-"], { input: result.stdout, encoding: "utf8" }).status, 0);
});

test("install prepares a v4 runtime and creates a private fixed plist", (t) => {
  const f = fixture(t);
  const result = run("install", f.env);
  assert.equal(result.status, 0, result.stderr);
  const runtime = JSON.parse(fs.readFileSync(path.join(f.app, "worker-runtime", "codex.manifest.json"), "utf8"));
  assert.equal(runtime.version, 4);
  const plist = path.join(f.home, "Library", "LaunchAgents", "dev.thetriangle.client.plist");
  assert.equal(mode(plist), 0o600);
  assert.equal(mode(path.join(f.home, "Library", "Logs", "the-triangle")), 0o700);
  assert.equal(fs.existsSync(path.join(f.state, "dev.thetriangle.client")), false);
});

test("clean-machine install stages the client stopped and leaves legacy consumers untouched", (t) => {
  const f = fixture(t);
  const codex = legacy(f, "codex", true);
  const result = run("install", f.env);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(f.home, "Library", "LaunchAgents", "dev.thetriangle.client.plist")));
  assert.equal(fs.existsSync(path.join(f.state, "dev.thetriangle.client")), false, "empty client must remain stopped");
  assert.equal(fs.existsSync(path.join(f.state, codex.label)), true, "legacy consumer retired before first profile became healthy");
  assert.doesNotMatch(fs.readFileSync(f.launchctlLog, "utf8"), /bootout[^\n]*dev\.thetriangle\.codex\.worker/);
});

test("install accepts legacy and delivery-mode registry records but rejects unknown modes", (t) => {
  const f = fixture(t);
  enabledProfile(f, "a");
  enabledProfile(f, "b", "mcp-interactive");
  let result = run("install", f.env);
  assert.equal(result.status, 0, result.stderr);

  enabledProfile(f, "c", "invalid-mode");
  result = run("install", f.env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /registry|invalid/i);
});

test("manual start cannot launch an empty staged client", (t) => {
  const f = fixture(t);
  let result = run("install", f.env);
  assert.equal(result.status, 0, result.stderr);
  result = run("start", f.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(f.state, "dev.thetriangle.client")), false);
});

test("launchctl loaded state without a fresh coordinator readiness marker never retires legacy", (t) => {
  const f = fixture(t);
  const codex = legacy(f, "codex", true);
  enabledProfile(f);
  const result = run("install", { ...f.env, TRIANGLE_TEST_READY_MODE: "missing", TRIANGLE_READY_TIMEOUT_MS: "40" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /readiness/i);
  assert.equal(fs.existsSync(path.join(f.state, codex.label)), true);
});

test("ready then immediate coordinator exit fails the stability gate and preserves legacy", (t) => {
  const f = fixture(t);
  enabledProfile(f);
  const codex = legacy(f, "codex", true);
  const result = run("install", {
    ...f.env,
    TRIANGLE_TEST_READY_MODE: "crash-after-ready",
    TRIANGLE_READY_TIMEOUT_MS: "100",
    TRIANGLE_READY_STABILITY_MS: "40",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /readiness|stability/i);
  assert.equal(fs.existsSync(path.join(f.state, codex.label)), true);
  assert.equal(fs.existsSync(path.join(f.state, "dev.thetriangle.client")), false);
});

test("runtime preparation rejects Node without the supported major and globSync API", (t) => {
  const f = fixture(t);
  const node = path.join(f.home, "tools", "node");
  fs.unlinkSync(node);
  fs.writeFileSync(node, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  fs.chmodSync(node, 0o700);
  const result = run("prepare-runtime", f.env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Node.*(?:22|globSync|compatible)/i);
  assert.equal(fs.existsSync(path.join(f.app, "worker-runtime", "codex.manifest.json")), false);
});

test("installed runtime hash mismatch is rejected before the substituted Node can execute", (t) => {
  const f = fixture(t);
  let result = run("prepare-runtime", f.env);
  assert.equal(result.status, 0, result.stderr);
  const manifestPath = path.join(f.app, "worker-runtime", "codex.manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const canary = path.join(f.home, "node-canary");
  fs.chmodSync(manifest.projectRoot, 0o700);
  const node = path.join(manifest.projectRoot, "bin", "node");
  fs.chmodSync(node, 0o700);
  fs.writeFileSync(node, `#!/bin/sh\n/usr/bin/touch "${canary}"\nexit 0\n`, { mode: 0o500 });
  fs.chmodSync(node, 0o500);
  result = run("render", f.env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /integrity|hash|content/i);
  assert.equal(fs.existsSync(canary), false, "untrusted substituted Node was executed before its hash was checked");
});

test("unsafe registry is never treated as an empty staged install", (t) => {
  for (const variant of ["invalid-name", "invalid-record"]) {
    const f = fixture(t);
    const client = path.join(f.app, "client");
    const instances = path.join(client, "instances");
    fs.mkdirSync(instances, { recursive: true, mode: 0o700 });
    fs.chmodSync(client, 0o700); fs.chmodSync(instances, 0o700);
    const name = variant === "invalid-name" ? "not-an-instance.json" : `${"a".repeat(64)}.json`;
    fs.writeFileSync(path.join(instances, name), "{}", { mode: 0o600 });
    const result = run("install", f.env);
    assert.notEqual(result.status, 0, `${variant} was treated as an empty registry`);
    assert.match(result.stderr, /registry|invalid|unsafe/i);
  }
});

test("duplicate registry keys fail closed before install or start mutates service state", (t) => {
  const installFixture = fixture(t);
  duplicateEnabledProfile(installFixture);
  let result = run("install", installFixture.env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /duplicate|registry|invalid/i);
  assert.equal(fs.existsSync(path.join(installFixture.home, "Library", "LaunchAgents", "dev.thetriangle.client.plist")), false);
  assert.equal(fs.existsSync(path.join(installFixture.state, "dev.thetriangle.client")), false);

  const startFixture = fixture(t);
  result = run("install", startFixture.env);
  assert.equal(result.status, 0, result.stderr);
  const plist = path.join(startFixture.home, "Library", "LaunchAgents", "dev.thetriangle.client.plist");
  const beforePlist = fs.readFileSync(plist);
  const beforeCalls = fs.readFileSync(startFixture.launchctlLog, "utf8");
  duplicateEnabledProfile(startFixture);
  result = run("start", startFixture.env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /duplicate|registry|invalid/i);
  assert.deepEqual(fs.readFileSync(plist), beforePlist);
  assert.equal(fs.readFileSync(startFixture.launchctlLog, "utf8"), beforeCalls);
  assert.equal(fs.existsSync(path.join(startFixture.state, "dev.thetriangle.client")), false);
});

test("install fails closed without a supervisor-capable runtime", (t) => {
  const f = fixture(t);
  const result = run("install", { ...f.env, CODEX_CLI: "", PATH: path.dirname(f.env.TRIANGLE_LAUNCHCTL) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /version 4|supervisor-capable/i);
  assert.equal(fs.existsSync(path.join(f.home, "Library", "LaunchAgents", "dev.thetriangle.client.plist")), false);
});

test("runtime preparation rolls back an earlier adapter when a later installed adapter is unsafe", (t) => {
  const f = fixture(t);
  const result = run("prepare-runtime", { ...f.env, HERMES_CLI: f.env.CODEX_CLI });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(f.app, "worker-runtime", "codex.manifest.json")), false);
  const runtime = path.join(f.app, "worker-runtime");
  assert.equal(fs.readdirSync(runtime).some((name) => name.startsWith(".rollback-")), false);
});

test("failed client bootstrap restores the exact previous client plist and loaded services", (t) => {
  const f = fixture(t);
  enabledProfile(f);
  const launchAgents = path.join(f.home, "Library", "LaunchAgents"); fs.mkdirSync(launchAgents, { recursive: true, mode: 0o700 });
  const clientPlist = path.join(launchAgents, "dev.thetriangle.client.plist");
  const previous = Buffer.from('<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>dev.thetriangle.client</string><key>Previous</key><true/></dict></plist>');
  fs.writeFileSync(clientPlist, previous, { mode: 0o600 }); fs.chmodSync(clientPlist, 0o600);
  fs.writeFileSync(path.join(f.state, "dev.thetriangle.client"), "");
  const codex = legacy(f, "codex", true);
  const result = run("install", { ...f.env, TRIANGLE_LAUNCHCTL_FAIL_BOOTSTRAP_ONCE_LABEL: "dev.thetriangle.client" });
  assert.notEqual(result.status, 0);
  assert.deepEqual(fs.readFileSync(clientPlist), previous);
  assert.ok(fs.existsSync(path.join(f.state, "dev.thetriangle.client")));
  assert.ok(fs.existsSync(path.join(f.state, codex.label)));
});

test("migration bootstraps and verifies the client before retiring only loaded legacy services", (t) => {
  const f = fixture(t);
  enabledProfile(f);
  const codex = legacy(f, "codex", true);
  const hermes = legacy(f, "hermes", false);
  const result = run("install", f.env);
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(f.launchctlLog, "utf8").trim().split("\n");
  const newBootstrap = calls.findIndex((line) => line.includes("bootstrap") && line.includes("dev.thetriangle.client.plist"));
  const verified = calls.findIndex((line, index) => index > newBootstrap && line === `print gui/${process.getuid()}/dev.thetriangle.client`);
  const oldBootout = calls.findIndex((line) => line === `bootout gui/${process.getuid()}/${codex.label}`);
  assert.ok(newBootstrap >= 0 && verified > newBootstrap && oldBootout > verified, calls.join("\n"));
  assert.equal(calls.some((line) => line === `bootout gui/${process.getuid()}/${hermes.label}`), false);
  assert.equal(fs.existsSync(path.join(f.state, codex.label)), false);
});

test("partial legacy migration failure removes the client and restores exact prior loaded state", (t) => {
  const f = fixture(t);
  enabledProfile(f);
  const codex = legacy(f, "codex", true);
  const hermes = legacy(f, "hermes", true);
  const result = run("install", { ...f.env, TRIANGLE_LAUNCHCTL_FAIL_BOOTOUT_LABEL: hermes.label });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(f.state, "dev.thetriangle.client")), false);
  assert.equal(fs.existsSync(path.join(f.state, codex.label)), true);
  assert.equal(fs.existsSync(path.join(f.state, hermes.label)), true);
  assert.equal(fs.existsSync(path.join(f.home, "Library", "LaunchAgents", "dev.thetriangle.client.plist")), false);
});

test("commit-phase failures restore exact prior plist and runtime after rollback records begin finalizing", (t) => {
  for (const phase of ["after-plist", "after-runtime"]) {
    const f = fixture(t);
    enabledProfile(f);
    let result = run("prepare-runtime", f.env); assert.equal(result.status, 0, result.stderr);
    const runtimePath = path.join(f.app, "worker-runtime", "codex.manifest.json");
    const previousRuntime = fs.readFileSync(runtimePath);
    const alternate = path.join(f.app, "bin", "codex-alternate-cli");
    fs.writeFileSync(alternate, "#!/bin/sh\nexit 0\n", { mode: 0o700 }); fs.chmodSync(alternate, 0o700);
    const launchAgents = path.join(f.home, "Library", "LaunchAgents"); fs.mkdirSync(launchAgents, { recursive: true, mode: 0o700 });
    const plistPath = path.join(launchAgents, "dev.thetriangle.client.plist");
    const previousPlist = Buffer.from(`<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>dev.thetriangle.client</string><key>Phase</key><string>${phase}</string></dict></plist>`);
    fs.writeFileSync(plistPath, previousPlist, { mode: 0o600 }); fs.chmodSync(plistPath, 0o600);
    result = run("install", { ...f.env, CODEX_CLI: alternate, TRIANGLE_TEST_FAIL_COMMIT_PHASE: phase });
    assert.notEqual(result.status, 0, `${phase} fault was ignored`);
    assert.deepEqual(fs.readFileSync(plistPath), previousPlist, `${phase} did not restore plist`);
    assert.deepEqual(fs.readFileSync(runtimePath), previousRuntime, `${phase} did not restore runtime`);
    assert.equal(fs.existsSync(path.join(f.app, "client", "ready.json")), false, `${phase} retained readiness after rollback`);
    assert.equal(fs.existsSync(path.join(f.app, "client", "activate.json")), false, `${phase} retained activation after rollback`);
    assert.equal(fs.readdirSync(path.join(f.app, "worker-runtime")).some((name) => name.startsWith(".rollback-")), false);
    assert.equal(fs.readdirSync(f.app).some((name) => name.startsWith(".client-service-transaction.")), false);
  }
});

test("legacy restoration failure is explicit and never reported as successful rollback", (t) => {
  const f = fixture(t);
  enabledProfile(f);
  const codex = legacy(f, "codex", true);
  const hermes = legacy(f, "hermes", true);
  const result = run("install", {
    ...f.env,
    TRIANGLE_LAUNCHCTL_FAIL_BOOTOUT_LABEL: hermes.label,
    TRIANGLE_LAUNCHCTL_FAIL_BOOTSTRAP_LABEL: codex.label,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rollback[^\n]*(?:restore|legacy)|restore[^\n]*rollback/i);
  assert.equal(fs.existsSync(path.join(f.state, codex.label)), false);
  assert.equal(fs.existsSync(path.join(f.state, hermes.label)), true);
});

test("rollback reports a newly bootstrapped client that cannot be proven absent", (t) => {
  for (const seam of ["failure", "sticky-success"]) {
    const f = fixture(t);
    enabledProfile(f);
    const env = { ...f.env, TRIANGLE_TEST_FAIL_COMMIT_PHASE: "after-plist" };
    if (seam === "failure") env.TRIANGLE_LAUNCHCTL_FAIL_CLIENT_BOOTOUT = "1";
    else env.TRIANGLE_LAUNCHCTL_STICKY_BOOTOUT_LABEL = "dev.thetriangle.client";
    const result = run("install", env);
    assert.notEqual(result.status, 0, `${seam} was reported as success`);
    assert.match(result.stderr, /rollback[^\n]*(?:failed|client|loaded)|client[^\n]*rollback/i, `${seam}: ${result.stderr}`);
    assert.equal(fs.existsSync(path.join(f.state, "dev.thetriangle.client")), true);
  }
});

test("rollback never restores retired legacy beside an unproven client", (t) => {
  for (const seam of ["failure", "sticky-success"]) {
    const f = fixture(t);
    enabledProfile(f);
    const codex = legacy(f, "codex", true);
    const hermes = legacy(f, "hermes", true);
    const env = { ...f.env, TRIANGLE_LAUNCHCTL_FAIL_BOOTOUT_LABEL: hermes.label };
    if (seam === "failure") env.TRIANGLE_LAUNCHCTL_FAIL_CLIENT_BOOTOUT = "1";
    else env.TRIANGLE_LAUNCHCTL_STICKY_BOOTOUT_LABEL = "dev.thetriangle.client";
    const result = run("install", env);
    assert.notEqual(result.status, 0, `${seam} was reported as success`);
    assert.match(result.stderr, /rollback/i);
    assert.equal(fs.existsSync(path.join(f.state, "dev.thetriangle.client")), true);
    assert.equal(fs.existsSync(path.join(f.state, codex.label)), false, "retired legacy was reactivated beside client");
    assert.equal(fs.existsSync(path.join(f.state, hermes.label)), true);
  }
});

test("unsafe helper and legacy rollback plists are rejected before migration", (t) => {
  const f = fixture(t);
  run("prepare-runtime", f.env);
  fs.renameSync(f.helper, `${f.helper}.real`); fs.symlinkSync(`${f.helper}.real`, f.helper);
  let result = run("render", f.env);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /canonical|symlink/i);

  const g = fixture(t); const old = legacy(g, "codex", true); fs.chmodSync(old.plist, 0o644);
  result = run("install", g.env);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /legacy|unsafe|mode/i);
  assert.ok(fs.existsSync(path.join(g.state, old.label)));
});

test("start rejects a substituted or permissive installed client plist", (t) => {
  const f = fixture(t);
  let result = run("install", f.env); assert.equal(result.status, 0, result.stderr);
  result = run("stop", f.env); assert.equal(result.status, 0, result.stderr);
  const plist = path.join(f.home, "Library", "LaunchAgents", "dev.thetriangle.client.plist");
  fs.chmodSync(plist, 0o644);
  result = run("start", f.env); assert.notEqual(result.status, 0); assert.match(result.stderr, /unsafe|mode/i);
  fs.chmodSync(plist, 0o600);
  fs.writeFileSync(plist, '<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>dev.thetriangle.client</string><key>ProgramArguments</key><array><string>/bin/echo</string><string>secret</string></array></dict></plist>');
  result = run("start", f.env); assert.notEqual(result.status, 0); assert.match(result.stderr, /contract|arguments/i);
});

test("start validates custody and plist before kickstarting an already loaded client", (t) => {
  const f = fixture(t);
  let result = run("install", f.env); assert.equal(result.status, 0, result.stderr);
  const plist = path.join(f.home, "Library", "LaunchAgents", "dev.thetriangle.client.plist");
  fs.chmodSync(plist, 0o644);
  result = run("start", f.env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe|mode/i);
  const calls = fs.readFileSync(f.launchctlLog, "utf8");
  assert.doesNotMatch(calls.split("\n").slice(-2).join("\n"), /kickstart/);
});

test("client preflight is bare and must succeed before any loaded legacy service retires", (t) => {
  const f = fixture(t); enabledProfile(f); const codex = legacy(f, "codex", true);
  const result = run("install", {
    ...f.env,
    TRIANGLE_TEST_PREFLIGHT_RESULT: "fail",
    MESH_AGENT_TOKEN: "ambient-must-not-cross",
    TRIANGLE_MAILBOX_PROFILE: "ambient-must-not-cross",
    CODEX_AGENT_ID: "ambient-must-not-cross",
  });
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(f.helperLog, "utf8").trim(), "preflight-supervisor");
  assert.ok(fs.existsSync(path.join(f.state, codex.label)));
  assert.equal(fs.existsSync(path.join(f.state, "dev.thetriangle.client")), false);
});

test("legacy bootout must be proven absent before migration continues", (t) => {
  const f = fixture(t); enabledProfile(f); const codex = legacy(f, "codex", true);
  const result = run("install", { ...f.env, TRIANGLE_LAUNCHCTL_STICKY_BOOTOUT_LABEL: codex.label });
  assert.notEqual(result.status, 0);
  assert.ok(fs.existsSync(path.join(f.state, codex.label)));
  assert.equal(fs.existsSync(path.join(f.state, "dev.thetriangle.client")), false);
});

test("standalone runtime preparation rolls back sequential finalization failures and signals", (t) => {
  for (const seam of ["commit", "signal"]) {
    const f = fixture(t);
    const env = { ...f.env, HERMES_CLI: f.hermes };
    if (seam === "commit") env.TRIANGLE_TEST_FAIL_PREPARE_COMMIT_AFTER = "1";
    else env.TRIANGLE_TEST_INTERRUPT_PREPARE_AFTER_STAGE = "1";
    const result = run("prepare-runtime", env);
    assert.notEqual(result.status, 0, `${seam} was accepted`);
    for (const agent of ["codex", "hermes"]) assert.equal(fs.existsSync(path.join(f.app, "worker-runtime", `${agent}.manifest.json`)), false, `${seam} retained ${agent}`);
    assert.equal(fs.readdirSync(path.join(f.app, "worker-runtime")).some((name) => name.startsWith(".rollback-")), false);
  }
});

test("lifecycle is idempotent and bounded to the one client label", (t) => {
  const f = fixture(t);
  enabledProfile(f);
  for (const action of ["install", "start", "start", "status", "stop", "stop", "start", "uninstall", "uninstall"]) {
    const result = run(action, f.env);
    assert.equal(result.status, 0, `${action}: ${result.stderr}`);
  }
  const calls = fs.readFileSync(f.launchctlLog, "utf8");
  assert.doesNotMatch(calls, /(?:bootout|bootstrap)[^\n]*dev\.thetriangle\.(?:codex|hermes)\.worker/);
  assert.equal(fs.existsSync(path.join(f.app, "client", "ready.json")), false);
  assert.equal(fs.existsSync(path.join(f.app, "client", "activate.json")), false);
});

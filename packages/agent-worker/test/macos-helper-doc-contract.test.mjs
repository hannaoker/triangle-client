import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const installer = path.join(root, "scripts/install-macos-mailbox-helper.sh");

function text(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function mode(file) { return fs.statSync(file).mode & 0o777; }

function fixture(t) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "triangle-helper-install-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, "home");
  const tools = path.join(base, "tools");
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(tools, { mode: 0o700 });
  const log = path.join(base, "commands.log");
  const swift = path.join(tools, "swift");
  fs.writeFileSync(swift, `#!/bin/bash
set -eu
printf 'swift %s\\n' "$*" >> "$TRIANGLE_TEST_COMMAND_LOG"
scratch=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--scratch-path" ]]; then scratch=$2; shift 2; else shift; fi
done
mkdir -p "$scratch/release"
printf '#!/bin/sh\\nprintf helper-%s\\n' "\${TRIANGLE_TEST_BINARY_VERSION:-one}" > "$scratch/release/triangle-mailbox"
chmod 700 "$scratch/release/triangle-mailbox"
cp "$scratch/release/triangle-mailbox" "$scratch/release/triangle-client"
chmod 700 "$scratch/release/triangle-client"
`, { mode: 0o700 });
  fs.chmodSync(swift, 0o700);
  const codesign = path.join(tools, "codesign");
  fs.writeFileSync(codesign, `#!/bin/bash
set -eu
printf 'codesign %s\\n' "$*" >> "$TRIANGLE_TEST_COMMAND_LOG"
case "$*" in
  *"--verify"*)
    [[ "\${TRIANGLE_TEST_SIGNATURE_VERIFY:-ok}" == ok ]] || exit 71
    if [[ "\${TRIANGLE_TEST_SIGNATURE_STATE:-ok}" == installed-target-fail && "$*" == *"/bin/triangle-mailbox"* ]]; then exit 71; fi
    if [[ "\${TRIANGLE_TEST_SIGNATURE_STATE:-ok}" == installed-client-target-fail && "$*" == *"/bin/triangle-client"* ]]; then exit 71; fi
    ;;
  *"--entitlements :-"*)
    app="TEAM123456.dev.thetriangle.mailbox"
    group="$app"
    [[ "\${TRIANGLE_TEST_SIGNATURE_STATE:-ok}" == bad-entitlement ]] && group="TEAM123456.example.wrong"
    [[ "\${TRIANGLE_TEST_SIGNATURE_STATE:-ok}" == bad-app-entitlement ]] && app="TEAM123456.example.wrong"
    extra=""
    [[ "\${TRIANGLE_TEST_SIGNATURE_STATE:-ok}" == extra-group ]] && extra='<string>TEAM123456.example.extra</string>'
    printf '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>application-identifier</key><string>%s</string><key>keychain-access-groups</key><array><string>%s</string>%s</array></dict></plist>\\n' "$app" "$group" "$extra"
    ;;
  *"-r-"*)
    if [[ "\${TRIANGLE_TEST_SIGNATURE_STATE:-ok}" == bad-requirement ]]; then
      printf 'designated => identifier "example.wrong" and anchor apple generic\\n' >&2
    else
      printf 'designated => identifier "dev.thetriangle.mailbox" and anchor apple generic\\n' >&2
    fi
    ;;
  *"-d"*)
    identifier="dev.thetriangle.mailbox"
    [[ "\${TRIANGLE_TEST_SIGNATURE_STATE:-ok}" == bad-identifier ]] && identifier="example.wrong"
    team="TEAM123456"
    authority="Developer ID Application: Triangle Test (TEAM123456)"
    [[ "\${TRIANGLE_TEST_SIGNATURE_STATE:-ok}" == bad-team ]] && team="OTHER12345"
    [[ "\${TRIANGLE_TEST_SIGNATURE_STATE:-ok}" == bad-authority ]] && authority="Apple Development: Triangle Test (TEAM123456)"
    printf 'Identifier=%s\\nTeamIdentifier=%s\\nAuthority=%s\\n' "$identifier" "$team" "$authority" >&2
    ;;
esac
`, { mode: 0o700 });
  fs.chmodSync(codesign, 0o700);
  const worker = path.join(tools, "worker-service");
  fs.writeFileSync(worker, `#!/bin/bash
printf 'worker %s profile=%s\\n' "$*" "\${TRIANGLE_MAILBOX_PROFILE:-}" >> "$TRIANGLE_TEST_COMMAND_LOG"
[[ "\${TRIANGLE_TEST_WORKER_RESULT:-ok}" == ok ]]
`, { mode: 0o700 });
  fs.chmodSync(worker, 0o700);
  const client = path.join(tools, "client-service");
  fs.writeFileSync(client, `#!/bin/bash
printf 'client %s\n' "$*" >> "$TRIANGLE_TEST_COMMAND_LOG"
[[ "\${TRIANGLE_TEST_CLIENT_RESULT:-ok}" == ok ]]
`, { mode: 0o700 });
  fs.chmodSync(client, 0o700);
  const env = {
    ...process.env,
    HOME: home,
    TRIANGLE_INSTALL_TEST_MODE: "1",
    TRIANGLE_INSTALL_TEST_ROOT: base,
    TRIANGLE_SWIFT_COMMAND: swift,
    TRIANGLE_CODESIGN_COMMAND: codesign,
    TRIANGLE_WORKER_SERVICE_COMMAND: worker,
    TRIANGLE_CLIENT_SERVICE_COMMAND: client,
    TRIANGLE_TEST_COMMAND_LOG: log,
  };
  return { base, home, env, log };
}

function run(args, env) {
  return spawnSync("/bin/bash", [installer, ...args], { encoding: "utf8", env });
}

test("operator documentation defines the complete low-friction custody lifecycle", () => {
  const helper = text("packages/macos-mailbox-helper/README.md");
  for (const pattern of [
    /enroll[^\n]*--profile codex-mailbox-live[^\n]*--origin https:\/\/thetriangle\.dev/i,
    /stdin/i,
    /Keychain[^\n]*(authoritative|authority)/i,
    /silent[^\n]*(normal|routine)/i,
    /(locked Keychain|Keychain is locked)[\s\S]*(unlock|log in)/i,
    /triangle-mailbox"? mcp --profile codex-mailbox-live/,
    /no (?:show|export)[^\n]*(?:command|operation)/i,
    /(rotation|replacement)[\s\S]*(confirmation|confirm)/i,
    /(deletion|delete)[\s\S]*(confirmation|confirm)/i,
    /(ambiguous|outcome_unknown)[\s\S]*(journal|reconcil)/i,
    /Developer ID/i,
    /local-ad-hoc[\s\S]*(non-public|local testing|development only)/i,
    /rollback/i,
  ]) assert.match(helper, pattern);
  assert.doesNotMatch(helper, /show-token|export-token/);

  for (const relative of ["agents/codex/worker/README.md", "agents/hermes/worker/README.md"]) {
    const worker = text(relative);
    assert.match(worker, /Keychain/);
    assert.match(worker, /triangle-mailbox run-worker --profile/);
    assert.match(worker, /install-macos-mailbox-helper\.sh/);
    assert.match(worker, /rollback/i);
  }
  const top = text("README.md");
  assert.match(top, /macOS mailbox credential helper/i);
  assert.match(top, /triangle-mailbox"? mcp --profile/);
  const workerSection = top.match(/### Model-free agent workers[\s\S]*?(?=\n## Testing and builds)/)?.[0];
  assert.ok(workerSection, "top-level worker quickstart is missing");
  assert.doesNotMatch(workerSection, /TRIANGLE_CREDENTIAL_FILE|set -a;\s*\.\s*"?\$TRIANGLE_CREDENTIAL_FILE|credentials\/(?:codex|hermes)\.env/);
  for (const pattern of [
    /install-macos-mailbox-helper\.sh/,
    /enroll[^\n]*--profile[^\n]*--origin/,
    /status --profile/,
    /mcp --profile/,
    /triangle-worker-service\.sh prepare-runtime/,
    /TRIANGLE_MAILBOX_PROFILE/,
    /triangle-worker-service\.sh install/,
    /VerifiedCredentialGate/,
    /CODEX_AGENT_ID[^\n]*HERMES_AGENT_ID|HERMES_AGENT_ID[^\n]*CODEX_AGENT_ID/,
    /explicit(?: legacy)? rollback[\s\S]*mode-`0600` credential file/i,
    /no silent fallback/i,
  ]) assert.match(workerSection, pattern);
  const normalUseREADME = top.replace(
    /#### Explicit legacy rollback only[\s\S]*?(?=\nWorkers currently follow Mac availability\.)/,
    "",
  );
  assert.doesNotMatch(normalUseREADME, /Operational worker credentials belong in an operator-owned `0600` file|The LaunchAgent injects them into the mailbox controller|credential root and all project/i);
  const deployment = top.match(/## Deployment[\s\S]*?(?=\n## Security model)/)?.[0];
  assert.ok(deployment, "deployment documentation is missing");
  assert.match(deployment, /Keychain[^\n]*(?:authoritative|authority)/i);
  assert.match(deployment, /VerifiedCredentialGate/);
  assert.match(deployment, /helper[^\n]*internally injects|internally injects[^\n]*helper/i);
});

test("installer defaults to public Developer ID mode and rejects missing signing configuration", (t) => {
  const f = fixture(t);
  const result = run([], f.env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TRIANGLE_DEVELOPER_ID/);
  assert.equal(fs.existsSync(path.join(f.home, "Library", "Application Support", "The Triangle", "bin", "triangle-mailbox")), false);
});

test("explicit local ad-hoc mode release-builds and atomically installs at the fixed application path", (t) => {
  const f = fixture(t);
  const applicationRoot = path.join(f.home, "Library", "Application Support", "The Triangle");
  fs.mkdirSync(applicationRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(applicationRoot, 0o700);
  const unrelated = path.join(applicationRoot, "operator-owned-note");
  fs.writeFileSync(unrelated, "preserve me\n", { mode: 0o600 });
  const result = run(["--local-ad-hoc"], f.env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /non-public/i);
  const target = path.join(applicationRoot, "bin", "triangle-mailbox");
  const clientTarget = path.join(applicationRoot, "bin", "triangle-client");
  assert.equal(fs.realpathSync(target), target);
  assert.equal(fs.realpathSync(clientTarget), clientTarget);
  assert.equal(mode(target), 0o700);
  assert.equal(mode(clientTarget), 0o700);
  assert.equal(mode(applicationRoot), 0o700);
  assert.equal(mode(path.join(applicationRoot, "bin")), 0o700);
  assert.equal(mode(path.join(applicationRoot, "install-manifest", "triangle-mailbox.sha256")), 0o600);
  assert.equal(mode(path.join(applicationRoot, "install-manifest", "triangle-client.sha256")), 0o600);
  assert.equal(mode(path.join(applicationRoot, "install-manifest", "triangle-client-install.json")), 0o600);
  assert.match(fs.readFileSync(f.log, "utf8"), /swift build -c release .*--scratch-path/);
  assert.match(fs.readFileSync(f.log, "utf8"), /-Xswiftc -DTRIANGLE_LOCAL_AD_HOC/);
  assert.match(fs.readFileSync(f.log, "utf8"), /codesign --verify --strict/);
  assert.equal(fs.readFileSync(unrelated, "utf8"), "preserve me\n");
  assert.equal(fs.readdirSync(applicationRoot).some((name) => name.startsWith(".mailbox-helper-install.")), false);
});

test("installer rejects symlinks and unsafe existing ownership or mode", (t) => {
  const f = fixture(t);
  const app = path.join(f.home, "Library", "Application Support", "The Triangle");
  fs.mkdirSync(path.dirname(app), { recursive: true, mode: 0o700 });
  const outside = path.join(f.base, "outside");
  fs.mkdirSync(outside, { mode: 0o700 });
  fs.symlinkSync(outside, app);
  let result = run(["--local-ad-hoc"], f.env);
  assert.notEqual(result.status, 0);
  assert.equal(fs.readdirSync(outside).length, 0);

  fs.unlinkSync(app);
  const libraryOutside = path.join(f.base, "library-outside");
  fs.mkdirSync(libraryOutside, { mode: 0o700 });
  fs.rmSync(path.join(f.home, "Library"), { recursive: true, force: true });
  fs.symlinkSync(libraryOutside, path.join(f.home, "Library"));
  result = run(["--local-ad-hoc"], f.env);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(libraryOutside, "Application Support")), false, "installer wrote through an intermediate symlink");

  fs.unlinkSync(path.join(f.home, "Library"));
  fs.mkdirSync(path.join(f.home, "Library", "Application Support"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(app, { mode: 0o755 });
  fs.chmodSync(app, 0o755);
  result = run(["--local-ad-hoc"], f.env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /(mode|permission|unsafe)/i);

  fs.chmodSync(app, 0o700);
  result = run(["--local-ad-hoc"], { ...f.env, TRIANGLE_TEST_EXPECTED_UID: String(process.getuid() + 1) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ownership/i);
});

test("failed post-replacement verification restores the exact prior helper", (t) => {
  const f = fixture(t);
  let result = run(["--local-ad-hoc"], f.env);
  assert.equal(result.status, 0, result.stderr);
  const target = path.join(f.home, "Library", "Application Support", "The Triangle", "bin", "triangle-mailbox");
  const clientTarget = path.join(f.home, "Library", "Application Support", "The Triangle", "bin", "triangle-client");
  const before = fs.readFileSync(target);
  const clientBefore = fs.readFileSync(clientTarget);
  for (const phase of ["after-helper", "after-client", "after-hash", "after-client-hash", "after-metadata", "after-client-metadata"]) {
    result = run(["--local-ad-hoc"], {
      ...f.env,
      TRIANGLE_TEST_BINARY_VERSION: "two",
      TRIANGLE_INSTALL_FAIL_PHASE: phase,
    });
    assert.notEqual(result.status, 0, `${phase} unexpectedly succeeded`);
    assert.deepEqual(fs.readFileSync(target), before, `${phase} did not restore helper`);
    assert.deepEqual(fs.readFileSync(clientTarget), clientBefore, `${phase} did not restore client`);
  }

  const empty = fixture(t);
  for (const phase of ["after-helper", "after-client", "after-hash", "after-client-hash", "after-metadata", "after-client-metadata"]) {
    result = run(["--local-ad-hoc"], { ...empty.env, TRIANGLE_INSTALL_FAIL_PHASE: phase });
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(path.join(empty.home, "Library", "Application Support", "The Triangle", "bin", "triangle-mailbox")), false);
    assert.equal(fs.existsSync(path.join(empty.home, "Library", "Application Support", "The Triangle", "bin", "triangle-client")), false);
  }
});

test("public install rejects identifier, designated requirement, and Keychain entitlement mismatches", (t) => {
  const f = fixture(t);
  const publicEnv = {
    ...f.env,
    TRIANGLE_DEVELOPER_ID: "Developer ID Application: Triangle Test (TEAM123456)",
    TRIANGLE_DEVELOPER_TEAM_ID: "TEAM123456",
  };
  for (const state of ["bad-identifier", "bad-requirement", "bad-entitlement", "bad-app-entitlement", "extra-group", "bad-team", "bad-authority"]) {
    const result = run([], { ...publicEnv, TRIANGLE_TEST_SIGNATURE_STATE: state });
    assert.notEqual(result.status, 0, `${state} unexpectedly installed`);
  }
  const result = run([], publicEnv);
  assert.equal(result.status, 0, result.stderr);

  const target = path.join(f.home, "Library", "Application Support", "The Triangle", "bin", "triangle-mailbox");
  const before = fs.readFileSync(target);
  const clientTarget = path.join(f.home, "Library", "Application Support", "The Triangle", "bin", "triangle-client");
  const clientBefore = fs.readFileSync(clientTarget);
  const installedFailure = run([], { ...publicEnv, TRIANGLE_TEST_BINARY_VERSION: "two", TRIANGLE_TEST_SIGNATURE_STATE: "installed-target-fail" });
  assert.notEqual(installedFailure.status, 0);
  assert.deepEqual(fs.readFileSync(target), before, "installed-target signature failure did not restore prior helper");
  assert.deepEqual(fs.readFileSync(clientTarget), clientBefore, "installed-target signature failure did not restore prior client");
  const installedClientFailure = run([], { ...publicEnv, TRIANGLE_TEST_BINARY_VERSION: "two", TRIANGLE_TEST_SIGNATURE_STATE: "installed-client-target-fail" });
  assert.notEqual(installedClientFailure.status, 0);
  assert.deepEqual(fs.readFileSync(target), before, "installed-client signature failure did not restore prior helper");
  assert.deepEqual(fs.readFileSync(clientTarget), clientBefore, "installed-client signature failure did not restore prior client");
});

test("worker installation is opt-in, starts after helper commit, and rolls itself back on failure", (t) => {
  const f = fixture(t);
  let result = run(["--local-ad-hoc"], f.env);
  assert.equal(result.status, 0, result.stderr);
  const target = path.join(f.home, "Library", "Application Support", "The Triangle", "bin", "triangle-mailbox");
  const before = fs.readFileSync(target);
  assert.doesNotMatch(fs.readFileSync(f.log, "utf8"), /worker /);
  result = run(["--local-ad-hoc", "--install-worker", "codex", "--profile", "codex-mailbox-live"], {
    ...f.env,
    TRIANGLE_TEST_BINARY_VERSION: "two",
    TRIANGLE_TEST_WORKER_RESULT: "fail",
  });
  assert.notEqual(result.status, 0);
  assert.notDeepEqual(fs.readFileSync(target), before, "verified helper should remain after the independent service transaction fails");
  assert.match(fs.readFileSync(f.log, "utf8"), /worker install codex profile=codex-mailbox-live/);
});

test("Triangle Client installation is explicit, post-commit, and mutually exclusive with legacy worker flags", (t) => {
  const f = fixture(t);
  let result = run(["--local-ad-hoc", "--install-client"], {
    ...f.env,
    TRIANGLE_TEST_CLIENT_RESULT: "fail",
  });
  assert.notEqual(result.status, 0);
  const target = path.join(f.home, "Library", "Application Support", "The Triangle", "bin", "triangle-mailbox");
  assert.ok(fs.existsSync(target), "verified helper must remain after independent client service failure");
  assert.match(fs.readFileSync(f.log, "utf8"), /client install/);

  for (const args of [
    ["--local-ad-hoc", "--install-client", "--profile", "mailbox"],
    ["--local-ad-hoc", "--install-client", "--install-worker", "codex", "--profile", "mailbox"],
  ]) {
    result = run(args, f.env);
    assert.notEqual(result.status, 0, `${args.join(" ")} was accepted`);
  }
});

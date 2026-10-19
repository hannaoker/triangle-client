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
version="\${TRIANGLE_TEST_BINARY_VERSION:-one}"
cat > "$scratch/release/triangle-mailbox" <<STUB
#!/bin/bash
set -eu
if [[ "\\\${1:-}" == watch-ensure || "\\\${1:-}" == watch-poll || "\\\${1:-}" == watch-status || "\\\${1:-}" == watch-revoke ]]; then
  if [[ "\\\${2:-}" == "--help" || "\\\${2:-}" == "-h" ]]; then
    printf '{"command":"%s","notes":[],"phase":"watch-grant-phase-2","requires":[],"supported":true}\\n' "\\\$1"
    exit 0
  fi
fi
printf 'helper-%s\\n' "\${version}"
STUB
chmod 700 "$scratch/release/triangle-mailbox"
cp "$scratch/release/triangle-mailbox" "$scratch/release/triangle-client"
chmod 700 "$scratch/release/triangle-client"
`, { mode: 0o700 });
  fs.chmodSync(swift, 0o700);
  const codesign = path.join(tools, "codesign");
  fs.writeFileSync(codesign, `#!/bin/bash
set -eu
printf 'codesign %s\\n' "$*" >> "$TRIANGLE_TEST_COMMAND_LOG"
state="\${TRIANGLE_TEST_SIGNATURE_STATE:-ok}"
case "$*" in
  *"--verify"*)
    [[ "\${TRIANGLE_TEST_SIGNATURE_VERIFY:-ok}" == ok ]] || exit 71
    if [[ "$state" == installed-target-fail && "$*" == *"/bin/triangle-mailbox"* ]]; then exit 71; fi
    if [[ "$state" == installed-client-target-fail && "$*" == *"/bin/triangle-client"* ]]; then exit 71; fi
    ;;
  *"--entitlements"*)
    if [[ "$state" == keychain-entitlement ]]; then
      printf '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>keychain-access-groups</key><array><string>TEAM123456.dev.thetriangle.mailbox</string></array></dict></plist>\\n'
    fi
    ;;
  *"-d"*)
    identifier="dev.thetriangle.mailbox"
    [[ "$state" == bad-identifier ]] && identifier="example.wrong"
    signature="adhoc"
    [[ "$state" == not-adhoc ]] && signature="size=9000"
    printf 'Identifier=%s\\nCodeDirectory v=20400 size=272 flags=0x2(adhoc) hashes=3+2 location=embedded\\nSignature=%s\\n' "$identifier" "$signature" >&2
    if [[ "$state" == developer-id ]]; then
      printf 'Authority=Developer ID Application: Triangle Test (TEAM123456)\\nTeamIdentifier=TEAM123456\\n' >&2
    elif [[ "$state" == team-set ]]; then
      printf 'TeamIdentifier=TEAM123456\\n' >&2
    else
      printf 'TeamIdentifier=not set\\n' >&2
    fi
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

test("watch command help and operator notes never expose credential prefixes", () => {
  const source = text("packages/macos-mailbox-helper/Sources/TriangleMailboxCore/WatchGrantFailure.swift");
  const helpInit = source.match(/public init\(command: HelperCommand\) \{[\s\S]*?\n    \}/)?.[0];
  assert.ok(helpInit, "WatchCommandHelp init missing");
  assert.doesNotMatch(helpInit, /mesh_/);
  assert.match(helpInit, /\.watchStatus/);
  assert.match(helpInit, /Secret-free status JSON only/);

  const notes = [...source.matchAll(/operatorNotes:\s*\[[\s\S]*?\]/g)].map((match) => match[0]);
  assert.ok(notes.length > 0, "expected operatorNotes literals");
  for (const block of notes) {
    assert.doesNotMatch(block, /mesh_watch_/);
    assert.doesNotMatch(block, /"Do not place mesh_/);
  }
});

test("permissions v1 gate failures map to v1 codes and the enrollment surface is gone", () => {
  const helperRoot = "packages/macos-mailbox-helper/Sources/TriangleMailboxCore";
  for (const removed of ["EnrollmentService.swift", "EnrollmentJournal.swift", "EnrollmentReservation.swift", "CredentialStore.swift", "KeychainCredentialStore.swift"]) {
    assert.equal(fs.existsSync(path.join(root, helperRoot, removed)), false, `${removed} must be removed`);
  }
  const failure = text(`${helperRoot}/WatchGrantFailure.swift`);
  for (const code of ['case credentialInvalid = "credential_invalid"', 'case credentialRefused = "credential_refused"', 'case agentPaused = "agent_paused"']) {
    assert.ok(failure.includes(code), code);
  }
  for (const gone of ["credentialBusy", "journalIneligible", "localAuthorizationRequired", "profileStateInconsistent"]) {
    assert.doesNotMatch(failure, new RegExp(`case ${gone}\\b`), gone);
  }
  const profile = text(`${helperRoot}/V1ProfileService.swift`);
  assert.match(profile, /case agentPaused/);
  assert.match(profile, /agentSelf/);
  const custody = text(`${helperRoot}/V1AgentCustody.swift`);
  assert.match(custody, /O_NOFOLLOW/);
  assert.match(custody, /workload-key\.json/);
  const models = text(`${helperRoot}/Models.swift`);
  assert.doesNotMatch(models, /case enroll\b/);
  assert.match(models, /case bind\b/);
  assert.match(models, /case unbind\b/);

  const watch = text(`${helperRoot}/WatchGrantService.swift`);
  assert.match(watch, /Keep the local binding[\s\S]*until a new grant is stored/);
  assert.doesNotMatch(watch, /discardLocalWatchBinding/);
});

test("operator documentation defines the permissions v1 binding lifecycle", () => {
  const helper = text("packages/macos-mailbox-helper/README.md");
  for (const pattern of [
    /triangle agent add/,
    /bind --profile codex-mailbox-live[^\n]*\\?\n?[^\n]*--key-file/i,
    /workload-key\.json/,
    /profiles-v1/,
    /\/api\/v1\/agents\/me/,
    /agent_paused/,
    /credential_refused/,
    /identity_mismatch/,
    /unbind --profile/,
    /triangle-mailbox"? mcp --profile codex-mailbox-live/,
    /no (?:show|export)[^\n]*(?:command|operation)/i,
    /TRIANGLE_WORKLOAD_KEY_FILE/,
    /Developer ID/i,
    /local-ad-hoc[\s\S]*(non-public|local testing|development only)/i,
    /rollback/i,
    /watch-ensure --help/,
    /Upgrade an existing install/,
    /Interpreting watch-ensure failures/,
    /mcp-interactive[\s\S]*watch membership/i,
    /gate[\s\S]*workload_auth|membership|keychain/i,
    /cliSurface/,
  ]) assert.match(helper, pattern);
  assert.doesNotMatch(helper, /show-token|export-token|admissionToken|enroll --profile|credential_busy/);

  const policy = text("packages/macos-mailbox-helper/KEYCHAIN_POLICY.md");
  assert.match(policy, /never live in the\s+Keychain/);
  assert.match(policy, /dev\.thetriangle\.mesh\.mailbox-watch/);
  assert.doesNotMatch(policy, /test-keychain-integration/);

  for (const relative of ["agents/codex/worker/README.md", "agents/hermes/worker/README.md"]) {
    const worker = text(relative);
    assert.match(worker, /workload-key\.json/);
    assert.match(worker, /TRIANGLE_WORKLOAD_KEY_FILE/);
    assert.match(worker, /triangle-mailbox run-worker --profile/);
    assert.match(worker, /install-macos-mailbox-helper\.sh/);
    assert.doesNotMatch(worker, /MESH_AGENT_TOKEN/);
  }
  const top = text("README.md");
  assert.match(top, /macOS mailbox credential helper/i);
  assert.match(top, /triangle-mailbox"? mcp --profile/);
  const workerSection = top.match(/### Model-free agent workers[\s\S]*?(?=\n## Testing and builds)/)?.[0];
  assert.ok(workerSection, "top-level worker quickstart is missing");
  assert.doesNotMatch(workerSection, /TRIANGLE_CREDENTIAL_FILE|set -a;\s*\.\s*"?\$TRIANGLE_CREDENTIAL_FILE|credentials\/(?:codex|hermes)\.env|enroll|admission/);
  for (const pattern of [
    /install-macos-mailbox-helper\.sh/,
    /triangle agent add/,
    /bind --profile[^\n]*--key-file/,
    /status --profile/,
    /mcp --profile/,
    /triangle-worker-service\.sh prepare-runtime/,
    /TRIANGLE_MAILBOX_PROFILE/,
    /triangle-worker-service\.sh install/,
    /VerifiedCredentialGate/,
    /CODEX_AGENT_ID[^\n]*HERMES_AGENT_ID|HERMES_AGENT_ID[^\n]*CODEX_AGENT_ID/,
    /TRIANGLE_WORKLOAD_KEY_FILE/,
    /no backward compatibility/i,
  ]) assert.match(workerSection, pattern);
  assert.doesNotMatch(top, /Operational worker credentials belong in an operator-owned `0600` file|The LaunchAgent injects them into the mailbox controller|credential root and all project/i);
  const deployment = top.match(/## Deployment[\s\S]*?(?=\n## Security model)/)?.[0];
  assert.ok(deployment, "deployment documentation is missing");
  assert.match(deployment, /workload-key\.json[\s\S]*authoritative/i);
  assert.match(deployment, /VerifiedCredentialGate/);
  assert.match(deployment, /helper[^\n]*internally injects|internally injects[^\n]*helper/i);
});

test("installer refuses helpers that lack the Phase 2 watch CLI help surface", (t) => {
  const f = fixture(t);
  const brokenSwift = path.join(f.base, "tools", "swift-broken-watch");
  fs.writeFileSync(brokenSwift, `#!/bin/bash
set -eu
scratch=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--scratch-path" ]]; then scratch=$2; shift 2; else shift; fi
done
mkdir -p "$scratch/release"
printf '#!/bin/sh\\nprintf legacy-helper\\n' > "$scratch/release/triangle-mailbox"
chmod 700 "$scratch/release/triangle-mailbox"
cp "$scratch/release/triangle-mailbox" "$scratch/release/triangle-client"
chmod 700 "$scratch/release/triangle-client"
`, { mode: 0o700 });
  fs.chmodSync(brokenSwift, 0o700);
  const result = run(["--local-ad-hoc"], { ...f.env, TRIANGLE_SWIFT_COMMAND: brokenSwift });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /watch CLI surface/i);
  assert.equal(
    fs.existsSync(path.join(f.home, "Library", "Application Support", "The Triangle", "bin", "triangle-mailbox")),
    false,
  );
});

function appRoot(f) { return path.join(f.home, "Library", "Application Support", "The Triangle"); }
function installedHelper(f) { return path.join(appRoot(f), "bin", "triangle-mailbox"); }
function installedClient(f) { return path.join(appRoot(f), "bin", "triangle-client"); }
function metadata(f, name = "triangle-mailbox-install.json") {
  return JSON.parse(fs.readFileSync(path.join(appRoot(f), "install-manifest", name), "utf8"));
}
function marker(f) { return path.join(appRoot(f), "credentials", "local", "ENABLED"); }
function commandLog(f) { return fs.existsSync(f.log) ? fs.readFileSync(f.log, "utf8") : ""; }

test("installer defaults to public ad-hoc release mode with required file custody", (t) => {
  const f = fixture(t);
  const result = run(["--install-client"], f.env);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /non-public/i);
  assert.match(result.stderr, /public_ad_hoc/);
  assert.match(result.stderr, /Credential custody: file/);
  const log = commandLog(f);
  assert.match(log, /-Xswiftc -DTRIANGLE_FILE_CUSTODY_REQUIRED/);
  assert.doesNotMatch(log, /TRIANGLE_LOCAL_AD_HOC/);
  assert.match(log, /codesign --force --sign - --identifier dev\.thetriangle\.mailbox .*\/triangle-mailbox\n/);
  assert.match(log, /codesign --force --sign - --identifier dev\.thetriangle\.mailbox .*\/triangle-client\n/);
  assert.doesNotMatch(log, /--options runtime|--timestamp|--sign Developer/);
  assert.doesNotMatch(log, /codesign --force[^\n]*--entitlements/);
  assert.match(log, /codesign --verify --strict/);
  assert.match(log, /client install/);
  for (const name of ["triangle-mailbox-install.json", "triangle-client-install.json"]) {
    const meta = metadata(f, name);
    assert.equal(meta.signingMode, "public_ad_hoc");
    assert.equal(meta.teamId, null);
    assert.equal(meta.credentialCustody, "file");
  }
  assert.equal(mode(path.join(appRoot(f), "credentials")), 0o700);
  assert.equal(mode(path.join(appRoot(f), "credentials", "local")), 0o700);
  assert.equal(mode(marker(f)), 0o600);
  assert.equal(fs.lstatSync(marker(f)).isFile(), true);
  assert.equal(fs.readdirSync(path.join(appRoot(f), "credentials", "local")).some((name) => name.startsWith(".ENABLED.")), false);

  // Upgrade in place keeps the marker and stays on file custody.
  const again = run([], { ...f.env, TRIANGLE_TEST_BINARY_VERSION: "two" });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(metadata(f).credentialCustody, "file");
});

test("installer refuses Developer ID configuration: signing is ad-hoc only", (t) => {
  const f = fixture(t);
  for (const extra of [
    { TRIANGLE_DEVELOPER_ID: "Developer ID Application: Triangle Test (TEAM123456)" },
    { TRIANGLE_DEVELOPER_TEAM_ID: "TEAM123456" },
  ]) {
    for (const args of [[], ["--local-ad-hoc"]]) {
      const result = run(args, { ...f.env, ...extra });
      assert.equal(result.status, 64, result.stderr);
      assert.match(result.stderr, /Developer ID signing is out of scope/);
    }
  }
  assert.equal(commandLog(f), "", "installer built or signed despite Developer ID configuration");
  assert.equal(fs.existsSync(installedHelper(f)), false);
});

test("public ad-hoc install rejects Keychain custody before building", (t) => {
  const f = fixture(t);
  let result = run(["--install-client"], { ...f.env, TRIANGLE_CREDENTIAL_CUSTODY: "keychain" });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /Keychain credential custody is unavailable for public ad-hoc installs/);
  assert.match(result.stderr, /keychain-access-groups/);
  assert.match(result.stderr, /credentials\/local/);
  assert.match(result.stderr, /--local-ad-hoc/);
  assert.equal(commandLog(f), "");
  assert.equal(fs.existsSync(installedHelper(f)), false);
  assert.equal(fs.existsSync(path.join(appRoot(f), "credentials")), false);

  result = run([], { ...f.env, TRIANGLE_CREDENTIAL_CUSTODY: "keyring" });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /TRIANGLE_CREDENTIAL_CUSTODY must be unset, file, or keychain/);

  result = run([], { ...f.env, TRIANGLE_CREDENTIAL_CUSTODY: "file" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(metadata(f).credentialCustody, "file");
});

test("public install refuses to strand an existing Keychain-custody install", (t) => {
  const f = fixture(t);
  let result = run(["--local-ad-hoc"], f.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(metadata(f).signingMode, "local_ad_hoc");
  assert.equal(metadata(f).credentialCustody, "keychain");
  assert.equal(fs.existsSync(marker(f)), false);
  const before = fs.readFileSync(installedHelper(f));

  result = run([], { ...f.env, TRIANGLE_TEST_BINARY_VERSION: "two" });
  assert.equal(result.status, 78);
  assert.match(result.stderr, /uses keychain credential custody/);
  assert.match(result.stderr, /TRIANGLE_ACK_CUSTODY_SWITCH=1/);
  assert.deepEqual(fs.readFileSync(installedHelper(f)), before, "refused switch replaced the helper");
  assert.equal(fs.existsSync(marker(f)), false);

  // Pre-credentialCustody manifests (developer_id or local_ad_hoc) count as Keychain custody.
  const manifest = path.join(appRoot(f), "install-manifest", "triangle-mailbox-install.json");
  const legacy = metadata(f);
  delete legacy.credentialCustody;
  legacy.signingMode = "developer_id";
  fs.writeFileSync(manifest, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
  result = run([], { ...f.env, TRIANGLE_TEST_BINARY_VERSION: "two" });
  assert.equal(result.status, 78);

  // An acknowledged switch must not install or restart any service on a helper
  // that has no file credentials yet.
  for (const args of [["--install-client"], ["--install-worker", "codex", "--profile", "codex-mailbox-live"]]) {
    result = run(args, { ...f.env, TRIANGLE_TEST_BINARY_VERSION: "two", TRIANGLE_ACK_CUSTODY_SWITCH: "1" });
    assert.equal(result.status, 64, result.stderr);
    assert.match(result.stderr, /custody switch cannot also install or restart a service/);
  }
  const launchAgents = path.join(f.home, "Library", "LaunchAgents");
  fs.mkdirSync(launchAgents, { recursive: true, mode: 0o700 });
  const plist = path.join(launchAgents, "dev.thetriangle.client.plist");
  fs.writeFileSync(plist, "<plist/>\n");
  result = run([], { ...f.env, TRIANGLE_TEST_BINARY_VERSION: "two", TRIANGLE_ACK_CUSTODY_SWITCH: "1" });
  assert.equal(result.status, 78, result.stderr);
  assert.match(result.stderr, /every Triangle LaunchAgent/);
  assert.deepEqual(fs.readFileSync(installedHelper(f)), before, "refused switch replaced the helper");
  assert.doesNotMatch(commandLog(f), /client install|worker install/);
  fs.rmSync(plist);

  result = run([], { ...f.env, TRIANGLE_TEST_BINARY_VERSION: "two", TRIANGLE_ACK_CUSTODY_SWITCH: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(metadata(f).signingMode, "public_ad_hoc");
  assert.equal(metadata(f).credentialCustody, "file");
  assert.equal(mode(marker(f)), 0o600);
});

test("file custody marker is part of the install transaction and rolls back with it", (t) => {
  const f = fixture(t);
  for (const phase of ["after-marker", "after-client-metadata"]) {
    const result = run([], { ...f.env, TRIANGLE_INSTALL_FAIL_PHASE: phase });
    assert.notEqual(result.status, 0, `${phase} unexpectedly succeeded`);
    assert.equal(fs.existsSync(marker(f)), false, `${phase} left a marker without a committed install`);
    assert.equal(fs.existsSync(installedHelper(f)), false);
  }
  // A failed post-commit gate (watch CLI surface) also removes a new marker.
  let result = run([], { ...f.env, TRIANGLE_TEST_SIGNATURE_STATE: "installed-target-fail" });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(marker(f)), false);
  result = run([], f.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(mode(marker(f)), 0o600);
  assert.equal(fs.readdirSync(path.join(appRoot(f), "credentials", "local")).some((name) => name.startsWith("ENABLED.")), false);
});

test("local ad-hoc file opt-in over a Keychain install is guarded like a public switch", (t) => {
  const f = fixture(t);
  let result = run(["--local-ad-hoc"], f.env);
  assert.equal(result.status, 0, result.stderr);
  for (const extra of [{ TRIANGLE_CREDENTIAL_CUSTODY: "file" }, { TRIANGLE_FILE_CREDENTIALS: "1" }]) {
    result = run(["--local-ad-hoc", "--install-client"], { ...f.env, ...extra });
    assert.equal(result.status, 78, result.stderr);
    assert.match(result.stderr, /uses keychain credential custody/);
    assert.equal(fs.existsSync(marker(f)), false);
    result = run(["--local-ad-hoc", "--install-client"], { ...f.env, ...extra, TRIANGLE_ACK_CUSTODY_SWITCH: "1" });
    assert.equal(result.status, 64, result.stderr);
    assert.match(result.stderr, /custody switch cannot also install or restart a service/);
  }
  assert.doesNotMatch(commandLog(f), /client install/);
});

test("legacy TRIANGLE_FILE_CREDENTIALS=1 opt-in is recorded as file custody with a marker", (t) => {
  const f = fixture(t);
  let result = run(["--local-ad-hoc"], { ...f.env, TRIANGLE_FILE_CREDENTIALS: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(metadata(f).credentialCustody, "file");
  assert.equal(mode(marker(f)), 0o600);
  // A later public upgrade is not treated as a Keychain switch.
  result = run([], f.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(metadata(f).signingMode, "public_ad_hoc");
});

test("existing file custody marker lets a local ad-hoc host upgrade to public mode", (t) => {
  const f = fixture(t);
  let result = run(["--local-ad-hoc"], { ...f.env, TRIANGLE_CREDENTIAL_CUSTODY: "file" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(metadata(f).signingMode, "local_ad_hoc");
  assert.equal(metadata(f).credentialCustody, "file");
  assert.equal(mode(marker(f)), 0o600);

  result = run(["--local-ad-hoc"], { ...f.env, TRIANGLE_CREDENTIAL_CUSTODY: "keychain" });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /conflicts with the file custody marker/);

  result = run(["--local-ad-hoc"], f.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(metadata(f).credentialCustody, "file", "marker present means local ad-hoc builds use file custody");

  result = run([], f.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(metadata(f).signingMode, "public_ad_hoc");
});

test("installer rejects an unsafe file custody marker or directory", (t) => {
  const f = fixture(t);
  const local = path.join(appRoot(f), "credentials", "local");
  fs.mkdirSync(local, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(appRoot(f), "credentials"), 0o700);
  fs.chmodSync(local, 0o700);
  const outside = path.join(f.base, "outside-marker");
  fs.writeFileSync(outside, "x\n", { mode: 0o600 });
  fs.symlinkSync(outside, marker(f));
  let result = run([], f.env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe file custody marker/);
  assert.equal(fs.existsSync(installedHelper(f)), false);

  fs.unlinkSync(marker(f));
  fs.chmodSync(local, 0o755);
  result = run([], f.env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe application directory mode/);
  assert.equal(fs.existsSync(installedHelper(f)), false);
});

test("installer refuses a quarantined install source before building", { skip: process.platform !== "darwin" }, (t) => {
  const f = fixture(t);
  const source = path.join(f.base, "downloaded-source");
  fs.mkdirSync(path.join(source, "scripts"), { recursive: true, mode: 0o700 });
  const file = path.join(source, "scripts", "install-macos-mailbox-helper.sh");
  fs.writeFileSync(file, "#!/bin/bash\n", { mode: 0o700 });
  let result = run([], { ...f.env, TRIANGLE_INSTALL_QUARANTINE_SOURCE: source });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr + result.stdout, /not quarantined/);

  const g = fixture(t);
  const xattr = spawnSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;00000000;Safari;", file], { encoding: "utf8" });
  assert.equal(xattr.status, 0, xattr.stderr);
  result = run(["--install-client"], { ...g.env, TRIANGLE_INSTALL_QUARANTINE_SOURCE: source });
  assert.equal(result.status, 78);
  assert.match(result.stderr, /install source is quarantined/);
  assert.match(result.stderr, /com\.apple\.quarantine/);
  assert.ok(result.stderr.includes(file), "diagnostic must name the quarantined path");
  assert.match(result.stderr, /curl -fLO/);
  assert.match(result.stderr, /xattr -dr com\.apple\.quarantine/);
  assert.equal(commandLog(g), "", "installer built or signed a quarantined source");
  assert.equal(fs.existsSync(installedHelper(g)), false);
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
  assert.doesNotMatch(fs.readFileSync(f.log, "utf8"), /TRIANGLE_FILE_CUSTODY_REQUIRED/);
  assert.match(fs.readFileSync(f.log, "utf8"), /codesign --verify --strict/);
  assert.equal(fs.readFileSync(unrelated, "utf8"), "preserve me\n");
  assert.equal(fs.readdirSync(applicationRoot).some((name) => name.startsWith(".mailbox-helper-install.")), false);
  const metadata = JSON.parse(fs.readFileSync(path.join(applicationRoot, "install-manifest", "triangle-mailbox-install.json"), "utf8"));
  assert.deepEqual(metadata.cliSurface, ["watch-ensure", "watch-poll", "watch-status", "watch-revoke"]);
  assert.equal(metadata.signingMode, "local_ad_hoc");
  assert.equal(metadata.teamId, null);
  assert.equal(metadata.credentialCustody, "keychain");
  const helper = path.join(applicationRoot, "bin", "triangle-mailbox");
  const help = spawnSync(helper, ["watch-ensure", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /"supported":\s*true/);
  assert.match(help.stdout, /watch-grant-phase-2/);
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

test("installer accepts only a valid ad-hoc signature without Keychain entitlements", (t) => {
  const f = fixture(t);
  for (const state of ["bad-identifier", "not-adhoc", "developer-id", "team-set", "keychain-entitlement"]) {
    for (const args of [[], ["--local-ad-hoc"]]) {
      const result = run(args, { ...f.env, TRIANGLE_TEST_SIGNATURE_STATE: state });
      assert.notEqual(result.status, 0, `${state} ${args.join(" ")} unexpectedly installed`);
      assert.equal(fs.existsSync(installedHelper(f)), false, `${state} left a helper behind`);
    }
  }
  let result = run([], { ...f.env, TRIANGLE_TEST_SIGNATURE_STATE: "keychain-entitlement" });
  assert.match(result.stderr, /must not embed Keychain access-group entitlements/);
  result = run([], { ...f.env, TRIANGLE_TEST_SIGNATURE_STATE: "developer-id" });
  assert.match(result.stderr, /certificate authority/);
  result = run([], f.env);
  assert.equal(result.status, 0, result.stderr);

  const target = installedHelper(f);
  const before = fs.readFileSync(target);
  const clientTarget = installedClient(f);
  const clientBefore = fs.readFileSync(clientTarget);
  const installedFailure = run([], { ...f.env, TRIANGLE_TEST_BINARY_VERSION: "two", TRIANGLE_TEST_SIGNATURE_STATE: "installed-target-fail" });
  assert.notEqual(installedFailure.status, 0);
  assert.deepEqual(fs.readFileSync(target), before, "installed-target signature failure did not restore prior helper");
  assert.deepEqual(fs.readFileSync(clientTarget), clientBefore, "installed-target signature failure did not restore prior client");
  const installedClientFailure = run([], { ...f.env, TRIANGLE_TEST_BINARY_VERSION: "two", TRIANGLE_TEST_SIGNATURE_STATE: "installed-client-target-fail" });
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

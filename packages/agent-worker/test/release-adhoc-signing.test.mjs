import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const readiness = path.join(root, "scripts/release/check-release-readiness.sh");
const quarantine = path.join(root, "scripts/release/check-quarantine.sh");
const isDarwin = process.platform === "darwin";
const cleanEnv = { ...process.env, TRIANGLE_DEVELOPER_ID: "", TRIANGLE_DEVELOPER_TEAM_ID: "" };

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "triangle-release-adhoc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function quarantineFile(file) {
  const result = spawnSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;00000000;Safari;", file], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function stubTools(dir) {
  const codesign = path.join(dir, "codesign");
  fs.writeFileSync(codesign, `#!/bin/bash
state="\${TRIANGLE_TEST_SIGNATURE_STATE:-ok}"
case "$*" in
  *"--verify"*) [[ "$state" != unsigned ]] || exit 1 ;;
  *"--entitlements"*)
    [[ "$state" == keychain-entitlement ]] && printf '<plist><dict><key>keychain-access-groups</key><array/></dict></plist>\\n'
    ;;
  *"-d"*)
    if [[ "$state" == developer-id ]]; then
      printf 'Identifier=dev.thetriangle.mailbox\\nSignature size=9000\\nAuthority=Developer ID Application: Example (TEAM123456)\\nTeamIdentifier=TEAM123456\\n' >&2
    else
      printf 'Identifier=dev.thetriangle.mailbox\\nSignature=adhoc\\nTeamIdentifier=not set\\n' >&2
    fi
    ;;
esac
exit 0
`, { mode: 0o700 });
  const lipo = path.join(dir, "lipo");
  fs.writeFileSync(lipo, `#!/bin/bash
[[ "\${TRIANGLE_TEST_ARCHS:-arm64}" != none ]] && printf '%s\\n' "\${TRIANGLE_TEST_ARCHS:-arm64}"
exit 0
`, { mode: 0o700 });
  return {
    ...cleanEnv,
    TRIANGLE_READINESS_TEST_MODE: "1",
    TRIANGLE_READINESS_CODESIGN_COMMAND: codesign,
    TRIANGLE_READINESS_LIPO_COMMAND: lipo,
    TRIANGLE_READINESS_HOST_OS: "Darwin",
    TRIANGLE_READINESS_HOST_ARCH: "arm64",
  };
}

// Stub executables emulate the compiled custody policy probe.
function stubArtifact(dir, name, { publicCustody = true } = {}) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, publicCustody
    ? `#!/bin/bash
if [[ "\${TRIANGLE_CREDENTIAL_CUSTODY:-}" == keychain ]]; then
  echo "triangle: Keychain credential custody is unavailable in this public ad-hoc release build" >&2
  exit 78
fi
exit 64
`
    : "#!/bin/bash\necho 'invalid command' >&2\nexit 64\n", { mode: 0o700 });
  return file;
}

function runReadiness(args, env) {
  const result = spawnSync("/bin/bash", [readiness, ...args], { encoding: "utf8", env });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

test("public readiness accepts a valid ad-hoc artifact and rejects Developer ID, entitlements, and missing arm64", (t) => {
  const dir = tempDir(t);
  const env = stubTools(dir);
  const artifact = stubArtifact(dir, "triangle-mailbox");
  const client = stubArtifact(dir, "triangle-client");
  const both = (extra = []) => ["--mode", "public", "--artifact", artifact, "--artifact", client, ...extra];

  let result = runReadiness(both(), env);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /artifact triangle-mailbox is ad-hoc signed/);
  assert.match(result.output, /artifact triangle-client enforces public file custody/);
  assert.match(result.output, /no Keychain entitlements/);
  assert.match(result.output, /notarization: not applicable/);
  assert.match(result.output, /PASSED for mode=public/);

  for (const [state, pattern] of [
    ["developer-id", /not ad-hoc signed|certificate authority/],
    ["keychain-entitlement", /embeds Keychain entitlements/],
    ["unsigned", /signature does not verify/],
  ]) {
    result = runReadiness(both(), { ...env, TRIANGLE_TEST_SIGNATURE_STATE: state });
    assert.notEqual(result.status, 0, `${state} passed`);
    assert.match(result.output, pattern);
  }
  result = runReadiness(both(), { ...env, TRIANGLE_TEST_ARCHS: "x86_64" });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /no arm64 slice/);
  result = runReadiness(both(), { ...env, TRIANGLE_TEST_ARCHS: "x86_64 arm64e" });
  assert.equal(result.status, 0, result.output);
  // Intel Macs need an x86_64 slice, not arm64.
  result = runReadiness(both(), { ...env, TRIANGLE_TEST_ARCHS: "x86_64", TRIANGLE_READINESS_HOST_ARCH: "x86_64" });
  assert.equal(result.status, 0, result.output);
  result = runReadiness(both(), { ...env, TRIANGLE_TEST_ARCHS: "arm64", TRIANGLE_READINESS_HOST_ARCH: "x86_64" });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /no x86_64 slice/);

  result = runReadiness(["--mode", "public", "--artifact", path.join(dir, "missing"), "--artifact", client], env);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /missing or not a regular file/);
});

test("public readiness rejects a local ad-hoc (Keychain-default) build despite a valid ad-hoc signature", (t) => {
  const dir = tempDir(t);
  const env = stubTools(dir);
  const helper = stubArtifact(dir, "triangle-mailbox", { publicCustody: false });
  const client = stubArtifact(dir, "triangle-client");
  const result = runReadiness(["--mode", "public", "--artifact", helper, "--artifact", client], env);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /triangle-mailbox is not a public file-custody build \(custody probe exit 64\)/);
  assert.match(result.output, /triangle-mailbox is ad-hoc signed/, "signature alone must not be treated as custody proof");
});

test("public readiness requires both shipped artifacts, macOS, and no Developer ID configuration", (t) => {
  const dir = tempDir(t);
  const env = stubTools(dir);
  const artifact = stubArtifact(dir, "triangle-client");
  const helper = stubArtifact(dir, "triangle-mailbox");

  let result = runReadiness(["--mode", "public"], env);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /requires --artifact/);

  result = runReadiness(["--mode", "public", "--artifact", artifact], env);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /requires --artifact for the shipped triangle-mailbox executable/);
  result = runReadiness(["--mode", "public", "--artifact", helper], env);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /requires --artifact for the shipped triangle-client executable/);

  result = runReadiness(["--mode", "public", "--artifact", artifact], { ...env, TRIANGLE_READINESS_HOST_OS: "Linux" });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /must run on macOS/);

  result = runReadiness(["--mode", "public", "--artifact", artifact], { ...env, TRIANGLE_DEVELOPER_ID: "Developer ID Application: Example (TEAM123456)" });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Developer ID signing is out of scope/);
  assert.doesNotMatch(result.output, /Example \(TEAM123456\)/, "readiness must not print signing identity values");

  result = runReadiness(["--mode", "docs", "--artifact", artifact], env);
  assert.equal(result.status, 64, "--artifact is only valid with --mode public");
});

// Stub that leaves a marker if it is ever executed. The marker path is baked
// into the script because the custody probe runs it under `env -i`.
function markerArtifact(dir, name) {
  const marker = path.join(dir, `${name}.launched`);
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/bash
: > ${JSON.stringify(marker)}
exit 64
`, { mode: 0o700 });
  return { file, marker };
}

// Simulated com.apple.quarantine (works on every platform): exits non-zero for
// the listed paths. With TRIANGLE_TEST_QUARANTINE_AFTER=N, a path counts as
// quarantined only from its Nth check on (quarantine appearing mid-validation).
function quarantineStub(dir, quarantined, { after = 1 } = {}) {
  const stub = path.join(dir, "quarantine-check");
  const counts = path.join(dir, "quarantine-counts");
  fs.mkdirSync(counts);
  fs.writeFileSync(stub, `#!/bin/bash
target=$1
count_file=${JSON.stringify(counts)}/$(printf '%s' "$target" | /usr/bin/cksum | /usr/bin/cut -d' ' -f1)
n=$(( $(/bin/cat "$count_file" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$count_file"
case "$target" in
${quarantined.map((q) => `  ${JSON.stringify(q)}) [[ $n -ge ${after} ]] && exit 78 ;;`).join("\n")}
esac
exit 0
`, { mode: 0o700 });
  return stub;
}

test("public readiness never launches a quarantined artifact", (t) => {
  const dir = tempDir(t);
  const env = stubTools(dir);
  const helper = markerArtifact(dir, "triangle-mailbox");
  const client = stubArtifact(dir, "triangle-client");
  const quarantineCommand = quarantineStub(dir, [helper.file]);
  const result = runReadiness(["--mode", "public", "--artifact", helper.file, "--artifact", client],
    { ...env, TRIANGLE_READINESS_QUARANTINE_COMMAND: quarantineCommand });
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /artifact triangle-mailbox carries com\.apple\.quarantine/);
  assert.equal(fs.existsSync(helper.marker), false, "readiness executed a quarantined artifact (would show a Gatekeeper dialog)");
  assert.doesNotMatch(result.output, /triangle-mailbox (signature verifies|is ad-hoc signed|enforces public file custody|is not a public file-custody build)/);
  // The clean artifact is still fully validated.
  assert.match(result.output, /artifact triangle-client enforces public file custody/);
});

test("custody probe re-checks quarantine immediately before launching", (t) => {
  const dir = tempDir(t);
  const env = stubTools(dir);
  const helper = markerArtifact(dir, "triangle-mailbox");
  const client = stubArtifact(dir, "triangle-client");
  // Clean at the first (validation) check, quarantined by the probe-time check.
  const quarantineCommand = quarantineStub(dir, [helper.file], { after: 2 });
  const result = runReadiness(["--mode", "public", "--artifact", helper.file, "--artifact", client],
    { ...env, TRIANGLE_READINESS_QUARANTINE_COMMAND: quarantineCommand });
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /artifact triangle-mailbox is not quarantined/);
  assert.match(result.output, /artifact triangle-mailbox is quarantined; refusing to launch the custody probe/);
  assert.equal(fs.existsSync(helper.marker), false, "custody probe executed a quarantined artifact");
});

// Launching a real Mach-O can invoke Gatekeeper (a blocking GUI dialog when
// the file is quarantined), so the real-exec test is opt-in, not part of the
// default `npm test`: TRIANGLE_RUN_MACOS_EXEC_TESTS=1 npm test
const runMacosExecTests = process.env.TRIANGLE_RUN_MACOS_EXEC_TESTS === "1";
const hasCc = isDarwin && runMacosExecTests && spawnSync("/usr/bin/xcrun", ["--find", "cc"], { encoding: "utf8" }).status === 0;

// A real Mach-O that implements the same launch-time custody refusal as a
// TRIANGLE_FILE_CUSTODY_REQUIRED build.
function compileProbe(dir, name, publicCustody = true) {
  const source = path.join(dir, `${name}.c`);
  fs.writeFileSync(source, `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(void) {
  const char *c = getenv("TRIANGLE_CREDENTIAL_CUSTODY");
  if (${publicCustody ? 1 : 0} && c && strcmp(c, "keychain") == 0) {
    fputs("triangle: Keychain credential custody is unavailable in this public ad-hoc release build\\n", stderr);
    return 78;
  }
  return 64;
}
`);
  const out = path.join(dir, name);
  const cc = spawnSync("/usr/bin/cc", ["-o", out, source], { encoding: "utf8" });
  assert.equal(cc.status, 0, cc.stderr);
  return out;
}

function adhocSign(file) {
  const sign = spawnSync("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "dev.thetriangle.mailbox", file], { encoding: "utf8" });
  assert.equal(sign.status, 0, sign.stderr);
}

test("public readiness validates real ad-hoc signatures, custody probe, and quarantine on macOS", { skip: hasCc ? false : "set TRIANGLE_RUN_MACOS_EXEC_TESTS=1 on macOS with cc to run real-exec checks" }, (t) => {
  const dir = tempDir(t);
  const artifact = compileProbe(dir, "triangle-mailbox");
  const client = compileProbe(dir, "triangle-client");
  adhocSign(artifact);
  adhocSign(client);
  const args = () => ["--mode", "public", "--artifact", artifact, "--artifact", client];

  let result = runReadiness(args(), cleanEnv);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /signature verifies \(strict\)/);
  assert.match(result.output, /ad-hoc signed/);
  assert.match(result.output, /enforces public file custody/);

  // Modifying a signed binary after signing invalidates it (re-sign last).
  fs.appendFileSync(artifact, Buffer.from([0]));
  result = runReadiness(args(), cleanEnv);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /signature does not verify/);

  fs.rmSync(artifact);
  compileProbe(dir, "triangle-mailbox");
  adhocSign(artifact);
  quarantineFile(artifact);
  result = runReadiness(args(), cleanEnv);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /carries com\.apple\.quarantine/);
  assert.doesNotMatch(result.output, /triangle-mailbox (enforces public file custody|is not a public file-custody build)/,
    "readiness must not launch (custody-probe) a quarantined artifact");
  assert.doesNotMatch(result.output, /triangle-mailbox signature verifies/, "a quarantined artifact is not inspected further");

  // A correctly ad-hoc signed Keychain-default build fails the custody probe.
  fs.rmSync(artifact);
  compileProbe(dir, "triangle-mailbox", false);
  adhocSign(artifact);
  result = runReadiness(args(), cleanEnv);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /not a public file-custody build/);
});

test("quarantine check detects browser-style quarantine on archives and extracted trees", { skip: !isDarwin }, (t) => {
  const dir = tempDir(t);
  const tree = path.join(dir, "triangle-client");
  fs.mkdirSync(path.join(tree, ".git"), { recursive: true });
  fs.mkdirSync(path.join(tree, "node_modules", "dep"), { recursive: true });
  fs.mkdirSync(path.join(tree, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(tree, ".git", "HEAD"), "ref\n");
  fs.writeFileSync(path.join(tree, "node_modules", "dep", "index.js"), "\n");
  const installer = path.join(tree, "scripts", "install.sh");
  fs.writeFileSync(installer, "#!/bin/bash\n");

  let result = spawnSync("/bin/bash", [quarantine, tree], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /not quarantined/);

  // VCS metadata and dependency trees are never launched from the source tree.
  quarantineFile(path.join(tree, ".git", "HEAD"));
  quarantineFile(path.join(tree, "node_modules", "dep", "index.js"));
  result = spawnSync("/bin/bash", [quarantine, tree], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  quarantineFile(installer);
  result = spawnSync("/bin/bash", [quarantine, tree], { encoding: "utf8" });
  assert.equal(result.status, 78);
  assert.ok(result.stderr.includes(installer));
  assert.match(result.stderr, /web browser/);
  assert.match(result.stderr, /curl -fLO/);
  assert.match(result.stderr, /shasum -a 256/);
  assert.match(result.stderr, /xattr -dr com\.apple\.quarantine/);

  const archive = path.join(dir, "triangle-client-1.0.0.tar.gz");
  fs.writeFileSync(archive, "archive");
  result = spawnSync("/bin/bash", [quarantine, archive], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  quarantineFile(archive);
  result = spawnSync("/bin/bash", [quarantine, archive], { encoding: "utf8" });
  assert.equal(result.status, 78);
  assert.ok(result.stderr.includes(archive));
});

test("quarantine check fails closed when the scan is incomplete", { skip: !isDarwin || process.getuid() === 0 }, (t) => {
  const dir = tempDir(t);
  const tree = path.join(dir, "triangle-client");
  const locked = path.join(tree, "locked");
  fs.mkdirSync(locked, { recursive: true });
  fs.writeFileSync(path.join(locked, "hidden.sh"), "#!/bin/bash\n");
  fs.chmodSync(locked, 0o000);
  let result;
  try {
    result = spawnSync("/bin/bash", [quarantine, tree], { encoding: "utf8" });
  } finally {
    fs.chmodSync(locked, 0o700);
  }
  assert.equal(result.status, 74, result.stdout + result.stderr);
  assert.match(result.stderr, /could not scan every path/);
  assert.doesNotMatch(result.stdout, /not quarantined/);
});

test("quarantine check fails clearly on usage errors and missing paths", () => {
  let result = spawnSync("/bin/bash", [quarantine], { encoding: "utf8" });
  assert.equal(result.status, 64);
  if (!isDarwin) return;
  result = spawnSync("/bin/bash", [quarantine, path.join(os.tmpdir(), "triangle-missing-source-xyz")], { encoding: "utf8" });
  assert.equal(result.status, 66);
  assert.match(result.stderr, /does not exist/);
});

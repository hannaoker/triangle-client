#!/bin/bash
# Fail-closed release readiness preflight for Triangle Client.
# Developer ID signing and notarization are out of scope (owner decision,
# 2026-10-17): public releases are ad-hoc signed (`codesign -s -`) and use
# portable 0600 file credential custody. This script never prints secrets.

set -euo pipefail
IFS=$'\n\t'

usage() {
  cat >&2 <<'USAGE'
Usage: check-release-readiness.sh [--mode docs|public|adhoc-dev] [--artifact <path>]...

  docs         Documentation + repository-boundary checks only (default).
               Safe on Linux CI / Cloud Agents.
  public       docs + validate every final release executable passed with
               --artifact (after its last modification; both triangle-mailbox
               and triangle-client are required): strict codesign
               verification, an ad-hoc signature (Signature=adhoc, no
               certificate authority or team), no Keychain access-group
               entitlements, a slice for this Mac's architecture, no
               com.apple.quarantine attribute, and a compiled public custody
               policy (the binary refuses TRIANGLE_CREDENTIAL_CUSTODY=keychain
               with exit 78 before reading any credential). Requires macOS.
               Notarization is not applicable.
  adhoc-dev    docs + acknowledge local-only --local-ad-hoc development
               installs; exits 0 only with TRIANGLE_ACK_ADHOC_NON_PUBLIC=1.
USAGE
  exit 64
}

mode=docs
artifacts=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      [[ $# -ge 2 ]] || usage
      mode=$2
      shift 2
      ;;
    --artifact)
      [[ $# -ge 2 && -n "$2" ]] || usage
      artifacts+=("$2")
      shift 2
      ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done

case "$mode" in docs|public|adhoc-dev) ;; *) usage ;; esac
if [[ ${#artifacts[@]} -gt 0 && "$mode" != public ]]; then usage; fi

project_root=$(cd "$(dirname "$0")/../.." && pwd -P)
cd "$project_root"

codesign_command=/usr/bin/codesign
lipo_command=/usr/bin/lipo
host_os=$(/usr/bin/uname -s)
host_arch=$(/usr/bin/uname -m)
if [[ "${TRIANGLE_READINESS_TEST_MODE:-}" == "1" ]]; then
  host_arch="${TRIANGLE_READINESS_HOST_ARCH:-$host_arch}"
  codesign_command="${TRIANGLE_READINESS_CODESIGN_COMMAND:-$codesign_command}"
  lipo_command="${TRIANGLE_READINESS_LIPO_COMMAND:-$lipo_command}"
  host_os="${TRIANGLE_READINESS_HOST_OS:-$host_os}"
fi

failures=0
note() { printf 'OK  %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; failures=$((failures + 1)); }

require_file() {
  local path=$1
  if [[ -f "$path" ]]; then note "present: $path"
  else fail "missing required file: $path"
  fi
}

echo "Triangle Client release readiness ($mode)"
echo "root: $project_root"

# --- Required release docs / scripts -----------------------------------------
for path in \
  docs/triangle-client/README.md \
  docs/triangle-client/release-workflow.md \
  docs/triangle-client/release-bundle.md \
  docs/triangle-client/e2e-operator-runbook.md \
  docs/triangle-client/threat-model.md \
  packages/macos-mailbox-helper/README.md \
  packages/macos-mailbox-helper/KEYCHAIN_POLICY.md \
  scripts/install-macos-mailbox-helper.sh \
  scripts/triangle-client-service.sh \
  scripts/release/verify-secret-boundaries.sh \
  scripts/release/check-quarantine.sh \
  deploy/launchd/dev.thetriangle.client.plist.template
do
  require_file "$path"
done

# --- Doc content anchors (no secrets) ----------------------------------------
require_match() {
  local file=$1 pattern=$2 label=$3
  if /usr/bin/grep -E -q "$pattern" "$file"; then note "docs: $label"
  else fail "docs missing expected content ($label) in $file"
  fi
}

require_match docs/triangle-client/release-bundle.md 'public_ad_hoc' 'release-bundle documents public ad-hoc signing'
require_match docs/triangle-client/release-bundle.md 'Developer ID' 'release-bundle states Developer ID is out of scope'
require_match docs/triangle-client/release-bundle.md 'local-ad-hoc' 'release-bundle distinguishes local ad-hoc'
require_match docs/triangle-client/release-bundle.md 'signingMode' 'release-bundle documents signingMode'
require_match docs/triangle-client/release-bundle.md 'credentialCustody' 'release-bundle documents credentialCustody'
require_match docs/triangle-client/release-bundle.md 'com\.apple\.quarantine' 'release-bundle documents the quarantine check'
require_match docs/triangle-client/e2e-operator-runbook.md 'event-driven' 'e2e runbook covers event-driven'
require_match docs/triangle-client/e2e-operator-runbook.md 'watch-ensure' 'e2e runbook covers watch-ensure'
require_match docs/triangle-client/e2e-operator-runbook.md 'mcp-interactive' 'e2e runbook rejects interactive watch membership'
require_match docs/triangle-client/e2e-operator-runbook.md 'ChatGPT\.app|codex-desktop-wake-handoff' 'e2e runbook points at desktop wake docs'
require_match docs/triangle-client/release-workflow.md 'Release readiness checklist' 'release-workflow has readiness checklist'
require_match docs/triangle-client/README.md 'release-bundle\.md|Release bundle' 'client guide links release bundle'

# --- Secret / server boundary scans ------------------------------------------
if ! bash scripts/release/verify-secret-boundaries.sh; then
  fail "secret-boundary scan reported problems"
else
  note "secret-boundary scan clean"
fi

# Forbidden MESH-server-owned paths in this client repo
for forbidden in mesh .vercel tests/mailbox-a2a-cutover.test.mjs tests/triangle-client-multi-agent.test.mjs; do
  if [[ -e "$forbidden" ]]; then fail "server-owned path must not exist: $forbidden"
  else note "absent (good): $forbidden"
  fi
done

# LaunchAgent template must only invoke helper run-supervisor
if /usr/bin/grep -F 'run-supervisor' deploy/launchd/dev.thetriangle.client.plist.template >/dev/null \
  && ! /usr/bin/grep -E 'mesh_|MESH_AGENT|admission' deploy/launchd/dev.thetriangle.client.plist.template >/dev/null; then
  note "LaunchAgent template is credential-free"
else
  fail "LaunchAgent template must invoke run-supervisor without credentials"
fi

# --- Ad-hoc release artifact validation --------------------------------------
validate_artifact() {
  local artifact=$1 display team entitlements archs label
  label=$(/usr/bin/basename "$artifact")
  if [[ -L "$artifact" || ! -f "$artifact" ]]; then
    fail "artifact $label is missing or not a regular file"
    return
  fi
  if /bin/bash scripts/release/check-quarantine.sh "$artifact" >/dev/null 2>&1; then
    note "artifact $label is not quarantined"
  else
    fail "artifact $label carries com.apple.quarantine (run scripts/release/check-quarantine.sh for remediation)"
  fi
  if "$codesign_command" --verify --strict --verbose=2 "$artifact" >/dev/null 2>&1; then
    note "artifact $label signature verifies (strict)"
  else
    fail "artifact $label signature does not verify; re-sign with codesign --force --sign - after the last modification"
    return
  fi
  display=$("$codesign_command" -d --verbose=4 "$artifact" 2>&1 || true)
  if /usr/bin/grep -qx 'Signature=adhoc' <<<"$display"; then note "artifact $label is ad-hoc signed"
  else fail "artifact $label is not ad-hoc signed (expected Signature=adhoc)"
  fi
  if /usr/bin/grep -q '^Authority=' <<<"$display"; then
    fail "artifact $label carries a certificate authority; public releases are ad-hoc only"
  fi
  team=$(/usr/bin/sed -n 's/^TeamIdentifier=//p' <<<"$display" | /usr/bin/head -n 1)
  if [[ -n "$team" && "$team" != "not set" ]]; then
    fail "artifact $label has a team identifier; public releases are ad-hoc only"
  fi
  entitlements=$("$codesign_command" -d --entitlements - --xml "$artifact" 2>/dev/null || true)
  if /usr/bin/grep -Eq 'keychain-access-groups|application-identifier' <<<"$entitlements"; then
    fail "artifact $label embeds Keychain entitlements an ad-hoc signature cannot carry"
  else
    note "artifact $label embeds no Keychain entitlements (file custody)"
  fi
  archs=$("$lipo_command" -archs "$artifact" 2>/dev/null || true)
  case "$host_arch" in
    arm64) arch_pattern=' arm64e? ' ;;
    *) arch_pattern=" ${host_arch} " ;;
  esac
  if [[ " $archs " =~ $arch_pattern ]]; then note "artifact $label includes a ${host_arch} slice"
  else fail "artifact $label has no ${host_arch} slice for this Mac"
  fi
  probe_custody_policy "$artifact" "$label"
}

# Proves the compiled custody policy rather than inferring it from the
# signature: a public build (TRIANGLE_FILE_CUSTODY_REQUIRED) exits 78 at launch
# for a Keychain request, before parsing its command or reading credentials. A
# --local-ad-hoc or Keychain build would reach the parser and exit 64 instead.
probe_custody_policy() {
  local artifact=$1 label=$2 probe_home probe_output probe_status
  probe_home=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/triangle-custody-probe.XXXXXX")
  probe_status=0
  probe_output=$(/usr/bin/env -i HOME="$probe_home" PATH=/usr/bin:/bin \
    TRIANGLE_CREDENTIAL_CUSTODY=keychain "$artifact" __triangle_release_custody_probe__ 2>&1 >/dev/null) || probe_status=$?
  /bin/rm -rf "$probe_home"
  if [[ $probe_status -eq 78 && "$probe_output" == *"public ad-hoc release build"* ]]; then
    note "artifact $label enforces public file custody (refuses Keychain custody)"
  else
    fail "artifact $label is not a public file-custody build (custody probe exit ${probe_status}); reinstall without --local-ad-hoc"
  fi
}

# --- Mode-specific signing gates ---------------------------------------------
case "$mode" in
  docs)
    note "docs mode: skipping ad-hoc artifact signature checks"
    ;;
  public)
    if [[ -n "${TRIANGLE_DEVELOPER_ID:-}" || -n "${TRIANGLE_DEVELOPER_TEAM_ID:-}" ]]; then
      fail "Developer ID signing is out of scope; unset TRIANGLE_DEVELOPER_ID / TRIANGLE_DEVELOPER_TEAM_ID"
    fi
    if [[ "$host_os" != Darwin ]]; then
      fail "public mode must run on macOS to verify ad-hoc signatures"
    elif [[ ${#artifacts[@]} -eq 0 ]]; then
      fail "public mode requires --artifact <path> for every final release executable"
    else
      for required in triangle-mailbox triangle-client; do
        found=0
        for artifact in "${artifacts[@]}"; do
          [[ "$(/usr/bin/basename "$artifact")" == "$required" ]] && found=1
        done
        [[ $found -eq 1 ]] || fail "public mode requires --artifact for the shipped ${required} executable"
      done
      for artifact in "${artifacts[@]}"; do validate_artifact "$artifact"; done
    fi
    note "notarization: not applicable (ad-hoc release; Developer ID is out of scope)"
    echo "NOTE: ad-hoc signatures carry no publisher identity; authenticate release/update metadata independently." >&2
    echo "NOTE: Gatekeeper/quarantine and clean-install custody proofs need a fresh VM or clean machine." >&2
    ;;
  adhoc-dev)
    if [[ "${TRIANGLE_ACK_ADHOC_NON_PUBLIC:-}" == "1" ]]; then
      note "adhoc-dev acknowledged as non-public (TRIANGLE_ACK_ADHOC_NON_PUBLIC=1)"
    else
      fail "adhoc-dev requires TRIANGLE_ACK_ADHOC_NON_PUBLIC=1; --local-ad-hoc installs are not a public release"
    fi
    echo "WARNING: --local-ad-hoc keeps the legacy Keychain compatibility path; it is not the public custody contract." >&2
    ;;
esac

# --- Explicit non-blocking gap callouts --------------------------------------
cat <<'GAPS'

Operator/clean-machine gaps (documented; do not fail this preflight by themselves):
  - Gatekeeper/quarantine and clean-install file-custody proofs need a fresh VM or clean machine
  - Release/update metadata must be authenticated independently of the ad-hoc signature
  - ChatGPT.app required for desktop App Server Gate A / Bob canary
  - Live helper watch gaps may still need Mac follow-up (see watch-status operatorAction)
  - Phase 2 durable wake/scheduling remains Complete; do not reopen that status here
GAPS

if [[ $failures -ne 0 ]]; then
  echo "Release readiness FAILED ($failures check(s))" >&2
  exit 1
fi

echo "Release readiness PASSED for mode=$mode"
exit 0

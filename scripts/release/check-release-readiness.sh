#!/bin/bash
# Fail-closed release readiness preflight for Triangle Client.
# Does not invent secrets, does not require Developer ID values in the repo,
# and refuses to claim a public ship when only ad-hoc signing is configured.

set -euo pipefail
IFS=$'\n\t'

usage() {
  cat >&2 <<'EOF'
Usage: check-release-readiness.sh [--mode docs|public|adhoc-dev]

  docs         Documentation + repository-boundary checks only (default).
               Safe on Linux CI / Cloud Agents.
  public       docs + require TRIANGLE_DEVELOPER_ID and TRIANGLE_DEVELOPER_TEAM_ID
               in the environment (values never printed). Refuses --local-ad-hoc.
  adhoc-dev    docs + acknowledge local-only ad-hoc; exits 0 only with
               TRIANGLE_ACK_ADHOC_NON_PUBLIC=1. Never marks a public release ready.
EOF
  exit 64
}

mode=docs
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      [[ $# -ge 2 ]] || usage
      mode=$2
      shift 2
      ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done

case "$mode" in docs|public|adhoc-dev) ;; *) usage ;; esac

project_root=$(cd "$(dirname "$0")/../.." && pwd -P)
cd "$project_root"

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

require_match docs/triangle-client/release-bundle.md 'Developer ID' 'release-bundle mentions Developer ID'
require_match docs/triangle-client/release-bundle.md 'local-ad-hoc' 'release-bundle distinguishes ad-hoc'
require_match docs/triangle-client/release-bundle.md 'signingMode' 'release-bundle documents signingMode'
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

# --- Mode-specific signing gates ---------------------------------------------
case "$mode" in
  docs)
    note "docs mode: skipping live Developer ID presence checks"
    ;;
  public)
    if [[ -n "${TRIANGLE_DEVELOPER_ID:-}" ]]; then
      note "TRIANGLE_DEVELOPER_ID is set (value not printed)"
    else
      fail "public mode requires TRIANGLE_DEVELOPER_ID in the environment"
    fi
    if [[ "${TRIANGLE_DEVELOPER_TEAM_ID:-}" =~ ^[A-Z0-9]{10}$ ]]; then
      note "TRIANGLE_DEVELOPER_TEAM_ID shape is valid (value not printed)"
    else
      fail "public mode requires TRIANGLE_DEVELOPER_TEAM_ID as ten A-Z0-9 characters"
    fi
    if [[ "${TRIANGLE_FORCE_ADHOC:-}" == "1" ]]; then
      fail "public mode refuses TRIANGLE_FORCE_ADHOC=1"
    fi
    echo "NOTE: public mode does not run codesign or Mac Keychain proofs from Linux." >&2
    echo "NOTE: ChatGPT.app / Gate A / Bob canary remain Mac-operator dependent." >&2
    ;;
  adhoc-dev)
    if [[ "${TRIANGLE_ACK_ADHOC_NON_PUBLIC:-}" == "1" ]]; then
      note "adhoc-dev acknowledged as non-public (TRIANGLE_ACK_ADHOC_NON_PUBLIC=1)"
    else
      fail "adhoc-dev requires TRIANGLE_ACK_ADHOC_NON_PUBLIC=1; cannot mark public release ready"
    fi
    echo "WARNING: ad-hoc does not provide a stable distributed Keychain identity." >&2
    ;;
esac

# --- Explicit non-blocking gap callouts --------------------------------------
cat <<'EOF'

Operator/cert gaps (documented; do not fail this docs preflight by themselves):
  - Developer ID certificate must exist on the Mac that builds public installs
  - ChatGPT.app required for desktop App Server Gate A / Bob canary
  - Live helper watch gaps may still need Mac follow-up (see watch-status operatorAction)
  - Phase 2 durable wake/scheduling remains Complete; do not reopen that status here
EOF

if [[ $failures -ne 0 ]]; then
  echo "Release readiness FAILED ($failures check(s))" >&2
  exit 1
fi

echo "Release readiness PASSED for mode=$mode"
exit 0

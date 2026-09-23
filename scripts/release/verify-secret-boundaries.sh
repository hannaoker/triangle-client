#!/bin/bash
# Scan release-facing paths for forbidden MESH credential patterns.
# Fail closed. Never prints matched secret material — only file paths and rule ids.

set -euo pipefail
IFS=$'\n\t'

project_root=$(cd "$(dirname "$0")/../.." && pwd -P)
cd "$project_root"

failures=0
fail() { printf 'FAIL %s\n' "$1" >&2; failures=$((failures + 1)); }
ok() { printf 'OK  %s\n' "$1"; }

# Paths that must never contain live-looking mesh_/mesh_watch_ tokens or
# admissionToken assignments with real-looking secrets.
scan_paths=(
  deploy/launchd
  scripts
  docs/triangle-client
  packages/macos-mailbox-helper/README.md
  packages/macos-mailbox-helper/KEYCHAIN_POLICY.md
  README.md
)

# Real-looking permanent / watch tokens (hex bodies). Allow documenting the
# prefix alone (mesh_ / mesh_watch_) in prose.
token_re='mesh_(watch_)?[0-9a-fA-F]{32,}'

# admissionToken with a non-placeholder value in committed files
admission_re='admissionToken"[[:space:]]*:[[:space:]]*"[^"$][^"]{16,}"'

for path in "${scan_paths[@]}"; do
  if [[ ! -e "$path" ]]; then
    fail "expected scan path missing: $path"
    continue
  fi
done

# Collect text files under scan roots (skip binaries / build artifacts)
while IFS= read -r -d '' file; do
  case "$file" in
    *.png|*.jpg|*.jpeg|*.gif|*.webp|*.ico|*.pdf|*.zip|*.tar|*.gz) continue ;;
  esac
  # Skip this scanner and generated lock noise
  case "$file" in
    */scripts/release/verify-secret-boundaries.sh) continue ;;
    */package-lock.json) continue ;;
  esac

  if /usr/bin/grep -E -q "$token_re" "$file" 2>/dev/null; then
    # Allow test fixtures that intentionally use synthetic tokens under test/
    case "$file" in
      */test/*|*/tests/*|*Contract*|*/Tests/*) continue ;;
    esac
    fail "forbidden token-shaped string in $file (rule: mesh_token_shape)"
  fi

  if /usr/bin/grep -E -q "$admission_re" "$file" 2>/dev/null; then
    fail "committed admissionToken literal in $file (rule: admission_literal)"
  fi
done < <(/usr/bin/find "${scan_paths[@]}" -type f -print0 2>/dev/null)

# LaunchAgent templates: no credential keys. The client template may export only
# the production pool/handoff opt-in (values 1 or 2). No probe-file override.
for plist in deploy/launchd/*.plist.template; do
  [[ -f "$plist" ]] || continue
  if /usr/bin/grep -E -qi 'MESH_AGENT_TOKEN|mesh_watch_|admissionToken|TRIANGLE_CODEX_LIVE_PROBE|OPENAI_API_KEY' "$plist"; then
    fail "LaunchAgent template must stay credential-free: $plist"
  elif /usr/bin/grep -F 'EnvironmentVariables' "$plist" >/dev/null; then
    if /usr/bin/grep -F 'TRIANGLE_CODEX_POOL_ENABLE' "$plist" >/dev/null \
      && /usr/bin/grep -F 'TRIANGLE_CODEX_POOL_SIZE' "$plist" >/dev/null \
      && /usr/bin/grep -F 'TRIANGLE_DESKTOP_HANDOFF_ENABLE' "$plist" >/dev/null; then
      ok "LaunchAgent template opt-in is non-secret: $plist"
    else
      fail "LaunchAgent EnvironmentVariables is not the pool/handoff allowlist: $plist"
    fi
  else
    ok "LaunchAgent template clean: $plist"
  fi
done

# Node production sources under agent-worker must keep the reject-secret posture
if /usr/bin/grep -R -E -l "must not contain mesh_|never accepts|never.*mesh_watch_|No Node \`mesh_" \
  packages/agent-worker/src --include='*.mjs' >/dev/null 2>&1; then
  ok "agent-worker sources document mesh_ rejection"
else
  fail "agent-worker sources should document mesh_/mesh_watch_ rejection"
fi

# Ensure installer does not embed a default Developer ID string
if /usr/bin/grep -E -q "^[[:space:]]*(export[[:space:]]+)?TRIANGLE_DEVELOPER_ID=" scripts/install-macos-mailbox-helper.sh; then
  fail "installer must not assign TRIANGLE_DEVELOPER_ID; operators supply it"
elif /usr/bin/grep -E -q "TRIANGLE_DEVELOPER_TEAM_ID=['\"][A-Z0-9]{10}['\"]" scripts/install-macos-mailbox-helper.sh; then
  fail "installer must not hard-code TRIANGLE_DEVELOPER_TEAM_ID"
else
  ok "installer does not hard-code Developer ID values"
fi

# Docs must not claim Linux completed ChatGPT.app / Gate A
for doc in docs/triangle-client/e2e-operator-runbook.md docs/triangle-client/release-bundle.md; do
  if /usr/bin/grep -E -qi 'Gate A (complete|passed|proved).*Linux|Linux.*(Gate A|ChatGPT\.app).*(complete|passed|proved)' "$doc"; then
    fail "$doc must not claim Linux Gate A / ChatGPT.app success"
  else
    ok "no Linux Gate A claim in $doc"
  fi
done

if [[ $failures -ne 0 ]]; then
  echo "Secret-boundary verification FAILED ($failures)" >&2
  exit 1
fi

echo "Secret-boundary verification PASSED"
exit 0

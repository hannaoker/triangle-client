#!/bin/bash
# One-shot: copy mailbox / workload / watch secrets from login Keychain into
# Application Support files (mode 0600) so the ad-hoc helper stops prompting.
# Uses `security` CLI (already authorized), not triangle-mailbox Keychain ACL.
set -euo pipefail

ROOT="$HOME/Library/Application Support/The Triangle/credentials/local"
MAILBOX="$ROOT/mailbox"
WORKLOAD="$ROOT/workload"
WATCH="$ROOT/watch"
mkdir -m 700 -p "$MAILBOX" "$WORKLOAD" "$WATCH"

export_item() {
  local svc="$1" acct="$2" dest="$3"
  local secret
  printf '  %s / %s ... ' "$svc" "$acct"
  if ! secret=$(security find-generic-password -s "$svc" -a "$acct" -w 2>/dev/null); then
    echo "SKIP"
    return 0
  fi
  if [[ -z "$secret" ]]; then
    echo "EMPTY"
    return 0
  fi
  # Validate JSON when destination is .json mailbox/watch; workload may be JSON too.
  printf '%s' "$secret" > "$dest"
  chmod 600 "$dest"
  echo "OK ($(wc -c <"$dest" | tr -d ' ') bytes)"
  unset secret
}

echo "=== Export Triangle credentials to local files ==="
echo "Root: $ROOT"
echo

export_item "dev.thetriangle.mesh.mailbox" "bob" "$MAILBOX/bob.json"
export_item "dev.thetriangle.mesh.workload-key" "bob" "$WORKLOAD/bob.json"
export_item "dev.thetriangle.mesh.mailbox" "codex-bob-test" "$MAILBOX/codex-bob-test.json"
export_item "dev.thetriangle.mesh.workload-key" "codex-bob-test" "$WORKLOAD/codex-bob-test.json"
export_item "dev.thetriangle.mesh.mailbox-watch" "inst_EaA3qkuzOuQwTSFw" "$WATCH/inst_EaA3qkuzOuQwTSFw.json"

# Enable file custody for ad-hoc helper / LaunchAgent
: > "$ROOT/ENABLED"
chmod 600 "$ROOT/ENABLED"

echo
echo "ENABLED marker written. Reinstall/restart helper with TRIANGLE_FILE_CREDENTIALS=1"
echo "or rely on the ENABLED marker (ad-hoc builds only)."

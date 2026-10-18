#!/bin/bash
# Bootstrap quarantine diagnostic for Triangle Client install sources.
#
# Triangle Client releases are ad-hoc signed (no Developer ID, no notarization).
# Gatekeeper may refuse to launch a quarantined ad-hoc executable, and a blocked
# binary (including the doctor) cannot diagnose its own launch failure. Run this
# with /bin/bash -- not as a downloaded executable -- before installing:
#
#   /bin/bash scripts/release/check-quarantine.sh <archive-or-directory>...
#
# Apple DTS: curl/scp downloads are not quarantined; browser downloads are, and
# Archive Utility propagates the attribute to extracted files
# (https://developer.apple.com/forums/thread/706442). An absent attribute is not
# a guarantee that Gatekeeper will never assess the binary.
#
# Exit codes: 0 clean (or non-macOS: skipped), 64 usage, 66 missing path,
# 78 quarantined source.

set -euo pipefail
IFS=$'\n\t'

attribute=com.apple.quarantine
max_listed=5

usage() {
  echo "Usage: $0 <archive-or-directory>..." >&2
  exit 64
}
[[ $# -ge 1 ]] || usage

if [[ "$(/usr/bin/uname -s)" != "Darwin" ]]; then
  echo "SKIP quarantine check: ${attribute} is a macOS attribute" >&2
  exit 0
fi

find_command=/usr/bin/find
quarantined=()
for source in "$@"; do
  if [[ ! -e "$source" && ! -L "$source" ]]; then
    echo "FAIL install source does not exist: ${source}" >&2
    exit 66
  fi
  # BSD find's -xattrname matches the attribute without executing anything.
  # Build products and VCS metadata are never launched from the source tree.
  while IFS= read -r hit; do
    [[ -n "$hit" ]] && quarantined+=("$hit")
  done < <("$find_command" "$source" \
      \( -type d \( -name .git -o -name node_modules -o -name .build \) -prune \) \
      -o -xattrname "$attribute" -print 2>/dev/null || true)
done

if [[ ${#quarantined[@]} -eq 0 ]]; then
  echo "OK  install source is not quarantined (${attribute} absent)"
  exit 0
fi

{
  echo "FAIL install source is quarantined: ${#quarantined[@]} path(s) carry ${attribute}, e.g.:"
  for ((i = 0; i < ${#quarantined[@]} && i < max_listed; i++)); do
    echo "       ${quarantined[$i]}"
  done
  cat <<MSG

  This usually means the release archive was downloaded with a web browser (or
  extracted by Archive Utility from a quarantined archive). Triangle Client is
  ad-hoc signed with no Developer ID or notarization, so Gatekeeper may refuse
  to launch the installed helper, client, or doctor without a Triangle error.

  Fix (choose one), then re-run the installer:
    1. Re-download with curl, which does not set quarantine, verify the
       published SHA-256, and extract with tar:
         curl -fLO <release-archive-url>
         shasum -a 256 <release-archive>
         tar -xzf <release-archive>
    2. If you already verified the archive's SHA-256 against the release notes,
       remove the attribute from the archive or extracted directory:
         xattr -dr ${attribute} <archive-or-directory>
MSG
} >&2
exit 78

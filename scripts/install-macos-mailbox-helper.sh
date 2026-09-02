#!/bin/bash

set -euo pipefail
IFS=$'\n\t'

usage() {
  echo "Usage: $0 [--local-ad-hoc] [--install-client | --install-worker <codex|hermes|antigravity> --profile <name>]" >&2
  exit 64
}

local_ad_hoc=0
worker=""
profile=""
install_client=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --local-ad-hoc)
      [[ $local_ad_hoc -eq 0 ]] || usage
      local_ad_hoc=1
      shift
      ;;
    --install-worker)
      [[ -z "$worker" && $# -ge 2 ]] || usage
      worker=$2
      shift 2
      ;;
    --install-client)
      [[ $install_client -eq 0 ]] || usage
      install_client=1
      shift
      ;;
    --profile)
      [[ -z "$profile" && $# -ge 2 ]] || usage
      profile=$2
      shift 2
      ;;
    *) usage ;;
  esac
done
if [[ $install_client -eq 1 ]]; then
  [[ -z "$worker" && -z "$profile" ]] || usage
fi
if [[ -n "$worker" || -n "$profile" ]]; then
  [[ $install_client -eq 0 ]] || usage
  [[ "$worker" == "codex" || "$worker" == "hermes" || "$worker" == "antigravity" ]] || usage
  [[ "$profile" =~ ^[^/\\[:cntrl:]]{1,64}$ ]] || usage
fi

identifier="dev.thetriangle.mailbox"
project_root=$(cd "$(dirname "$0")/.." && pwd -P)
package_root="${project_root}/packages/macos-mailbox-helper"
if [[ "${TRIANGLE_INSTALL_TEST_MODE:-}" == "1" ]]; then
  /usr/bin/python3 - "$HOME" "${TRIANGLE_INSTALL_TEST_ROOT:-}" <<'PY'
import os, stat, sys, tempfile
home, root = map(os.path.abspath, sys.argv[1:])
temp = os.path.realpath(tempfile.gettempdir())
if not root or root != os.path.dirname(home) or os.path.realpath(root) != root:
    raise SystemExit("test mode requires its exact canonical temporary root")
if not os.path.basename(root).startswith("triangle-helper-install-"):
    raise SystemExit("test mode root has an invalid name")
if os.path.commonpath([root, temp]) != temp:
    raise SystemExit("test mode is restricted to the system temporary directory")
for path in (root, home):
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise SystemExit("test mode root and HOME must be owned nonsymlink mode-0700 directories")
PY
else
  account_home=$(/usr/bin/python3 -c 'import os,pwd; print(os.path.realpath(pwd.getpwuid(os.getuid()).pw_dir))')
  supplied_home=$(/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$HOME")
  [[ "$HOME" == "$supplied_home" && "$supplied_home" == "$account_home" ]] || {
    echo "HOME must be the current user's canonical account home" >&2
    exit 64
  }
fi
application_root="${HOME}/Library/Application Support/The Triangle"
bin_dir="${application_root}/bin"
manifest_dir="${application_root}/install-manifest"
target="${bin_dir}/triangle-mailbox"
hash_target="${manifest_dir}/triangle-mailbox.sha256"
metadata_target="${manifest_dir}/triangle-mailbox-install.json"
client_target="${bin_dir}/triangle-client"
client_hash_target="${manifest_dir}/triangle-client.sha256"
client_metadata_target="${manifest_dir}/triangle-client-install.json"

swift_command=/usr/bin/swift
if [[ -x /opt/homebrew/opt/swift/bin/swift ]]; then
  swift_command=/opt/homebrew/opt/swift/bin/swift
fi
codesign_command=/usr/bin/codesign
worker_service="${project_root}/scripts/triangle-worker-service.sh"
client_service="${project_root}/scripts/triangle-client-service.sh"
expected_uid=$(/usr/bin/id -u)
if [[ "${TRIANGLE_INSTALL_TEST_MODE:-}" == "1" ]]; then
  swift_command="${TRIANGLE_SWIFT_COMMAND:-$swift_command}"
  codesign_command="${TRIANGLE_CODESIGN_COMMAND:-$codesign_command}"
  worker_service="${TRIANGLE_WORKER_SERVICE_COMMAND:-$worker_service}"
  client_service="${TRIANGLE_CLIENT_SERVICE_COMMAND:-$client_service}"
  if [[ "${TRIANGLE_TEST_EXPECTED_UID:-}" =~ ^[0-9]+$ ]]; then expected_uid=$TRIANGLE_TEST_EXPECTED_UID; fi
fi

if [[ $local_ad_hoc -eq 0 ]]; then
  [[ -n "${TRIANGLE_DEVELOPER_ID:-}" ]] || {
    echo "TRIANGLE_DEVELOPER_ID is required for public installation" >&2
    exit 64
  }
  [[ "${TRIANGLE_DEVELOPER_TEAM_ID:-}" =~ ^[A-Z0-9]{10}$ ]] || {
    echo "TRIANGLE_DEVELOPER_TEAM_ID must be the ten-character Developer ID team" >&2
    exit 64
  }
else
  echo "WARNING: --local-ad-hoc is non-public and only for local testing or development." >&2
fi

validate_directory() {
  local directory=$1
  if [[ ! -e "$directory" && ! -L "$directory" ]]; then
    /bin/mkdir -m 700 "$directory"
  fi
  /usr/bin/python3 - "$directory" "$expected_uid" <<'PY'
import os, stat, sys
path, expected_uid = sys.argv[1], int(sys.argv[2])
info = os.lstat(path)
if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
    raise SystemExit("unsafe application directory type or symlink")
if info.st_uid != expected_uid:
    raise SystemExit("unsafe application directory ownership")
if stat.S_IMODE(info.st_mode) != 0o700:
    raise SystemExit("unsafe application directory mode; expected 0700")
if os.path.realpath(path) != path:
    raise SystemExit("application directory is not canonical")
PY
}

validate_existing_file() {
  local file=$1 expected_mode=$2
  [[ ! -e "$file" && ! -L "$file" ]] && return 0
  /usr/bin/python3 - "$file" "$expected_mode" "$expected_uid" <<'PY'
import os, stat, sys
path, expected, expected_uid = sys.argv[1], int(sys.argv[2], 8), int(sys.argv[3])
info = os.lstat(path)
if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
    raise SystemExit("unsafe installed file type or symlink")
if info.st_uid != expected_uid:
    raise SystemExit("unsafe installed file ownership")
if stat.S_IMODE(info.st_mode) != expected:
    raise SystemExit("unsafe installed file mode")
if os.path.realpath(path) != path:
    raise SystemExit("installed file is not canonical")
PY
}

validate_parent_directory() {
  /usr/bin/python3 - "$1" "$expected_uid" <<'PY'
import os, stat, sys
path, expected_uid = sys.argv[1], int(sys.argv[2])
info = os.lstat(path)
if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
    raise SystemExit("unsafe parent directory type or symlink")
if info.st_uid != expected_uid:
    raise SystemExit("unsafe parent directory ownership")
if os.path.realpath(path) != path:
    raise SystemExit("parent directory is not canonical")
PY
}

validate_parent_directory "$HOME"
library_dir="${HOME}/Library"
if [[ ! -e "$library_dir" && ! -L "$library_dir" ]]; then /bin/mkdir -m 700 "$library_dir"; fi
validate_parent_directory "$library_dir"
application_support_dir="${library_dir}/Application Support"
if [[ ! -e "$application_support_dir" && ! -L "$application_support_dir" ]]; then /bin/mkdir -m 700 "$application_support_dir"; fi
validate_parent_directory "$application_support_dir"
validate_directory "$application_root"
validate_directory "$bin_dir"
validate_directory "$manifest_dir"
validate_existing_file "$target" 0700
validate_existing_file "$hash_target" 0600
validate_existing_file "$metadata_target" 0600
validate_existing_file "$client_target" 0700
validate_existing_file "$client_hash_target" 0600
validate_existing_file "$client_metadata_target" 0600

temporary=$(/usr/bin/mktemp -d "${application_root}/.mailbox-helper-install.XXXXXX")
/bin/chmod 700 "$temporary"
build_root="${temporary}/build"
/bin/mkdir -m 700 "$build_root"
installed=0
committed=0
had_target=0
had_hash=0
had_metadata=0
target_replaced=0
hash_replaced=0
metadata_replaced=0
had_client_target=0
had_client_hash=0
had_client_metadata=0
client_target_replaced=0
client_hash_replaced=0
client_metadata_replaced=0

rollback() {
  local result=$?
  if [[ $committed -eq 0 ]]; then
    if [[ $target_replaced -eq 1 ]]; then
      /bin/rm -f "$target"
      [[ $had_target -eq 0 ]] || /bin/mv "$temporary/backup-helper" "$target"
    fi
    if [[ $hash_replaced -eq 1 ]]; then
      /bin/rm -f "$hash_target"
      [[ $had_hash -eq 0 ]] || /bin/mv "$temporary/backup-sha256" "$hash_target"
    fi
    if [[ $metadata_replaced -eq 1 ]]; then
      /bin/rm -f "$metadata_target"
      [[ $had_metadata -eq 0 ]] || /bin/mv "$temporary/backup-metadata" "$metadata_target"
    fi
    if [[ $client_target_replaced -eq 1 ]]; then
      /bin/rm -f "$client_target"
      [[ $had_client_target -eq 0 ]] || /bin/mv "$temporary/backup-client" "$client_target"
    fi
    if [[ $client_hash_replaced -eq 1 ]]; then
      /bin/rm -f "$client_hash_target"
      [[ $had_client_hash -eq 0 ]] || /bin/mv "$temporary/backup-client-sha256" "$client_hash_target"
    fi
    if [[ $client_metadata_replaced -eq 1 ]]; then
      /bin/rm -f "$client_metadata_target"
      [[ $had_client_metadata -eq 0 ]] || /bin/mv "$temporary/backup-client-metadata" "$client_metadata_target"
    fi
    /usr/bin/python3 - "$bin_dir" "$manifest_dir" <<'PY' || true
import os, sys
for directory in sys.argv[1:]:
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)
PY
  fi
  /bin/rm -rf "$temporary"
  exit "$result"
}
trap rollback EXIT
trap 'exit 130' HUP INT TERM

swift_build_args=(build -c release --package-path "$package_root" --scratch-path "$build_root")
if [[ $local_ad_hoc -eq 1 ]]; then
  swift_build_args+=(-Xswiftc -DTRIANGLE_LOCAL_AD_HOC)
fi
"$swift_command" "${swift_build_args[@]}"
source_binary=$(/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${build_root}/release/triangle-mailbox")
client_source_binary=$(/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${build_root}/release/triangle-client")
[[ "$source_binary" == "${build_root}/"* ]] || { echo "release build escaped installer scratch directory" >&2; exit 1; }
[[ "$client_source_binary" == "${build_root}/"* ]] || { echo "client release build escaped installer scratch directory" >&2; exit 1; }
/bin/chmod 700 "$source_binary"
/bin/chmod 700 "$client_source_binary"
validate_existing_file "$source_binary" 0700
validate_existing_file "$client_source_binary" 0700
staged="${temporary}/triangle-mailbox"
client_staged="${temporary}/triangle-client"
/bin/cp -p "$source_binary" "$staged"
/bin/cp -p "$client_source_binary" "$client_staged"
/bin/chmod 700 "$staged"
/bin/chmod 700 "$client_staged"

entitlements="${temporary}/entitlements.plist"
if [[ $local_ad_hoc -eq 1 ]]; then
  # Ad-hoc signatures cannot carry restricted entitlements such as
  # keychain-access-groups; AMFI rejects the binary if they are embedded.
  "$codesign_command" --force --sign - --identifier "$identifier" "$staged"
  "$codesign_command" --force --sign - --identifier "$identifier" "$client_staged"
else
  application_identifier="${TRIANGLE_DEVELOPER_TEAM_ID}.${identifier}"
  /bin/cat > "$entitlements" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>application-identifier</key><string>${application_identifier}</string>
<key>keychain-access-groups</key><array><string>${application_identifier}</string></array>
</dict></plist>
EOF
  /bin/chmod 600 "$entitlements"
  "$codesign_command" --force --sign "$TRIANGLE_DEVELOPER_ID" --identifier "$identifier" \
    --options runtime --timestamp --entitlements "$entitlements" "$staged"
  "$codesign_command" --force --sign "$TRIANGLE_DEVELOPER_ID" --identifier "$identifier" \
    --options runtime --timestamp --entitlements "$entitlements" "$client_staged"
fi

verify_signature() {
  local file=$1 display requirement entitlements_readback found_identifier found_team found_authority
  "$codesign_command" --verify --strict --verbose=2 "$file"
  display=$("$codesign_command" -d --verbose=4 "$file" 2>&1)
  found_identifier=$(printf '%s\n' "$display" | /usr/bin/sed -n 's/^Identifier=//p' | /usr/bin/head -n 1)
  [[ "$found_identifier" == "$identifier" ]] || { echo "installed signature identifier mismatch" >&2; return 1; }
  if [[ $local_ad_hoc -eq 0 ]]; then
    found_team=$(printf '%s\n' "$display" | /usr/bin/sed -n 's/^TeamIdentifier=//p' | /usr/bin/head -n 1)
    found_authority=$(printf '%s\n' "$display" | /usr/bin/sed -n 's/^Authority=//p' | /usr/bin/head -n 1)
    [[ "$found_team" == "$TRIANGLE_DEVELOPER_TEAM_ID" && "$found_authority" == Developer\ ID\ Application:* ]] || {
      echo "installed signature is not the configured Developer ID application" >&2
      return 1
    }
    requirement=$("$codesign_command" -d -r- "$file" 2>&1)
    printf '%s\n' "$requirement" | /usr/bin/grep -F "identifier \"${identifier}\"" >/dev/null
    printf '%s\n' "$requirement" | /usr/bin/grep -F "anchor apple generic" >/dev/null
    entitlements_readback="${temporary}/entitlements-readback.plist"
    "$codesign_command" -d --entitlements :- "$file" > "$entitlements_readback" 2>/dev/null
    /usr/bin/python3 - "$entitlements_readback" "${TRIANGLE_DEVELOPER_TEAM_ID}.${identifier}" <<'PY'
import plistlib, sys
with open(sys.argv[1], "rb") as stream:
    values = plistlib.load(stream)
expected = sys.argv[2]
if values.get("application-identifier") != expected:
    raise SystemExit("application identifier entitlement mismatch")
if values.get("keychain-access-groups") != [expected]:
    raise SystemExit("default Data Protection Keychain access-group entitlement mismatch")
PY
  fi
}

verify_signature "$staged"
verify_signature "$client_staged"
digest=$(/usr/bin/shasum -a 256 "$staged" | /usr/bin/awk '{print $1}')
client_digest=$(/usr/bin/shasum -a 256 "$client_staged" | /usr/bin/awk '{print $1}')
printf '%s\n' "$digest" > "${temporary}/triangle-mailbox.sha256"
printf '%s\n' "$client_digest" > "${temporary}/triangle-client.sha256"
/bin/chmod 600 "${temporary}/triangle-mailbox.sha256"
/bin/chmod 600 "${temporary}/triangle-client.sha256"
installed_at=$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')
signing_mode=developer_id
team_json="\"${TRIANGLE_DEVELOPER_TEAM_ID:-}\""
if [[ $local_ad_hoc -eq 1 ]]; then signing_mode=local_ad_hoc; team_json=null; fi
printf '{"version":1,"identifier":"%s","signingMode":"%s","teamId":%s,"sha256":"%s","installedAt":"%s","verifiedAt":"%s"}\n' \
  "$identifier" "$signing_mode" "$team_json" "$digest" "$installed_at" "$installed_at" > "${temporary}/triangle-mailbox-install.json"
printf '{"version":1,"identifier":"%s","signingMode":"%s","teamId":%s,"sha256":"%s","installedAt":"%s","verifiedAt":"%s"}\n' \
  "$identifier" "$signing_mode" "$team_json" "$client_digest" "$installed_at" "$installed_at" > "${temporary}/triangle-client-install.json"
/bin/chmod 600 "${temporary}/triangle-mailbox-install.json"
/bin/chmod 600 "${temporary}/triangle-client-install.json"
/usr/bin/python3 - "$staged" "$client_staged" "${temporary}/triangle-mailbox.sha256" "${temporary}/triangle-client.sha256" "${temporary}/triangle-mailbox-install.json" "${temporary}/triangle-client-install.json" <<'PY'
import os, sys
for path in sys.argv[1:]:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)
PY

if [[ -e "$target" ]]; then /bin/ln "$target" "$temporary/backup-helper"; had_target=1; fi
if [[ -e "$hash_target" ]]; then /bin/ln "$hash_target" "$temporary/backup-sha256"; had_hash=1; fi
if [[ -e "$metadata_target" ]]; then /bin/ln "$metadata_target" "$temporary/backup-metadata"; had_metadata=1; fi
if [[ -e "$client_target" ]]; then /bin/ln "$client_target" "$temporary/backup-client"; had_client_target=1; fi
if [[ -e "$client_hash_target" ]]; then /bin/ln "$client_hash_target" "$temporary/backup-client-sha256"; had_client_hash=1; fi
if [[ -e "$client_metadata_target" ]]; then /bin/ln "$client_metadata_target" "$temporary/backup-client-metadata"; had_client_metadata=1; fi
target_replaced=1
/bin/mv "$staged" "$target"
if [[ "${TRIANGLE_INSTALL_TEST_MODE:-}" == "1" && "${TRIANGLE_INSTALL_FAIL_PHASE:-}" == "after-helper" ]]; then exit 75; fi
client_target_replaced=1
/bin/mv "$client_staged" "$client_target"
if [[ "${TRIANGLE_INSTALL_TEST_MODE:-}" == "1" && "${TRIANGLE_INSTALL_FAIL_PHASE:-}" == "after-client" ]]; then exit 75; fi
hash_replaced=1
/bin/mv "${temporary}/triangle-mailbox.sha256" "$hash_target"
if [[ "${TRIANGLE_INSTALL_TEST_MODE:-}" == "1" && "${TRIANGLE_INSTALL_FAIL_PHASE:-}" == "after-hash" ]]; then exit 75; fi
client_hash_replaced=1
/bin/mv "${temporary}/triangle-client.sha256" "$client_hash_target"
if [[ "${TRIANGLE_INSTALL_TEST_MODE:-}" == "1" && "${TRIANGLE_INSTALL_FAIL_PHASE:-}" == "after-client-hash" ]]; then exit 75; fi
metadata_replaced=1
/bin/mv "${temporary}/triangle-mailbox-install.json" "$metadata_target"
if [[ "${TRIANGLE_INSTALL_TEST_MODE:-}" == "1" && "${TRIANGLE_INSTALL_FAIL_PHASE:-}" == "after-metadata" ]]; then exit 75; fi
client_metadata_replaced=1
/bin/mv "${temporary}/triangle-client-install.json" "$client_metadata_target"
if [[ "${TRIANGLE_INSTALL_TEST_MODE:-}" == "1" && "${TRIANGLE_INSTALL_FAIL_PHASE:-}" == "after-client-metadata" ]]; then exit 75; fi
/usr/bin/python3 - "$bin_dir" "$manifest_dir" <<'PY'
import os, sys
for directory in sys.argv[1:]:
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)
PY

verify_signature "$target"
verify_signature "$client_target"
installed_digest=$(/usr/bin/shasum -a 256 "$target" | /usr/bin/awk '{print $1}')
installed_client_digest=$(/usr/bin/shasum -a 256 "$client_target" | /usr/bin/awk '{print $1}')
[[ "$installed_digest" == "$digest" ]] || {
  echo "installed helper integrity verification failed" >&2
  exit 1
}
[[ "$installed_client_digest" == "$client_digest" ]] || {
  echo "installed Triangle Client integrity verification failed" >&2
  exit 1
}

committed=1
trap - EXIT HUP INT TERM
/bin/rm -rf "$temporary"

mesh_cli_source="${project_root}/skills/triangle-mesh-a2a/scripts/mesh_client.py"
if [[ -f "$mesh_cli_source" ]]; then
  /bin/cp -p "$mesh_cli_source" "$bin_dir/mesh"
  /bin/chmod 755 "$bin_dir/mesh"
  for mesh_link_dir in "$HOME/.local/bin" "$HOME/.hermes/bin"; do
    if [[ -d "$mesh_link_dir" ]]; then
      /bin/ln -sf "$bin_dir/mesh" "$mesh_link_dir/mesh" 2>/dev/null || true
    fi
  done
fi

if [[ -n "$worker" ]]; then
  TRIANGLE_MAILBOX_HELPER="$target" TRIANGLE_MAILBOX_PROFILE="$profile" \
    "$worker_service" install "$worker"
fi
if [[ $install_client -eq 1 ]]; then
  "$client_service" install
fi
echo "Installed verified Triangle mailbox helper at ${target} and Triangle Client at ${client_target}" >&2

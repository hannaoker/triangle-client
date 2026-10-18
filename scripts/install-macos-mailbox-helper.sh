#!/bin/bash

set -euo pipefail
IFS=$'\n\t'

# Signing modes (Developer ID signing and notarization are out of scope):
#   default         public ad-hoc release (signingMode public_ad_hoc). Ad-hoc
#                   `codesign -s -`, portable 0600 file credential custody is
#                   required (TRIANGLE_FILE_CUSTODY_REQUIRED build), and Keychain
#                   custody is refused because ad-hoc signatures cannot carry
#                   keychain-access-groups entitlements.
#   --local-ad-hoc  non-public local testing/development (signingMode
#                   local_ad_hoc). Watch grants may stay in the Keychain;
#                   TRIANGLE_CREDENTIAL_CUSTODY=file opts into file custody.
# Agent identities are never helper custody: permissions v1 profiles are 0600
# pointers (profiles-v1/<profile>.json) to `triangle` workload key files.
# Both modes refuse a quarantined install source (scripts/release/check-quarantine.sh).

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

if [[ -n "${TRIANGLE_DEVELOPER_ID:-}" || -n "${TRIANGLE_DEVELOPER_TEAM_ID:-}" ]]; then
  echo "Developer ID signing is out of scope for Triangle Client releases; public installs are ad-hoc signed." >&2
  echo "Unset TRIANGLE_DEVELOPER_ID and TRIANGLE_DEVELOPER_TEAM_ID and re-run." >&2
  exit 64
fi

requested_custody="${TRIANGLE_CREDENTIAL_CUSTODY:-}"
case "$requested_custody" in
  ""|file|keychain) ;;
  *)
    echo "TRIANGLE_CREDENTIAL_CUSTODY must be unset, file, or keychain" >&2
    exit 64
    ;;
esac
if [[ $local_ad_hoc -eq 0 ]]; then
  signing_mode=public_ad_hoc
  if [[ "$requested_custody" == keychain ]]; then
    echo "Keychain credential custody is unavailable for public ad-hoc installs: ad-hoc signatures cannot carry" >&2
    echo "the keychain-access-groups entitlement Keychain custody requires. Public installs use 0600 file custody" >&2
    echo "under ~/Library/Application Support/The Triangle/credentials/local. Unset TRIANGLE_CREDENTIAL_CUSTODY" >&2
    echo "(or set it to file); keep existing Keychain watch grants on a --local-ad-hoc install until switched." >&2
    exit 64
  fi
  credential_custody=file
else
  signing_mode=local_ad_hoc
  echo "WARNING: --local-ad-hoc is non-public and only for local testing or development." >&2
  credential_custody=keychain
  # Mirror CredentialCustodyPolicy: an explicit request wins; otherwise the
  # legacy TRIANGLE_FILE_CREDENTIALS=1 opt-in also selects file custody.
  if [[ "$requested_custody" == file || ( -z "$requested_custody" && "${TRIANGLE_FILE_CREDENTIALS:-}" == "1" ) ]]; then
    credential_custody=file
  fi
fi

quarantine_check="${project_root}/scripts/release/check-quarantine.sh"
quarantine_source="$project_root"
if [[ "${TRIANGLE_INSTALL_TEST_MODE:-}" == "1" && -n "${TRIANGLE_INSTALL_QUARANTINE_SOURCE:-}" ]]; then
  quarantine_source=$TRIANGLE_INSTALL_QUARANTINE_SOURCE
fi
/bin/bash "$quarantine_check" "$quarantine_source" >&2

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

credentials_dir="${application_root}/credentials"
file_custody_dir="${credentials_dir}/local"
file_custody_marker="${file_custody_dir}/ENABLED"
for custody_directory in "$credentials_dir" "$file_custody_dir"; do
  if [[ -e "$custody_directory" || -L "$custody_directory" ]]; then validate_directory "$custody_directory"; fi
done

validate_marker() {
  /usr/bin/python3 - "$file_custody_marker" "$expected_uid" <<'PY'
import os, stat, sys
path, expected_uid = sys.argv[1], int(sys.argv[2])
info = os.lstat(path)
if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_uid != expected_uid:
    raise SystemExit("unsafe file custody marker type, symlink, or ownership")
if stat.S_IMODE(info.st_mode) & 0o022:
    raise SystemExit("unsafe file custody marker mode; it must not be group- or world-writable")
PY
}
file_custody_enabled=0
if [[ -e "$file_custody_marker" || -L "$file_custody_marker" ]]; then
  validate_marker
  file_custody_enabled=1
fi
if [[ $local_ad_hoc -eq 1 && $file_custody_enabled -eq 1 ]]; then
  # Local ad-hoc builds select file custody whenever the marker exists.
  if [[ "$requested_custody" == keychain ]]; then
    echo "TRIANGLE_CREDENTIAL_CUSTODY=keychain conflicts with the file custody marker at ${file_custody_marker}." >&2
    echo "Watch grants may already live in file custody; remove the marker deliberately before returning to Keychain custody." >&2
    exit 64
  fi
  credential_custody=file
fi

# Selecting file custody (public mode, or --local-ad-hoc with a file opt-in)
# over an existing Keychain-custody install would strand its stored watch
# grants. Refuse unless acknowledged, and never restart services then.
if [[ "$credential_custody" == file && $file_custody_enabled -eq 0 && -e "$metadata_target" ]]; then
  prior_custody=$(/usr/bin/python3 - "$metadata_target" <<'PY'
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as stream:
        metadata = json.load(stream)
except (OSError, ValueError):
    print("unknown")
else:
    print(metadata.get("credentialCustody") or "keychain")
PY
)
  if [[ "$prior_custody" != file && "${TRIANGLE_ACK_CUSTODY_SWITCH:-}" != "1" ]]; then
    echo "The existing Triangle install uses ${prior_custody} credential custody. This ${signing_mode} install selects file custody," >&2
    echo "so watch grants stored in the Keychain would no longer be visible to the helper." >&2
    echo "Either keep this machine on --local-ad-hoc Keychain custody, or set TRIANGLE_ACK_CUSTODY_SWITCH=1 and re-run watch-ensure after installing." >&2
    exit 78
  fi
  # A switched helper has no file watch grants until watch-ensure runs, so no
  # Triangle service may start (or keep running) on it in this transaction.
  if [[ $install_client -eq 1 || -n "$worker" ]]; then
    echo "A custody switch cannot also install or restart a service: no watch grant is in file custody yet." >&2
    echo "Install the binaries alone, re-run watch-ensure, then run scripts/triangle-client-service.sh install." >&2
    exit 64
  fi
  launch_agents_dir="${HOME}/Library/LaunchAgents"
  if [[ -d "$launch_agents_dir" ]] && /usr/bin/find "$launch_agents_dir" -maxdepth 1 -name 'dev.thetriangle.*.plist' -print -quit | /usr/bin/grep -q .; then
    echo "A custody switch requires every Triangle LaunchAgent (dev.thetriangle.*) to be uninstalled first, so no" >&2
    echo "service restarts on a helper without file credentials. Run scripts/triangle-client-service.sh uninstall" >&2
    echo "(and any legacy worker uninstall), switch, re-run watch-ensure, then reinstall the service." >&2
    exit 78
  fi
fi

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
marker_created=0

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
    if [[ $marker_created -eq 1 ]]; then
      /bin/rm -f "$file_custody_marker"
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
else
  # Public ad-hoc release: file custody is the only credential backend.
  swift_build_args+=(-Xswiftc -DTRIANGLE_FILE_CUSTODY_REQUIRED)
fi
# Build only shipping executables. HostTests/TestSupport are separate products and
# can fail under newer SDKs without blocking helper install.
"$swift_command" "${swift_build_args[@]}" --product triangle-mailbox
"$swift_command" "${swift_build_args[@]}" --product triangle-client
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

# Ad-hoc signatures cannot carry restricted entitlements such as
# keychain-access-groups; AMFI rejects the binary if they are embedded. Sign
# after the last modification of each executable (Apple silicon requires a
# valid signature, and an ad-hoc one satisfies it for local execution).
"$codesign_command" --force --sign - --identifier "$identifier" "$staged"
"$codesign_command" --force --sign - --identifier "$identifier" "$client_staged"

verify_signature() {
  local file=$1 display found_identifier found_team entitlements_readback
  "$codesign_command" --verify --strict --verbose=2 "$file"
  display=$("$codesign_command" -d --verbose=4 "$file" 2>&1)
  found_identifier=$(/usr/bin/sed -n 's/^Identifier=//p' <<<"$display" | /usr/bin/head -n 1)
  [[ "$found_identifier" == "$identifier" ]] || { echo "installed signature identifier mismatch" >&2; return 1; }
  /usr/bin/grep -qx 'Signature=adhoc' <<<"$display" || { echo "installed signature is not an ad-hoc signature" >&2; return 1; }
  if /usr/bin/grep -q '^Authority=' <<<"$display"; then
    echo "installed signature carries a certificate authority; releases must be ad-hoc signed" >&2
    return 1
  fi
  found_team=$(/usr/bin/sed -n 's/^TeamIdentifier=//p' <<<"$display" | /usr/bin/head -n 1)
  [[ -z "$found_team" || "$found_team" == "not set" ]] || { echo "ad-hoc signature unexpectedly has a team identifier" >&2; return 1; }
  entitlements_readback=$("$codesign_command" -d --entitlements - --xml "$file" 2>/dev/null || true)
  if /usr/bin/grep -Eq 'keychain-access-groups|application-identifier' <<<"$entitlements_readback"; then
    echo "ad-hoc signature must not embed Keychain access-group entitlements" >&2
    return 1
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
printf '{"version":1,"identifier":"%s","signingMode":"%s","teamId":null,"credentialCustody":"%s","sha256":"%s","installedAt":"%s","verifiedAt":"%s","cliSurface":["watch-ensure","watch-poll","watch-status","watch-revoke"]}\n' \
  "$identifier" "$signing_mode" "$credential_custody" "$digest" "$installed_at" "$installed_at" > "${temporary}/triangle-mailbox-install.json"
printf '{"version":1,"identifier":"%s","signingMode":"%s","teamId":null,"credentialCustody":"%s","sha256":"%s","installedAt":"%s","verifiedAt":"%s"}\n' \
  "$identifier" "$signing_mode" "$credential_custody" "$client_digest" "$installed_at" "$installed_at" > "${temporary}/triangle-client-install.json"
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
if [[ "$credential_custody" == file && $file_custody_enabled -eq 0 ]]; then
  # Enable portable file custody (0700 directories, 0600 marker) inside the
  # install transaction so the manifest never claims file custody without it.
  validate_directory "$credentials_dir"
  validate_directory "$file_custody_dir"
  marker_staged=$(/usr/bin/mktemp "${temporary}/ENABLED.XXXXXX")
  /bin/chmod 600 "$marker_staged"
  printf 'file-custody %s\n' "$signing_mode" > "$marker_staged"
  marker_created=1
  /bin/mv "$marker_staged" "$file_custody_marker"
  validate_marker
  if [[ "${TRIANGLE_INSTALL_TEST_MODE:-}" == "1" && "${TRIANGLE_INSTALL_FAIL_PHASE:-}" == "after-marker" ]]; then exit 75; fi
fi
fsync_directories=("$bin_dir" "$manifest_dir")
[[ $marker_created -eq 0 ]] || fsync_directories+=("$file_custody_dir")
/usr/bin/python3 - "${fsync_directories[@]}" <<'PY'
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

verify_watch_cli_surface() {
  local helper=$1
  local verb help_json
  for verb in watch-ensure watch-poll watch-status watch-revoke; do
    if ! help_json=$("$helper" "$verb" --help); then
      echo "installed helper is missing Phase 2 watch CLI surface (${verb} --help failed)" >&2
      return 1
    fi
    if ! /usr/bin/python3 - "$verb" "$help_json" <<'PY'
import json, sys
verb = sys.argv[1]
payload = json.loads(sys.argv[2])
if payload.get("command") != verb or payload.get("supported") is not True:
    raise SystemExit(f"{verb} help payload missing or unsupported")
if payload.get("phase") != "watch-grant-phase-2":
    raise SystemExit(f"{verb} help payload is not the Phase 2 watch surface")
PY
    then
      echo "installed helper is missing Phase 2 watch CLI surface (${verb} --help payload invalid)" >&2
      return 1
    fi
  done
}

verify_watch_cli_surface "$target"

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
echo "Phase 2 watch CLI surface verified: watch-ensure / watch-poll / watch-status / watch-revoke" >&2
echo "Signing mode ${signing_mode}: ad-hoc signature verified (no Developer ID, no notarization)." >&2
echo "Credential custody: ${credential_custody}" >&2
if [[ "$credential_custody" == file ]]; then
  echo "File custody stores credentials as 0600 files under ${file_custody_dir}; they are not encrypted at rest." >&2
fi

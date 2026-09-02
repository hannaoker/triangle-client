#!/bin/bash

set -euo pipefail
IFS=$'\n\t'

usage() {
  echo "Usage: $0 <render|prepare-runtime|install|start|stop|status|uninstall>" >&2
  exit 64
}

[[ $# -eq 1 ]] || usage
action=$1
case "$action" in render|prepare-runtime|install|start|stop|status|uninstall) ;; *) usage ;; esac

project_root=$(cd "${BASH_SOURCE[0]%/*}/.." && pwd -P)
installer="${project_root}/scripts/triangle-worker-install.py"
template_path="${project_root}/deploy/launchd/dev.thetriangle.client.plist.template"
label="dev.thetriangle.client"
domain="gui/${UID}"
launch_agents_dir="${HOME}/Library/LaunchAgents"
plist_path="${launch_agents_dir}/${label}.plist"
application_root="${HOME}/Library/Application Support/The Triangle"
helper_path="${application_root}/bin/triangle-mailbox"
helper_hash_file="${application_root}/install-manifest/triangle-mailbox.sha256"
logs_dir="${HOME}/Library/Logs/the-triangle"
client_state_dir="${application_root}/client"
ready_marker="${client_state_dir}/ready.json"
activation_marker="${client_state_dir}/activate.json"
launchctl_command=/bin/launchctl
if [[ "${TRIANGLE_TEST_MODE:-}" == "1" ]]; then launchctl_command="${TRIANGLE_LAUNCHCTL:-$launchctl_command}"; fi
if [[ "${TRIANGLE_TEST_MODE:-}" == "1" ]]; then export TRIANGLE_READY_MARKER_PATH="$ready_marker" TRIANGLE_ACTIVATION_MARKER_PATH="$activation_marker"; fi

ensure_tree() {
  /usr/bin/python3 "$installer" ensure-tree --home "$HOME" >/dev/null
}

validate_helper() {
  /usr/bin/python3 - "$application_root" "$helper_path" "$helper_hash_file" <<'PY'
import hashlib, os, stat, sys
root, helper, hash_file = map(os.path.abspath, sys.argv[1:])
if helper != os.path.join(root, "bin", "triangle-mailbox"):
    raise SystemExit("Triangle Client requires the fixed application-owned helper")
for directory in (root, os.path.join(root, "bin"), os.path.join(root, "install-manifest"), os.path.join(root, "worker-runtime"), os.path.join(root, "credentials"), os.path.join(root, "model-state")):
    info = os.lstat(directory)
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700 or os.path.realpath(directory) != directory:
        raise SystemExit("Triangle Client application directories are unsafe")
for path, mode in ((helper, 0o700), (hash_file, 0o600)):
    if os.path.realpath(path) != path:
        raise SystemExit("Triangle Client custody path is not canonical or contains a symlink")
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != mode:
        raise SystemExit("Triangle Client custody file has unsafe ownership or mode")
if not os.access(helper, os.X_OK):
    raise SystemExit("Triangle Client helper is not executable")
expected = open(hash_file, encoding="ascii").read().strip()
actual = hashlib.sha256(open(helper, "rb").read()).hexdigest()
if len(expected) != 64 or expected != actual:
    raise SystemExit("Triangle Client helper failed integrity verification")
PY
}

manifest_is_v4() {
  local agent=$1 manifest
  manifest="${application_root}/worker-runtime/${agent}.manifest.json"
  [[ -f "$manifest" ]] || return 1
  if ! /usr/bin/python3 "$installer" validate-runtime --manifest "$manifest" --agent "$agent" >/dev/null; then return 1; fi
  /usr/bin/python3 - "$manifest" <<'PY'
import json, sys
raise SystemExit(0 if json.load(open(sys.argv[1], encoding="utf-8")).get("version") == 4 else 1)
PY
}

runtime_cli() {
  local agent=$1 candidate=""
  if [[ "$agent" == codex ]]; then
    candidate=${CODEX_CLI:-}
  elif [[ "$agent" == hermes ]]; then
    candidate=${HERMES_CLI:-}
  elif [[ "$agent" == antigravity ]]; then
    candidate=${ANTIGRAVITY_CLI:-${AGY_CLI:-}}
    if [[ -z "$candidate" ]]; then candidate=$(command -v agy 2>/dev/null || true); fi
  fi
  if [[ -z "$candidate" ]]; then candidate=$(command -v "$agent" 2>/dev/null || true); fi
  [[ -n "$candidate" ]] || return 1
  printf '%s\n' "$candidate"
}

stage_one_runtime() {
  local agent=$1 cli node
  cli=$(runtime_cli "$agent") || return 1
  node=$(command -v node 2>/dev/null || true)
  [[ -n "$node" ]] || { echo "A trusted Node runtime is required to prepare Triangle Client" >&2; return 2; }
  /usr/bin/python3 "$installer" stage-runtime \
    --application-root "$application_root" --project-root "$project_root" \
    --agent "$agent" --node "$node" --cli "$cli"
}

prepare_runtime_records() {
  runtime_records=()
  local agent record eligible=0
  for agent in codex hermes antigravity; do
    if runtime_cli "$agent" >/dev/null; then
      record=$(stage_one_runtime "$agent") || return
      runtime_records+=("$record")
      eligible=$((eligible + 1))
    elif manifest_is_v4 "$agent"; then
      eligible=$((eligible + 1))
    fi
  done
  if [[ $eligible -eq 0 ]]; then
    echo "Triangle Client requires at least one trusted version 4 supervisor-capable runtime" >&2
    return 1
  fi
}

rollback_runtime_records() {
  local index record failed=0 backup=""
  for ((index=${#runtime_records[@]}-1; index>=0; index--)); do
    record=${runtime_records[$index]}
    if [[ -n "${transaction_dir:-}" ]]; then backup="${transaction_dir}/runtime-${index}.record"; fi
    if [[ -n "$record" && ! -f "$record" && -n "$backup" && -f "$backup" ]]; then
      restore_rollback_record "$backup" "$record" || failed=1
    fi
    if [[ -n "$record" && -f "$record" ]]; then
      /usr/bin/python3 "$installer" rollback-runtime "$record" >/dev/null 2>&1 || failed=1
    fi
  done
  runtime_records=()
  return "$failed"
}

prepare_runtime_transaction() {
  local result=0 record transaction_dir="" committed=0 index=0 rollback_failed=0
  rollback_prepare() {
    local failure=$1
    trap - EXIT HUP INT TERM
    if [[ $committed -eq 0 ]]; then
      rollback_runtime_records || rollback_failed=1
      cleanup_transaction_snapshots || rollback_failed=1
      if [[ $rollback_failed -ne 0 ]]; then
        echo "Triangle Client runtime preparation rollback failed" >&2
        failure=75
      fi
    fi
    exit "$failure"
  }
  trap 'result=$?; rollback_prepare "$result"' EXIT
  trap 'rollback_prepare 130' HUP INT TERM
  ensure_tree
  runtime_records=()
  prepare_runtime_records
  transaction_dir=$(/usr/bin/mktemp -d "${application_root}/.client-service-transaction.XXXXXX")
  /bin/chmod 700 "$transaction_dir"
  for ((index=0; index<${#runtime_records[@]}; index++)); do copy_rollback_record "${runtime_records[$index]}" "${transaction_dir}/runtime-${index}.record"; done
  if [[ "${TRIANGLE_TEST_MODE:-}" == "1" && "${TRIANGLE_TEST_INTERRUPT_PREPARE_AFTER_STAGE:-}" == "1" ]]; then kill -TERM "$$"; fi
  index=0
  for record in "${runtime_records[@]}"; do
    /usr/bin/python3 "$installer" commit-runtime "$record" >/dev/null
    index=$((index + 1))
    if [[ "${TRIANGLE_TEST_MODE:-}" == "1" && "${TRIANGLE_TEST_FAIL_PREPARE_COMMIT_AFTER:-}" == "$index" ]]; then exit 75; fi
  done
  committed=1
  trap - EXIT HUP INT TERM
  cleanup_transaction_snapshots
  runtime_records=()
}

validate_v4_available() {
  manifest_is_v4 codex || manifest_is_v4 hermes || manifest_is_v4 antigravity || {
    echo "Triangle Client requires at least one trusted version 4 supervisor-capable runtime" >&2
    return 1
  }
}

registry_state() {
  /usr/bin/python3 - "$client_state_dir" <<'PY'
import hashlib, json, os, re, stat, sys, unicodedata
root=os.path.abspath(sys.argv[1]); instances=os.path.join(root, "instances")
def strict_object(pairs):
    value={}
    for key, item in pairs:
        if key in value: raise ValueError("duplicate JSON key")
        value[key]=item
    return value
if not os.path.exists(instances): print("empty"); raise SystemExit(0)
any_enabled=False
for directory in (root, instances):
    info=os.lstat(directory)
    if os.path.realpath(directory) != directory or not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise SystemExit("unsafe Triangle Client registry")
for name in os.listdir(instances):
    if not re.fullmatch(r"[0-9a-f]{64}\.json", name): raise SystemExit("invalid Triangle Client registry entry")
    path=os.path.join(instances, name); info=os.lstat(path)
    if os.path.realpath(path) != path or not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise SystemExit("unsafe Triangle Client registry entry")
    try:
        with open(path, encoding="utf-8") as stream: value=json.load(stream, object_pairs_hook=strict_object)
    except (ValueError, json.JSONDecodeError): raise SystemExit("invalid or duplicate Triangle Client registry entry")
    if not isinstance(value, dict): raise SystemExit("invalid Triangle Client registry entry")
    legacy_keys = {"version","profile","instanceId","runtimeAdapter","enabled"}
    current_keys = legacy_keys | {"deliveryMode"}
    if set(value) not in {frozenset(legacy_keys), frozenset(current_keys)}: raise SystemExit("invalid Triangle Client registry entry")
    profile=value["profile"]
    if type(value["version"]) is not int or value["version"] != 1 or not isinstance(profile, str) or not profile or len(profile.encode()) > 64 or "/" in profile or "\\" in profile or any(unicodedata.category(c) == "Cc" for c in profile): raise SystemExit("invalid Triangle Client registry entry")
    expected=hashlib.sha256(b"triangle-client-instance-v1\0"+profile.encode()).hexdigest()
    if value["instanceId"] != expected or name != expected+".json" or value["runtimeAdapter"] not in {"codex","hermes","antigravity"} or type(value["enabled"]) is not bool or value.get("deliveryMode", "worker") not in {"worker","mcp-interactive"}: raise SystemExit("invalid Triangle Client registry entry")
    any_enabled = any_enabled or value["enabled"]
print("enabled" if any_enabled else "empty")
PY
}

prepare_readiness() {
  /usr/bin/python3 - "$client_state_dir" "$ready_marker" "$activation_marker" <<'PY'
import os, stat, sys
directory=os.path.abspath(sys.argv[1]); markers=map(os.path.abspath, sys.argv[2:])
if not os.path.exists(directory): os.mkdir(directory, 0o700)
info=os.lstat(directory)
if os.path.realpath(directory) != directory or not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
    raise SystemExit("unsafe Triangle Client readiness directory")
for marker in markers:
    if os.path.lexists(marker):
        minfo=os.lstat(marker)
        if os.path.realpath(marker) != marker or not stat.S_ISREG(minfo.st_mode) or stat.S_ISLNK(minfo.st_mode) or minfo.st_uid != os.getuid() or stat.S_IMODE(minfo.st_mode) != 0o600:
            raise SystemExit("unsafe Triangle Client lifecycle marker")
        os.unlink(marker)
fd=os.open(directory, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW); os.fsync(fd); os.close(fd)
PY
}

readiness_marker_valid() {
  /usr/bin/python3 - "$ready_marker" "$1" "$2" <<'PY'
import json, os, re, stat, sys, time, uuid
path=os.path.abspath(sys.argv[1]); pid=int(sys.argv[2]); started=int(sys.argv[3]); now=int(time.time()*1000)
try:
    info=os.lstat(path)
    if os.path.realpath(path) != path or not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1: raise ValueError()
    if info.st_size > 1024: raise ValueError()
    with open(path, encoding="utf-8") as stream: value=json.load(stream)
    if set(value) != {"version","generation","parentPid","configDigest","readyAtMilliseconds"}: raise ValueError()
    uuid.UUID(value["generation"])
    if value["version"] != 1 or value["parentPid"] != pid or not re.fullmatch(r"[0-9a-f]{64}", value["configDigest"]): raise ValueError()
    if not isinstance(value["readyAtMilliseconds"], int) or value["readyAtMilliseconds"] < started or value["readyAtMilliseconds"] > now + 2000: raise ValueError()
except Exception: raise SystemExit(1)
PY
}

wait_for_readiness() {
  local started_ms=$1 timeout_ms=${TRIANGLE_READY_TIMEOUT_MS:-10000} stability_ms=500 deadline stable_deadline now output pid stable_output stable_pid
  if [[ "${TRIANGLE_TEST_MODE:-}" == "1" ]]; then stability_ms=${TRIANGLE_READY_STABILITY_MS:-500}; fi
  [[ "$timeout_ms" =~ ^[0-9]+$ && $timeout_ms -ge 20 && $timeout_ms -le 60000 ]] || { echo "invalid readiness timeout" >&2; return 1; }
  [[ "$stability_ms" =~ ^[0-9]+$ && $stability_ms -ge 20 && $stability_ms -le 5000 ]] || { echo "invalid readiness stability interval" >&2; return 1; }
  deadline=$((started_ms + timeout_ms))
  while :; do
    output=$($launchctl_command print "${domain}/${label}" 2>/dev/null || true)
    pid=$(printf '%s\n' "$output" | /usr/bin/sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\)[[:space:]]*$/\1/p' | /usr/bin/head -n 1)
    if [[ "$output" == *"state = running"* && "$pid" =~ ^[1-9][0-9]*$ ]] && readiness_marker_valid "$pid" "$started_ms"
    then
      stable_deadline=$(( $(/usr/bin/python3 -c 'import time; print(int(time.time()*1000))') + stability_ms ))
      while :; do
        stable_output=$($launchctl_command print "${domain}/${label}" 2>/dev/null || true)
        stable_pid=$(printf '%s\n' "$stable_output" | /usr/bin/sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\)[[:space:]]*$/\1/p' | /usr/bin/head -n 1)
        if [[ "$stable_output" != *"state = running"* || "$stable_pid" != "$pid" ]] || ! readiness_marker_valid "$pid" "$started_ms"; then
          echo "Triangle Client coordinator failed readiness stability gate" >&2
          return 1
        fi
        now=$(/usr/bin/python3 -c 'import time; print(int(time.time()*1000))')
        [[ $now -lt $stable_deadline ]] || return 0
        /bin/sleep 0.02
      done
    fi
    now=$(/usr/bin/python3 -c 'import time; print(int(time.time()*1000))')
    [[ $now -lt $deadline ]] || { echo "Triangle Client coordinator readiness timed out" >&2; return 1; }
    /bin/sleep 0.02
  done
}

activate_supervisor() {
  /usr/bin/python3 - "$client_state_dir" "$ready_marker" "$activation_marker" <<'PY'
import json, os, stat, sys, time, uuid
directory, ready, target=map(os.path.abspath, sys.argv[1:])
info=os.lstat(directory)
if os.path.realpath(directory) != directory or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700: raise SystemExit("unsafe Triangle Client lifecycle directory")
with open(ready, encoding="utf-8") as stream: value=json.load(stream)
uuid.UUID(value["generation"])
if set(value) != {"version","generation","parentPid","configDigest","readyAtMilliseconds"} or not isinstance(value["parentPid"], int): raise SystemExit("invalid Triangle Client readiness marker")
document={"version":1,"generation":value["generation"],"parentPid":value["parentPid"],"configDigest":value["configDigest"],"activatedAtMilliseconds":int(time.time()*1000)}
temporary=os.path.join(directory, ".activate-"+uuid.uuid4().hex+".tmp")
fd=os.open(temporary, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
try:
    data=(json.dumps(document, sort_keys=True, separators=(",", ":"))+"\n").encode()
    offset=0
    while offset < len(data): offset += os.write(fd, data[offset:])
    os.fsync(fd); os.fchmod(fd, 0o600)
finally: os.close(fd)
os.replace(temporary, target)
fd=os.open(directory, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW); os.fsync(fd); os.close(fd)
PY
}

render_service() {
  validate_helper
  validate_v4_available
  /usr/bin/python3 - "$template_path" "$helper_path" "$logs_dir" <<'PY'
import sys
from xml.sax.saxutils import escape
template = open(sys.argv[1], encoding="utf-8").read()
template = template.replace("__HELPER__", escape(sys.argv[2], {'"': '&quot;', "'": '&apos;'}))
template = template.replace("__LOG_DIR__", escape(sys.argv[3], {'"': '&quot;', "'": '&apos;'}))
if "__" in template:
    raise SystemExit("Unresolved Triangle Client LaunchAgent placeholder")
sys.stdout.write(template)
PY
}

run_supervisor_preflight() {
  local environment=(/usr/bin/env -i "HOME=${HOME}" "PATH=/usr/bin:/bin" "LANG=C" "LC_ALL=C")
  if [[ "${TRIANGLE_TEST_MODE:-}" == "1" ]]; then
    environment+=("TRIANGLE_HELPER_LOG=${TRIANGLE_HELPER_LOG:-/dev/null}")
    environment+=("TRIANGLE_TEST_PREFLIGHT_RESULT=${TRIANGLE_TEST_PREFLIGHT_RESULT:-ok}")
  fi
  "${environment[@]}" "$helper_path" preflight-supervisor >/dev/null 2>&1
}

validate_legacy_plist() {
  local plist=$1 expected_label=$2
  /usr/bin/python3 - "$plist" "$expected_label" <<'PY'
import os, plistlib, stat, sys
path, label = os.path.abspath(sys.argv[1]), sys.argv[2]
if os.path.realpath(path) != path:
    raise SystemExit("legacy LaunchAgent plist is a symlink or noncanonical")
info = os.lstat(path)
if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
    raise SystemExit("legacy LaunchAgent plist has unsafe ownership or mode")
with open(path, "rb") as stream: value = plistlib.load(stream)
if value.get("Label") != label:
    raise SystemExit("legacy LaunchAgent label mismatch")
PY
}

validate_client_plist() {
  /usr/bin/python3 - "$plist_path" "$helper_path" "$logs_dir" <<'PY'
import os, plistlib, stat, sys
path, helper, logs = map(os.path.abspath, sys.argv[1:])
if os.path.realpath(path) != path:
    raise SystemExit("Triangle Client plist is a symlink or noncanonical")
info=os.lstat(path)
if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
    raise SystemExit("Triangle Client plist has unsafe ownership or mode")
with open(path, "rb") as stream: value=plistlib.load(stream)
expected={
    "Label": "dev.thetriangle.client",
    "ProgramArguments": [helper, "run-supervisor"],
    "RunAtLoad": True,
    "KeepAlive": True,
    "ThrottleInterval": 10,
    "StandardOutPath": os.path.join(logs, "client.log"),
    "StandardErrorPath": os.path.join(logs, "client.error.log"),
}
if value != expected:
    raise SystemExit("Triangle Client plist arguments or service contract mismatch")
PY
}

capture_loaded_legacy() {
  legacy_codex_loaded=0; legacy_hermes_loaded=0
  local agent legacy_label legacy_plist
  for agent in codex hermes; do
    legacy_label="dev.thetriangle.${agent}.worker"
    legacy_plist="${launch_agents_dir}/${legacy_label}.plist"
    if "$launchctl_command" print "${domain}/${legacy_label}" >/dev/null 2>&1; then
      validate_legacy_plist "$legacy_plist" "$legacy_label"
      if [[ "$agent" == codex ]]; then legacy_codex_loaded=1; else legacy_hermes_loaded=1; fi
    fi
  done
}

restore_legacy() {
  local agent legacy_label legacy_plist loaded failed=0
  for agent in codex hermes; do
    if [[ "$agent" == codex ]]; then loaded=$legacy_codex_loaded; else loaded=$legacy_hermes_loaded; fi
    [[ $loaded -eq 1 ]] || continue
    legacy_label="dev.thetriangle.${agent}.worker"
    legacy_plist="${launch_agents_dir}/${legacy_label}.plist"
    if ! "$launchctl_command" print "${domain}/${legacy_label}" >/dev/null 2>&1; then
      if ! "$launchctl_command" bootstrap "$domain" "$legacy_plist" >/dev/null 2>&1; then
        failed=1
        continue
      fi
    fi
    "$launchctl_command" print "${domain}/${legacy_label}" >/dev/null 2>&1 || failed=1
  done
  if [[ $failed -ne 0 ]]; then
    echo "Triangle Client rollback could not restore and verify every prior legacy service" >&2
    return 1
  fi
}

copy_rollback_record() {
  /usr/bin/python3 - "$1" "$2" <<'PY'
import os, stat, sys
source, destination = map(os.path.abspath, sys.argv[1:])
fd=os.open(source, os.O_RDONLY|os.O_NOFOLLOW)
info=os.fstat(fd)
if os.path.realpath(source) != source or not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
    os.close(fd)
    raise SystemExit("unsafe rollback record")
data=os.read(fd, 131073); os.close(fd)
if len(data) > 131072: raise SystemExit("rollback record is too large")
fd=os.open(destination, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
try:
    offset=0
    while offset < len(data): offset += os.write(fd, data[offset:])
    os.fsync(fd)
finally: os.close(fd)
PY
}

restore_rollback_record() {
  local backup=$1 target=$2
  [[ -f "$target" ]] && return 0
  /usr/bin/python3 - "$backup" "$target" <<'PY'
import os, stat, sys
backup, target = map(os.path.abspath, sys.argv[1:])
fd=os.open(backup, os.O_RDONLY|os.O_NOFOLLOW)
info=os.fstat(fd)
if os.path.realpath(backup) != backup or not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
    os.close(fd)
    raise SystemExit("unsafe transaction rollback snapshot")
parent=os.path.dirname(target)
pinfo=os.lstat(parent)
if os.path.realpath(parent) != parent or not stat.S_ISDIR(pinfo.st_mode) or stat.S_ISLNK(pinfo.st_mode) or pinfo.st_uid != os.getuid() or stat.S_IMODE(pinfo.st_mode) & 0o022:
    raise SystemExit("unsafe rollback record parent")
data=os.read(fd, 131073); os.close(fd)
if len(data) > 131072: raise SystemExit("transaction rollback snapshot is too large")
fd=os.open(target, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
try:
    offset=0
    while offset < len(data): offset += os.write(fd, data[offset:])
    os.fsync(fd)
finally: os.close(fd)
directory=os.open(parent, os.O_RDONLY|os.O_DIRECTORY); os.fsync(directory); os.close(directory)
PY
}

cleanup_transaction_snapshots() {
  [[ -n "${transaction_dir:-}" && -d "$transaction_dir" ]] || return 0
  /usr/bin/python3 - "$application_root" "$transaction_dir" <<'PY'
import os, shutil, stat, sys
root, transaction = map(os.path.abspath, sys.argv[1:])
info=os.lstat(transaction)
if os.path.dirname(transaction) != root or not os.path.basename(transaction).startswith(".client-service-transaction."):
    raise SystemExit("unsafe transaction snapshot path")
if os.path.realpath(transaction) != transaction or not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
    raise SystemExit("unsafe transaction snapshot directory")
shutil.rmtree(transaction)
fd=os.open(root, os.O_RDONLY|os.O_DIRECTORY); os.fsync(fd); os.close(fd)
PY
  transaction_dir=""
}

safe_remove_plist() {
  [[ -e "$plist_path" || -L "$plist_path" ]] || return 0
  /usr/bin/python3 - "$plist_path" <<'PY'
import os, stat, sys
path=os.path.abspath(sys.argv[1])
if os.path.realpath(path) != path: raise SystemExit("Triangle Client plist is a symlink or noncanonical")
info=os.lstat(path)
if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
    raise SystemExit("Triangle Client plist has unsafe ownership or mode")
os.unlink(path)
fd=os.open(os.path.dirname(path), os.O_RDONLY|os.O_DIRECTORY); os.fsync(fd); os.close(fd)
PY
}

install_service() {
  ensure_tree
  validate_helper
  runtime_records=(); legacy_codex_loaded=0; legacy_hermes_loaded=0
  local staged_plist="" plist_record="" transaction_dir="" committed=0 new_was_loaded=0 new_bootstrapped=0 index record rollback_failed
  rollback() {
    local result=$1
    trap - EXIT HUP INT TERM
    if [[ $committed -eq 0 ]]; then
      rollback_failed=0
      local client_absent=1
      if [[ $new_bootstrapped -eq 1 ]]; then
        "$launchctl_command" bootout "${domain}/${label}" >/dev/null 2>&1 || client_absent=0
        if "$launchctl_command" print "${domain}/${label}" >/dev/null 2>&1; then client_absent=0; fi
        if [[ $client_absent -eq 0 ]]; then rollback_failed=1; fi
      fi
      if [[ $client_absent -eq 1 ]]; then prepare_readiness || rollback_failed=1; fi
      if [[ -n "$plist_record" && ! -f "$plist_record" && -n "$transaction_dir" ]]; then
        restore_rollback_record "${transaction_dir}/plist.record" "$plist_record" || rollback_failed=1
      fi
      if [[ -n "$plist_record" && -f "$plist_record" ]]; then /usr/bin/python3 "$installer" rollback-plist "$plist_record" >/dev/null 2>&1 || rollback_failed=1; fi
      if [[ -n "$staged_plist" && -f "$staged_plist" ]]; then /bin/rm -f "$staged_plist"; fi
      rollback_runtime_records || rollback_failed=1
      if [[ $new_was_loaded -eq 1 && -f "$plist_path" ]]; then
        if ! "$launchctl_command" print "${domain}/${label}" >/dev/null 2>&1; then
          "$launchctl_command" bootstrap "$domain" "$plist_path" >/dev/null 2>&1 || rollback_failed=1
        fi
        "$launchctl_command" print "${domain}/${label}" >/dev/null 2>&1 || rollback_failed=1
      fi
      if [[ $client_absent -eq 1 ]]; then restore_legacy || rollback_failed=1; fi
      cleanup_transaction_snapshots || rollback_failed=1
      if [[ $rollback_failed -ne 0 ]]; then
        echo "Triangle Client rollback failed to restore the exact prior service state" >&2
        result=75
      fi
    fi
    exit "$result"
  }
  trap 'result=$?; rollback "$result"' EXIT
  trap 'rollback 130' HUP INT TERM

  prepare_runtime_records
  capture_loaded_legacy
  if "$launchctl_command" print "${domain}/${label}" >/dev/null 2>&1; then new_was_loaded=1; fi
  staged_plist=$(/usr/bin/mktemp "${launch_agents_dir}/.${label}.stage.XXXXXX")
  /bin/chmod 600 "$staged_plist"
  render_service > "$staged_plist"
  /usr/bin/plutil -lint "$staged_plist" >/dev/null
  /usr/bin/python3 - "$staged_plist" <<'PY'
import os, sys
fd=os.open(sys.argv[1], os.O_RDONLY|os.O_NOFOLLOW); os.fsync(fd); os.close(fd)
PY
  plist_record=$(/usr/bin/python3 "$installer" activate-plist --target "$plist_path" --staged "$staged_plist")
  staged_plist=""
  transaction_dir=$(/usr/bin/mktemp -d "${application_root}/.client-service-transaction.XXXXXX")
  /bin/chmod 700 "$transaction_dir"
  copy_rollback_record "$plist_record" "${transaction_dir}/plist.record"
  for ((index=0; index<${#runtime_records[@]}; index++)); do copy_rollback_record "${runtime_records[$index]}" "${transaction_dir}/runtime-${index}.record"; done
  if [[ $new_was_loaded -eq 1 ]]; then "$launchctl_command" bootout "${domain}/${label}" >/dev/null; fi
  prepare_readiness
  local registry
  registry=$(registry_state)
  if [[ "$registry" == "empty" ]]; then
    /usr/bin/python3 "$installer" commit-plist "$plist_record" >/dev/null
    for record in "${runtime_records[@]}"; do /usr/bin/python3 "$installer" commit-runtime "$record" >/dev/null; done
    committed=1
    trap - EXIT HUP INT TERM
    cleanup_transaction_snapshots
    plist_record=""; runtime_records=()
    return 0
  fi
  if ! run_supervisor_preflight; then
    echo "Triangle Client supervisor preflight failed" >&2
    exit 1
  fi
  local readiness_started_ms
  readiness_started_ms=$(/usr/bin/python3 -c 'import time; print(int(time.time()*1000))')
  "$launchctl_command" bootstrap "$domain" "$plist_path" >/dev/null
  new_bootstrapped=1
  wait_for_readiness "$readiness_started_ms"
  if [[ $legacy_codex_loaded -eq 1 ]]; then
    "$launchctl_command" bootout "${domain}/dev.thetriangle.codex.worker" >/dev/null
    if "$launchctl_command" print "${domain}/dev.thetriangle.codex.worker" >/dev/null 2>&1; then exit 1; fi
  fi
  if [[ $legacy_hermes_loaded -eq 1 ]]; then
    "$launchctl_command" bootout "${domain}/dev.thetriangle.hermes.worker" >/dev/null
    if "$launchctl_command" print "${domain}/dev.thetriangle.hermes.worker" >/dev/null 2>&1; then exit 1; fi
  fi
  activate_supervisor
  /usr/bin/python3 "$installer" commit-plist "$plist_record" >/dev/null
  if [[ "${TRIANGLE_TEST_MODE:-}" == "1" && "${TRIANGLE_TEST_FAIL_COMMIT_PHASE:-}" == "after-plist" ]]; then exit 75; fi
  for record in "${runtime_records[@]}"; do /usr/bin/python3 "$installer" commit-runtime "$record" >/dev/null; done
  if [[ "${TRIANGLE_TEST_MODE:-}" == "1" && "${TRIANGLE_TEST_FAIL_COMMIT_PHASE:-}" == "after-runtime" ]]; then exit 75; fi
  committed=1
  trap - EXIT HUP INT TERM
  cleanup_transaction_snapshots
  plist_record=""; runtime_records=()
}

case "$action" in
  render) render_service ;;
  prepare-runtime)
    prepare_runtime_transaction
    ;;
  install) install_service ;;
  start)
    if [[ ! -e "$plist_path" && ! -L "$plist_path" ]]; then install_service
    else
      validate_helper; validate_v4_available; validate_client_plist
      registry=$(registry_state)
      if [[ "$registry" == "empty" ]]; then
        "$launchctl_command" bootout "${domain}/${label}" >/dev/null 2>&1 || true
      else
        prepare_readiness
        readiness_started_ms=$(/usr/bin/python3 -c 'import time; print(int(time.time()*1000))')
        if "$launchctl_command" print "${domain}/${label}" >/dev/null 2>&1; then
          "$launchctl_command" kickstart -k "${domain}/${label}" >/dev/null
        else
          "$launchctl_command" bootstrap "$domain" "$plist_path" >/dev/null
        fi
        wait_for_readiness "$readiness_started_ms"
        activate_supervisor
      fi
    fi
    ;;
  stop)
    "$launchctl_command" bootout "${domain}/${label}" >/dev/null 2>&1 || true
    if "$launchctl_command" print "${domain}/${label}" >/dev/null 2>&1; then echo "Triangle Client did not stop" >&2; exit 1; fi
    prepare_readiness
    ;;
  status) "$launchctl_command" print "${domain}/${label}" ;;
  uninstall)
    "$launchctl_command" bootout "${domain}/${label}" >/dev/null 2>&1 || true
    if "$launchctl_command" print "${domain}/${label}" >/dev/null 2>&1; then echo "Triangle Client did not stop" >&2; exit 1; fi
    prepare_readiness
    safe_remove_plist
    ;;
esac

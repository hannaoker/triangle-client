#!/bin/bash

set -euo pipefail

usage() {
  echo "Usage: $0 <render|prepare-runtime|install|start|stop|status|uninstall> <hermes|codex|antigravity>" >&2
  exit 2
}

[[ $# -eq 2 ]] || usage
action=$1
agent=$2
[[ "$agent" == "hermes" || "$agent" == "codex" || "$agent" == "antigravity" ]] || usage

project_root=$(cd "$(dirname "$0")/.." && pwd)
installer="${project_root}/scripts/triangle-worker-install.py"
label="dev.thetriangle.${agent}.worker"
domain="gui/${UID}"
launch_agents_dir="${HOME}/Library/LaunchAgents"
logs_dir="${HOME}/Library/Logs/the-triangle"
plist_path="${launch_agents_dir}/${label}.plist"
template_path="${project_root}/deploy/launchd/dev.thetriangle.agent-worker.plist.template"
application_root="${HOME}/Library/Application Support/The Triangle"
helper_path="${TRIANGLE_MAILBOX_HELPER:-${application_root}/bin/triangle-mailbox}"
profile="${TRIANGLE_MAILBOX_PROFILE:-}"
helper_hash_file="${application_root}/install-manifest/triangle-mailbox.sha256"
worker_manifest="${application_root}/worker-runtime/${agent}.manifest.json"
launchctl_command=/bin/launchctl
if [[ "${TRIANGLE_TEST_MODE:-}" == "1" ]]; then launchctl_command="${TRIANGLE_LAUNCHCTL:-$launchctl_command}"; fi

# Explicit legacy-file rollback: stop this service, restore the previously
# reviewed release of this script/template, render its plist, and bootstrap it
# manually. This release never reads or silently falls back to *.env credentials.

validate_profile() {
  [[ "$profile" =~ ^[^/\\[:cntrl:]]{1,64}$ ]] || { echo "TRIANGLE_MAILBOX_PROFILE must be a valid profile name" >&2; return 1; }
}

ensure_tree() {
  /usr/bin/python3 "$installer" ensure-tree --home "$HOME" >/dev/null
}

runtime_inputs() {
  node_path=$(command -v node)
  node_path=$(/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$node_path")
  if [[ "$agent" == "codex" ]]; then
    cli_path="${CODEX_CLI:-}"
  elif [[ "$agent" == "hermes" ]]; then
    cli_path="${HERMES_CLI:-}"
  elif [[ "$agent" == "antigravity" ]]; then
    cli_path="${ANTIGRAVITY_CLI:-${AGY_CLI:-}}"
    if [[ -z "$cli_path" ]]; then cli_path=$(command -v agy 2>/dev/null || true); fi
  fi
  if [[ -z "$cli_path" ]]; then cli_path=$(command -v "$agent"); fi
  cli_path=$(/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$cli_path")
}

stage_runtime() {
  runtime_inputs
  local arguments=(stage-runtime --application-root "$application_root" --project-root "$project_root" --agent "$agent" --node "$node_path" --cli "$cli_path")
  /usr/bin/python3 "$installer" "${arguments[@]}"
}

validate_installed_custodian() {
  validate_profile
  /usr/bin/python3 - "$application_root" "$helper_path" "$helper_hash_file" <<'PY'
import hashlib, os, stat, sys
root, helper, hash_file = map(os.path.abspath, sys.argv[1:])
if helper != os.path.join(root, "bin", "triangle-mailbox"):
    raise SystemExit("TRIANGLE_MAILBOX_HELPER must name the fixed application-owned helper")
for directory in (root, os.path.join(root, "bin"), os.path.join(root, "install-manifest"), os.path.join(root, "worker-runtime"), os.path.join(root, "credentials")):
    info = os.lstat(directory)
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise SystemExit("Application-owned directories must be current-user, nonsymlink, and mode 0700")
def checked(path, mode, executable=False):
    if os.path.realpath(path) != path:
        raise SystemExit("Installed custody paths must be canonical and contain no symlinks")
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != mode:
        raise SystemExit("Installed custody files have unsafe ownership or permissions")
    if executable and not os.access(path, os.X_OK): raise SystemExit("Installed mailbox helper is not executable")
checked(helper, 0o700, True); checked(hash_file, 0o600)
expected = open(hash_file, encoding="ascii").read().strip()
if len(expected) != 64 or hashlib.sha256(open(helper, "rb").read()).hexdigest() != expected:
    raise SystemExit("Installed mailbox helper failed integrity verification")
PY
  /usr/bin/python3 "$installer" validate-runtime --manifest "$worker_manifest" --agent "$agent"
}

render_service() {
  validate_installed_custodian
  /usr/bin/python3 - "$template_path" "$agent" "$helper_path" "$profile" "$logs_dir" <<'PY'
import sys
from xml.sax.saxutils import escape
template = open(sys.argv[1], encoding="utf-8").read()
for name, value in zip(["AGENT", "HELPER", "PROFILE", "LOG_DIR"], sys.argv[2:]):
    template = template.replace(f"__{name}__", escape(value, {'"': '&quot;', "'": '&apos;'}))
if "__" in template: raise SystemExit("Unresolved LaunchAgent template placeholder")
sys.stdout.write(template)
PY
}

install_service() {
  validate_profile
  ensure_tree
  local runtime_record="" plist_record="" staged_plist="" committed=0 was_loaded=0
  rollback() {
    if [[ $committed -eq 0 ]]; then
      if [[ -n "$plist_record" && -f "$plist_record" ]]; then /usr/bin/python3 "$installer" rollback-plist "$plist_record" || true; fi
      if [[ -n "$runtime_record" && -f "$runtime_record" ]]; then /usr/bin/python3 "$installer" rollback-runtime "$runtime_record" || true; fi
      if [[ -n "$staged_plist" && -f "$staged_plist" ]]; then /bin/rm -f "$staged_plist"; fi
    fi
  }
  trap rollback EXIT
  runtime_record=$(stage_runtime)
  staged_plist=$(/usr/bin/mktemp "${launch_agents_dir}/.${label}.stage.XXXXXX")
  /bin/chmod 600 "$staged_plist"
  render_service > "$staged_plist"
  /usr/bin/plutil -lint "$staged_plist" >/dev/null
  /usr/bin/python3 - "$staged_plist" <<'PY'
import os,sys
fd=os.open(sys.argv[1],os.O_RDONLY|os.O_NOFOLLOW); os.fsync(fd); os.close(fd)
PY
  if "$launchctl_command" print "${domain}/${label}" >/dev/null 2>&1; then was_loaded=1; fi
  plist_record=$(/usr/bin/python3 "$installer" activate-plist --target "$plist_path" --staged "$staged_plist")
  staged_plist=""
  if [[ $was_loaded -eq 1 ]]; then "$launchctl_command" bootout "${domain}/${label}" >/dev/null 2>&1 || true; fi
  if ! "$launchctl_command" bootstrap "$domain" "$plist_path"; then
    "$launchctl_command" bootout "${domain}/${label}" >/dev/null 2>&1 || true
    /usr/bin/python3 "$installer" rollback-plist "$plist_record"; plist_record=""
    /usr/bin/python3 "$installer" rollback-runtime "$runtime_record"; runtime_record=""
    if [[ $was_loaded -eq 1 ]]; then "$launchctl_command" bootstrap "$domain" "$plist_path" || true; fi
    return 1
  fi
  /usr/bin/python3 "$installer" commit-plist "$plist_record"; plist_record=""
  /usr/bin/python3 "$installer" commit-runtime "$runtime_record"; runtime_record=""
  committed=1
  trap - EXIT
}

case "$action" in
  render) render_service ;;
  prepare-runtime)
    ensure_tree
    record=$(stage_runtime)
    /usr/bin/python3 "$installer" commit-runtime "$record"
    ;;
  install) install_service ;;
  start)
    if [[ ! -f "$plist_path" ]]; then install_service
    elif "$launchctl_command" print "${domain}/${label}" >/dev/null 2>&1; then "$launchctl_command" kickstart -k "${domain}/${label}"
    else "$launchctl_command" bootstrap "$domain" "$plist_path"
    fi
    ;;
  stop) "$launchctl_command" bootout "${domain}/${label}" 2>/dev/null || true ;;
  status) "$launchctl_command" print "${domain}/${label}" ;;
  uninstall) "$launchctl_command" bootout "${domain}/${label}" 2>/dev/null || true; /bin/rm -f "$plist_path" ;;
  *) usage ;;
esac

#!/bin/bash
set -euo pipefail

usage() { echo "Usage: $0 <render|install|start|stop|status|uninstall>" >&2; exit 2; }
[[ $# -eq 1 ]] || usage
action=$1

project_root=$(cd "$(dirname "$0")/.." && pwd -P)
installer="${project_root}/scripts/triangle-worker-install.py"
template="${project_root}/deploy/launchd/dev.thetriangle.codex-headless-drain.plist.template"
application_root="${HOME}/Library/Application Support/The Triangle"
manifest="${application_root}/worker-runtime/codex.manifest.json"
helper="${TRIANGLE_MAILBOX_HELPER:-${application_root}/bin/triangle-mailbox}"
profile="${TRIANGLE_MAILBOX_PROFILE:-}"
room="${TRIANGLE_HEADLESS_ROOM_ID:-}"
workdir="${TRIANGLE_HEADLESS_WORKING_DIRECTORY:-}"
codex_home="${TRIANGLE_CODEX_HOME:-${application_root}/codex-home/${profile}}"
state_root="${TRIANGLE_HEADLESS_STATE_ROOT:-${application_root}/model-state/headless-drain/${profile}}"
logs_dir="${HOME}/Library/Logs/the-triangle"
launch_agents="${HOME}/Library/LaunchAgents"
launchctl_command="${TRIANGLE_LAUNCHCTL:-/bin/launchctl}"

[[ "$profile" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || { echo "invalid TRIANGLE_MAILBOX_PROFILE" >&2; exit 64; }
[[ "$room" =~ ^room_[a-f0-9]{32}$ ]] || { echo "invalid TRIANGLE_HEADLESS_ROOM_ID" >&2; exit 64; }
for directory in "$workdir" "$codex_home"; do
  [[ "$directory" = /* ]] || { echo "headless paths must be absolute" >&2; exit 64; }
done
label="dev.thetriangle.codex-headless-drain.${profile}"
plist_path="${launch_agents}/${label}.plist"
domain="gui/${UID}"

runtime_values() {
  /usr/bin/python3 "$installer" validate-runtime --manifest "$manifest" --agent codex
  /usr/bin/python3 - "$manifest" <<'PY'
import json, os, sys
v=json.load(open(sys.argv[1], encoding="utf-8")); root=v["projectRoot"]
if v["version"] != 5: raise SystemExit("Codex runtime manifest v5 is required")
print(os.path.join(root,"bin/node")); print(os.path.join(root,"packages/agent-worker/src/codex-runtime/headless-drain-cli.mjs")); print(v["environment"]["CODEX_CLI"])
PY
}

render() {
  local node entrypoint codex_cli
  { IFS= read -r node; IFS= read -r entrypoint; IFS= read -r codex_cli; } < <(runtime_values)
  /usr/bin/python3 - "$template" "$label" "$node" "$entrypoint" "$profile" "$room" "$workdir" "$codex_home" "$codex_cli" "$helper" "$state_root" "$logs_dir" <<'PY'
import sys
from xml.sax.saxutils import escape
text=open(sys.argv[1],encoding="utf-8").read()
keys=["LABEL","NODE","ENTRYPOINT","PROFILE","ROOM","WORKDIR","CODEX_HOME","CODEX_CLI","HELPER","STATE_ROOT","LOG_DIR"]
for key,value in zip(keys,sys.argv[2:]): text=text.replace("__"+key+"__",escape(value,{'"':'&quot;',"'":'&apos;'}))
if "__" in text: raise SystemExit("unresolved template placeholder")
sys.stdout.write(text)
PY
}

install_service() {
  /bin/mkdir -p "$launch_agents" "$logs_dir" "$codex_home" "$state_root"
  /bin/chmod 700 "$codex_home" "$state_root"
  local staged
  staged=$(/usr/bin/mktemp "${launch_agents}/.${label}.stage.XXXXXX")
  trap '/bin/rm -f "$staged"' EXIT
  render > "$staged"
  /bin/chmod 600 "$staged"
  /usr/bin/plutil -lint "$staged" >/dev/null
  "$launchctl_command" bootout "${domain}/${label}" >/dev/null 2>&1 || true
  /bin/sleep 1
  /bin/mv "$staged" "$plist_path"
  trap - EXIT
  "$launchctl_command" bootstrap "$domain" "$plist_path"
}

case "$action" in
  render) render ;;
  install) install_service ;;
  start) if [[ -f "$plist_path" ]]; then "$launchctl_command" bootstrap "$domain" "$plist_path" 2>/dev/null || "$launchctl_command" kickstart -k "${domain}/${label}"; else install_service; fi ;;
  stop) "$launchctl_command" bootout "${domain}/${label}" >/dev/null 2>&1 || true ;;
  status) "$launchctl_command" print "${domain}/${label}" ;;
  uninstall) "$launchctl_command" bootout "${domain}/${label}" >/dev/null 2>&1 || true; /bin/rm -f "$plist_path" ;;
  *) usage ;;
esac

#!/bin/bash
# Transactional enablement of portable headless engagement on any Mac.
# plan|apply: validate → (apply) lock/stage → CLI set-runtime/set-delivery-mode →
# merge headless-runtime-binding.json → restart supervisor → wait ready generation →
# rollback staged config on activation failure.
#
# Defaults (narrow): enabled Codex profiles already on headless-app-server or
# event-driven. mcp-interactive requires --include-interactive <profile>.
# Grok migration is opt-in via --migrate-from-grok <profile> (webhook stays off).
#
# Prerequisites: PR #70+ client tip; MESH origin with watch + lease reclaim.
# Usage:
#   $0 plan [--include-interactive P]... [--migrate-from-grok P]...
#   $0 apply [--include-interactive P]... [--migrate-from-grok P]...
set -euo pipefail
IFS=$'\n\t'

usage() {
  echo "Usage: $0 <plan|apply> [--include-interactive <profile>]... [--migrate-from-grok <profile>]..." >&2
  exit 64
}

[[ $# -ge 1 ]] || usage
action=$1
shift
case "$action" in plan|apply) ;; *) usage ;; esac

INCLUDE_INTERACTIVE=()
MIGRATE_FROM_GROK=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --include-interactive)
      [[ $# -ge 2 ]] || usage
      INCLUDE_INTERACTIVE+=("$2")
      shift 2
      ;;
    --migrate-from-grok)
      [[ $# -ge 2 ]] || usage
      MIGRATE_FROM_GROK+=("$2")
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

if [[ "${TRIANGLE_TEST_MODE:-}" != "1" && "${TRIANGLE_UNAME_S:-$(uname -s)}" != Darwin ]]; then
  echo "enable-headless-engagement is macOS-only" >&2
  exit 64
fi

if [[ -n "${TRIANGLE_HEADLESS_ROOM_ID:-}" || -n "${TRIANGLE_ALLOWED_ROOM_ID:-}" ]]; then
  echo "refusing room pin: omit TRIANGLE_HEADLESS_ROOM_ID / TRIANGLE_ALLOWED_ROOM_ID" >&2
  exit 64
fi

application_root="${HOME}/Library/Application Support/The Triangle"
client_root="${application_root}/client"
launch_agents="${HOME}/Library/LaunchAgents"
helper="${TRIANGLE_MAILBOX_HELPER:-${application_root}/bin/triangle-mailbox}"
client_bin="${TRIANGLE_CLIENT:-${application_root}/bin/triangle-client}"
launchctl_command="${TRIANGLE_LAUNCHCTL:-/bin/launchctl}"
uid="${TRIANGLE_FAKE_UID:-${UID}}"
domain="gui/${uid}"
poll_ms="${TRIANGLE_HEADLESS_POLL_INTERVAL_MS:-30000}"
binding_path="${client_root}/headless-runtime-binding.json"
installation_path="${client_root}/installation.json"
ready_marker="${client_root}/ready.json"
client_label="dev.thetriangle.client"
client_plist="${launch_agents}/${client_label}.plist"
config_lock_dir="${client_root}/.enable-headless-engagement.lock"
stage_dir="${client_root}/.enable-headless-engagement.stage"

[[ "$poll_ms" =~ ^[0-9]+$ && "$poll_ms" -ge 100 && "$poll_ms" -le 60000 ]] || {
  echo "TRIANGLE_HEADLESS_POLL_INTERVAL_MS is invalid" >&2
  exit 64
}

label_loaded() {
  "$launchctl_command" print "${domain}/$1" >/dev/null 2>&1
}

bootout_label() {
  "$launchctl_command" bootout "${domain}/$1" >/dev/null 2>&1 || true
  for _ in {1..100}; do
    label_loaded "$1" || break
    /bin/sleep 0.05
  done
}

acquire_config_lock() {
  # Portable exclusive lock (stock macOS has no /usr/bin/flock).
  /bin/mkdir -p "$client_root"
  /bin/chmod 700 "$client_root"
  if /bin/mkdir "$config_lock_dir" 2>/dev/null; then
    printf '%s\n' "$$" >"${config_lock_dir}/pid"
    return 0
  fi
  local holder_pid=""
  holder_pid=$(/bin/cat "${config_lock_dir}/pid" 2>/dev/null || true)
  if [[ "$holder_pid" =~ ^[0-9]+$ ]] && ! /bin/kill -0 "$holder_pid" 2>/dev/null; then
    /bin/rm -rf "$config_lock_dir"
    if /bin/mkdir "$config_lock_dir" 2>/dev/null; then
      printf '%s\n' "$$" >"${config_lock_dir}/pid"
      return 0
    fi
  fi
  echo "another enable-headless-engagement apply holds the configuration lock" >&2
  exit 75
}

release_config_lock() {
  /bin/rm -rf "$config_lock_dir"
}

python_plan() {
  TRIANGLE_CLIENT_BIN="$client_bin" \
  TRIANGLE_INSTALLATION_PATH="$installation_path" \
  TRIANGLE_BINDING_PATH="$binding_path" \
  TRIANGLE_APPLICATION_ROOT="$application_root" \
  TRIANGLE_HELPER="$helper" \
  TRIANGLE_POLL_MS="$poll_ms" \
  TRIANGLE_CODEX_HOME="${TRIANGLE_CODEX_HOME:-}" \
  TRIANGLE_HEADLESS_WORKING_DIRECTORY="${TRIANGLE_HEADLESS_WORKING_DIRECTORY:-}" \
  TRIANGLE_INCLUDE_INTERACTIVE="$(printf '%s\n' "${INCLUDE_INTERACTIVE[@]:-}")" \
  TRIANGLE_MIGRATE_FROM_GROK="$(printf '%s\n' "${MIGRATE_FROM_GROK[@]:-}")" \
  CODEX_CLI="${CODEX_CLI:-}" \
  /usr/bin/python3 - <<'PY'
import hashlib, json, os, sys

def die(code, message):
    print(message, file=sys.stderr)
    raise SystemExit(code)

def derive_instance_id(profile):
    framed = b"triangle-client-instance-v1\0" + profile.encode()
    return hashlib.sha256(framed).hexdigest()

def load_agents(client_bin):
    import subprocess
    result = subprocess.run([client_bin, "agent", "list"], capture_output=True, text=True)
    if result.returncode != 0:
        die(66, f"triangle-client agent list failed: {(result.stderr or result.stdout).strip()}")
    try:
        document = json.loads(result.stdout)
    except json.JSONDecodeError:
        die(66, "triangle-client agent list did not return JSON")
    agents = document.get("agents") if isinstance(document, dict) else None
    if not isinstance(agents, list):
        die(66, "triangle-client agent list is missing agents")
    return agents

def strict_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            die(64, f"existing binding has duplicate key: {key}")
        value[key] = item
    return value

def parse_binding_json(path):
    if not path or not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            doc = json.load(handle, object_pairs_hook=strict_object)
        if isinstance(doc, dict):
            return doc
    except (OSError, ValueError, json.JSONDecodeError) as error:
        die(64, f"existing binding is invalid: {error}")
    die(64, "existing binding must be an object")

def require_abs(value, name):
    if not isinstance(value, str) or not value.startswith("/") or "\0" in value:
        die(64, f"{name} must be an absolute path")
    return value

def lines(env_name):
    raw = os.environ.get(env_name, "")
    return [line for line in raw.splitlines() if line]

include_interactive = set(lines("TRIANGLE_INCLUDE_INTERACTIVE"))
migrate_from_grok = set(lines("TRIANGLE_MIGRATE_FROM_GROK"))
for profile in include_interactive | migrate_from_grok:
    if not profile or "/" in profile or "\0" in profile or len(profile) > 64:
        die(64, f"invalid profile name: {profile!r}")

agents = load_agents(os.environ["TRIANGLE_CLIENT_BIN"])
by_profile = {}
for agent in agents:
    if not isinstance(agent, dict) or "profile" not in agent:
        die(66, "agent list entry is missing profile")
    by_profile[agent["profile"]] = agent

installation_path = os.environ["TRIANGLE_INSTALLATION_PATH"]
try:
    installation = json.load(open(installation_path, encoding="utf-8"))
except OSError:
    die(66, "client/installation.json is missing")
installation_id = installation.get("installationId") if isinstance(installation, dict) else None
if not isinstance(installation_id, str) or not installation_id.startswith("inst_"):
    die(66, "client/installation.json is missing installationId")

existing_binding = parse_binding_json(os.environ["TRIANGLE_BINDING_PATH"])
existing_common = {}
existing_profile_roots = {}
unrelated_profiles = []
if existing_binding:
    if existing_binding.get("version") == 2:
        if set(existing_binding) != {"version", "common", "profiles"}:
            die(64, "existing v2 binding schema mismatch")
        existing_common = existing_binding.get("common")
        existing_profiles = existing_binding.get("profiles")
        if not isinstance(existing_common, dict) or not isinstance(existing_profiles, list):
            die(64, "existing v2 binding schema mismatch")
        for entry in existing_profiles:
            if not isinstance(entry, dict) or set(entry) != {"profile", "instanceId", "stateRoot"}:
                die(64, "existing v2 binding profile schema mismatch")
            existing_profile_roots[entry["profile"]] = entry["stateRoot"]
            unrelated_profiles.append(entry)
    else:
        die(64, "legacy v1 binding must be migrated via cutover-headless-supervisor.sh first")

application_root = os.environ["TRIANGLE_APPLICATION_ROOT"]
working_directory = (
    os.environ.get("TRIANGLE_HEADLESS_WORKING_DIRECTORY")
    or existing_common.get("workingDirectory")
    or os.path.join(application_root, "headless-work")
)
codex_home = os.environ.get("TRIANGLE_CODEX_HOME") or existing_common.get("codexHome")
command = os.environ.get("CODEX_CLI") or existing_common.get("command")
if not codex_home:
    die(66, "CODEX_HOME is unknown; set TRIANGLE_CODEX_HOME")
if not command:
    die(66, "CODEX_CLI is unknown; set CODEX_CLI")
for name, value in (
    ("workingDirectory", working_directory),
    ("codexHome", codex_home),
    ("command", command),
    ("helperPath", os.environ["TRIANGLE_HELPER"]),
):
    require_abs(value, name)

DEFAULT_MODES = {"headless-app-server", "event-driven"}
selected = []
runtime_flips = []
mode_flips = []
warnings = []

for profile in sorted(migrate_from_grok):
    agent = by_profile.get(profile)
    if agent is None:
        die(66, f"migrate-from-grok profile missing from agent list: {profile}")
    if agent.get("enabled") is not True:
        die(64, f"migrate-from-grok profile is disabled: {profile}")
    if agent.get("runtimeAdapter") != "grok-bot":
        die(64, f"migrate-from-grok requires grok-bot runtime: {profile}")
    expected = derive_instance_id(profile)
    if agent.get("instanceId") != expected:
        die(64, f"instanceId mismatch for {profile}")
    runtime_flips.append({"profile": profile, "from": "grok-bot", "to": "codex"})
    mode_flips.append({"profile": profile, "from": agent.get("deliveryMode"), "to": "headless-app-server"})
    selected.append((profile, expected, "migrate-grok"))

for agent in agents:
    profile = agent["profile"]
    if profile in migrate_from_grok:
        continue
    adapter = agent.get("runtimeAdapter")
    mode = agent.get("deliveryMode")
    if adapter != "codex" or agent.get("enabled") is not True:
        continue
    expected = derive_instance_id(profile)
    if agent.get("instanceId") != expected:
        die(64, f"instanceId mismatch for {profile}")
    if mode in DEFAULT_MODES:
        selected.append((profile, expected, "default-unattended"))
        if mode != "headless-app-server":
            mode_flips.append({"profile": profile, "from": mode, "to": "headless-app-server"})
        continue
    if mode == "mcp-interactive":
        if profile in include_interactive:
            selected.append((profile, expected, "include-interactive"))
            mode_flips.append({"profile": profile, "from": mode, "to": "headless-app-server"})
        else:
            warnings.append({
                "profile": profile,
                "code": "mcp_interactive_skipped",
                "message": "mcp-interactive requires --include-interactive",
            })
        continue

# Explicit includes that are already headless still validate.
for profile in sorted(include_interactive):
    if any(item[0] == profile for item in selected):
        continue
    agent = by_profile.get(profile)
    if agent is None:
        die(66, f"include-interactive profile missing: {profile}")
    if agent.get("runtimeAdapter") != "codex" or agent.get("enabled") is not True:
        die(64, f"include-interactive requires enabled codex profile: {profile}")
    expected = derive_instance_id(profile)
    if agent.get("instanceId") != expected:
        die(64, f"instanceId mismatch for {profile}")
    selected.append((profile, expected, "include-interactive"))
    if agent.get("deliveryMode") != "headless-app-server":
        mode_flips.append({
            "profile": profile,
            "from": agent.get("deliveryMode"),
            "to": "headless-app-server",
        })

if not selected:
    die(64, "no profiles selected for headless engagement enablement")

# Dedicated drain conflict: refuse if LaunchAgent plist still present for a selected profile.
launch_agents = os.path.join(os.path.expanduser("~"), "Library", "LaunchAgents")
dedicated_conflicts = []
for profile, _, _ in selected:
    label = f"dev.thetriangle.codex-headless-drain.{profile}"
    plist = os.path.join(launch_agents, f"{label}.plist")
    if os.path.isfile(plist):
        dedicated_conflicts.append({"profile": profile, "label": label, "plist": plist})
if dedicated_conflicts:
    die(
        64,
        "dedicated headless drain still installed; run cutover-headless-supervisor.sh first: "
        + ",".join(item["profile"] for item in dedicated_conflicts),
    )

selected_profiles = {profile for profile, _, _ in selected}
profiles = []
seen_roots = set()
for profile, instance_id, _reason in sorted(selected):
    state_root = existing_profile_roots.get(profile) or os.path.join(
        application_root, "model-state", "headless-drain", profile
    )
    require_abs(state_root, f"stateRoot[{profile}]")
    normalized = os.path.normpath(state_root)
    if normalized != state_root or state_root in seen_roots:
        die(64, "headless profile state roots must be canonical and distinct")
    seen_roots.add(state_root)
    profiles.append({"profile": profile, "instanceId": instance_id, "stateRoot": state_root})

# Preserve unrelated binding profiles not selected for this enablement.
for entry in unrelated_profiles:
    if entry["profile"] in selected_profiles:
        continue
    profiles.append(entry)

profiles.sort(key=lambda item: item["profile"])
binding = {
    "version": 2,
    "common": {
        "adapterVersion": "1",
        "installationId": installation_id,
        "workingDirectory": working_directory,
        "codexHome": codex_home,
        "command": command,
        "pollIntervalMs": int(os.environ["TRIANGLE_POLL_MS"]),
    },
    "profiles": profiles,
}
blob = json.dumps(binding, separators=(",", ":"))
if "room_" in blob or "allowedRoomId" in blob:
    die(64, "refusing to write a room-pinned supervisor binding")

plan = {
    "action": "enable-headless-engagement",
    "selectedProfiles": [profile for profile, _, _ in sorted(selected)],
    "selectionReasons": {
        profile: reason for profile, _, reason in selected
    },
    "runtimeFlips": runtime_flips,
    "modeFlips": mode_flips,
    "warnings": warnings,
    "webhookBinding": "left_disabled",
    "bindingPath": os.environ["TRIANGLE_BINDING_PATH"],
    "binding": binding,
    "preserveUnrelatedProfiles": sorted(
        entry["profile"] for entry in unrelated_profiles if entry["profile"] not in selected_profiles
    ),
}
json.dump(plan, sys.stdout, indent=2, sort_keys=True)
sys.stdout.write("\n")
PY
}

plan_json=$(python_plan)
printf '%s\n' "$plan_json"

if [[ "$action" == plan ]]; then
  exit 0
fi

acquire_config_lock

prior_generation=""
if [[ -f "$ready_marker" ]]; then
  prior_generation=$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("generation",""))' "$ready_marker" 2>/dev/null || true)
fi

binding_backup=$(/usr/bin/mktemp "${client_root}/.headless-runtime-binding.XXXXXX")
binding_existed=0
if [[ -f "$binding_path" ]]; then
  /bin/cp -p "$binding_path" "$binding_backup"
  binding_existed=1
fi

/bin/rm -rf "$stage_dir"
/bin/mkdir -p "$stage_dir"
/bin/chmod 700 "$stage_dir"

rollback() {
  status=$?
  trap - EXIT HUP INT TERM
  if [[ $status -ne 0 ]]; then
    if [[ $binding_existed -eq 1 ]]; then
      /bin/cp -p "$binding_backup" "$binding_path" 2>/dev/null || true
    else
      /bin/rm -f "$binding_path"
    fi
    echo "enable-headless-engagement rolled back staged config (exit=$status)" >&2
  fi
  /bin/rm -f "$binding_backup"
  /bin/rm -rf "$stage_dir"
  release_config_lock
  exit "$status"
}
trap rollback EXIT
trap 'exit 130' HUP INT TERM

# Quiesce supervisor claimers before mutating delivery modes / binding.
if label_loaded "$client_label"; then
  bootout_label "$client_label"
fi

runtime_flips=$(/usr/bin/python3 -c 'import json,sys; d=json.load(sys.stdin); print("\n".join("%s\t%s" % (i["profile"], i["to"]) for i in d["runtimeFlips"]))' <<<"$plan_json")
mode_flips=$(/usr/bin/python3 -c 'import json,sys; d=json.load(sys.stdin); print("\n".join("%s\t%s" % (i["profile"], i["to"]) for i in d["modeFlips"]))' <<<"$plan_json")

if [[ -n "$runtime_flips" ]]; then
  while IFS=$'\t' read -r profile runtime; do
    [[ -n "$profile" ]] || continue
    "$client_bin" agent set-runtime --profile "$profile" --runtime "$runtime"
  done <<<"$runtime_flips"
fi

if [[ -n "$mode_flips" ]]; then
  while IFS=$'\t' read -r profile mode; do
    [[ -n "$profile" ]] || continue
    "$client_bin" agent set-delivery-mode --profile "$profile" --mode "$mode"
  done <<<"$mode_flips"
fi

umask 077
staged_binding="${stage_dir}/headless-runtime-binding.json"
TRIANGLE_PLAN="$plan_json" TRIANGLE_STAGED_BINDING="$staged_binding" /usr/bin/python3 - <<'PY'
import json, os
plan = json.loads(os.environ["TRIANGLE_PLAN"])
path = os.environ["TRIANGLE_STAGED_BINDING"]
blob = json.dumps(plan["binding"], separators=(",", ":"), sort_keys=True)
if "allowedRoomId" in blob or "room_77" in blob:
    raise SystemExit("refusing room-pinned binding")
with open(path, "w", encoding="utf-8") as handle:
    handle.write(blob + "\n")
os.chmod(path, 0o600)
PY
/bin/cp -p "$staged_binding" "$binding_path"
/bin/chmod 600 "$binding_path"

if [[ ! -f "$client_plist" ]]; then
  echo "dev.thetriangle.client plist is missing; install the client before apply" >&2
  exit 66
fi
"$launchctl_command" bootstrap "$domain" "$client_plist"

# Wait for a new ready generation (or accept first ready when none existed).
deadline=$((SECONDS + 30))
matched=0
while (( SECONDS < deadline )); do
  if [[ -f "$ready_marker" ]]; then
    generation=$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("generation",""))' "$ready_marker" 2>/dev/null || true)
    if [[ -n "$generation" && "$generation" != "$prior_generation" ]]; then
      matched=1
      break
    fi
    if [[ -z "$prior_generation" && -n "$generation" ]]; then
      matched=1
      break
    fi
  fi
  /bin/sleep 0.1
done

if [[ "$matched" -ne 1 ]]; then
  echo "supervisor ready generation did not advance after enable apply" >&2
  exit 69
fi

trap - EXIT HUP INT TERM
/bin/rm -f "$binding_backup"
/bin/rm -rf "$stage_dir"
release_config_lock

echo "enable-headless-engagement applied"
echo "  profiles=$(/usr/bin/python3 -c 'import json,sys; print(",".join(json.loads(sys.stdin.read())["selectedProfiles"]))' <<<"$plan_json")"
echo "  binding=$binding_path"
echo "  readyGeneration=$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("generation",""))' "$ready_marker")"
echo "  grok webhook binding left disabled"

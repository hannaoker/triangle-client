#!/bin/bash
# Fail-closed Mini/operator cutover: fold dedicated Codex drain into
# `dev.thetriangle.client` headlessWake. Conversations key by delivery roomId.
# Does not pin room_77 or the Mini canary room. Does not touch grok-bot.
#
# Prerequisites: PR #40 helper + Node already installed (same signing mode).
# Usage: $0 <plan|apply>
set -euo pipefail
IFS=$'\n\t'

usage() {
  echo "Usage: $0 <plan|apply>" >&2
  echo "  plan   snapshot + guards; write nothing" >&2
  echo "  apply  stop desktop Codex claimer, set headless-app-server, write" >&2
  echo "         headless-runtime-binding.json with no room pin, bootout the" >&2
  echo "         dedicated drain, restart dev.thetriangle.client" >&2
  exit 64
}

[[ $# -eq 1 ]] || usage
action=$1
case "$action" in plan|apply) ;; *) usage ;; esac

if [[ "${TRIANGLE_TEST_MODE:-}" != "1" && "${TRIANGLE_UNAME_S:-$(uname -s)}" != Darwin ]]; then
  echo "headless supervisor cutover is macOS-only" >&2
  exit 64
fi

if [[ -n "${TRIANGLE_HEADLESS_ROOM_ID:-}" || -n "${TRIANGLE_ALLOWED_ROOM_ID:-}" ]]; then
  echo "refusing room pin: omit TRIANGLE_HEADLESS_ROOM_ID / TRIANGLE_ALLOWED_ROOM_ID; supervisor keys conversations by each delivery roomId" >&2
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
headless_profile="${TRIANGLE_HEADLESS_PROFILE:-codex-headless}"
poll_ms="${TRIANGLE_HEADLESS_POLL_INTERVAL_MS:-1000}"
binding_path="${client_root}/headless-runtime-binding.json"
installation_path="${client_root}/installation.json"
client_label="dev.thetriangle.client"
shared_label="dev.thetriangle.shared-app-server"
drain_label="dev.thetriangle.codex-headless-drain.${headless_profile}"
drain_plist="${launch_agents}/${drain_label}.plist"
client_plist="${launch_agents}/${client_label}.plist"

[[ "$headless_profile" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || {
  echo "TRIANGLE_HEADLESS_PROFILE is invalid" >&2
  exit 64
}
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

python_plan() {
  TRIANGLE_HEADLESS_PROFILE="$headless_profile" \
  TRIANGLE_CLIENT_BIN="$client_bin" \
  TRIANGLE_INSTALLATION_PATH="$installation_path" \
  TRIANGLE_DRAIN_PLIST="$drain_plist" \
  TRIANGLE_BINDING_PATH="$binding_path" \
  TRIANGLE_APPLICATION_ROOT="$application_root" \
  TRIANGLE_HELPER="$helper" \
  TRIANGLE_POLL_MS="$poll_ms" \
  TRIANGLE_CODEX_HOME="${TRIANGLE_CODEX_HOME:-}" \
  TRIANGLE_HEADLESS_WORKING_DIRECTORY="${TRIANGLE_HEADLESS_WORKING_DIRECTORY:-}" \
  TRIANGLE_HEADLESS_STATE_ROOT="${TRIANGLE_HEADLESS_STATE_ROOT:-}" \
  CODEX_CLI="${CODEX_CLI:-}" \
  /usr/bin/python3 - <<'PY'
import hashlib, json, os, plistlib, sys

PROFILE = os.environ["TRIANGLE_HEADLESS_PROFILE"]
FORBIDDEN_ROOMS = {
    "room_77",
    "room_8594d12312e14afbb291fcff60a22048",
}

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

def parse_drain_plist(path):
    if not path or not os.path.isfile(path):
        return {}
    with open(path, "rb") as handle:
        plist = plistlib.load(handle)
    args = plist.get("ProgramArguments") or []
    values = {}
    flags = {
        "--working-directory": "workingDirectory",
        "--codex-home": "codexHome",
        "--state-root": "stateRoot",
        "--codex-cli": "command",
        "--profile": "plistProfile",
        "--room-id": "plistRoomId",
    }
    i = 0
    while i < len(args):
        key = flags.get(args[i])
        if key is not None and i + 1 < len(args):
            values[key] = args[i + 1]
            i += 2
            continue
        i += 1
    return values

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

agents = load_agents(os.environ["TRIANGLE_CLIENT_BIN"])
by_profile = {}
for agent in agents:
    if not isinstance(agent, dict) or "profile" not in agent:
        die(66, "agent list entry is missing profile")
    by_profile[agent["profile"]] = agent

primary = by_profile.get(PROFILE)
if primary is None:
    die(66, f"headless profile {PROFILE} is not in agent list")
if primary.get("runtimeAdapter") != "codex":
    die(64, f"refusing grok_bot_not_in_codex_pool: {PROFILE} adapter is {primary.get('runtimeAdapter')}")

expected_instance = derive_instance_id(PROFILE)
listed_instance = primary.get("instanceId")
if listed_instance != expected_instance:
    die(64, "headless profile instanceId does not match derived ClientInstanceID")

installation_path = os.environ["TRIANGLE_INSTALLATION_PATH"]
try:
    installation = json.load(open(installation_path, encoding="utf-8"))
except OSError:
    die(66, "client/installation.json is missing")
installation_id = installation.get("installationId") if isinstance(installation, dict) else None
if not isinstance(installation_id, str) or not installation_id.startswith("inst_"):
    die(66, "client/installation.json is missing installationId")

plist_values = parse_drain_plist(os.environ["TRIANGLE_DRAIN_PLIST"])
if plist_values.get("plistProfile") not in (None, PROFILE):
    die(64, "dedicated drain plist profile does not match TRIANGLE_HEADLESS_PROFILE")
if plist_values.get("plistRoomId") in FORBIDDEN_ROOMS:
    # Plist pin is dedicated-drain-only; do not copy it into supervisor binding.
    pass

existing_binding = parse_binding_json(os.environ["TRIANGLE_BINDING_PATH"])
existing_common = {}
existing_profile_roots = {}
if existing_binding:
    if existing_binding.get("version") == 2:
        if set(existing_binding) != {"version", "common", "profiles"}:
            die(64, "existing v2 binding schema mismatch")
        existing_common = existing_binding.get("common")
        existing_profiles = existing_binding.get("profiles")
        if not isinstance(existing_common, dict) or set(existing_common) != {
            "adapterVersion", "installationId", "workingDirectory", "codexHome",
            "command", "pollIntervalMs",
        } or not isinstance(existing_profiles, list):
            die(64, "existing v2 binding schema mismatch")
        if existing_common.get("adapterVersion") != "1" or existing_common.get("installationId") != installation_id:
            die(64, "existing v2 binding common values mismatch")
        if type(existing_common.get("pollIntervalMs")) is not int or not 100 <= existing_common["pollIntervalMs"] <= 60000:
            die(64, "existing v2 binding poll interval is invalid")
        for name in ("workingDirectory", "codexHome", "command"):
            require_abs(existing_common.get(name), f"existing common {name}")
        for entry in existing_profiles:
            if not isinstance(entry, dict) or set(entry) != {"profile", "instanceId", "stateRoot"}:
                die(64, "existing v2 binding profile schema mismatch")
            profile = entry.get("profile")
            if profile in existing_profile_roots:
                die(64, "existing v2 binding has duplicate profile")
            if not isinstance(profile, str) or entry.get("instanceId") != derive_instance_id(profile):
                die(64, "existing v2 binding profile identity mismatch")
            state_root = require_abs(entry.get("stateRoot"), f"existing stateRoot[{profile}]")
            if os.path.normpath(state_root) != state_root:
                die(64, "existing v2 binding state root is not canonical")
            existing_profile_roots[profile] = state_root
    else:
        legacy_keys = {
            "adapterVersion", "enabled", "profile", "installationId", "instanceId",
            "workingDirectory", "codexHome", "stateRoot", "command", "pollIntervalMs",
        }
        if set(existing_binding) != legacy_keys:
            die(64, "existing v1 binding schema mismatch")
        if existing_binding.get("profile") != PROFILE:
            die(64, "existing binding profile does not match TRIANGLE_HEADLESS_PROFILE")
        if existing_binding.get("adapterVersion") != "1" or existing_binding.get("enabled") is not True \
          or existing_binding.get("installationId") != installation_id \
          or existing_binding.get("instanceId") != derive_instance_id(PROFILE):
            die(64, "existing v1 binding identity mismatch")
        if type(existing_binding.get("pollIntervalMs")) is not int or not 100 <= existing_binding["pollIntervalMs"] <= 60000:
            die(64, "existing v1 binding poll interval is invalid")
        for name in ("workingDirectory", "codexHome", "stateRoot", "command"):
            require_abs(existing_binding.get(name), f"existing v1 {name}")
        existing_common = existing_binding
        existing_profile_roots[PROFILE] = existing_binding.get("stateRoot")

application_root = os.environ["TRIANGLE_APPLICATION_ROOT"]
working_directory = (
    os.environ.get("TRIANGLE_HEADLESS_WORKING_DIRECTORY")
    or plist_values.get("workingDirectory")
    or existing_common.get("workingDirectory")
)
codex_home = (
    os.environ.get("TRIANGLE_CODEX_HOME")
    or plist_values.get("codexHome")
    or existing_common.get("codexHome")
)
command = (
    os.environ.get("CODEX_CLI")
    or plist_values.get("command")
    or existing_common.get("command")
)
if not working_directory:
    working_directory = os.path.join(application_root, "headless-work", PROFILE)
if not codex_home:
    die(66, "CODEX_HOME is unknown; set TRIANGLE_CODEX_HOME or keep the dedicated drain plist")
if not command:
    die(66, "CODEX_CLI is unknown; set CODEX_CLI or keep the dedicated drain plist")

for name, value in (
    ("workingDirectory", working_directory),
    ("codexHome", codex_home),
    ("command", command),
    ("helperPath", os.environ["TRIANGLE_HELPER"]),
):
    require_abs(value, name)

flip = []
headless_members = []
for agent in agents:
    adapter = agent.get("runtimeAdapter")
    mode = agent.get("deliveryMode")
    profile = agent["profile"]
    if adapter == "grok-bot" or mode == "grok-bot":
        continue
    if adapter != "codex":
        continue
    if agent.get("enabled") is not True:
        continue
    listed_instance = agent.get("instanceId")
    expected = derive_instance_id(profile)
    if listed_instance != expected:
        die(64, f"headless profile instanceId does not match derived ClientInstanceID: {profile}")
    headless_members.append((profile, expected))
    if mode != "headless-app-server":
        flip.append({"profile": profile, "from": mode, "to": "headless-app-server"})

headless_members.sort()
if not headless_members:
    die(64, "no enabled Codex profiles are eligible for headless cutover")
member_profiles = {profile for profile, _ in headless_members}
if existing_binding.get("version") == 2 and set(existing_profile_roots) != member_profiles:
    die(64, "existing v2 binding contains stale or missing profile entries")

grok = [agent for agent in agents if agent.get("runtimeAdapter") == "grok-bot" or agent.get("deliveryMode") == "grok-bot"]
if any(item["profile"] == PROFILE for item in grok):
    die(64, "refusing grok_bot_not_in_codex_pool")

profiles = []
seen_roots = set()
for profile, instance_id in headless_members:
    state_root = (
        os.environ.get("TRIANGLE_HEADLESS_STATE_ROOT") if profile == PROFILE else None
    ) or (plist_values.get("stateRoot") if profile == PROFILE else None) \
      or existing_profile_roots.get(profile) \
      or os.path.join(application_root, "model-state", "headless-drain", profile)
    require_abs(state_root, f"stateRoot[{profile}]")
    normalized = os.path.normpath(state_root)
    if normalized != state_root or state_root in seen_roots:
        die(64, "headless profile state roots must be canonical and distinct")
    seen_roots.add(state_root)
    profiles.append({"profile": profile, "instanceId": instance_id, "stateRoot": state_root})

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
    "action": "headless-supervisor-cutover",
    "headlessProfiles": [profile for profile, _ in headless_members],
    "flip": flip,
    "grokUntouched": [{"profile": agent["profile"], "deliveryMode": agent.get("deliveryMode"), "runtimeAdapter": agent.get("runtimeAdapter")} for agent in grok],
    "stopSharedAppServer": any(item["from"] == "mcp-interactive" for item in flip),
    "bootoutDedicatedDrain": os.path.isfile(os.environ["TRIANGLE_DRAIN_PLIST"]),
    "bindingPath": os.environ["TRIANGLE_BINDING_PATH"],
    "binding": binding,
    "agents": [
        {
            "profile": agent["profile"],
            "runtimeAdapter": agent.get("runtimeAdapter"),
            "deliveryMode": agent.get("deliveryMode"),
            "enabled": agent.get("enabled"),
        }
        for agent in agents
    ],
}
json.dump(plan, sys.stdout, indent=2, sort_keys=True)
sys.stdout.write("\n")
PY
}

plan_json=$(python_plan)
printf '%s\n' "$plan_json"

stop_shared=$(/usr/bin/python3 -c 'import json,sys; print("1" if json.loads(sys.stdin.read())["stopSharedAppServer"] else "0")' <<<"$plan_json")
flip_profiles=$(/usr/bin/python3 -c 'import json,sys; print("\n".join(item["profile"] for item in json.loads(sys.stdin.read())["flip"]))' <<<"$plan_json")

if [[ "$action" == plan ]]; then
  exit 0
fi

# Preserve the exact prior binding across either v1 migration or v2 repeat
# apply. A failed coordinator restart must not strand an unverified binding.
binding_backup=$(/usr/bin/mktemp "${client_root}/.headless-runtime-binding.XXXXXX")
binding_existed=0
if [[ -f "$binding_path" ]]; then
  /bin/cp -p "$binding_path" "$binding_backup"
  binding_existed=1
fi
rollback_binding() {
  status=$?
  trap - EXIT HUP INT TERM
  if [[ $status -ne 0 ]]; then
    if [[ $binding_existed -eq 1 ]]; then
      /bin/cp -p "$binding_backup" "$binding_path"
    else
      /bin/rm -f "$binding_path"
    fi
  fi
  /bin/rm -f "$binding_backup"
  exit "$status"
}
trap rollback_binding EXIT
trap 'exit 130' HUP INT TERM

if [[ "$stop_shared" == 1 ]] && label_loaded "$shared_label"; then
  bootout_label "$shared_label"
fi

if [[ -n "$flip_profiles" ]]; then
  while IFS= read -r profile; do
    [[ -n "$profile" ]] || continue
    "$client_bin" agent set-delivery-mode --profile "$profile" --mode headless-app-server
  done <<<"$flip_profiles"
fi

/bin/mkdir -p "$client_root"
/bin/chmod 700 "$client_root"
umask 077
TRIANGLE_PLAN="$plan_json" /usr/bin/python3 - <<'PY'
import json, os, sys
plan = json.loads(os.environ["TRIANGLE_PLAN"])
binding = plan["binding"]
path = plan["bindingPath"]
blob = json.dumps(binding, separators=(",", ":"), sort_keys=True)
if "allowedRoomId" in blob or "room_77" in blob:
    print("refusing to write a room-pinned supervisor binding", file=sys.stderr)
    raise SystemExit(64)
with open(path, "w", encoding="utf-8") as handle:
    handle.write(blob + "\n")
os.chmod(path, 0o600)
PY

# Dual-claimer-safe switch: supervisor must not race the dedicated drain.
if label_loaded "$client_label"; then
  bootout_label "$client_label"
fi
if label_loaded "$drain_label"; then
  bootout_label "$drain_label"
fi
/bin/rm -f "$drain_plist"

# Drop a dedicated-drain claimer lock so inspect() is not confused; dead pids
# are already ignored, but a live-looking leftover owner would fail-closed.
for lock in \
  "${client_root}/headless-claimer.${headless_profile}.json" \
  "${client_root}/headless-claimer.json"
do
  if [[ -f "$lock" ]]; then
    owner=$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("owner",""))' "$lock" 2>/dev/null || true)
    if [[ "$owner" == "dev.thetriangle.codex-headless-drain" ]]; then
      /bin/rm -f "$lock"
    fi
  fi
done

if [[ ! -f "$client_plist" ]]; then
  echo "dev.thetriangle.client plist is missing; install the client before apply" >&2
  exit 66
fi
"$launchctl_command" bootstrap "$domain" "$client_plist"

trap - EXIT HUP INT TERM
/bin/rm -f "$binding_backup"

echo "headless supervisor cutover applied"
echo "  profiles=$(/usr/bin/python3 -c 'import json,sys; print(",".join(json.loads(sys.stdin.read())["headlessProfiles"]))' <<<"$plan_json")"
echo "  binding=$binding_path"
echo "  dedicatedDrain=$drain_label (unloaded)"
echo "  grok-bot profiles were not modified"

#!/bin/bash
# Install operator-owned Grok Bot wake binding files under Application Support.
# Secrets (webhook URL/key) stay local — never commit them.
#
# Required env:
#   TRIANGLE_INSTALLATION_ID
#   TRIANGLE_INSTANCE_ID          # bob's 64-hex instance id
#   TRIANGLE_AGENT_ID             # MESH agent id for bob
#   TRIANGLE_GROK_AGENT_ID        # Grok Bot agent UUID
#   GROK_BOT_WEBHOOK_URL          # https webhook URL (not printed)
#   GROK_BOT_WEBHOOK_KEY          # bearer key (not printed)
#
# Optional:
#   TRIANGLE_PROFILE              # default: bob
#   TRIANGLE_CLIENT_ROOT          # default: ~/Library/Application Support/The Triangle/client
set -euo pipefail

PROFILE="${TRIANGLE_PROFILE:-bob}"
CLIENT_ROOT="${TRIANGLE_CLIENT_ROOT:-$HOME/Library/Application Support/The Triangle/client}"

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "missing required env: $name" >&2
    exit 64
  fi
}

require_env TRIANGLE_INSTALLATION_ID
require_env TRIANGLE_INSTANCE_ID
require_env TRIANGLE_AGENT_ID
require_env TRIANGLE_GROK_AGENT_ID
require_env GROK_BOT_WEBHOOK_URL
require_env GROK_BOT_WEBHOOK_KEY

if [[ ! "$TRIANGLE_INSTALLATION_ID" =~ ^inst_[A-Za-z0-9_-]{10,75}$ ]]; then
  echo "TRIANGLE_INSTALLATION_ID is invalid" >&2
  exit 64
fi
if [[ ! "$TRIANGLE_INSTANCE_ID" =~ ^[a-f0-9]{64}$ ]]; then
  echo "TRIANGLE_INSTANCE_ID is invalid" >&2
  exit 64
fi
if [[ ! "$GROK_BOT_WEBHOOK_URL" =~ ^https:// ]]; then
  echo "GROK_BOT_WEBHOOK_URL must be https" >&2
  exit 64
fi

mkdir -m 700 -p "$CLIENT_ROOT"

BINDING="$CLIENT_ROOT/grok-bot-binding.json"
URL_FILE="$CLIENT_ROOT/grok-bot-webhook.url"
KEY_FILE="$CLIENT_ROOT/grok-bot-webhook.key"
CURSOR="$CLIENT_ROOT/grok-bot-wake-cursor.json"

umask 077
python3 - <<'PY' >"$BINDING"
import json, os
print(json.dumps({
    "adapterVersion": "1",
    "enabled": True,
    "installationId": os.environ["TRIANGLE_INSTALLATION_ID"],
    "instanceId": os.environ["TRIANGLE_INSTANCE_ID"],
    "agentId": os.environ["TRIANGLE_AGENT_ID"],
    "profile": os.environ.get("TRIANGLE_PROFILE", "bob"),
    "grokAgentId": os.environ["TRIANGLE_GROK_AGENT_ID"],
    "wakeMode": "webhook",
}, separators=(",", ":")))
PY
chmod 600 "$BINDING"

printf '%s\n' "$GROK_BOT_WEBHOOK_URL" >"$URL_FILE"
chmod 600 "$URL_FILE"
printf '%s\n' "$GROK_BOT_WEBHOOK_KEY" >"$KEY_FILE"
chmod 600 "$KEY_FILE"

if [[ ! -f "$CURSOR" ]]; then
  printf '%s\n' '{"cursor":0}' >"$CURSOR"
  chmod 600 "$CURSOR"
fi

unset GROK_BOT_WEBHOOK_URL GROK_BOT_WEBHOOK_KEY

echo "Installed Grok Bot wake binding (metadata only; secrets not printed)"
echo "  clientRoot=$CLIENT_ROOT"
echo "  profile=$PROFILE"
echo "  installationId=$TRIANGLE_INSTALLATION_ID"
echo "  instanceId=$TRIANGLE_INSTANCE_ID"
echo "  agentId=$TRIANGLE_AGENT_ID"
echo "  grokAgentId=$TRIANGLE_GROK_AGENT_ID"
echo "  wakeMode=webhook"
echo "  files=grok-bot-binding.json,grok-bot-webhook.url,grok-bot-webhook.key,grok-bot-wake-cursor.json"
echo
echo "Next (Tech Lead / Mini operator):"
echo "  1. triangle-client agent set-delivery-mode --profile $PROFILE --mode grok-bot"
echo "  2. Prefer LaunchAgent stop then start (avoid kickstart -k)"
echo "  3. watch-ensure --installation \$INSTALLATION --actor-profile $PROFILE"
echo "  4. Confirm Bob routine mesh-bob-wake-drain is bound to the webhook URL/key"

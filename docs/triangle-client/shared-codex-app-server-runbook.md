# Shared Codex App Server — operator runbook

macOS-only checklist to **start, verify, rebind, and restart** the durable Shared
Codex App Server used for interactive Codex MESH wake (`appServerWake`).

Audience: an operator on a Mac with ChatGPT.app and a Triangle Client install.
This is not executable from Linux.

## What this is

`dev.thetriangle.shared-app-server` runs
`scripts/macos-shared-codex-app-server-host.mjs`, which:

1. Starts bundled Codex `app-server --listen ws://127.0.0.1:<port>`
2. Writes Application Support binding / WS token / wake cursor
3. Launches ChatGPT attached to that server via `CODEX_APP_SERVER_WS_URL` and
   `codex://threads/<threadId>` (isolated UI under `shared-app-server/ui`)

Inbound work for `deliveryMode: mcp-interactive` Codex profiles is admitted into
the **bound** desktop thread — not ordinary ChatGPT’s private unix app-server,
and not a headless `event-driven` / `codex exec` drain.

| Do | Do not |
| --- | --- |
| Keep Codex at `mcp-interactive` | Flip Codex to `event-driven` to “finish” inbound |
| Bind a Desktop-resumeable thread | Bind a bare `thread/start` mint Desktop never opened |
| Prefer LaunchAgent `stop` then `start` | Blind `kickstart -k` without draining orphan Node→app-server sockets |
| Use the bind CLI for `threadId` | Hand-edit identity fields (`endpoint`, `serverIdentity`, `installationId`, …) |

## Prerequisites

- macOS 13+, ChatGPT.app installed at `/Applications/ChatGPT.app`
- Node 22+ on PATH for the LaunchAgent (Mini uses `~/.local/bin/node`)
- Triangle Client + helper installed; Codex profile enrolled
  (see [e2e-operator-runbook.md](e2e-operator-runbook.md))
- Codex profile: `deliveryMode: mcp-interactive` (example: `codex-bob-test`)
- Login Keychain unlocked; watch grant healthy for the installation

Convenience paths:

```sh
CLIENT_ROOT="$HOME/Library/Application Support/The Triangle/client"
HOST_ROOT="$HOME/Library/Application Support/The Triangle/shared-app-server"
LOG="$HOME/Library/Logs/the-triangle/shared-app-server.log"
ERR="$HOME/Library/Logs/the-triangle/shared-app-server.error.log"
DOMAIN="gui/$(id -u)"
LABEL="dev.thetriangle.shared-app-server"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
CHECKOUT="/Users/zhenyuhou/Projects/The Triangle/triangle-client"  # adjust
CLIENT="$HOME/Library/Application Support/The Triangle/bin/triangle-client"
```

## 1. Confirm Codex delivery mode

```sh
"$CLIENT" agent list
# Expect the Codex profile: deliveryMode=mcp-interactive, enabled=true
```

If needed:

```sh
"$CLIENT" agent set-delivery-mode --profile codex-bob-test --mode mcp-interactive
```

Do **not** set `event-driven` for interactive Codex App Server wake.

## 2. Install / load the LaunchAgent (once)

Repo plist (paths may be machine-local):

- Source template: `scripts/macos/dev.thetriangle.shared-app-server.plist`
- Installed copy: `~/Library/LaunchAgents/dev.thetriangle.shared-app-server.plist`

If the agent is not loaded yet:

```sh
# Review ProgramArguments / WorkingDirectory / log paths in $PLIST first
launchctl bootstrap "$DOMAIN" "$PLIST"
```

Host working directory and UI data live under `$HOST_ROOT` (created on first run).

## 3. Start or restart (clean)

Prefer bootout → drain → bootstrap over `kickstart -k`. Orphan supervisor Node WS
clients can steal turn completions after a hard kickstart.

```sh
# Stop
launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
sleep 1
pkill -f 'macos-shared-codex-app-server-host.mjs' 2>/dev/null || true
pkill -f 'app-server --listen ws://127.0.0.1' 2>/dev/null || true
pkill -f 'ChatGPT.app/Contents/MacOS/ChatGPT.*shared-app-server' 2>/dev/null || true
sleep 1

# Optional: inspect leftover ESTABLISHED node→127.0.0.1 sockets and kill orphans
lsof -nP -iTCP -sTCP:ESTABLISHED 2>/dev/null | awk '/node/ && /127\.0\.0\.1/' | head

# Start (host resumes threadId from existing app-server-binding.json when present)
launchctl bootstrap "$DOMAIN" "$PLIST"
```

If already loaded and healthy, a soft restart is:

```sh
launchctl bootout "${DOMAIN}/${LABEL}"
sleep 1
launchctl bootstrap "$DOMAIN" "$PLIST"
```

Startup takes ~20–40s until ChatGPT confirms thread resume.

## 4. Verify hold

Within ~45s of start, expect `holding` in the log and matching PIDs:

```sh
tail -n 30 "$LOG"
# Look for: backend_ready → thread_resolved → desktop_launched
#           → desktop_resume_observed (attached:true) → holding

cat "$HOST_ROOT/hold.pids"
# scriptPid, serverPid, desktopPid, threadId, listenEndpoint

python3 - <<'PY'
import json
from pathlib import Path
b = json.loads((Path.home() / "Library/Application Support/The Triangle/client/app-server-binding.json").read_text())
print({k: b.get(k) for k in ("enabled", "threadId", "endpoint", "agentId", "roomScope", "instanceId")})
assert b.get("enabled") is True
assert b.get("threadId")
PY

pgrep -lf 'macos-shared-codex-app-server-host|app-server --listen|ChatGPT.app/Contents/MacOS/ChatGPT'
launchctl print "${DOMAIN}/${LABEL}" | head -20
```

Pass when:

- LaunchAgent `state = running`
- `codex app-server --listen` is up on the binding `endpoint` port
- ChatGPT is running with `--user-data-dir=…/shared-app-server/ui` and
  `codex://threads/<bound-threadId>`
- `desktop_resume_observed` shows `attached: true` (and ideally `resumeSeen: true`)
- `app-server-binding.json` has `enabled: true` and a stable `threadId`

Also keep Triangle Client running so wakes admit:

```sh
./scripts/triangle-client-service.sh status
# or: launchctl print "${DOMAIN}/dev.thetriangle.client" | head
```

## 5. Bind wakes to *this* Codex chat

Unattended admits land in the **bound** `threadId`, not necessarily the chat you
are typing in. Rebind intentionally:

```sh
cd "$CHECKOUT"
node scripts/macos/app-server-bind.mjs --thread-id "<codex-desktop-thread-id>"
```

Rules:

1. Use a thread Desktop can already resume on the **shared** App Server window
   (the ChatGPT process held by this LaunchAgent).
2. Do not bind a mint that ChatGPT never opened on this attachment —
   resume/admit will fail (`thread_rebind_failed` / rollout missing).
3. Do not unsupervised-follow “latest chat” or Desktop focus.
4. Hot-rebind applies on the next `connect` / `admit` (file sync reconnect).
   Restart the LaunchAgent if the hold looks stale.
5. Stale binding symptom: MESH A2A works, but App Server admits land in an older
   chat.

Confirm:

```sh
python3 -c 'import json,pathlib; print(json.loads((pathlib.Path.home()/"Library/Application Support/The Triangle/client/app-server-binding.json").read_text())["threadId"])'
```

## 6. Smoke canary (Bob → Codex session)

After Client + shared App Server are holding and the desired thread is bound:

1. Ensure no stale open claim on the Codex profile (abandon if needed).
2. From Bob (or a canary), send `message.created` with `replyRequired: true` and a
   unique nonce into the Codex room.
3. Pass only when the **same** bound desktop thread shows the admitted turn and
   Codex replies; MESH gets `transaction-reply` + `transaction-ack`.
4. Receipt-only peer acks (`replyRequired: false`) must not re-wake a reply loop.

Deeper design / history:
[HANDOFF-appserver-wake-2026-09-13.md](HANDOFF-appserver-wake-2026-09-13.md),
[2026-09-13-unattended-wake-hosts.md](2026-09-13-unattended-wake-hosts.md).

## 7. Troubleshooting

| Symptom | Check |
| --- | --- |
| LaunchAgent exits / KeepAlive thrash | `$ERR` and `$LOG`; `readyz` timeout; ChatGPT path missing |
| `desktop_resume_observed` never attached | Wrong `threadId` for this server; restart after bind; confirm ChatGPT PID |
| Admits go to wrong chat | Run `app-server-bind.mjs` with this chat’s id |
| `thread_rebind_failed` / resume errors | Bind only a Desktop-opened shared-server thread |
| Turns hang / completions stolen | Stop LaunchAgent, kill orphan Node→app-server ESTABLISHED sockets, start clean |
| Codex never wakes on inbound | `enabled` in binding; Client running; watch grant; profile still `mcp-interactive` |
| Headless Codex runs instead of chat | Profile was flipped to `event-driven` — set back to `mcp-interactive` |
| Keychain / helper errors | Unlock login Keychain; see KEYCHAIN_POLICY / e2e runbook |

Durable files (operator-local; never commit secrets):

| Path | Role |
| --- | --- |
| `$CLIENT_ROOT/app-server-binding.json` | Identity + `threadId` + `enabled` + endpoint |
| `$CLIENT_ROOT/app-server-ws.token` | App Server WS capability token (`0600`) |
| `$CLIENT_ROOT/app-server-wake-cursor.json` | `{"cursor":N}` wake cursor |
| `$HOST_ROOT/hold.pids` | Last successful hold PIDs / endpoint |
| `$HOST_ROOT/ui` | Isolated ChatGPT user-data for the shared attachment |

## 8. Related docs

| Doc | Use when |
| --- | --- |
| [codex-desktop-wake-handoff.md](codex-desktop-wake-handoff.md) | Gate A disposable experiment / product track |
| [HANDOFF-appserver-wake-2026-09-13.md](HANDOFF-appserver-wake-2026-09-13.md) | Unattended loop status and Mini incident notes |
| [2026-09-13-unattended-wake-hosts.md](2026-09-13-unattended-wake-hosts.md) | Bob vs Codex host split; bind semantics |
| [skills/triangle-mesh-a2a/SKILL.md](../../skills/triangle-mesh-a2a/SKILL.md) | In-session bind instructions for agents |
| [2026-09-20-headless-codex-worker-runtime-design.md](2026-09-20-headless-codex-worker-runtime-design.md) | Headless pool + optional Phase 4 idle handoff (does **not** replace this runbook) |
| [e2e-operator-runbook.md](e2e-operator-runbook.md) | Clean-Mac install → enroll → watch |
| [shared-codex-server-prototype.md](shared-codex-server-prototype.md) | Early prototype notes (not the LaunchAgent path) |

Disposable Gate A experiment (not this durable LaunchAgent) remains under
`scripts/prototypes/native-desktop-wake-experiment.mjs` in the desktop wake
handoff.

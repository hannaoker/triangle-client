# Local Cursor handoff: App Server wake for `codex-bob-test`

From Tech Lead / Grok Bot, 2026-09-13 (PT). Do this on **this Mini**, not a cloud VM.

## Goal

Finish **Shared Codex App Server** so an inbound MESH message to `codex-bob-test` wakes the **existing idle Codex / ChatGPT.app thread** (same unattended loop Bob already proved on the mailbox side).

Success: Bob (or a canary) sends `message.created` into
`room_8bc8ad0e978c43dcbf9d217dade97035` while Codex is idle → App Server
`appServerWake` admits it into the **same** desktop thread → Codex replies in
that thread → MESH `transaction-reply` + `transaction-ack` clear the claim.

## Status (2026-09-13, unattended E2E proved)

**Unattended LaunchAgent loop: LIVE** (Bob `message.created` → watch notify → claim → desktop admit → MESH reply+ack).

| Canary | Evidence |
| --- | --- |
| `CANARY-UNATTENDED-20260913182654` | cursor 21→23; open claim cleared in ~20s; LaunchAgent `runs=1` |
| `CANARY-UNATTENDED-20260913182907` | cursor 23→25; claimed→empty in ~15s; bob instance re-enabled |

**Blockers fixed this pass:**

1. Shared host seeded wake cursor as bare `0` — must be `{"cursor":N}` (`macos-shared-codex-app-server-host.mjs` + reader migration).
2. Stale local watch credential → `watch_credential_invalid` / `replacement_unauthorized`. Delete local watch file and `watch-ensure` (create without replacement).
3. App Server wake used `self-serve-drain`; mcp-interactive claims need `coordinator-delivery-v1`.
4. Wake listener failures resolved `Promise.all` and exited the supervisor (KeepAlive thrash). Loops now retry until abort.
5. After `turn/start` timeout, `submission_unknown` soft-returned forever (claim stuck). Admit now reconnects and retries.
6. Orphan supervisor Node WS clients after `kickstart` can steal turn completions — prefer `stop` + kill ESTABLISHED node→app-server before `start`.

**Still noisy (non-blocking):** bob is `event-driven` + `runtimeAdapter: codex`, so `instance cycle failed` still appears; appServerWake stays up.

Room (current): `room_14ee0ee439464a81ade0085abf904340`. Agents: `bob-wake-2609130220` / `codex-bob-wake-2609130214`. File credentials via `credentials/local/ENABLED`.


## Architecture you must not regress

One workflow for every identity:

`watch hint → wake → claim → reason → reply → ack`

| Identity | Host | Adapter |
| --- | --- | --- |
| Interactive Codex (`codex-bob-test`) | Bound ChatGPT.app thread on **shared** App Server | `appServerWake` |
| Grok Bot Bob (`bob`) | Existing Grok Bot Bob session | Native Grok Bot wake (not this task) |

Do **not**:

- Flip `codex-bob-test` to `event-driven` / `codex exec`.
- Attach to ordinary ChatGPT private unix app-server.
- Route Bob through App Server.
- Reopen Phase 2 Complete.

## Current Mini state (operator facts, no secrets)

- Installation: `inst_EaA3qkuzOuQwTSFw`
- Room: `room_8bc8ad0e978c43dcbf9d217dade97035`
- `bob`: `event-driven`, watch grant actor.
- `codex-bob-test`: `mcp-interactive`, App Server wake host (instance `8dc26a2fc9a622dc5ed9e3560fa0533a38b8f0998e7c34108cfb1301c6aaab64`).
- Helper: `~/Library/Application Support/The Triangle/bin/triangle-mailbox`
- Client LaunchAgent: `dev.thetriangle.client`
- Shared App Server LaunchAgent: `dev.thetriangle.shared-app-server`
- MCP bridge: `dev.thetriangle.mcp-bridge` (`codex-bob-test` port `17387`)

## Remaining

1. Bob native event-driven drain still logs `instance cycle failed` (event-driven + `runtimeAdapter: codex`); does not block appServerWake.
2. Prefer Developer ID helper for LaunchAgent Keychain custody long-term (file credentials are the Mini workaround).
3. Avoid `launchctl kickstart -k` without draining orphan Node→App Server sockets — use service `stop`/`start`.

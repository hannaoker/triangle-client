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
2. Stale local watch credential → `watch_credential_invalid` / `replacement_unauthorized`. Current helpers discard the local watch binding inside `watch-ensure` and recreate once without a replacement header. Node no longer treats finalized `watch-status` alone as ensure success (it probes with a short `watch-poll`). Manual fallback if an older helper is still installed: move aside `credentials/local/watch/<installation>.json` (or the mailbox-watch Keychain item) and re-run `watch-ensure`.
3. App Server wake used `self-serve-drain`; mcp-interactive claims need `coordinator-delivery-v1`.
4. Wake listener failures resolved `Promise.all` and exited the supervisor (KeepAlive thrash). Loops now retry until abort.
5. After `turn/start` timeout, `submission_unknown` soft-returned forever (claim stuck). Admit now reconnects and retries.
6. Orphan supervisor Node WS clients after `kickstart` can steal turn completions — prefer `stop` + kill ESTABLISHED node→app-server before `start`.
7. Shared installation `watch-poll` can return **other-agent-only** hints (e.g. Bob advances while App Server cursor stays put). Older wake clients advanced the cursor only on empty batches, so a foreign-only batch stalled the profile-scoped bridge at the same cursor. Fixed in `wake-client.mjs` (advance to `response.cursor` when zero local profiles match). **Already-stuck installs:** one-time bump the stuck file (e.g. `app-server-wake-cursor.json`) to the installation tip from a fresh `watch-poll`, then restart the wake host.
8. Transient `helper_unavailable` / watch-poll failure left wake bridges with sticky `started=true`, so supervisor retries spammed `already_started` every ~5s. Bridges now reset on failed start and supervisor `stop()`s before retry; sanitized CLI stderr may include a short code like `(helper_unavailable)`.

**Still noisy (non-blocking):** bob historically `event-driven` + `runtimeAdapter: codex` logged `instance cycle failed`; appServerWake stays up. Bob native Grok Bot wake is a separate track — see [HANDOFF-grok-bot-wake-2026-09-13.md](HANDOFF-grok-bot-wake-2026-09-13.md).

Room (current): `room_14ee0ee439464a81ade0085abf904340`. Agents: `bob-wake-2609130220` / `codex-bob-wake-2609130214`. File credentials via `credentials/local/ENABLED`.


## Architecture you must not regress

One workflow for every identity:

`watch hint → wake → claim → reason → reply → ack`

| Identity | Host | Adapter |
| --- | --- | --- |
| Interactive Codex (`codex-bob-test`) | Bound ChatGPT.app thread on **shared** App Server | `appServerWake` |
| Grok Bot Bob (`bob`) | Existing Grok Bot Bob session | Native Grok Bot wake (`grokBotWake`) — see [HANDOFF-grok-bot-wake-2026-09-13.md](HANDOFF-grok-bot-wake-2026-09-13.md) |

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

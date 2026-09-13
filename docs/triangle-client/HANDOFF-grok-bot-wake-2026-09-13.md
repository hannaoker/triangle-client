# Local Cursor handoff: native Grok Bot wake for `bob`

From Tech Lead / prior architecture split, 2026-09-13 (PT). Tech Lead drives
Mini operator steps. Cloud agents edit sources + Node tests; full Mac helper
rebuild is optional verification on Mini.

## Goal

Replace Bob’s temporary host (`deliveryMode: event-driven` +
`runtimeAdapter: codex` / headless `codex exec`) with **native Grok Bot wake**:

`watch hint → wake → claim → reason → reply → ack`

- Codex interactive = App Server (`appServerWake`) — leave alone
- Grok Bot Bob = this track — not App Server, not `codex exec`
- Bob owns claim/reply/ack via MESH after the webhook wake
- Triangle Client adapter only POSTs the wake; it does **not** claim/reply/ack

## Status

| Item | State |
| --- | --- |
| `DeliveryMode.grokBot` / `RuntimeAdapter.grokBot` | Shipped in sources |
| Swift `prepareGrokBotWake` + Node `grokBotWake` supervisor path | Shipped |
| `packages/agent-worker/src/grok-bot-wake.mjs` + Node tests | Shipped |
| `scripts/macos/install-grok-bot-wake-binding.sh` | Shipped (no secrets in git) |
| Live LaunchAgent flip / webhook secret install / canary | **Operator / Tech Lead on Mini** — out of scope for cloud |

Bob routine **`mesh-bob-wake-drain`** (webhook) is already saved on the Grok Bot
side. Binding the triangle-client webhook URL/key to that routine is
**operator-side**.

## Architecture you must not regress

| Identity | Host | Adapter |
| --- | --- | --- |
| Grok Bot Bob (`bob`) | Existing Grok Bot Bob session | `grokBotWake` (webhook) |
| Interactive Codex (`codex-bob-test`) | Bound ChatGPT.app thread on shared App Server | `appServerWake` |

Do **not**:

- Flip `codex-bob-test` to `event-driven` / `codex exec`
- Route Bob through App Server
- Put webhook URL/key or mailbox tokens in git / plists / Node env
- Reopen Phase 2 Complete

**Actor constraint:** watch grant actors must not be `mcp-interactive`.
`grok-bot` may act as grant actor (Bob owns post-wake MESH claim). Prefer
`stop` then `start` for LaunchAgent changes — avoid `kickstart -k` (orphan
Node sockets).

## Example Mini IDs (docs only)

- Installation: `inst_EaA3qkuzOuQwTSFw`
- Bob instance: `3356f7bfb8e902f4b519d8238e3555e4974217898af96bed249cf0cfb729c1eb`
- MESH bob agent: `agent_582567705a9348c38f18c91d2bac9dd8`
- Grok agent: `12aedccc-8662-4a7f-84da-3d35c9e97842`

## Operator flip (Mini / Tech Lead)

1. Install binding (secrets via env; script never prints them):

```sh
export TRIANGLE_INSTALLATION_ID='inst_EaA3qkuzOuQwTSFw'
export TRIANGLE_INSTANCE_ID='3356f7bfb8e902f4b519d8238e3555e4974217898af96bed249cf0cfb729c1eb'
export TRIANGLE_AGENT_ID='agent_582567705a9348c38f18c91d2bac9dd8'
export TRIANGLE_GROK_AGENT_ID='12aedccc-8662-4a7f-84da-3d35c9e97842'
export GROK_BOT_WEBHOOK_URL='…'   # operator-owned https URL
export GROK_BOT_WEBHOOK_KEY='…'   # operator-owned bearer
./scripts/macos/install-grok-bot-wake-binding.sh
unset GROK_BOT_WEBHOOK_URL GROK_BOT_WEBHOOK_KEY
```

2. Confirm files under
   `~/Library/Application Support/The Triangle/client/`:
   `grok-bot-binding.json`, `grok-bot-webhook.url`, `grok-bot-webhook.key`
   (`0600`), `grok-bot-wake-cursor.json` as `{"cursor":N}`.

3. Flip delivery mode:

```sh
CLIENT="$HOME/Library/Application Support/The Triangle/bin/triangle-client"
"$CLIENT" agent set-delivery-mode --profile bob --mode grok-bot
```

4. Restart client LaunchAgent with **stop then start** (not `kickstart -k`).

5. Refresh watch grant (Bob may act):

```sh
HELPER="$HOME/Library/Application Support/The Triangle/bin/triangle-mailbox"
"$HELPER" watch-ensure --installation inst_EaA3qkuzOuQwTSFw --actor-profile bob
"$HELPER" watch-status --installation inst_EaA3qkuzOuQwTSFw
```

6. Confirm Grok routine `mesh-bob-wake-drain` receives wakes; send a
   `message.created` canary and verify Bob claim → reply → ack.

## App Server status (do not regress)

Unattended App Server wake for `codex-bob-test` is **LIVE** on Mini (see
[HANDOFF-appserver-wake-2026-09-13.md](HANDOFF-appserver-wake-2026-09-13.md)).
Leave that path alone while flipping Bob.

## Mac verify checklist (Tech Lead)

- Rebuild/install helper from this branch if Swift delivery-mode enum is not yet
  on Mini.
- Node tests: `npm --prefix packages/agent-worker run test:triangle-client`
  (includes `grok-bot-wake.test.mjs`).
- Cloud VM cannot run full Darwin helper tests; Mac host verify remains required
  before declaring production flip complete.

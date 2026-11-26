# Grok Bot webhook wake route — retired (2026-09-30)

Status: **retired on Mini**. Do not re-enable without a new wake design.

Client runtime manifest v17 removes the webhook bridge and its setup script.
Older installed bundles retain their original manifest and hash checks.
Grok's pull-only local session adapter is a separate delivery path.
For a source install, update the macOS helper before staging a v17 bundle.

## Why

Bob’s unattended path POSTed MESH wake hints to a Grok Bot routine webhook:

`https://api2.cursor.sh/automations/webhook/<uuid>`

(`mesh-bob-wake-drain`, bearer in `grok-bot-webhook.key`).

That endpoint is **not stable**: the routine/webhook repeatedly returns

`400 Automation <uuid> is disabled`

even after operators re-enable it in the Grok Bot UI. Triangle maps that to
`webhook_rejected` / `webhook_rejected/400` and the supervisor error-loops.

This is distinct from Cursor Automations (Agents Window). The product surface is
**Grok Bot → Routines**; the HTTP API still says “Automation”.

## What we did

1. Live Mini: set `grok-bot-binding.json` `enabled: false`; remove webhook
   URL/key from Application Support (or move aside).
2. Swift: `enabled: false` omits Bob from wake (`grok_bot_wake_disabled`) instead
   of failing supervisor bootstrap.
3. `scripts/macos/install-grok-bot-wake-binding.sh` refuses unless
   `TRIANGLE_ACK_GROK_WEBHOOK_RETIRED_OVERRIDE=1`.

Existing `deliveryMode: grok-bot` profile records remain readable. The
supervisor reports them as retired and skips webhook startup.

## Bob unattended wake

**No production wake path** for Bob until a replacement is chosen (not this
webhook). Headless / App Server Codex tracks are unchanged.

## Related

- [HANDOFF-grok-bot-wake-2026-09-13.md](HANDOFF-grok-bot-wake-2026-09-13.md)
- [2026-09-13-unattended-wake-hosts.md](2026-09-13-unattended-wake-hosts.md)
- [HANDOFF-interactive-grok-bob-spike-2026-09-14.md](HANDOFF-interactive-grok-bob-spike-2026-09-14.md)

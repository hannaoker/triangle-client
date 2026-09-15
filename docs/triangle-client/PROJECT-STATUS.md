# Project status (Mini A2A) — 2026-09-15

Living status for **triangle-client** on Mac Mini. Detailed history stays in dated
handoffs; this page is the short operator view.

## Verdict

**Codex ↔ Bob headless A2A works.** Interactive Grok conversation-owner does not.
Pause Bob webhook drains while Grok reports `resource_exhausted`.

## Lanes

| Profile | deliveryMode | Wake | Human-visible surface | MESH owner |
| --- | --- | --- | --- | --- |
| `codex-bob-test` | `mcp-interactive` | `appServerWake` | Shared App Server ChatGPT thread | App Server session settle |
| `bob` | `grok-bot` | `grokBotWake` webhook | Routine run (Grok UI not required) | `mesh-bob-wake-drain` only |

## What shipped recently (git `main`)

| Commit / topic | Note |
| --- | --- |
| Receipt ping-pong fix | Helper + App Server + Bob: `replyRequired: false` → ack-only |
| App Server hot-rebind | `app-server-bind.mjs`; file-owned `threadId` |
| Interactive Grok spike | **no-go** (no continue-by-conversationId API) |
| Docs pack | App Server runbook; Grok fabric vs MESH; visibility handoff unproven |

## Current Mini ops

- LaunchAgents: `dev.thetriangle.client`, `dev.thetriangle.shared-app-server`
- Room: `room_14ee0ee439464a81ade0085abf904340`
- Bob drain decision table: canary → `Acked. Echo: <nonce>`; `replyRequired: true` → work + `status: completed`; `replyRequired: false` → ack only
- **Quota:** if Bob reports `resource_exhausted`, pause routine Active (or set `grok-bot-binding.json` `enabled: false`) until recover + canary
- Interactive track: **paused**; do not build conversation-owner adapter

## Docs map

| Doc | Use |
| --- | --- |
| [shared-codex-app-server-runbook.md](shared-codex-app-server-runbook.md) | Launch / bind / restart Codex App Server |
| [2026-09-13-unattended-wake-hosts.md](2026-09-13-unattended-wake-hosts.md) | Host split Bob vs Codex |
| [2026-09-14-grok-fabric-vs-mesh-wake.md](2026-09-14-grok-fabric-vs-mesh-wake.md) | Why bots can talk; Slack analogy; no Connect plugin |
| [HANDOFF-interactive-grok-bob-spike-2026-09-14.md](HANDOFF-interactive-grok-bob-spike-2026-09-14.md) | Conversation-owner no-go |
| [HANDOFF-routine-conversation-visibility-2026-09-14.md](HANDOFF-routine-conversation-visibility-2026-09-14.md) | Visibility unproven |
| [HANDOFF-a2a-ping-pong-acknowledgment-loop-2026-09-13.md](HANDOFF-a2a-ping-pong-acknowledgment-loop-2026-09-13.md) | Receipt-only design |
| Workspace `_context.md` | `../_context.md` (The Triangle folder) |

## Open (not blocking headless A2A)

- [ ] Re-arm Bob drain after Grok quota recovers; one canary
- [ ] Developer ID helper for long-term Keychain custody (file credentials are Mini workaround)
- [ ] Optional: Cursor product ask for conversation continue API / MESH listener
- [ ] Do **not**: dual claimers, mirror-as-interactive, Codex `event-driven` for inbound

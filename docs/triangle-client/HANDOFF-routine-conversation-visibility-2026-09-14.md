# HANDOFF — Routine→conversation visibility spike

**Date:** 2026-09-14 (America/Los_Angeles) / 2026-09-15 UTC  
**Repository:** `triangle-client` (Mini)  
**Parent design note:** [2026-09-14-grok-fabric-vs-mesh-wake.md](2026-09-14-grok-fabric-vs-mesh-wake.md)  
**Prior spike:** [HANDOFF-interactive-grok-bob-spike-2026-09-14.md](HANDOFF-interactive-grok-bob-spike-2026-09-14.md) (conversation-owner **no-go**)

## Goal

Prove whether webhook-triggered `mesh-bob-wake-drain` runs appear in Bob’s **main Grok conversation** (Slack-listener parity) vs **Run history only**, without a second MESH claimer and without UI-automation-as-continue-API evidence.

## Procedure executed

| Step | Result |
| --- | --- |
| Preflight | `bob` `deliveryMode=grok-bot` enabled; binding enabled; Client LaunchAgent running; Grok Bot.app running (v0.51.0) |
| Cursor before | `grok-bot-wake-cursor.json` → `{"cursor":257}` |
| Canary send | From `codex-bob-test` via `mesh send --reply-required` into `room_14ee0ee439464a81ade0085abf904340` |
| Nonce | `VIS-SPIKE-20260915T050711Z-72841` |
| Codex event | seq **238** `event_307ac2a59a1643dd930008e19d1a1501` |
| Bob MESH reply | seq **239** `Acked. Echo: VIS-SPIKE-20260915T050711Z-72841` (`replyRequired: false`) |
| Cursor after | `{"cursor":259}` (wake advanced) |
| Dual claimer | None — spike operator did not claim Bob’s mailbox |

## Visibility evidence

| Check | Outcome |
| --- | --- |
| MESH + webhook path | **PASS** — wake cursor advanced; Bob echoed nonce and acked |
| New `sand-client-persistence` blob containing nonce after run | **Not found** — newest conversation-sized blobs mtime predates spike (~19:45 PT); post-spike files were only caches/session markers |
| Screencapture / front-window UI snapshot | **Failed** (no Screen Recording permission for agent) |
| Operator visual confirm of main chat vs Run history | **Not obtained in this pass** |
| Human “Stop now” / mid-run redirect | **Not tested** |
| Routine uses Bob conversation memory vs isolated run context | **Not tested** |

## Verdict

**Visibility: unproven / fail-closed → do not reopen interactive definition.**

- Conversation-owner remain **no-go** (no continue-by-`conversationId` API — unchanged).
- **Routine-visible** interactive candidate does **not** pass: we cannot show the run in Bob’s main conversation from available evidence; local client persistence did not record the nonce.
- Keep **Codex App Server** as the human-visible A2A surface; keep `mesh-bob-wake-drain` as sole Bob MESH owner.

## Recommendation

1. Stop adapter design for conversation-owner and for routine-visible-as-green until an operator (or Cursor) can show Run history **and** main-chat transcript for a webhook canary.
2. Optional operator follow-up (manual, 2 minutes): open Bob → conversation + Routines → Run history; search `VIS-SPIKE-20260915T050711Z-72841`; note where it appears; append to this handoff.
3. Do not build a MESH Connect plugin / Slack-listener clone (see design note).
4. Product ask to Cursor remains: conversation-targeted continue API and/or first-party MESH listener — not Triangle inventing Connect registration.

## Non-goals honored

- No mirror scored as interactive go  
- No dual claimers  
- No UI automation as continue-API evidence  
- Codex stays `mcp-interactive` (not flipped to `event-driven`)

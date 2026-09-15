# HANDOFF — Interactive Grok Bob conversation-owner spike

**Date:** 2026-09-14 (America/Los_Angeles)  
**Repository:** `triangle-client` (Mini)  
**Verdict:** **no-go**  
**Owner next:** none for conversation-owner adapter; keep headless `mesh-bob-wake-drain` as sole Bob MESH owner

## Mode lock

| Mode | Who reasons | Who commits MESH reply | Counts as interactive go? |
| --- | --- | --- | --- |
| Conversation-owner | Bound Grok conversation | Sole txn owner using that response | Yes — **target** |
| Mirror | Headless routine | Headless routine; UI gets copy | **No** |

Interactive Bob is defined only as conversation-owner mode. Mirror/notify-after-headless is out of scope for green.

## Phase 1 — Read-only API inventory

### Live Mini binding (metadata only)

| Field | Value |
| --- | --- |
| profile | `bob` |
| MESH agentId | `agent_9f494dbb1906489193cc89237b19c01f` |
| grokAgentId | `12aedccc-8662-4a7f-84da-3d35c9e97842` |
| wakeMode | `webhook` (only value accepted by `validateGrokBotBinding`) |
| Webhook host | `api2.cursor.sh` |
| Webhook path shape | `/automations/webhook/<uuid>` |

Wake body from [`packages/agent-worker/src/grok-bot-wake.mjs`](../../packages/agent-worker/src/grok-bot-wake.mjs): `source`, `type: "mesh.mailbox.wake"`, installation/instance/agent/profile, `highWatermark`, `reason`. **No `conversationId`.** `grokAgentId` is stored in binding JSON and is **not** POSTed.

Auth for wake: per-routine Bearer key in `grok-bot-webhook.key` (`0600`). Must not reuse MESH `mesh_` / `mesh_watch_` credentials as HTTP bearer (separate stores).

### Capability table

| Capability | Available? | Auth | Evidence | ID stability | Response correlation |
| --- | --- | --- | --- | --- | --- |
| Fire Grok Bot routine webhook → Sand **run** | **Yes** | Routine Bearer → `api2.cursor.sh/automations/webhook/<uuid>` | [cursor.com/help/grok-bot/routines](https://cursor.com/help/grok-bot/routines); triangle-client `grok-bot-wake.mjs`; live Mini HTTP 200 + run accept | Webhook UUID stable while routine/key unchanged | 200 = run **accepted**, not finished; correlate via Run history / MESH nonce inside routine — not via conversation continue API |
| List Grok Bot conversations (official API) | **No** | — | Official help: UI chat + Routines only | — | — |
| Get Grok Bot transcript (official API) | **No** | — | Docs: check “Run history, or the conversation” **in the UI** | — | — |
| Continue / run turn in existing conversation by stable `conversationId` (official API) | **No** | — | Routines webhook starts a **routine run** with body + instruction; no conversation-target continue endpoint documented | No public continue ID surface | N/A |
| UI-only human chat continue | **Yes** | Cursor/Grok Bot sign-in | [getting-started / how-tos](https://cursor.com/help/grok-bot/getting-started) | History retained in product UI | Human-visible only; not an API |
| Undocumented local Sand host gateway (`127.0.0.1:1340` listAgents/sendPrompt) | **Not present on Mini** | — | No listener on `:1340`; no `sand-data/gateway.json` under Cursor/Grok paths checked 2026-09-14 | — | Treat as unavailable here |
| Cursor Cloud Agents follow-up / conversation APIs | **Different product** | Cursor API key → `api.cursor.com` | Cloud Agents docs | Cloud agent IDs | Not Grok Bot Sand chat |
| xAI Responses `previous_response_id` | **Different product** | xAI API key → `api.x.ai` | xAI docs | Response IDs ~30d | Does not bind Sand/Grok Bot UI conversation |

Public probes: `api2.cursor.sh/` returns 200 plaintext; `/openapi.json` and `/automations` 404 without inventing private endpoints.

### Auth boundaries (must not blur)

- Routine webhook key ↔ wake only.
- MESH mailbox / watch credentials stay in helper Keychain or file credential store; never as automation Bearer.
- DashboardService / account usage APIs (used historically for quota reports) are **not** conversation-continue APIs.

## Phase 3 — Conversation spike

**Status:** **Not executed** — blocked by inventory.

The strengthened spike requires an official (or otherwise accepted) continue/run-turn surface against an operator-selected conversation ID, a model response in that same conversation, reconnect readback, and no mailbox claim. No such official API exists. UI automation / focus hacks are excluded as evidence. Local unofficial gateway is absent on this Mini.

Therefore the spike cannot meet **pass** criteria without inventing an unsupported path. Per plan: treat as **no-go** (routine-only remote surface), not as inconclusive-unsafe (no partial conversation API was found on Mini that merely fails correlation).

## Verdict

**no-go**

- Official remote integration for Bob remains: **webhook → Sand routine run** (`mesh-bob-wake-drain`).
- Conversation-owner interactive Bob is **not** implementable on documented APIs today.
- Do **not** build a conversation bind adapter, dual claimer, or mirror scored as interactive go.

### Recommendation

1. Keep headless `mesh-bob-wake-drain` as the **sole** Bob MESH transaction owner.
2. Humans observe A2A results via the bound Codex App Server thread (separate track), not via injecting into Grok UI.
3. Re-open conversation-owner work only if Cursor ships a documented continue-conversation API with stable IDs and response correlation.

## Related

- [HANDOFF-grok-bot-wake-2026-09-13.md](HANDOFF-grok-bot-wake-2026-09-13.md)
- [2026-09-13-unattended-wake-hosts.md](2026-09-13-unattended-wake-hosts.md)
- [HANDOFF-bob-general-work-over-mesh-2026-09-13.md](HANDOFF-bob-general-work-over-mesh-2026-09-13.md)

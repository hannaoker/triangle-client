# Unattended wake hosts (2026-09-13)

Updated: 2026-09-13 (America/Los_Angeles).

This is the current architecture note for unattended MESH inbound. It supersedes
chat-era assumptions that “Bob event-driven” already meant Grok Bot Bob, or that
Codex App Server and Triangle Client event-driven drain were different products.

Phase 2 durable wake/scheduling remains **Complete**. This note does not reopen
that bar. See
[phase 1/2 completion criteria](2026-09-05-realtime-mailbox-phase-1-2-completion-criteria.md)
and [Phase 2](2026-09-03-realtime-mailbox-phase-2.md).

## One workflow, three host adapters

The workflow is the same for every mailbox identity:

**watch hint → wake → claim → reason → reply → ack**

`replyRequired: false` plus `inReplyToEventId` on autonomous replies. Wake receipt
and model-turn completion are not MESH acknowledgements. Slice 6 / 6.1 owns
claim, outbound initiate, and ack.

Only the **host that receives the wake** changes:

| Identity | Host that must wake | Adapter |
| --- | --- | --- |
| Grok Bot **Bob** (`bob`) | The existing Grok Bot Bob session | **Native Grok Bot wake** (`deliveryMode: grok-bot` + `grokBotWake`) |
| Interactive **Codex** (`codex-bob-test` and later) | The existing Codex / ChatGPT.app conversation | **Shared Codex App Server** (`deliveryMode: mcp-interactive` + `appServerWake`) |
| Temporary / legacy drain | Headless runner under supervisor | `event-driven` + `eventWake` (not Bob production) |

Do **not** treat a headless `codex exec` under Bob’s MESH identity as Bob. That
was a transport proof: the mailbox identity `bob` can complete the loop. The
reasoner was Codex, not Grok Bot Bob.

Do **not** flip `codex-bob-test` to `event-driven` to “finish” Codex inbound.
That would spawn headless `codex exec`, not wake the interactive session App
Server exists to support.

Do **not** route Bob through Codex App Server. Grok Bot wake is a parallel
adapter: watch → webhook POST → Bob claims/replies/acks.

## Shared core (already the product)

- MESH installation watch grant + held `watch-poll` (notification-only).
- Signed helper Keychain custody (`mesh_watch_` never in Node).
- Supervisor bootstrap: secret-free membership + per-profile drain credentials
  (event-driven) or host bindings (App Server / Grok Bot).
- Mailbox client: `listUnread` → `completeAndAcknowledge` (claim → reason →
  append `message.created` → ack).
- Trusted transaction proxy (Slice 6 / 6.1) for claim / outbound initiate / ack.

`mcp-interactive` and `grok-bot` profiles may join the installation watch grant as
**notify members** when their durable binding matches the instance. They stay off
`eventWake` drains.

- Interactive Codex stays `mcp-interactive` and is woken via `appServerWake`.
- Bob flips to `grok-bot` and is woken via `grokBotWake` (webhook). Bob owns
  claim/reply/ack after wake; the Node adapter does not.

**Actor constraint:** `mcp-interactive` cannot act as the watch grant actor.
`grok-bot` may act (Bob is the natural grant owner). Prefer an event-driven
actor when one is available beside notify-only hosts.

## What is proven (Mini, 2026-09-13)

Production MESH (`https://thetriangle.dev`):

- Watch routes enabled (`MESH_MAILBOX_WATCH_ENABLED`).
- Watch tables migrated (`0013`, `0014`).
- Empty-body join / finalize / revoke accepted (Vercel leaves a stream on
  body-less POST; shipped as `07dbba7` on `codex/the-triangle`).

Triangle Client on Mini (`inst_EaA3qkuzOuQwTSFw`):

- Profile `bob`: historically `event-driven` + `runtimeAdapter: codex` as a
  **temporary** reasoner (watch grant actor; identity canary proven). Native
  Grok Bot wake replaces that temporary host — see
  [HANDOFF-grok-bot-wake-2026-09-13.md](HANDOFF-grok-bot-wake-2026-09-13.md).
- Identity proof (temporary host): `codex-bob-test` sent `message.created` canary
  `BOB-WATCH-85b9b18a` → Bob mailbox claimed → reply event sequence 43 echoed
  the nonce → ack. No supervisor restart, no manual Bob prompt.
- Profile `codex-bob-test`: `mcp-interactive`. Eligible as a **notify**
  watch-grant member when `app-server-binding.json` matches its instance.
  Durable shared App Server LaunchAgent `dev.thetriangle.shared-app-server` holds
  a bound ChatGPT thread and writes Application Support binding/token/cursor.
  Swift emits live `appServerWake`; Node settles MESH reply+ack after desktop
  turn. Unattended LaunchAgent loop is **LIVE** (see
  [HANDOFF-appserver-wake-2026-09-13.md](HANDOFF-appserver-wake-2026-09-13.md)).

Example Mini IDs (docs only, no secrets):

| Field | Value |
| --- | --- |
| Installation | `inst_EaA3qkuzOuQwTSFw` |
| Bob instance | `3356f7bfb8e902f4b519d8238e3555e4974217898af96bed249cf0cfb729c1eb` |
| MESH bob agent | `agent_582567705a9348c38f18c91d2bac9dd8` |
| Grok agent | `12aedccc-8662-4a7f-84da-3d35c9e97842` |

Operator canary rules that matter:

- Event type must be `message.created`. Type `message` is skip-acked with no
  reply.
- Room appends need workload JWT + DPoP. Permanent `mesh_` bearer alone 401s
  on `/api/v1/rooms/{id}/events`.
- Hermes runner under the supervisor sandbox is **not** a working Bob reasoner
  today (`No module named 'encodings'`). Isolated `CODEX_HOME` needs Codex
  `auth.json` provisioned; copying from the shared Codex model home was a local
  operator workaround, not a release installer behavior.

## Binding files (Grok Bot)

Under `~/Library/Application Support/The Triangle/client/` (operator-local;
never commit secrets):

| File | Role |
| --- | --- |
| `grok-bot-binding.json` | Metadata: `adapterVersion`, `enabled`, `installationId`, `instanceId`, `agentId`, `profile`, `grokAgentId`, `wakeMode:"webhook"` |
| `grok-bot-webhook.url` | HTTPS webhook URL (`0600`) |
| `grok-bot-webhook.key` | Bearer key (`0600`) |
| `grok-bot-wake-cursor.json` | `{"cursor":N}` |

Install helper: `scripts/macos/install-grok-bot-wake-binding.sh`.

## Next work (in order)

1. **Native Grok Bot wake for Bob (this track).** Operator flip on Mini:
   install binding → set `deliveryMode: grok-bot` → stop/start LaunchAgent →
   `watch-ensure` → canary. Bob routine `mesh-bob-wake-drain` is already saved;
   URL/key binding is operator-side.
2. **Codex App Server ops.** Unattended loop is live; prefer Developer ID helper
   for long-term Keychain custody. Do not flip Codex to `event-driven`.
3. Optional: installer-provision Codex/Hermes auth into instance `*_HOME`;
   Hermes sandbox encodings; public `mesh` binding flags.

## Pointers

- Grok Bot wake handoff:
  [HANDOFF-grok-bot-wake-2026-09-13.md](HANDOFF-grok-bot-wake-2026-09-13.md)
- Codex App Server track and Gate A runbook:
  [codex-desktop-wake-handoff.md](codex-desktop-wake-handoff.md)
- App Server unattended handoff:
  [HANDOFF-appserver-wake-2026-09-13.md](HANDOFF-appserver-wake-2026-09-13.md)
- Operator install / enroll / watch-ensure:
  [e2e-operator-runbook.md](e2e-operator-runbook.md)
- MESH watch contract: `the-triangle` ADR 18
  (`docs/adrs/0018-realtime-mailbox-watch-and-leases.md`)

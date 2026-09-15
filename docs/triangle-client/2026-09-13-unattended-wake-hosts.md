# Unattended wake hosts (2026-09-13)

Updated: 2026-09-14 (America/Los_Angeles).

This is the current architecture note for unattended MESH inbound. It supersedes
chat-era assumptions that “Bob event-driven” already meant Grok Bot Bob, or that
Codex App Server and Triangle Client event-driven drain were different products.

Phase 2 durable wake/scheduling remains **Complete**. This note does not reopen
that bar. See
[phase 1/2 completion criteria](2026-09-05-realtime-mailbox-phase-1-2-completion-criteria.md)
and [Phase 2](2026-09-03-realtime-mailbox-phase-2.md).

## Shared watch grant + per-host cursors

Multiple wake bridges may share one installation watch grant but keep **separate**
cursor files (`app-server-wake-cursor.json`, `grok-bot-wake-cursor.json`, …).
`watch-poll` can return events for agents that are not in a given bridge’s
profile set. The shared wake client must still advance that bridge’s cursor to
the poll response tip when the batch matches zero local profiles; otherwise the
bridge re-polls the same cursor forever and never reaches a held tip poll.

After deploying that fix, an already-stuck cursor may still need a one-time bump
to the installation tip (see
[HANDOFF-appserver-wake-2026-09-13.md](HANDOFF-appserver-wake-2026-09-13.md)).

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

Watch grant custody notes:

- `watch-status` can report `finalized` + `listenerReady` while the local
  `mesh_watch_` secret is revoked. Do not treat status alone as poll-ready.
- Current `watch-ensure` discards a stale local binding on
  `replacement_unauthorized` / `watch_credential_invalid` and recreates once
  without a replacement header. Rebuild/reinstall the helper for that path.
- Source now makes runtime poll rejection recoverable: the supervisor stops the
  affected bridge, performs one installation-scoped `watch-ensure`, and resumes
  every bridge from its own durable cursor. Concurrent App Server / Bob failures
  share one renewal generation instead of racing grant replacements. This is
  covered by an expiry → renew → two-cursor resume → exactly-once wake test.
  The Mini was rebuilt/reinstalled on 2026-09-14; the supervisor remained live
  after recreating the expired grant and both host cursors advanced.
- The first live recreate exposed a second defect: the stale-replacement retry
  reused the first request's DPoP proof, so MESH rejected the replay as
  `agent_auth_required`. `WatchGrantService` now mints fresh authorization
  headers for the retry. The regression requires two distinct DPoP proofs.

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

## Operator canary rules that matter

- Event type must be `message.created`. Type `message` is skip-acked with no
  reply.
- Room appends need workload JWT + DPoP. Permanent `mesh_` bearer alone 401s

### Rebuilt-runtime canary (PARTIAL, 2026-09-14)

- Codex sent sequence 214, event
  `event_d27a3ea68f064484a5ef34096010ce5c`, nonce
  `CODEX-BOB-LIVE-20260914T1910PT`.
- The rebuilt supervisor stayed running and both Grok Bot / App Server durable
  watch cursors advanced to 234, proving MESH watch receipt and local fan-out.
- Bob's pending mailbox became empty, but no threaded room reply appeared in
  more than two minutes. Therefore the watch-renewal fix is live, while the
  downstream Grok routine claim/reason/reply/ack chain is **not yet proven**.
  Do not report end-to-end unattended Bob communication as achieved from this
  canary.
  on `/api/v1/rooms/{id}/events`.
- Hermes runner under the supervisor sandbox is **not** a working Bob reasoner
  today (`No module named 'encodings'`). Isolated `CODEX_HOME` needs Codex
  `auth.json` provisioned; copying from the shared Codex model home was a local
  operator workaround, not a release installer behavior.

## A2A receipt-only contract (ping-pong hard stop)

Autonomous A2A rooms must not turn polite closures into fresh work. Wire field
`body.replyRequired` is the control plane (not Acked/Acknowledged text matching).

### Codex App Server (triangle-client)

- Helper `transaction-claim-next` parses `replyRequired` from mailbox list items.
- When the list omits `replyRequired`, fetch the room event body before deciding
  (absent must not default to work-required).
- When `replyRequired: false`: claim → ack immediately, `shouldStartModel: false`,
  no open model turn, no MESH reply (`receiptOnly: true`).
- Node durable resolver skips admit for receipts. Older helpers that leave an open
  claimed receipt fail closed and require upgrade; the general ack command cannot
  prove that such a claim is receipt-only.
- Admitted work remains reply-before-ack: empty assistant text or `[NO_REPLY]`
  fails settlement and leaves the claim retryable. Redeploy the worker-runtime
  bundle when `prepare-runtime` is fixed.

### Live proof (2026-09-14)

Quiet-room canary on `room_14ee0ee439464a81ade0085abf904340`: Codex seq 210
(`replyRequired: true`) → Bob seq 211 exact nonce echo (`replyRequired: false`) →
**zero** Codex MESH posts for 60s. Details:
[HANDOFF-a2a-ping-pong-acknowledgment-loop-2026-09-13.md](HANDOFF-a2a-ping-pong-acknowledgment-loop-2026-09-13.md).

### Bob Grok Bot routine `mesh-bob-wake-drain` (external — verify/apply in Grok Bot Sand)

| Inbound | Action |
| --- | --- |
| Canary nonce present | Reply `Acked. Echo: <nonce>`, then `transaction-ack` |
| `replyRequired: true` work | Do the work, reply `status: completed\n<result>`, then `transaction-ack` |
| `replyRequired: false` (any text, including completions and "Acknowledged.") | **Do not reply.** Run `transaction-ack` only and exit |

Remove any fallback rule like "No nonce → brief Acked. OK". That rule caused the
Seq 169–192 ping-pong.

### Re-enable checklist

1. Rebuild/reinstall macOS helper so claim-next emits receipt-only behavior.
2. Update Bob’s `mesh-bob-wake-drain` prompt per the table above.
3. Set `app-server-binding.json` `enabled: true`.
4. Canary: `replyRequired: true` work request → one substantive Bob result →
   Codex must **not** post a MESH ack that re-wakes Bob → room goes quiet.

See
[HANDOFF-a2a-ping-pong-acknowledgment-loop-2026-09-13.md](HANDOFF-a2a-ping-pong-acknowledgment-loop-2026-09-13.md).

## Next work (in order)

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
   `watch-ensure` → canary. Verify/update Bob routine `mesh-bob-wake-drain`
   against the receipt-only table above; URL/key binding is operator-side.
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

# Unattended wake hosts (2026-09-13)

Updated: 2026-09-13 (America/Los_Angeles).

This is the current architecture note for unattended MESH inbound. It supersedes
chat-era assumptions that “Bob event-driven” already meant Grok Bot Bob, or that
Codex App Server and Triangle Client event-driven drain were different products.

Phase 2 durable wake/scheduling remains **Complete**. This note does not reopen
that bar. See
[phase 1/2 completion criteria](2026-09-05-realtime-mailbox-phase-1-2-completion-criteria.md)
and [Phase 2](2026-09-03-realtime-mailbox-phase-2.md).

## One workflow, two host adapters

The workflow is the same for every mailbox identity:

**watch hint → wake → claim → reason → reply → ack**

`replyRequired: false` plus `inReplyToEventId` on autonomous replies. Wake receipt
and model-turn completion are not MESH acknowledgements. Slice 6 / 6.1 owns
claim, outbound initiate, and ack.

Only the **host that receives the wake** changes:

| Identity | Host that must wake | Adapter |
| --- | --- | --- |
| Grok Bot **Bob** (`bob`) | The existing Grok Bot Bob session | **Native Grok Bot wake** (not built yet) |
| Interactive **Codex** (`codex-bob-test` and later) | The existing Codex / ChatGPT.app conversation | **Shared Codex App Server** (session canary proved on Mini 2026-09-13; LaunchAgent live binding still open) |

Do **not** treat a headless `codex exec` under Bob’s MESH identity as Bob. That
was a transport proof: the mailbox identity `bob` can complete the loop. The
reasoner was Codex, not Grok Bot Bob.

Do **not** flip `codex-bob-test` to `event-driven` to “finish” Codex inbound.
That would spawn headless `codex exec`, not wake the interactive session App
Server exists to support.

## Shared core (already the product)

- MESH installation watch grant + held `watch-poll` (notification-only).
- Signed helper Keychain custody (`mesh_watch_` never in Node).
- Supervisor bootstrap: secret-free membership + per-profile drain credentials.
- Mailbox client: `listUnread` → `completeAndAcknowledge` (claim → reason →
  append `message.created` → ack).
- Trusted transaction proxy (Slice 6 / 6.1) for claim / outbound initiate / ack.

`mcp-interactive` profiles may join the installation watch grant as **notify-only**
members (so App Server wake receives hints). They stay off `eventWake` drains.
Interactive Codex stays `mcp-interactive` and is woken via `appServerWake`, not via a
second mailbox owner / `codex exec`.

## What is proven (Mini, 2026-09-13)

Production MESH (`https://thetriangle.dev`):

- Watch routes enabled (`MESH_MAILBOX_WATCH_ENABLED`).
- Watch tables migrated (`0013`, `0014`).
- Empty-body join / finalize / revoke accepted (Vercel leaves a stream on
  body-less POST; shipped as `07dbba7` on `codex/the-triangle`).

Triangle Client on Mini (`inst_EaA3qkuzOuQwTSFw`):

- Profile `bob`: `event-driven`, currently `runtimeAdapter: codex` as a
  **temporary** reasoner. Watch grant finalized, `listenerReady: true`.
- Identity proof: `codex-bob-test` sent `message.created` canary
  `BOB-WATCH-85b9b18a` → Bob mailbox claimed → reply event sequence 43 echoed
  the nonce → ack. No supervisor restart, no manual Bob prompt.
- Profile `codex-bob-test`: still `mcp-interactive`. Eligible as a **notify-only**
  watch-grant member when `app-server-binding.json` matches its instance.
  Durable shared App Server LaunchAgent `dev.thetriangle.shared-app-server` holds
  thread `01a099c7-9aad-7e11-904d-fdb4daf24da1` and writes Application Support
  binding/token/cursor. Swift emits live `appServerWake`; Node settles MESH
  reply+ack after desktop turn. Live Bob→Codex LaunchAgent canary waits on
  Keychain Allow after ad-hoc helper re-sign (see
  [HANDOFF-appserver-wake-2026-09-13.md](HANDOFF-appserver-wake-2026-09-13.md)).
  Earlier Gate A disposable session canary:
  nonce `CODEX-APPSERVER-mtzhbdf9-a9e00a`, thread
  `01a099a2-a2b0-7832-89d3-e3d8ece8234b`. See
  [codex-desktop-wake-handoff.md](codex-desktop-wake-handoff.md) Gate E.

Operator canary rules that matter:

- Event type must be `message.created`. Type `message` is skip-acked with no
  reply.
- Room appends need workload JWT + DPoP. Permanent `mesh_` bearer alone 401s
  on `/api/v1/rooms/{id}/events`.
- Hermes runner under the supervisor sandbox is **not** a working Bob reasoner
  today (`No module named 'encodings'`). Isolated `CODEX_HOME` needs Codex
  `auth.json` provisioned; copying from the shared Codex model home was a local
  operator workaround, not a release installer behavior.

## Next work (in order)

1. **Native Grok Bot wake for Bob.** Same MESH watch + claim/reply/ack. The
   wake adapter must target Grok Bot Bob’s session. Do not keep `codex exec` as
   Bob’s production host. Do not route Bob through Codex App Server unless a
   later review proves Grok Bot can attach as a second App Server client.
2. **Production-bind Codex App Server** for `codex-bob-test`: **shipped on Mini**
   (shared App Server LaunchAgent + Swift `appServerWake` + MESH reply/ack).
   Remaining: one Keychain Allow after ad-hoc helper re-sign, then live Bob
   nonce canary. Do not flip Codex to `event-driven`.
3. Optional: installer-provision Codex/Hermes auth into instance `*_HOME`;
   Hermes sandbox encodings; public `mesh` binding flags.

## Pointers

- Codex App Server track and Gate A runbook:
  [codex-desktop-wake-handoff.md](codex-desktop-wake-handoff.md)
- Operator install / enroll / watch-ensure:
  [e2e-operator-runbook.md](e2e-operator-runbook.md)
- MESH watch contract: `the-triangle` ADR 18
  (`docs/adrs/0018-realtime-mailbox-watch-and-leases.md`)

# Bob drain nonce-echo reliability fix

**Date:** 2026-09-13 (America/Los_Angeles)  
**Status:** Implemented and locally deployed; source changes remain uncommitted  
**Checkout baseline:** `triangle-client` at `51a4df0` (PR #24 merge)

## Outcome

The unattended Codex-to-Bob canary path completed cleanly after the fix:

- Codex canary: `CODEX-BOB-E2E-20260913T191325PT`
- Outbound event: `event_882df0aec1e94be8a12a5960180a75a7`, room sequence 66
- Bob unattended reply: `event_cfffcdd641be4627b97287d4fde9f791`, room sequence 67
- Reply text: `Acked. Echo: CODEX-BOB-E2E-20260913T191325PT`
- Threading: Bob's reply used the canary event as `inReplyToEventId`
- No intervening bare `Acked.` occurred for this delivery
- Bound Codex task emitted `DESKTOP_SHARED_WAKE_OK CODEX-BOB-E2E-20260913T191325PT`
- No manual Shell reply was used

## Root cause confirmed

The wake webhook intentionally carried only a secret-free notification. The durable
transaction interface persisted delivery and room metadata but not the inbound event
identifier/sequence, and it exposed message text only when the metadata-only mailbox
list happened to include an optional `admitText`. A resumed Grok wake therefore could
hold a valid claim without having a deterministic way to retrieve the inbound nonce.
Prompt hardening alone could not repair this missing data contract, so Bob could take
the no-nonce fallback and send bare `Acked.`.

## Implemented changes

### Durable transaction contract

- `MailboxOpenTransaction` now persists the claimed `inboundEventId` and
  `inboundRoomSequence`; peer message text is still never persisted.
- Existing version-1 transaction records without those optional fields remain
  readable. A legacy open claim cannot use the new read operation and fails closed
  with `invalidState`.
- `transaction-status` exposes the non-secret inbound identifiers on an open claim.

### Exact ephemeral inbound read

- Added `transaction-read-inbound --profile <profile> --protocol <protocol>`.
- The helper fetches exactly one room-history event using
  `after_sequence = inboundRoomSequence - 1` and `limit = 1`.
- The response must match the claimed room, event ID, and room sequence.
- The event must be `message.created`, contain canonical nonblank `body.text`, have
  a valid sender, and come from a peer rather than the authenticated local actor.
- Text is bounded to 32 KiB, returned ephemerally, and never stored or logged.

### Reply binding

- If a durable claim has an inbound event ID, `transaction-reply` automatically
  threads to it when the caller omits `inReplyToEventId`.
- A caller-supplied event ID that differs from the durable claim is rejected.

### Bob routine

The active `MESH Bob Wake Drain` Grok routine now requires
`transaction-read-inbound` before constructing every reply. If the read is missing,
unavailable, or inconsistent with the open claim, it records
`inbound_text_unavailable` and stops without replying or acknowledging. For a canary,
it constructs and self-checks exact `Acked. Echo: <nonce>` text; a mismatch records
`nonce_echo_mismatch` and also fails closed. Bare `Acked.` is permitted only after a
verified inbound read establishes that no nonce is present.

## Verification

- Macro-free Swift mailbox transaction contract runner: 30/30 passed.
- Node wake/installer focused tests: 18/18 passed.
- Swift release build: passed.
- Installed helper contains `transaction-read-inbound`, passes strict code-signature
  verification, and `dev.thetriangle.client` is running.
- Bob transaction queue was empty before the canary; no legacy open claim required
  migration or manual completion.
- The first attempted validation send created no event because an older replied Codex
  transaction (delivery 244) still needed acknowledgment. It was safely acknowledged,
  then the fresh canary above was sent successfully.

The standard `swift test` frontend could not launch because this machine's Swift
Testing macro plugin was unavailable. The repository's macro-free host contract
runner was used instead. A broader host run also encounters a pre-existing
`invalidManifest` failure in an unrelated worker-resolver contract; this was not
treated as evidence against the focused mailbox results.

## Source files changed

- `packages/macos-mailbox-helper/Sources/TriangleMailbox/main.swift`
- `packages/macos-mailbox-helper/Sources/TriangleMailboxCore/MCPProxy.swift`
- `packages/macos-mailbox-helper/Sources/TriangleMailboxCore/MCPTransactionRewriter.swift`
- `packages/macos-mailbox-helper/Sources/TriangleMailboxCore/MailboxTransactionModels.swift`
- `packages/macos-mailbox-helper/Sources/TriangleMailboxCore/MailboxTransactionService.swift`
- `packages/macos-mailbox-helper/Sources/TriangleMailboxCore/Models.swift`
- `packages/macos-mailbox-helper/Sources/TriangleMailboxCore/WatchGrantFailure.swift`
- mailbox transaction tests and the macro-free focused test harness

One unrelated test-only compile correction moved a throwing `ProfileName("bob")`
initializer outside a non-throwing assertion autoclosure.

## Deployment and remaining gates

- The local Mini installation was rebuilt with `--install-client --local-ad-hoc`.
- The live Grok routine was updated and saved through Grok Bot.
- Repository edits are not committed or pushed.
- This proves one clean unattended canary. It does not replace any separate 24-hour
  soak, Darwin release evidence, Developer ID signing, or Phase 2 promotion gate.
- App Server thread-binding cleanup, watch-credential automatic healing, and the
  separate wake/status visibility investigation remain follow-up work.
- General-purpose work execution through Bob's MESH drain remains open; see
  `HANDOFF-bob-general-work-over-mesh-2026-09-13.md`.

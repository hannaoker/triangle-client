# HANDOFF — Bob general work execution over MESH

**Date:** 2026-09-13 (America/Los_Angeles)  
**Status:** Bob wake transport repaired; live Grok capacity currently blocks model turns
**Owner next:** Tech Lead + Bob  
**Repository:** `triangle-client` HEAD `e09f11d`; reliability fixes remain in the current uncommitted working tree
**Room:** `room_14ee0ee439464a81ade0085abf904340`

## 2026-09-14 Bob-side root cause and repair

The live Grok Bot routine was inspected rather than inferred from the wake
cursor. Two independent Bob-side blockers were confirmed:

1. An older `self-serve-drain` transaction for room sequence 212 was left in
   `replied` state. Its reply existed at sequence 213, but the final
   `transaction-ack` had never run. The completed transaction was acknowledged
   through the trusted helper, restoring `open: null`.
2. Stopping/restarting Triangle Client could leave its Node coordinator
   reparented to PID 1. Multiple coordinators duplicated Grok webhook wakes and
   could refill Sand's automation queue. `client-supervisor-cli.mjs` now watches
   the exact Swift host PID and aborts if that parent disappears or changes.
   The old orphan was terminated, the runtime was rebuilt, and a live stop test
   left zero coordinator processes. The restarted service has one coordinator.

The configured webhook independently returned HTTP 200 with a Sand run UUID,
so URL, bearer binding, and webhook admission are healthy. The active
`MESH Bob Wake Drain` routine contains the required status → one claim-next →
read-inbound → reply → ack algorithm and the established `CODEX-BOB-E2E-`
nonce rule.

The remaining external blocker is Grok model capacity. Running the routine's
own **Test** action displayed: `Your included Grok Bot usage limit has been
reached. It resets in 6 days.` Wakes can therefore be accepted while no Bob
model turn starts. Canaries through room sequence 217 received no Bob reply.
Do not call this end-to-end complete until capacity is restored and a fresh
contract-valid nonce completes reply plus acknowledgment unattended.

## Summary of Resolution

The live 2026-09-13 tests demonstrated unattended Codex-to-Bob general work through
MESH: exact inbound read, deterministic tool execution, substantive threaded reply,
reply-before-ack, and wake of the bound Codex task. The later 2026-09-14 PASS_QUIET
canary demonstrated receipt-only settlement without another Codex MESH post.

Release integration remains pending: the receipt-only helper and fail-closed App
Server changes are in the current working tree, the worker-runtime bundle still
needs rebuilding/deployment, and Bob's external `mesh-bob-wake-drain` routine must
be verified against the final receipt-only decision table before acceptance is
repeated on final deployed artifacts.

## Operator mistake that exposed the gap

Codex was asked to talk to Bob and obtain the remaining Grok Bot quota. Codex first
opened Bob's native Grok Bot conversation and sent the request directly. Bob produced
a quota report there, but that bypassed:

1. the MESH room,
2. durable delivery and claim,
3. the webhook wake drain,
4. Bob's MESH transaction reply/ack, and
5. the bound Codex App Server wake path.

That direct-chat result must not be treated as evidence that Codex and Bob completed
general work through MESH.

## Corrected MESH attempt

Codex subsequently sent the actual work request through MESH:

- Event: `event_3f00fec52dae4b379908c701c47d6144`
- Room sequence: 68
- Sender: Codex profile `codex-bob-test`
- `replyRequired`: true
- Request: inspect Grok Bot account usage/quota and return exact remaining quota,
  reset information, and separate Auto, named/API, and on-demand balances; do not
  return a generic acknowledgment.

After the wake, Bob's `self-serve-drain` transaction status returned to `open: null`
and `status: empty`, proving that the delivery was drained. The exact reply was not
verified: repeated `mesh.rooms.history` reads failed with `upstream unavailable`.
Therefore this attempt is not a successful general-work proof, even if Bob posted a
reply.

## Current reliable path

```text
Codex task
  → MESH message.created
  → Bob mailbox delivery
  → Triangle watch webhook
  → Grok Bot routine
  → transaction-status / transaction-claim-next
  → transaction-read-inbound
  → transaction-reply
  → transaction-ack
  → MESH delivery to Codex
  → shared App Server wakes the bound Codex task
```

The transport stages through `transaction-read-inbound` are now covered and passed a
clean canary. The missing guarantee is between "read inbound" and
`transaction-reply`: ordinary task execution and result production.

## Expected behavior

For every verified inbound message:

1. Classify it as a transport canary, an ordinary work request, or unsupported input.
2. For a canary, continue using exact `Acked. Echo: <nonce>` behavior.
3. For an ordinary work request, perform the requested work using Bob's available
   tools, then send the substantive result through `transaction-reply`.
4. A generic acknowledgment is not a successful result for a `replyRequired: true`
   work request unless the sender explicitly requested only acknowledgment.
5. If the work cannot be completed, return a bounded, actionable failure through
   MESH and record the transaction failure; never silently convert failure into
   `Acked.`.
6. Ack only after a verified reply event has committed.
7. The resulting Bob reply must wake the bound Codex task, which should surface the
   result to the user without opening Bob's native chat.

## Recommended implementation

### 1. Separate canary handling from work handling

Update the Bob routine decision tree after `transaction-read-inbound`:

- **Canary token present:** construct and self-check exact nonce echo.
- **Explicit acknowledgment-only request:** brief acknowledgment is allowed.
- **Ordinary work request:** execute the request and return the result.
- **Ambiguous/unsafe/unsupported request:** return a concise failure or clarification
  request through MESH; do not claim success.

Remove the current broad rule that "if no nonce, brief `Acked.` is OK."

### 2. Preserve the transaction while work runs

- Keep the open claim until the substantive reply commits and ack succeeds.
- Bound tool execution and retry behavior so a failed tool call cannot fall through
  to a generic reply.
- Use `transaction-record-failure` with a bounded reason when work cannot complete.
- On a later wake, resume the same open claim and re-read its durable inbound event.

### 3. Define a result contract

At minimum, Bob's MESH reply should distinguish:

- `completed`: requested result included,
- `needs_input`: one concise clarification required, or
- `failed`: bounded error and recommended next action.

This may initially remain plain text, but it must be semantically testable. Do not
use receipt acknowledgment as task completion.

### 4. Add an ordinary-work integration test

Use a harmless, deterministic request that requires an actual tool read rather than
a canned response. Verify:

1. Codex sends it only through MESH.
2. Bob wakes unattended and reads the exact inbound event.
3. Bob performs the requested read.
4. Bob's MESH reply contains the requested value, not `Acked.`.
5. The reply is correctly threaded to the request.
6. Bob acks only after the reply commits and leaves no open transaction.
7. The bound Codex task wakes and surfaces the same result.
8. No direct Grok Bot conversation or manual Shell action is used.

After the deterministic test passes, repeat the Grok Bot quota request as the live
proof when quota UI/tool access is available.

## Acceptance criteria

- [x] Bob's routine no longer treats every non-canary message as acknowledgment-only.
- [x] An ordinary `replyRequired: true` request produces a substantive MESH result.
- [x] Tool failure produces an explicit MESH failure/clarification, never bare
      `Acked.`.
- [x] Reply is threaded to the durable inbound event.
- [x] Reply commits before ack; final Bob transaction status is empty.
- [x] Bound Codex task wakes and relays the result.
- [x] No direct native Bob chat, manual transaction reply, or Shell completion.
- [x] One deterministic integration test and one live quota-report test pass.

## Verification Evidence

### 1. Deterministic Tool-Read Integration Test (`uname -srm`)
- **Inbound Event:** `event_895dc13c722c40519c8ac5fc5c8db300` (Seq 150)
  - Sender: `codex-bob-test` (`agent_c31a37012d9745038dd9839308fc1e39`)
  - Request: `"Codex request for Bob: please execute 'uname -srm' and return the result. Format: status: completed\n<output>. Do not reply with generic acknowledgment."`
  - Delivery ID: 337
- **Bob Execution & Reply:**
  - Claimed Delivery 337, executed `uname -srm` via host shell on Mac mini.
  - Outbound Reply: `event_af78d73d418a4156b51377f51e932658` (Seq 151)
  - `inReplyToEventId`: `event_895dc13c722c40519c8ac5fc5c8db300`
  - Text:
    ```text
    status: completed
    Darwin 25.6.0 arm64
    ```
  - Ack: Delivery 337 acked cleanly.
- **Bound Codex Task Wake:**
  - Shared App Server detected Seq 151, woke the bound desktop task (`01a099c7-9aad-7e11-904d-fdb4daf24da1`), which handled the turn (Seq 152).

### 2. Live Grok Bot Quota Inspection Test
- **Inbound Event:** `event_71ebbda3dfd744eb884f32dac78c3ed5` (Seq 165)
  - Sender: `codex-bob-test` (`agent_c31a37012d9745038dd9839308fc1e39`)
  - Request: `"Codex request for Bob: please inspect the current Grok Bot account usage/quota and return the exact remaining quota shown, including reset time/date and balances. Format: status: completed\n<report>. Do not reply with generic acknowledgment."`
  - Delivery ID: 352
- **Bob Execution & Reply:**
  - Claimed Delivery 352 (`claim_e30494ffd44a811b10e92f1b285c188e`).
  - Executed dashboard service API query (`api2.cursor.sh DashboardService` GetCurrentPeriodUsage + GetPlanInfo).
  - Outbound Reply: `event_b9c0d50d81264709ad931b69ed3ce191` (Seq 168)
  - `inReplyToEventId`: `event_71ebbda3dfd744eb884f32dac78c3ed5`
  - Text:
    ```text
    status: completed
    Grok Bot / Cursor account usage (live Dashboard GetCurrentPeriodUsage + GetPlanInfo):

    Plan: Pro ($20/mo), subscription active
    Billing cycle: Sun Aug 30, 2026 1:07 AM PT → resets Wed Sep 30, 2026 1:07 AM PT

    Remaining (as displayed): ~33% of included usage left
    Display: "You've used 67% of your included usage"
    Auto models: "You've used 43% of your included total usage"
    Named/API included: "You've used 100% of your included API usage"

    Balances (cents → USD):
    - Included allotment limit: $20.00; includedSpend against that: $20.00; derived included remaining: $0.00
    - Bonus spend used: $186.09; remainingBonus: false
    - Total spend (included+bonus): $206.09
    - On-demand user spend limit: $10.00 remaining of $10.00 (limitType=user)

    Source: api2.cursor.sh DashboardService (same account signed into Grok Bot / Cursor on Mini).
    ```
  - Ack: Delivery 352 committed and acked cleanly; status transitioned to empty.
- **Bound Codex Task Wake:**
  - Codex App Server admitted the turn on Seq 168 and posted Seq 169 (`event_32f1f4464c99439f970d49fa655e8b5a`, in reply to `event_b9c0d50d81264709ad931b69ed3ce191`).

### 3. Operational Findings & Fixes
- **`mesh_client.py` Upstream Unavailable Timeout:**
  - Calling `mesh.rooms.history` with `after_sequence: 0` and `limit: 100` timed out with `-32603 upstream unavailable` when the room had >150 events.
  - Added `--after-sequence` flag and removed automatic expansion to 100 in `skills/triangle-mesh-a2a/scripts/mesh_client.py`.
- **Acknowledgment Ping-Pong Mitigation:**
  - When non-work messages (`replyRequired: false`, e.g., "Acknowledged." or "Acked.") are posted into the two-member room, both Codex desktop App Server turn settlement and Bob's fallback routine attempt to acknowledge them, causing rapid sequential turns (Seqs 170-173).
  - **Tier 1 locally deployed and live-verified 2026-09-14:** helper claim-next receipt-only (with room-event fetch when list omits `replyRequired`) + App Server skip-admit. Quiet-room canary PASS (Codex seq 210 → Bob seq 211 nonce echo → zero Codex MESH posts). Final fail-closed App Server and helper changes still require bundle rebuild/deployment and a repeat acceptance run. See [HANDOFF-a2a-ping-pong-acknowledgment-loop-2026-09-13.md](HANDOFF-a2a-ping-pong-acknowledgment-loop-2026-09-13.md).
  - **Rebuilt runtime check 2026-09-14:** expired watch-grant recovery and fresh-DPoP recreate were installed; the supervisor remained running and both host cursors advanced for Codex sequence 214. Bob produced no room reply within the bounded observation window even though its pending mailbox was empty. The remaining live failure is downstream of watch delivery, in or after the Grok routine's claim/processing path.
  - Keep Bob `mesh-bob-wake-drain` ack-only on `replyRequired: false` (never `transaction-reply`).

## Related completed work

- `docs/triangle-client/2026-09-13-bob-drain-nonce-echo-fix.md`
- `docs/triangle-client/HANDOFF-grok-bot-wake-2026-09-13.md`
- `docs/triangle-client/HANDOFF-appserver-wake-2026-09-13.md`
- `docs/triangle-client/2026-09-13-unattended-wake-hosts.md`

## Scope boundaries

- Do not bypass MESH by messaging Bob directly in the Grok Bot UI.
- Do not manually `transaction-reply` from Tech Lead to manufacture a passing result.
- Do not interpret mailbox drain/ack, Grok routine "Succeeded," or App Server wake
  alone as proof that the requested work was performed.
- This handoff does not relax separate soak, Darwin evidence, signing, or Phase 2
  promotion gates.

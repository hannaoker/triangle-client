# Design: Issue #43 - Stop Grok Bot Wakes from Spending Quota on Receipts and Exhausted Retries

**Date:** 2026-09-24  
**Author:** Hermes  
**Reviewer:** Codex (`agent_4aced27b92cb436dba06cc840756b072`, via Triangle MESH A2A)  
**Repository:** `hannaoker/triangle-client`  
**Issue Reference:** [Issue #43](https://github.com/hannaoker/triangle-client/issues/43)  
**Target Branch:** `fix/issue-43-grok-bot-quota-protection`  

---

## 1. Problem Statement & Root Cause

Bob (`mesh-bob-wake-drain`) spends included model usage on MESH wakeups that do not require an LLM turn. Specifically:
1. **Unconditional Webhook POSTs:** Every MESH watch notification, startup reconciliation (`reconcileStartup`), and resync (`resync_required`) in `packages/agent-worker/src/grok-bot-wake.mjs` immediately POSTs a watermark payload to the `mesh-bob-wake-drain` webhook. That webhook starts a Grok routine Sand run. Classification only happens *after* the model is running.
2. **Ping-Pong Acknowledgment Loops:** In room `room_14ee0ee439464a81ade0085abf904340`, Bob received a completion report (`replyRequired: false`) and acknowledged it with an "Acked." message. Codex and Bob subsequently ping-ponged acknowledgments across ~24 model turns in 5 minutes.
3. **Short Circuit on Long Quotas:** When Grok Bot hits its usage limit ("included Grok Bot usage limit reached, resets at T" days in the future), the webhook returns HTTP 200 (run accepted). The current backoff circuit (`isWebhookQuotaExhaustion`) only inspects HTTP 429 or `resource_exhausted` error bodies, and caps backoff at `MAX_QUOTA_BACKOFF_MS = 15m`. The host therefore keeps waking Bob every 15 minutes against a multi-day quota reset.
4. **Empty Daemon Restarts / Resyncs:** Client restarts call `reconcileStartup` with no pending deliveries, firing an empty routine run.

---

## 2. Core Architecture & Codex Review Invariants

Based on formal review feedback received from Codex over Triangle MESH A2A (`room_a34e2d8424d4497d91830a2875f01844`, Sequence 7):

### Invariant 1: Trusted Helper Serialized Transaction Path (Single-Claimer Protection)
- **Do not use a separate REST/MCP claimer.** Settling receipts directly through raw REST or an uncoordinated client would race Bob's running Grok routine and violate single-claimer guarantees.
- **Use Helper's `self-serve-drain` Path:** Settle receipts exclusively through the trusted macOS mailbox helper's serialized `self-serve-drain` transaction path (`transaction-claim-next`).
- **Yield on Open Work Claims:** If Bob already has an open claim (`store.readOpen() != nil`), the host must defer immediately and avoid interfering with Bob's active transaction.

### Invariant 2: Accurate Event Resolution & Integrity Verification
- When the mailbox list omits `body.replyRequired`, the bridge must resolve the exact room event (`/rooms/{roomId}/events/{eventId}`) and verify the `roomId`, `eventId`, and `sequence` before deciding whether an item is a receipt.
- If classification fails or history is unavailable, the bridge must **never** treat the delivery as an empty mailbox. It must fail-safe and retain a durable retry/reconcile path.

### Invariant 3: Isolation within Grok Bridge (`grok-bot-wake.mjs`)
- Keep Bob-specific filtering strictly encapsulated in `packages/agent-worker/src/grok-bot-wake.mjs`.
- Do **not** modify generic `wake-client.mjs` cursor mechanics. In `wake-client.mjs`, cursor persistence occurs prior to `onWake`. Introducing Bob-specific filtering there could cause message loss or advance cursors over unclassified deliveries during startup/resync.
- Filter and condition wakes during startup and resync inside the Grok bridge's wake handler and reconciliation loop.

### Invariant 4: Decoupled Quota Learning & Multi-Day Reset Backoff ($T$)
- **HTTP 200 Distinction:** HTTP 200 from the webhook dispatcher only confirms that the webhook accepted the run; it does *not* imply that the Grok routine executed successfully without quota exhaustion.
- **Quota Learning Channels:** Multi-day reset timestamps ($T$) must be learned from:
  1. Authenticated routine completion/status payloads (e.g. routine status callback or exit payload).
  2. Direct webhook error responses (e.g. 429/503 with reset time).
  3. Explicit operator cooldown signals / CLI command (`triangle-mailbox quota-cooldown ...`).
- **Atomic Persistence:** Reset timestamp $T$ must be validated and atomically persisted to a local file bound per profile instance (e.g., `grok-bot-quota-reset.json`).
- **Separation of Concerns:** Keep multi-day reset backoff completely separate from transient HTTP 429 exponential backoff (60s–15m).
- **Probing & Operator Clear:** Provide clean expiry probing and operator commands/flags to clear $T$.

### Invariant 5: Opt-in Safety Gate
- Gate the pre-wake receipt classifier behind `TRIANGLE_GROK_BOT_FILTER_RECEIPTS=1` (opt-in initially, defaulting to disabled `0` until live canary verification confirms safety).

---

## 3. Detailed Proposed Changes

### Component A: Pre-Wake Receipt Classifier & Settler (`grok-bot-wake.mjs`)
Before dispatching a webhook POST (`wakeDispatcher.deliver(payload)`):
1. **Gate Check:** If `TRIANGLE_GROK_BOT_FILTER_RECEIPTS !== "1"`, proceed with legacy wake flow directly.
2. **Inspect Open Claims:** Check helper transaction store (`readOpen`). If an open claim already exists for Bob, defer to Bob's routine.
3. **Inspect Unread Deliveries:**
   - Fetch unread deliveries for Bob.
   - For each delivery:
     - Check `delivery.body?.replyRequired`. If missing, query the room event to verify `replyRequired`, room ID, and sequence.
     - If `replyRequired === false`: Settle the receipt through the helper's `claimNext` (which triggers `settleReceiptOnly` under `self-serve-drain`, acknowledging the delivery without requiring a model turn).
     - If `replyRequired === true`: Retain as actionable work.
4. **Wake Decision:**
   - Only call `wakeDispatcher.deliver()` if there is at least one actionable work item (`replyRequired: true`) or an unresolved delivery that could not be verified.
   - If all unread items were receipts and settled, or the mailbox is empty: do not wake the model. Advance watermark / cursor safely.

### Component B: Bridge Startup & Resync Conditioning (`grok-bot-wake.mjs`)
1. Wrap the bridge's `onWake` handler to inspect the reason:
   - For `startup_reconcile` and `resync_reconcile`, run the pre-wake candidate classification first.
   - If no actionable `replyRequired: true` deliveries exist, log quietly and avoid firing the webhook.
   - If classification fails or cannot be resolved, retain the retry path so nothing is skipped.

### Component C: Long-Horizon Quota Reset Circuit Breaker ($T$)
1. **State Persistence:**
   - Maintain `grok-bot-quota-reset.json` atomically in the instance directory.
   - Structure: `{ "resetsAt": "2026-09-27T12:00:00.000Z", "reason": "usage_limit_reached", "updatedAt": "..." }`.
2. **Timestamp Detection:**
   - Parse ISO-8601 or text patterns (`resets (?:at )?([^\n]+)`) from error bodies, status events, or operator inputs.
3. **Circuit Enforcement:**
   - Before any wake attempt, verify `Date.now() < resetsAt`. If circuit is open, suppress wake and log time remaining.
   - Provide an escape hatch (`TRIANGLE_GROK_BOT_CLEAR_QUOTA=1` or manual deletion of the cache file) to reset the circuit.

---

## 4. Verification & Test Plan

1. **Unit & Contract Tests (`packages/agent-worker/test/grok-bot-wake.test.mjs`):**
   - **Receipt Filtering:** Verify `replyRequired: false` delivery is settled through helper without webhook POST when flag is enabled.
   - **Work Delivery:** Verify `replyRequired: true` delivery dispatches webhook POST.
   - **Mixed Batch:** Verify a batch with 3 receipts and 1 work delivery settles receipts and then triggers webhook POST for the work delivery.
   - **Open Claim Deference:** Verify that if an open claim already exists, the pre-wake settler yields and defers to Bob.
   - **Quiet Startup & Resync:** Verify empty mailbox on `startup_reconcile` and `resync_reconcile` produces zero webhook calls.
   - **Multi-day Quota Breaker:** Verify persistent storage and backoff enforcement until $T$.
   - **Fallback Safety:** Verify that unresolvable items fail-open and trigger wake rather than dropping messages.

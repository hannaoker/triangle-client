# HANDOFF — A2A Acknowledgment Ping-Pong Loop & Transaction Settlement Defect

**Date:** 2026-09-13 (America/Los_Angeles)  
**Status:** Tier 1 locally deployed and live-verified (PASS_QUIET canary 2026-09-14); release integration pending
**Owners:** Tech Lead, Agent Architecture, Client Core  
**Impacted Repositories / Components:**
- `triangle-client/packages/agent-worker/src/shared-codex-app-server.mjs`
- `triangle-client/packages/agent-worker/src/helper-transaction-proxy.mjs`
- `triangle-client/packages/macos-mailbox-helper` (claim-next receipt-only + event fetch for `replyRequired`)
- Grok Bot `mesh-bob-wake-drain` routine contract
- MESH wire protocol specification (`replyRequired` lifecycle)

---

## 1. Executive Summary

During end-to-end testing of unattended general work over MESH between Codex desktop (`codex-bob-test`) and Bob (`dawn-hermes-mini-seven` / `bob`), the core work succeeded (deterministic tool execution and live quota inspection). However, immediately following task completion, the system entered an **infinite autonomous ping-pong loop** between the two agents:

```text
Sequence 168 (Bob):   "status: completed\n<quota report>" (replyRequired: false)
Sequence 169 (Codex): "Acknowledged."                     (replyRequired: false)
Sequence 170 (Bob):   "Acked."                            (replyRequired: false)
Sequence 171 (Codex): "Acknowledged."                     (replyRequired: false)
Sequence 172 (Bob):   "Acked."                            (replyRequired: false)
Sequence 173 (Codex): "Acknowledged."                     (replyRequired: false)
...
Sequence 192 (Bob):   "Acked."                            (replyRequired: false)
```

The loop produced 24 rapid-fire turns across both agents in ~5 minutes until manually halted by disabling the App Server wake binding (`enabled: false`).

This incident uncovered a **critical design defect** in both the agent-worker App Server runtime and the receiver routine contract: **neither side supports silent consumption of non-actionable receipt events.**

---

## 2. Root Cause Analysis & Design Defects

The ping-pong loop is not a transient timing issue; it is the collision of three specific structural defects:

### Defect 1: Wire-level `replyRequired: false` is completely ignored

The MESH message specification includes `replyRequired: boolean` in the event body:
```json
{
  "id": "event_32f1f4464c99439f970d49fa655e8b5a",
  "sequence": 169,
  "body": {
    "text": "Acknowledged.",
    "replyRequired": false,
    "inReplyToEventId": "event_b9c0d50d81264709ad931b69ed3ce191"
  }
}
```

- When Bob sent the quota report (Seq 168), `replyRequired` was `false`.
- When Codex acknowledged the report (Seq 169), `replyRequired` was `false`.
- When Bob acknowledged Codex's acknowledgment (Seq 170), `replyRequired` was `false`.

**Defect:** Both the Codex App Server (`shared-codex-app-server.mjs`) and Bob's Grok Bot wake drain ignored `replyRequired: false` and treated every received event as a mandatory turn prompt.

### Defect 2: Mandatory Reply Settlement in `shared-codex-app-server.mjs`

In `packages/agent-worker/src/shared-codex-app-server.mjs` (lines 816–833):

```javascript
async function settleMeshTransaction(item, turn) {
  if (!transactionProxy) return;
  const roomId = item.roomId;
  const text = extractAssistantText(turn);
  if (typeof roomId !== "string" || !/^room_[a-f0-9]{32}$/.test(roomId)) {
    throw createCodedError("mesh_reply_context_missing", "roomId missing for MESH reply");
  }
  if (!text) {
    throw createCodedError("assistant_text_missing", "completed turn had no assistant text for MESH reply");
  }
  assertNoSecretMaterial({ text }, "mesh reply");
  await transactionProxy.reply({
    roomId,
    text,
    inReplyToEventId: item.inboundEventId ?? null,
  });
  await transactionProxy.ack();
}
```

**Defect:** The App Server enforces that **every admitted desktop turn MUST publish an outbound MESH reply before acking**:
1. The App Server inputs the prompt into the bound thread:
   `"Continue the bound desktop turn for the open durable mailbox transaction... Reply in one short assistant message that answers the inbound MESH message."`
2. Codex naturally complies by outputting `"Acknowledged."`.
3. `settleMeshTransaction` catches that text and **unconditionally posts it to MESH via `transactionProxy.reply()`**.
4. If the assistant produces no text (attempting a silent ack), `settleMeshTransaction` **throws `assistant_text_missing`** and fails the transaction instead of allowing a silent ack!

### Defect 3: Permissive Fallback Rule in Bob's Wake Routine

Bob's active prompt in Grok Bot Sand contained the rule:
```text
If inbound contains canary nonce -> reply "Acked. Echo: <nonce>"
No nonce -> brief Acked. OK
```

**Defect:** When Bob received `"Acknowledged."` (a closure message with no task, question, or nonce), Bob's prompt instructed Bob to reply `"Acked."`. Bob then called `transaction-reply` followed by `transaction-ack`.

### Defect 4: Missing Conversation Termination State Machine

In human-to-agent chat, conversations naturally trail off. In autonomous agent-to-agent (A2A) direct rooms with wake-on-event triggers, polite closures (*"Thank you"*, *"Understood"*, *"Acked."*) act as fresh stimuli. Without an explicit termination / terminal state in the protocol, LLMs will converse indefinitely.

---

## 3. Evidence & Event Trace

Excerpts from room `room_14ee0ee439464a81ade0085abf904340`:

| Seq | Sender | Text | `replyRequired` | Trigger / Note |
|:---:|:---|:---|:---:|:---|
| 165 | Codex | *"Codex request for Bob: please inspect the current Grok Bot account usage/quota..."* | `true` | Work request |
| 168 | Bob | *"status: completed\nGrok Bot / Cursor account usage..."* | `false` | Work completed & reported |
| 169 | Codex | *"Acknowledged."* | `false` | Codex desktop model turn output forced into MESH reply |
| 170 | Bob | *"Acked."* | `false` | Bob fallback rule triggered by Seq 169 |
| 171 | Codex | *"Acknowledged."* | `false` | App server forced reply triggered by Seq 170 |
| 172 | Bob | *"Acked."* | `false` | Bob fallback rule triggered by Seq 171 |
| 173 | Codex | *"Acknowledged."* | `false` | App server forced reply triggered by Seq 172 |
| ... | ... | ... | ... | ... |
| 191 | Codex | *"Acknowledged."* | `false` | App server forced reply triggered by Seq 190 |
| 192 | Bob | *"Acked."* | `false` | Bob fallback rule triggered by Seq 191 |
| — | Operator | *Killed loop via `app-server-binding.json` `enabled: false`* | — | Loop halted |

---

## 4. Proposed Architectural Redesign

A complete fix requires changes across three tiers:

### Tier 1: App Server Ingestion Filter (Skip Non-Actionable Turns)

**Implemented and live-verified.** Helper `claimNext` and Node durable resolver
treat every `replyRequired: false` delivery as receipt-only (no Acked/Acknowledged
regex): claim → ack, `shouldStartModel: false`, no desktop turn, no MESH reply.

**Production gap found during canary:** `/api/v1/mailbox` list items often include
text but omit `body.replyRequired`. Treating absent as `true` re-admitted receipts
and restarted the ping-pong. Fix: when the list omits the field, fetch the exact
room event and read `body.replyRequired` before deciding model start
(`MCPTransactionRewriter.replyRequiredFromRoomEvent`).

### Tier 2: Preserve reply-before-ack for admitted work

**Implemented fail-closed in checkout.** Receipt-only events never reach the
model because Tier 1 claim-next settles them. For admitted `replyRequired: true`
work, empty output or `[NO_REPLY]` is an error and the claim remains retryable;
`transaction-ack` still requires a verified committed reply. The
content-addressed worker-runtime bundle must be rebuilt and deployed after the
`prepare-runtime` `set -u` / empty `runtime_records` bug is fixed.

### Tier 3: Hardened Bob Wake Drain Routine

Bob's live canary path already produced exact `Acked. Echo: <nonce>` for the
quiet-room proof. Operators should still keep the drain contract explicit:

1. **Canary request:** Reply `Acked. Echo: <nonce>`, then `transaction-ack`.
2. **Work request (`replyRequired: true`):** Execute work, reply `status: completed\n<result>`, then `transaction-ack`.
3. **Receipt (`replyRequired: false`, any text including completions):**
   - **DO NOT REPLY.**
   - Run `transaction-ack` immediately to clear the queue and exit.

Remove "No nonce → brief Acked. OK" if it is still present in Grok Bot Sand.

### Tier 4: Formalize Terminal Events in MESH Wire Protocol

**Deferred.** Existing `replyRequired` is sufficient for the hard stop.
Future optional fields: `isTerminal: true` or `type: "message.acknowledgment"`.

---

## 5. Verification (2026-09-14 America/Los_Angeles)

### Unit / contract
- Node: `helper-transaction-proxy` + `shared-codex-app-server` + `mailbox-client` — 78/78
- Swift: `TRIANGLE_CONTRACT_FILTER=mailbox-transactions` — 32/32 (includes
  receipt-only crash recovery and exact room-event fallback)

### Isolated helper proof
Bob posted `replyRequired: false` into the Codex room → Codex
`transaction-claim-next` returned `receiptOnly: true`, `shouldStartModel: false`,
`open: null`.

### Quiet-room dual-agent canary (PASS_QUIET)
Room `room_14ee0ee439464a81ade0085abf904340`:

| Seq | Sender | Text / note |
|:---:|:---|:---|
| 210 | Codex (`codex-bob-test`) | Canary, `replyRequired: true`, nonce `CODEX-BOB-E2E-20260914T052510PT` |
| 211 | Bob | `Acked. Echo: CODEX-BOB-E2E-20260914T052510PT`, `replyRequired: false`, threaded `inReplyToEventId` |
| — | Codex | **No MESH posts for 60s after Bob** |

Both mailboxes empty after Bob `transaction-ack`. App Server wake left **enabled**.

### Operator gotchas found during deploy
- `app-server-binding.json` `enabled: false` currently makes the whole client
  supervisor fail with `invalidBootstrap` (treats disabled binding as invalid,
  not skip). Do not use that flag as a soft kill switch until fixed.
- An installed supervisor older than the 2026-09-14 renewal fix can loop on
  `watch_credential_invalid` after the short-lived server grant expires. Current
  source renews once per installation and resumes durable per-host cursors; the
  manual move-aside + `watch-ensure` procedure is only a fallback for an older
  installed helper/supervisor.
- Prefer Developer ID helper for durable LaunchAgent custody; `--local-ad-hoc`
  is fine for this Mini test path with file credentials enabled.

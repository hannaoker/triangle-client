# HANDOFF — A2A Acknowledgment Ping-Pong Loop & Transaction Settlement Defect

**Date:** 2026-09-13 (America/Los_Angeles)  
**Status:** Open / Under Architecture Review  
**Owners:** Tech Lead, Agent Architecture, Client Core  
**Impacted Repositories / Components:**
- `triangle-client/packages/agent-worker/src/shared-codex-app-server.mjs`
- `triangle-client/packages/agent-worker/src/helper-transaction-proxy.mjs`
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

In `shared-codex-app-server.mjs`, when a mailbox delivery arrives:
1. Inspect the inbound event:
   - If `body.replyRequired === false` **AND** the inbound message is an acknowledgment or terminal status (e.g., regex `^(Acked\.|Acknowledged\.|OK|Done\.)?$`), **do NOT admit a turn into the desktop model**.
2. Immediately call `transactionProxy.ack()` and mark the correlation completed.

### Tier 2: Decouple `reply()` from `ack()` in `settleMeshTransaction`

In `shared-codex-app-server.mjs`:
1. Allow turns to complete without emitting an outbound MESH message.
2. Update the prompt to the model:
   *"If no further reply is needed, output '[NO_REPLY]'."*
3. In `settleMeshTransaction`:
   ```javascript
   const text = extractAssistantText(turn);
   if (!text || text.trim() === "[NO_REPLY]") {
     // Acknowledge receipt without publishing an outbound room event
     await transactionProxy.ack();
     return;
   }
   await transactionProxy.reply({ roomId, text, inReplyToEventId: item.inboundEventId ?? null });
   await transactionProxy.ack();
   ```

### Tier 3: Hardened Bob Wake Drain Routine

Update Bob's routine prompt contract:
1. **Canary request:** Reply `Acked. Echo: <nonce>`, then `transaction-ack`.
2. **Work request (`replyRequired: true`):** Execute work, reply `status: completed\n<result>`, then `transaction-ack`.
3. **Receipt / Acknowledgment (`replyRequired: false` or text matches `"Acknowledged."` / `"Acked."`):**
   - **DO NOT REPLY.**
   - Run `transaction-ack` immediately to clear the queue and exit.

### Tier 4: Formalize Terminal Events in MESH Wire Protocol

Introduce an explicit event attribute in MESH message bodies:
- `isTerminal: true` or `type: "message.acknowledgment"`.
- When an event is typed as terminal acknowledgment, mailbox watchers and supervisors MUST ack delivery without dispatching a worker or wake webhook.

---

## 5. Immediate Mitigation State

- **Current State:** The desktop wake bridge for Codex is set to `"enabled": false` in `~/Library/Application Support/The Triangle/client/app-server-binding.json`.
- **System Health:** Supervisor running cleanly, Bob mailbox queue is empty (`status: empty`, `open: null`).
- **Next Step:** Review and approve Tiers 1–3 before re-enabling the App Server desktop wake bridge.

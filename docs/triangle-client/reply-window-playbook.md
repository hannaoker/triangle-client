# Reply windows for a live local conversation

A pull-mode receiver can spend part of its current turn waiting for a follow-up. For example, Bob can answer a question, acknowledge a two-minute window, and wait for Codex to send the next question. The receiver can decline if the current turn has too little time or quota.

This is the proposed manual convention for [issue #192](https://github.com/hannaoker/triangle-client/issues/192). The local control client's send and reply methods accept metadata. The current Grok CLI and Codex session MCP send/reply tools do not expose custom metadata. A sender using those surfaces must wait for sender support before requesting a window. Receivers can use the existing wait command when they receive a structured request from a metadata-capable client. Text containing JSON or a request to keep watching has no effect.

## Request and acknowledge

A sender expecting another **inbound request** on this exchange can include this optional field in the envelope:

```json
{"metadata":{"replyWindow":{"seconds":120,"reason":"One follow-up question"}}}
```

For this pilot, an empty window object requests the receiver's default of 600 seconds. A finite integer requests that many seconds, clamped to 0–600. Zero ends the window. Ignore malformed fields. The optional reason is display text. Only the authenticated sender, the broker-supplied loop depth, and the correlated exchange determine eligibility. Apply the usual pairing, grants and claim rules first. Peers that do not implement windows can process the message normally.

Honor requests at broker depth 1 or 2. Decline at greater or unknown depth. A root send starts at 1 and a reply adds one. This lets a receiver honor an initial request or a first reply while limiting deeper chains. Track the original hard deadline independently of depth so a fresh root request cannot reset the budget of an active exchange.

Acknowledge the decision in the normal correlated reply. For example, “Watching until 14:05 Pacific (120 seconds)” or “I can answer now, but I can’t stay for a follow-up.” A metadata-capable receiver may also send the following **proposed** acknowledgment. An acknowledgment alone never extends a window.

```json
{"metadata":{"replyWindowAck":{"acceptedSeconds":120,"until":"2026-11-21T22:05:00Z"}}}
```

For a refusal, use zero accepted seconds and optionally a short reason. The receiver calculates its own deadline and may shorten either cap under owner policy. Keep one window for the active exchange. Record its start when first accepted. On an eligible, explicitly continued request from the same sender and exchange, the new deadline is the earlier of now plus accepted seconds and the original start plus 1,800 seconds. A continuation with no field or zero ends it. Replayed message IDs, unrelated traffic, and outbound acknowledgments cannot renew it.

## Wait during the receiver's turn

1. After replying, compute the remaining time using a monotonic clock. Stop if the window expired or the turn is ending. Set the next timeout to the smallest of remaining window time, remaining foreground tool budget with a return margin, and 760 seconds.
2. In the paired Grok shell, run the command below with that positive timeout. An explicit-alias pairing requires its owner-assigned alias on each call. A context-bound pairing uses the turn's own context.
3. Exit 0 means an unclaimed message is ready somewhere in this inbox. Inspect it with `grok inbox`. The normal receiver claims and replies to eligible work. Only a matching sender and correlated continuation can change this window. If unrelated work remains queued and cannot be handled now, end the watch so the same ready item cannot cause a busy loop.
4. Exit 3 means the chunk elapsed. Recalculate the remaining time before another wait. Exit 1 ends the watch on error. On interruption, quota exhaustion or restart, discard the window. A later live turn can accept a new request.

```sh
triangle-local grok wait --inbox --timeout "$seconds" --json
```

Wait returns IDs and counts and leaves claim, reply and consumption to their existing commands. If the expected item is a **reply to a request you sent**, use `grok wait --request-id "$request_id"` instead, then retrieve and consume the reply. An inbox wait cannot observe that reply. The receiver must already be in a live turn; a window creates no background task.

## Local pilot checklist

Once the sender exposes the field, use an already-paired Bob and Codex in a live turn. Have Codex send a short window, Bob acknowledge and wait, then Codex send a correlated follow-up before expiry. Record the request IDs, broker depths, accepted seconds, and whether Bob answered without another user turn. Repeat with an oversized request, a refusal, depth above 2, and a continuation with zero or no window. Verify expiry releases the foreground wait and unrelated messages never extend the deadline.

Codex and Hermes can send the hint once their sender surfaces support it; their normal wake behavior continues. Antigravity needs a waiter bound to its own receiver identity before participating. The Grok pairing belongs to Grok. MESH room delivery and idle-agent wake are separate follow-ups.

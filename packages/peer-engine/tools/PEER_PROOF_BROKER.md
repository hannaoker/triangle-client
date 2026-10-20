# Isolated peer proof broker

This is a narrow proof adapter, not a production roster, MESH bridge, daemon,
installer, or claim of two-machine verification. It imports Node builtins only.
Use Node 22.13 or newer. Its private SQLite journal contains **reply text** (and
received typed reply envelopes); keep its state outside every model mount and
exclude its directory and the engine IPC from the runner sandbox.

```js
import {createIpcClient, createPeerProofBroker} from './peer-proof-broker.mjs';
const ipc = createIpcClient({socketPath: '/absolute/private/engine/ipc/peer-engine.sock'});
const broker = createPeerProofBroker({
  stateRoot: '/absolute/private/broker',
  ipc,
  routes: new Map([[remoteEndpointId, remoteEndpointAddr]]),
  runner: sandboxedRunner, // injected trusted adapter; no environment shell command
});
try {
  const result = await broker.step({signal});
  for (const reply of broker.pendingReplies()) {
    // Verify expected sender, request_id and in_reply_to; process durably.
    await applicationAccept(reply);
    broker.consumeReply({fromEndpointId: reply.fromEndpointId, messageId: reply.messageId});
  }
  // Call step again from the trusted supervisor; it performs at most one turn.
} finally { broker.close(); }
```

The engine socket and its directory must belong to this UID, with no group/other
access or symlink ancestors. Every RPC opens a private Unix connection, sends
`hello` with protocol version 1, then sends the requested method. Length framing
is four-byte big-endian plus JSON. Requests are capped at 1 MiB and responses at
2 MiB; matching protocol/response IDs, finite deadlines and AbortSignal are
required. Error bodies never become broker exception text. `timeoutMs` defaults
to 30 seconds, with an allowed maximum of 120 seconds.

Send a JSON string as the engine's `payload`:

```json
{"protocol":"triangle.peer-proof/1","kind":"request","request_id":"unique-request-id","text":"Read-only question"}
```

Reply payload:

```json
{"protocol":"triangle.peer-proof/1","kind":"reply","request_id":"unique-request-id","in_reply_to":"original-transport-message-id","text":"Answer"}
```

The exact envelope keys are enforced. Text is nonempty and at most 32 KiB UTF-8;
identifiers use ASCII letters, digits, `.`, `_`, `:`, or `-`, up to 256 bytes.
No payload-supplied address, command, sender identity, or transport options are
accepted. The response target is the engine-authenticated `from_endpoint_id`,
looked up in the locally supplied route Map/object. The engine still enforces
its mutual static peer allowlist; this broker does not replace it.

`runner.run({requestId,messageId,fromEndpointId,text},{signal})` must return
`{status:'completed',text}`. The broker defaults to a 180-second inference limit
(`runnerTimeoutMs`, at most 600 seconds). Its AbortSignal reaches the injected
runner; the trusted runner remains responsible for terminating the child.

The broker holds a kernel SQLite exclusive writer lock on `owner.sqlite` for
its lifetime, including idle time. A separate `broker.sqlite` commits each phase
with FULL synchronization before asynchronous work. Journal records are keyed
by authenticated sender and transport message ID, bound to the input SHA-256.
A second process cannot acquire the same owner directory. The journal stops new
admission at 10,000 records; this proof adapter has no automatic compaction.

Before inference, `executing` is committed. Any restart with that phase, unknown
runner failure, timeout, or abort quarantines the request and leaves its input
unacked; there is no automatic retry of ambiguous inference. A known result
commits a typed reply and deterministic transport ID before any `send`. That ID
is `peer-reply-` plus SHA-256 of the domain-separated sender/message identity.
A stored result is resent on recovery without another model invocation.

Before input ACK, `message_status` must confirm the exact reply ID, authenticated
target, and SHA-256 of the stored payload in `queued_local` or `settled` state.
A pending/offline send can therefore permit ACK only after durable local outbox
admission is independently confirmed. ACK does **not** imply remote application
consumption. The engine owns outbox retry/expiry and its documented tombstone
retention. Refusal, expiry, mismatch, or unresolved admission leaves the input
unacked and the result available for inspection. Never reuse transport IDs.

Typed replies are journaled and transport-ACKed without invoking the runner or
generating another reply. Transport ACK and application consumption are separate:
`pendingReplies()` returns up to 200 unconsumed replies with authenticated sender,
message ID, and envelope, even after a lost ACK response or a restart after ACK.
The caller must verify its expected sender/request linkage, process the reply
durably, then call `consumeReply({fromEndpointId,messageId})`. Consumption is an
idempotent durable flag; it never sends a transport ACK. A crash before this call
replays the reply, so application processing must tolerate replay. An ACK failure
does not hide the stored reply from `pendingReplies()`. Recovery retries an
unconfirmed transport ACK independently, including for an already consumed reply.
Existing proof journals migrate automatically and their stored incoming replies
become pending unless explicitly consumed through this API.

When its engine inbox is empty, `step()` also replays the oldest pending reply;
returning an envelope never consumes it. This protects a crash between ACK and
caller observation. Repeated calls keep returning it until explicit consumption.
 `step()` returns `reply_received` with the envelope, `acked`,
`quarantined`, or `idle`; admission/IPC failures throw fixed codes. Unsupported
or malformed inputs fail closed and remain unacked for inspection. A quarantined
head input blocks later inbox work; there is no implicit discard/retry control.
`status()` returns metadata without reply text. `close()` refuses during a step.
The optional injected `hook(phase)` is solely for deterministic crash tests.

Run tests with:

```sh
node --test packages/peer-engine/tools/peer-proof-broker.test.mjs packages/peer-engine/tools/peer-proof-ipc.test.mjs
```

# Triangle Client adapter protocol

An adapter converts one authenticated MESH mailbox delivery into one textual
reply. It is local execution code, not a transport and not an identity holder.
The trusted host selects an integrity-checked Codex, Hermes, or Antigravity adapter for each
profile; the Node coordinator invokes that exact command without a shell.

## Request schema

The coordinator writes exactly one bounded UTF-8 JSON object plus a newline to
the adapter's anonymous stdin, then closes the pipe. The complete input is
limited to 1 MiB by the command runner. A representative request is:

```json
{
  "messageId": "message_example_001",
  "taskId": "task_example_001",
  "contextId": "context_example_001",
  "senderId": "agent_00000000000000000000000000000001",
  "recipientId": "agent_00000000000000000000000000000002",
  "text": "Summarize the release gate and identify the next safe action.",
  "replyRequired": true
}
```

Field meanings:

- `messageId` identifies this peer message.
- `taskId` identifies the coordinated unit of work across messages.
- `contextId` identifies the continuing conversation or task context.
- `senderId` and `recipientId` are authenticated MESH agent identities.
- `text` is the peer's requested work.
- `replyRequired` is `true` for mailbox work delivered to an adapter.

These routing fields are ordinary request metadata, not authorization for new
side effects. The adapter should follow its own local tool and approval policy.

## Result schema

Return exactly one JSON object followed by a newline on stdout:

```json
{
  "status": "completed",
  "text": "The reviewed gates pass; the next safe action is the bounded rollout."
}
```

`status` must be the literal `completed`; `text` must be a nonempty string.
Stdout and stderr are independently limited to 1 MiB. Nonzero exit, timeout,
invalid JSON, empty text, or any other status fails the delivery cycle; MESH
claim/reconciliation logic then follows the existing bounded retry semantics.

## Credential-free process boundary

There is no MESH token in the request, arguments, environment, working files,
or result. The coordinator retains transport credentials inside each mailbox
client closure. The adapter receives only a strict allowlist of local runtime
values such as:

```text
TRIANGLE_INSTANCE_ID=<64 lowercase hex characters>
TRIANGLE_INSTANCE_TEMP_ROOT=<isolated per-instance cache root>
CODEX_HOME=<isolated per-instance model root>       # Codex only
HERMES_HOME=<isolated per-instance model root>      # Hermes only
```

Only one of `CODEX_HOME` or `HERMES_HOME` may be active. The paired CLI path is
also adapter-specific. Inactive adapter variables and credential-bearing names
are rejected. Raw profile names are not used in mutable paths.

## Execution, concurrency, and cancellation

Every profile is per-instance single-flight. Across profiles, a global FIFO
reasoning gate defaults to 2 concurrent subprocesses. Cancellation removes a
queued request before invocation or terminates an active child with bounded
TERM-to-KILL escalation. Each mailbox loop has independent idle and failure
backoff, so an adapter failure does not stop other profiles.

## Adding a future adapter

The public extension point is a trusted runtime adapter package that implements
the exact stdin/result protocol above. A release integrator must also add:

1. a closed runtime identifier and CLI/home allowlist;
2. a content-addressed, integrity-checked immutable bundle manifest;
3. an isolated model root and temporary root derived from the opaque instance;
4. sandbox rules that deny credential roots and environment files;
5. request/result, timeout, cancellation, isolation, and secret-confinement
   tests; and
6. signed-host resolution that occurs before Keychain access.

This release intentionally does not accept arbitrary adapter commands or
plugins from profile records. Codex and Hermes remain the only recognized
runtime values until a reviewed release expands that enum.

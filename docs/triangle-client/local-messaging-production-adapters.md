# Local Messaging Production Adapters

This document details the production storage and execution dispatcher adapters for Triangle same-host local agent messaging (Slice 1 of the installed local messaging execution plan).

## Architecture & Shared Custody

- **`shared-delivery-journal.mjs`**:
  - Implements shared custody and path safety (`openDeliveryJournal`).
  - Enforces canonical filesystem safety: 0700 directories, 0600 files, and immediate rejection of symlinks or unsafe ancestor permissions via `privateDir` and `privateFile`.
  - Establishes exclusive process and file locks using `BEGIN EXCLUSIVE` on `peer-drain-owner.sqlite` and an in-process active root set (`activeStateRoots`).
  - Shared directly between the peer drain service (`peer-drain-service.mjs`) and the local messaging journal (`local-messaging-journal.mjs`) so that no competing independent owners contend on a single state root.

## Local Messaging Journal (`local-messaging-journal.mjs`)

- Implements `#106` `REQUIRED_JOURNAL_METHODS` (`recordSend`, `recordReply`, `recordExecutionFailure`, `listReplies`, `consumeReply`, `getRecord`) and lifecycle execution methods (`recoverQueued`, `claimExecution`, `completeExecution`, `holdExecution`, `status`, `close`).
- **Atomic Full Envelope Identity**: Uses recursive canonical JSON serialization and SHA-256 hashing to compare inbound envelopes. Exact duplicates return `isDuplicate: true`; conflicting envelopes sharing a `messageId` throw `duplicate_id_conflict`.
- **Reply Correlation & Validation**: Verifies that reply envelopes accurately match the original request (`inReplyTo`, matching `sender`/`recipient`, matching `requestId`). Forgeries throw `invalid_reply_recipient`, `invalid_reply_sender`, or `invalid_reply_correlation`.
- **Foreign Isolation & Explicit Consumption**: `listReplies` filters strictly to the requester; foreign access is hidden. `consumeReply` verifies ownership and throws `foreign_access_denied` for unauthorized consumers. Reply pagination progress is tracked via base64url-encoded cursors.
- **Crash Recovery**: On journal instantiation, any in-flight requests in phase `executing` are immediately transitioned to `held` with reason `crash_recovery` rather than being re-executed.

## Local Messaging Dispatcher (`local-messaging-dispatcher.mjs`)

- Implements `createLocalMessagingDispatcher({ journal, runRecipient, logger, runnerTimeoutMs, maxConcurrent })`.
- **Startup & Recovery**: `start()` calls `journal.recoverQueued()`, enqueues queued records without blocking on model execution turns, and ignores held/uncertain executions.
- **Per-Recipient Serialization & Concurrency**: Serializes execution per recipient to avoid concurrent harness overlap, while allowing parallel dispatch across distinct recipients up to `maxConcurrent`.
- **Safe Timeout & Execution Custody**: Execution timeout begins strictly when the runner invokes `onStarted()`, ignoring shared gate wait times. Abort and shutdown (`stop()`) retain journal ownership until the underlying runner has completely terminated.
- **Ordered Drain & Shutdown**: Dispatcher shutdown gracefully drains pending admitted requests while refusing new admissions.

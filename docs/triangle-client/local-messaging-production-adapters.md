# Local Messaging Production Adapters

This document details the production storage and execution dispatcher adapters for Triangle same-host local agent messaging (Slice 1 of the installed local messaging execution plan).

## Architecture & Shared Custody

- **`shared-delivery-journal.mjs`**:
  - Implements shared custody and path safety (`openDeliveryJournal`).
  - Enforces canonical filesystem safety: 0700 directories, 0600 files, and immediate rejection of symlinks or unsafe ancestor permissions via `privateDir` and `privateFile`.
  - Establishes exclusive process and file locks using `BEGIN EXCLUSIVE` on the owner database (`peer-drain-owner.sqlite` for the peer drain, `local-messaging-owner.sqlite` for the local journal) and an in-process active root set (`activeStateRoots`).
  - Shared directly between the peer drain service (`peer-drain-service.mjs`) and the local messaging journal (`local-messaging-journal.mjs`) so that no competing independent owners contend on a single state root.

## Local Messaging Journal (`local-messaging-journal.mjs`)

- Implements `#106` `REQUIRED_JOURNAL_METHODS` (`recordSend`, `recordReply`, `recordExecutionFailure`, `listReplies`, `consumeReply`, `getRecord`) and lifecycle execution methods (`recoverQueued`, `claimExecution`, `completeExecution`, `holdExecution`, `status`, `close`).
- **Atomic Full Envelope Identity**: Uses recursive canonical JSON serialization and SHA-256 hashing to compare inbound envelopes. Exact duplicates return `isDuplicate: true`; conflicting envelopes sharing a `messageId` throw `duplicate_id_conflict`.
- **Reply Correlation & Validation**: Verifies that reply envelopes accurately match the original request (`inReplyTo`, matching `sender`/`recipient`, matching `requestId`). Forgeries throw `invalid_reply_recipient`, `invalid_reply_sender`, or `invalid_reply_correlation`.
- **Foreign Isolation & Explicit Consumption**: `listReplies` filters strictly to the requester; foreign access is hidden. `consumeReply` verifies ownership and throws `foreign_access_denied` for unauthorized consumers. Reply pagination progress is tracked via base64url-encoded cursors.
- **Crash Recovery**: On journal instantiation, any in-flight requests in phase `executing` are immediately transitioned to `held` with reason `crash_recovery` rather than being re-executed.
- **File Names & Migration**: Uses `local-messaging.sqlite` and `local-messaging-owner.sqlite`. Journals written under the peer drain's names are moved once under the old owner lock (with any `-journal` files, preserving 0600); a live old owner gives `journal_busy`, both name sets give `journal_migration_conflict`, and a database without a `local_messages` table is never touched.
- **Late Results**: `holdExecution(messageId, reason, { lateResultText })` stores a result that arrived after a timeout in the additive `late_result_text` column (added idempotently with `PRAGMA table_info` + `ALTER TABLE`). Records expose only `hasLateResult`; `getLateResult(messageId)` is the owner-inspection accessor and is never reachable over the socket.
- **Retention**: `compact({ now, retentionMs })` deletes consumed replies and completed messages whose replies are all gone after eight days. `held`, `queued_local` and `executing` records and unconsumed replies are never compacted.

## Local Messaging Dispatcher (`local-messaging-dispatcher.mjs`)

- Implements `createLocalMessagingDispatcher({ journal, runRecipient, logger, runnerTimeoutMs, maxConcurrent, now, compactIntervalMs })`. It runs `journal.compact()` at `start()` and then at most once per `compactIntervalMs` (default one hour) when work arrives; a compaction failure is logged and never disturbs execution.
- **Startup & Recovery**: `start()` calls `journal.recoverQueued()`, enqueues queued records without blocking on model execution turns, and ignores held/uncertain executions.
- **Per-Recipient Serialization & Concurrency**: Serializes execution per recipient to avoid concurrent harness overlap, while allowing parallel dispatch across distinct recipients up to `maxConcurrent`.
- **Safe Timeout & Execution Custody**: Execution timeout begins strictly when the runner invokes `onStarted()`, ignoring shared gate wait times. Abort and shutdown (`stop()`) retain journal ownership until the underlying runner has completely terminated.
- **Shutdown**: `stop()` refuses new admissions, starts nothing new and waits only for executions that already started, so an hour-long turn can delay shutdown but a long queue cannot. Unclaimed messages stay `queued_local` in the journal and the next `start()` recovers them.

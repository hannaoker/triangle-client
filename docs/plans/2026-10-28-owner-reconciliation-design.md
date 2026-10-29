# Owner reconciliation of held and expired local work (item 2 design)

Status: design draft, 2026-10-28, against main `451eb44`. Design only: no code, no production change, not owner-approved. It authorizes no install, grant or permission change, and no action on the two existing held tasks, the 14 pending replies, the queued request or the older backlog. Facts marked "checked" were read in the code at `451eb44`; names marked "proposed" do not exist. It answers the second remaining item of the 2026-10-28 Codex handoff: specify custody, idempotency and late-result behavior before any reconciliation operation is built. Scope is the local journal (`local-messaging-journal.mjs`); the Iroh peer lane and MESH keep their own states. It builds on [messaging status explanations](../reviews/2026-10-28-messaging-status-ux.md) and the offline `reconcile-wake` precedent in [installed local messaging](../triangle-client/installed-local-messaging.md).

## 1. Summary

No code path takes work out of `held`, and nothing in the product reads the late result a held record may carry. Status explanations tell senders to "ask the owner to reconcile", but the owner has only a count (`triangle-local status`) and no operation. This design adds two owner-only, offline commands: `held` (read-only list) and `reconcile-message` (one record, one action). Two actions exist: `mark-failed` closes the record without a result, and `accept-late-result` turns the retained late result into a normal correlated reply marked as owner-reconciled. Replay, requeue, claim transfer and bulk operations are excluded, because an exact retry must never run work twice. Each operation is one SQLite transaction keyed by a caller-supplied reconcile ID, with an expected-version check and, for late results, an expected-hash check, so retries are exact and a stale view changes nothing. The first slice copies the `reconcile-wake` pattern (service stopped, exclusive journal ownership, no RPC, no MCP tool) because the owner CLI and the bound Codex MCP adapter share one credential.

## 2. Goals and non-goals

Goals:

1. An owner-only way to close or complete held work, with the sender told honestly what happened.
2. Never replay: reconciliation cannot cause the work to run again.
3. Exactly-once effect under retries, crashes and stale listings.
4. Late results handled as untrusted data: the owner decides, the sender can tell the origin, the audit keeps a hash and not the text.
5. No new surface reachable by a model or by the bound conversation's credential.
6. Additive storage that older runtimes ignore safely.

Non-goals: requeue or replay, claim transfer or lease renewal, filters or bulk actions, deleting records, the Iroh peer lane (`reply_failed`, `retry_pending`, `resend_pending`) and MESH, remote machines, automatic expiry or cleanup, and any use of the existing held tasks or backlog for testing.

## 3. What exists today (checked)

How a record becomes `held`:

| Cause | `reason` | Where | Late text kept |
| :--- | :--- | :--- | :--- |
| Journal opened while a row is `executing` (restart or crash) | `crash_recovery` | journal open, `recoverQueued` | no |
| Runner timed out | `runner_timeout` | dispatcher: `recordExecutionFailure`, or `holdExecution` when the runner completed after the timeout | only in the second case |
| Runner threw | `runtime_error` | dispatcher `recordExecutionFailure` | no |
| Runner finished without `completed` | its reason, else `uncompleted` | dispatcher `holdExecution` | no |
| Persisting the result failed | `persistence_failure` | dispatcher | no |
| Dispatch failed at admission | `admission_failure` | server | no |
| Interactive claim lease ran out | `lease_expired` | `listInbox`, claim retry, or a reply arriving after expiry | the late reply text |
| Interactive reply arrives while held | unchanged | `recordInteractiveReply` | yes, replacing any earlier text |

- **No exit.** Every phase write in the journal moves `queued_local` to `executing` to `completed` or `held`; nothing writes `queued_local` after admission and nothing leaves `held`. `compact` deletes only `completed` records and consumed replies, so held records, late text and unconsumed replies persist.
- **Opening mutates.** Any open of the journal holds every `executing` row as `crash_recovery`, so a tool that only wants to look must not use the normal open.
- **Late text.** `late_result_text` is written by the timeout hold, by a reply on a held message and by a reply after lease expiry; each write replaces the previous text. Senders see only `hasLateResult`. `getLateResult` has no caller outside tests, and no owner command shows the text.
- **Owner tools.** `triangle-local status` returns phase counts. The only reconcile command is `reconcile-wake`: offline, exclusive journal ownership (a second opener fails `journal_busy`), private owner configuration checked, exact IDs required, no RPC and no MCP tool.
- **Sender view.** `delivery.state` is `held` or `lease_expired` with "ask the owner to reconcile". Sender wake snapshots count held messages and a late-result flag (`Held tasks`, `Late result`). `reply_failed` is written only by the peer lane, never by the local journal.
- **Authority.** The owner CLI and the bound MCP adapter obtain their credential the same way (`exchangeTurnBinding`), so an RPC reachable by one is reachable by the other. The data database uses `journal_mode=DELETE`; the owner lock is a separate database taken with `BEGIN EXCLUSIVE`.
- **Reply path.** `triangle_reply_message` passes only `messageId`, `claimToken`, `replyId` and `text`, but the server's `send_reply` RPC accepts caller metadata, so metadata is not a trustworthy provenance channel.

## 4. Design

### 4.1 Surfaces (proposed, owner-only, offline)

| Command | Effect |
| :--- | :--- |
| `triangle-local held` | Read-only JSON list of held records, with `version` and the actions currently valid. `--show-late-result ID` prints one late text between fixed delimiters. |
| `triangle-local reconcile-message --message-id ID --reconcile-id RID --expect-version V --action mark-failed\|accept-late-result [--expect-late-hash H] [--note TEXT]` | One action on one record. |

Both refuse while the supervisor runs (`journal_busy`), require valid private owner configuration and take the journal's exclusive owner lock. There is no RPC method and no MCP tool, and no tool description or `delivery.nextAction` names the command: senders are models and are told only to ask the owner.

`held` opens the database read-only under the owner lock and never runs recovery; `executing` rows appear as "held on next open (`crash_recovery`)". `reconcile-message` uses the normal open and so sees exactly what the next restart would.

Listed fields: `messageId`, `requestId`, `sender`, `recipient`, `recipientType`, `phase`, `reason`, `createdAt`, `updatedAt`, `leaseExpiresAt`, `pinned` (a reply route key exists), `hasLateResult`, `lateResultBytes`, `lateResultSha256`, `version`, `actions`. No message bodies, late text or runtime error text by default; claim tokens and wake IDs are never printed.

### 4.2 Custody and authority

- The operation needs what `reconcile-wake` needs: the owner's private configuration, exclusive journal ownership and no running supervisor. Offline removes the shared-credential surface instead of guarding it.
- It never claims, consumes or acknowledges anything of anyone else's: no `consumeReply`, no wake acknowledgment, no claim token use, no grant or policy change.
- With the service stopped the transaction is the only writer, so the row cannot change between check and write. The version check protects against the operator's listing going stale across a restart.
- Limit, as documented elsewhere: a same-user process can run the CLI or read owner files. The controls are no model-facing tool, harness approval of the command, arguments that peer text cannot supply (reconcile ID, version, late hash) and an audit row.

### 4.3 Actions

| Action | Valid when | Writes (one `BEGIN IMMEDIATE`) | Sender then sees |
| :--- | :--- | :--- | :--- |
| `mark-failed` | phase `held` | audit row; phase `failed` (new terminal), reason `owner_marked_failed`; late text cleared | `delivery.state` `closed_by_owner`: closed by the owner without a result, send a new request with new IDs if still needed; `hasLateResult` false; held count drops |
| `accept-late-result` | phase `held`, late text present, `--expect-late-hash` equals its SHA-256, no reply route key | audit row; reply row from recipient to sender; phase `completed`; late text cleared | a correlated reply whose view carries `reconciled: {reconcileId}`; `delivery.state` `completed` |

Excluded, with reasons: **requeue or replay** (breaks "an exact retry never runs the work twice" and cannot know what the first attempt already did); **claim transfer or lease renewal** (a second chat would duplicate work the first may have done); **delete** (evidence); **filters or bulk** (every action names one exact record, so the old backlog cannot be hit by mistake); **accept for pinned routes** (the reply must advance a route pin that needs the authenticated child, which an offline tool cannot supply).

### 4.4 Idempotency and concurrency

- `reconcileId`: caller-supplied stable identifier (`[A-Za-z0-9._:-]{1,256}`), unique in `local_reconciliations` (proposed additive table: `reconcile_id` primary key, `message_id`, `action`, `from_phase`, `from_reason`, `expected_version`, `late_result_sha256`, `reply_message_id`, `outcome_phase`, `note` bounded to 256 characters, `created_at`).
- Exact retry (same ID, message, action, version, hash) returns the stored outcome with `isDuplicate: true` and writes nothing. The same ID with any difference fails `duplicate_id_conflict`. A different ID on an already closed record fails `not_reconcilable` and names the stored outcome.
- `version` is the SHA-256 of the canonical JSON of `[messageId, phase, reason, updatedAt, leaseExpiresAt, claimOperationId, lateTextSha256|null]`. A mismatch fails `stale_view` and writes nothing.
- Late text can be replaced by a later reply (checked), so the version alone is not enough: `accept-late-result` also requires the hash of the exact bytes the owner read.
- The reply ID is `rep-rc-<reconcileId>` and goes through the existing hash-checked duplicate path, so a retry after a lost audit row cannot create a second reply.
- One transaction: a crash before `COMMIT` changes nothing and the retry runs normally; after `COMMIT` the retry returns the stored result.

### 4.5 Late-result behavior

1. A late result is untrusted model output retained as evidence. It is never delivered by itself (current behavior, unchanged).
2. Visibility: senders see `hasLateResult` only. The owner listing shows size and SHA-256. The text is printed only by `held --show-late-result ID`, between fixed delimiters, with a warning that terminal output read by a model becomes model input. The audit keeps the hash, never the text.
3. Decision: accept it as the reply, or close the record. Doing nothing leaves it held.
4. Replacement: a later reply replaces the stored text (checked). The listing always shows the hash of the current text; accepting with an older hash fails `late_result_mismatch`.
5. After the fact: a chat replying after `mark-failed` gets `reply_not_accepted` (phase `failed`) and no text is stored, because only held or expired-executing records retain it (checked). After `accept-late-result`, the chat's own later reply with its claim token reaches the completed-message path: identical content is a duplicate, anything else fails `duplicate_id_conflict`.
6. Provenance: a new nullable `local_replies.reconcile_id` column, set only by this operation, surfaced by the reply view as `reconciled: {reconcileId}`. It is a column and not metadata because `send_reply` accepts caller metadata (checked). The reply carries no `senderProvenance`, and the sender treats its text as untrusted like any reply.

### 4.6 Sender-visible states

| Before | After `mark-failed` | After `accept-late-result` |
| :--- | :--- | :--- |
| `held` / `lease_expired`, "ask the owner to reconcile" | `closed_by_owner` (`failed` phase) | `completed`, reply present |
| wake snapshot: `Held tasks` N, `Late result` flag | held item gone | held item gone, one unread reply |

The offline tool pushes nothing. The supervisor's notifier recomputes obligations from the journal at its next start, so a new wake appears there.

### 4.7 Failure semantics

| Situation | Result |
| :--- | :--- |
| Supervisor running | `journal_busy`: stop the service |
| Unknown message | `not_found` |
| Not `held` (queued, completed, failed) | `not_reconcilable` with the current phase |
| Stale listing | `stale_view` with the current version; nothing written |
| No late text / hash differs | `late_result_missing` / `late_result_mismatch` |
| Pinned record on accept | `reply_route_pinned`; `mark-failed` stays available |
| Same ID, different parameters | `duplicate_id_conflict` |
| Exact retry | stored outcome, `isDuplicate: true` |
| Crash mid-operation | nothing written; retry |

### 4.8 Compatibility, retention and rollback

- Additive: one table, one nullable reply column, one new phase value (`failed`). Older runtimes degrade safely (checked): `describeMessageDelivery` reports `unknown` for an unrecognized phase, `status()` counts ignore it, wake obligations read only held and queued rows, and claims require `queued_local`, so nothing replays. Older compaction leaves `failed` rows in place.
- Retention: `failed` records compact with `completed` ones (8 days, run by the dispatcher). Audit rows are not compacted in the first slice.
- Rollback: reinstall the previous bundle; rows stay inert. A reconciled `completed` record with its reply is an ordinary completed record.
- Packaging: keep the code inside `local-messaging-cli.mjs` and the journal to avoid a new module, which would need the manifest bump and installer list change.

## 5. Security notes

| Concern | Handling |
| :--- | :--- |
| A model triggers reconciliation | No RPC, MCP tool or sender-facing command text exists. |
| Stale view acted on | Version and late-hash checks; nothing written on mismatch. |
| Hostile late text | Hash-only audit; delimited display; the accepted reply is untrusted data for its reader. |
| Replayed side effects | Replay is excluded; closing never re-runs anything. |
| Forged provenance | A column written only here, not caller metadata. |
| Wrong record touched | One exact message ID per call; no filter, bulk or wildcard. |
| Old backlog touched | The two held tasks, 14 pending replies and queued request are never named by tests; acting on them needs new exact owner authorization. |
| Lock stolen | Uses the existing owner lock; no override flag. |
| Secrets in output or audit | Claim tokens, wake IDs and credentials are never printed or stored. |

## 6. Verification plan

Disposable journals and state roots only; nothing reads installed state.

- Journal level: each cause in section 3 produces a reconcilable record; each action's writes and sender-visible result; stale version; late-hash mismatch after a replacement; exact retry; conflicting retry; crash injected before and after `COMMIT`; pinned refusal; non-held refusal; listing leaves the database byte-identical; listing needs no recovery; audit holds no text; compaction; wake obligations before and after.
- CLI level: real processes against a stopped state root; `journal_busy` against a live owner; argument validation; output redaction.
- Compatibility: load the baseline journal module from git (as `r1-integration-v13.test.mjs` does) and prove it opens a journal containing `failed` rows, reports `unknown` and replays nothing.
- Installed acceptance (needs new exact owner authorization): fresh scratch records produced on the Mini, service stopped for the operation, before and after comparison of every original message, reply and route row (excluding the scratch ones), rollback rehearsal. The existing held tasks are not used.

## 7. Slices

| Slice | Delivers | Gate |
| :--- | :--- | :--- |
| O0 | `held` read-only listing and runbook text | tests only; read-only |
| O1 | audit table, `failed` phase, `mark-failed`, `closed_by_owner` explanation, compaction rule | owner approval, then install gate |
| O2 | `accept-late-result` for unpinned records, reply column, `reconciled` view | owner approval, then install gate |
| O3 | optional online owner channel | separate owner decision; not designed here |

## 8. Owner decisions

Recommendations, none settled.

1. **Offline first (recommended)** or an online owner channel. Offline costs a service stop per reconciliation, which also pauses the MESH, headless and ACP lanes; online needs a credential distinct from every turn credential and does not isolate same-user processes.
2. **Actions:** `mark-failed` and `accept-late-result` only (recommended); replay stays excluded.
3. **New terminal phase `failed` (recommended)** or `held` with a reason. The second leaves senders told to ask the owner forever.
4. **Pinned (R2) late results:** refuse acceptance in O2 (recommended) or design an owner path to advance the pin.
5. **Late text:** hash-only audit and clearing on close (recommended) or retaining it for later inspection.
6. **Retention:** closed records with `completed` ones at 8 days and audit rows kept (recommended).
7. **Existing backlog:** untouched until the owner names exact IDs after O1 ships.

## 9. Unverified or open

- Whether a read-only listing could run beside a live supervisor under `journal_mode=DELETE`; the offline design avoids the question and it was not tested.
- How the notifier treats the changed obligation fingerprint at its next start (a new wake is expected, not exercised).
- Whether any other process opens this journal besides the supervisor and `reconcile-wake`; only those two were checked.
- How an owner-authored reply could advance a reply route pin, if decision 4 goes the other way.
- Whether the owner accepts a service stop per reconciliation, or wants slice O3 earlier.

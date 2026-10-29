# Owner reconciliation of held and expired local work (item 2 design)

Status: design draft, 2026-10-28, against main `451eb44`. Slices O0 to O2 are implemented in source on `claude/owner-reconcile-o0-o2` with the owner decisions in section 8 applied at their recommended answers, and an independent read-only review has been applied to both design and code. The design is not owner-approved and nothing is installed. It authorizes no install, grant or permission change, and no action on the two existing held tasks, the 14 pending replies, the queued request or the older backlog. Facts marked "checked" were read in the code at `451eb44`. It answers the second remaining item of the 2026-10-28 Codex handoff: specify custody, idempotency and late-result behavior before any reconciliation operation is built. Scope is the local journal (`local-messaging-journal.mjs`); the Iroh peer lane and MESH keep their own states. It builds on [messaging status explanations](../reviews/2026-10-28-messaging-status-ux.md) and the offline `reconcile-wake` precedent in [installed local messaging](../triangle-client/installed-local-messaging.md).

## 1. Summary

No code path takes work out of `held`, and nothing in the product reads the late result a held record may carry. Status explanations tell senders to "ask the owner to reconcile", but the owner has only a count (`triangle-local status`) and no operation. This design adds two owner-only, offline commands: `held` (read-only list) and `reconcile-message` (one record, one action). Three actions exist: `mark-failed` closes the record without a result, `mark-completed` completes a record whose reply is already stored, and `accept-late-result` turns the retained late result into a normal correlated reply marked as owner-reconciled. Replay, requeue, claim transfer and bulk operations are excluded, because an exact retry must never run work twice. Each operation is one SQLite transaction keyed by a caller-supplied reconcile ID, with an expected-version check and, wherever a late result would be discarded or accepted, an expected-hash check, so retries are exact and a stale view changes nothing. Both commands validate and pre-check read-only before the normal open, so a refused call changes nothing. The first slice copies the `reconcile-wake` pattern (service stopped, exclusive journal ownership, no RPC, no MCP tool) because the owner CLI and the bound Codex MCP adapter share one credential.

## 2. Goals and non-goals

Goals:

1. An owner-only way to close or complete held work, with the sender told honestly what happened.
2. Never replay: reconciliation cannot cause the work to run again, and cannot tell a sender to rerun finished work.
3. Exactly-once effect under retries, crashes and stale listings.
4. Late results handled as untrusted data: the owner decides, the sender can tell the origin, the audit keeps a hash and not the text, and nothing is discarded unacknowledged.
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
| Crash or `persistence_failure` after the runner's reply was stored | `crash_recovery` or `persistence_failure` | the dispatcher stores the reply and completes the record in two separate writes | no, the reply exists |

- **No exit.** Every phase write in the journal moves `queued_local` to `executing` to `completed` or `held`; nothing writes `queued_local` after admission and nothing leaves `held`. `compact` deletes only `completed` records and consumed replies, so held records, late text and unconsumed replies persist.
- **Opening mutates.** Any open of the journal migrates the schema and holds every `executing` row as `crash_recovery`. A graceful stop leaves interactive `executing` rows alone, so the next open or restart holds in-flight claims whose chat is still working; that chat's later reply is rejected and stored as a late result.
- **Late text.** `late_result_text` is written by the timeout hold, by a reply on a held message and by a reply after lease expiry; each write replaces the previous text. Senders see only `hasLateResult`. `getLateResult` has no caller outside tests, and no owner command shows the text.
- **Owner tools.** `triangle-local status` returns phase counts. The only reconcile command is `reconcile-wake`: offline, exclusive journal ownership (a second opener fails `journal_busy`), private owner configuration checked, exact IDs required, no RPC and no MCP tool.
- **Sender view.** `delivery.state` is `held` or `lease_expired` with "ask the owner to reconcile". Sender wake snapshots count held messages and a late-result flag (`Held tasks`, `Late result`). `reply_failed` is written only by the peer lane, never by the local journal.
- **Authority.** The owner CLI and the bound MCP adapter obtain their credential the same way (`exchangeTurnBinding`), so an RPC reachable by one is reachable by the other. The data database uses `journal_mode=DELETE`; the owner lock is a separate database taken with `BEGIN EXCLUSIVE`.
- **Reply path.** `triangle_reply_message` passes only `messageId`, `claimToken`, `replyId` and `text`, but the server's `send_reply` RPC accepts caller metadata, so metadata is not a trustworthy provenance channel.

## 4. Design

### 4.1 Surfaces (owner-only, offline)

| Command | Effect |
| :--- | :--- |
| `triangle-local held` | Read-only JSON list of held records, with `version`, any stored replies and the actions currently valid. `--show-late-result ID` prints one late text in a field marked `untrusted`. |
| `triangle-local reconcile-message --message-id ID --reconcile-id RID --expect-version V --action mark-failed\|mark-completed\|accept-late-result [--expect-late-hash H] [--expect-reply-id R] [--note TEXT]` | One action on one record. |

Both refuse while the supervisor runs (`journal_busy`), require valid private owner configuration and take the journal's exclusive owner lock. They accept only their own flags, and the owner flags are refused on every other command, so a typo fails instead of being ignored. There is no RPC method and no MCP tool, and no tool description or `delivery.nextAction` names the commands: senders are models and are told only to ask the owner.

`held` takes the owner lock and only reads (the connection is `query_only`): it never runs recovery and creates nothing. A journal still under its old file names fails `journal_not_adopted`, and one whose lock database is missing fails `journal_incomplete`, instead of reporting an empty list or creating files. A test compares the database bytes before and after; SQLite itself may roll back a crashed transaction on the first read, which is the one write outside the journal's control.

`reconcile-message` validates every argument, then pre-checks the named record through the same read-only path (unknown record, not held, stale version) and refuses before the normal open. The normal open migrates the schema and holds every `executing` row, so a refused call must not reach it; a successful call performs it, exactly as the next restart would. The transaction inside the journal stays authoritative.

`executing` rows appear with `effectivePhase: held` (`crash_recovery`), no `version` and no actions: they become reconcilable only after a normal open holds them (start and stop the service once), and then need a fresh listing.

Listed fields: `messageId`, `requestId`, `sender`, `recipient`, `recipientType`, `phase`, `reason`, `createdAt`, `updatedAt`, `leaseExpiresAt`, `pinned` (a reply route key exists), `replyMessageIds`, `hasLateResult`, `lateResultBytes`, `lateResultSha256`, `version`, `actions`. No message bodies, late text or runtime error text; claim tokens and wake IDs are never printed. Failures print their code and message (IDs, phases and codes only).

### 4.2 Custody and authority

- The operation needs what `reconcile-wake` needs: the owner's private configuration, exclusive journal ownership and no running supervisor. Offline removes the shared-credential surface instead of guarding it.
- It never claims, consumes or acknowledges anything of anyone else's: no `consumeReply`, no wake acknowledgment, no claim token use, no grant or policy change.
- With the service stopped the transaction is the only writer, so the row cannot change between check and write. The version check protects against the operator's listing going stale across a restart.
- Limit: a same-user process can run the CLI or read owner files, and the CLI is normally run by an AI agent here. `held` prints the version and hash next to the peer-written late text, so injected text could try to make an agent copy them into `reconcile-message`. The version, hash and reconcile ID are exactness checks, not authorization. The controls that hold are a person reviewing the late text, the harness's approval of the command, no model-facing tool and the audit row. An agent that displayed a late result must not run `reconcile-message` on its own.

### 4.3 Actions

| Action | Valid when | Writes (one `BEGIN IMMEDIATE`) | Sender then sees |
| :--- | :--- | :--- | :--- |
| `mark-failed` | phase `held`, no stored reply; with late text, `--expect-late-hash` must equal its SHA-256 (acknowledging that closing discards it) | audit row; phase `failed` (new terminal), reason `owner_marked_failed`; late text cleared | `delivery.state` `closed_by_owner`: closed by the owner without a result, the sender may send a new request with new IDs; `hasLateResult` false; held count drops |
| `mark-completed` | phase `held` with a stored reply; `--expect-reply-id` names it; with late text, the hash as above | audit row; phase `completed`, reason `owner_marked_completed`; no reply written | `completed`; the reply it already has |
| `accept-late-result` | phase `held`, no stored reply, late text present, `--expect-late-hash` equals its SHA-256, no reply route key | audit row; reply row from recipient to sender; phase `completed`, reason `owner_accepted_late_result`; late text cleared | a correlated reply whose view carries `reconciled: {reconcileId}`; `delivery.state` `completed` |

A record that already has a reply offers only `mark-completed`: closing it as failed would tell the sender to rerun finished work, and accepting a late result would add a second reply.

Excluded, with reasons: **requeue or replay** (breaks "an exact retry never runs the work twice" and cannot know what the first attempt already did); **claim transfer or lease renewal** (a second chat would duplicate work the first may have done); **delete** (evidence); **filters or bulk** (every action names one exact record, so the old backlog cannot be hit by mistake); **accept for pinned routes** (the reply must advance a route pin that needs the authenticated child, which an offline tool cannot supply).

### 4.4 Idempotency and concurrency

- `reconcileId`: caller-supplied stable identifier (`[A-Za-z0-9._:-]{1,128}`), unique in `local_reconciliations` (additive table: `reconcile_id` primary key, `message_id`, `action`, `from_phase`, `from_reason`, `expected_version`, `late_result_sha256`, `reply_message_id`, `outcome_phase`, `note` bounded to 256 characters, `created_at`).
- Exact retry (same ID, message, action, version, hash, reply ID and note) returns the stored outcome with `isDuplicate: true` and writes nothing. The same ID with any difference fails `duplicate_id_conflict`. A different ID on an already closed record fails `not_reconcilable` and names the stored outcome.
- `version` is the SHA-256 of the canonical JSON of `[messageId, phase, reason, updatedAt, leaseExpiresAt, claimOperationId, lateTextSha256|null, replyMessageIds]`. A mismatch fails `stale_view`, naming the current version, and writes nothing.
- Late text can be replaced by a later reply (checked), so the version alone is not enough: wherever late text would be accepted or discarded the owner also gives the hash of the exact bytes they read.
- The reply ID is `rep-rc-<reconcileId>`; the transaction checks that no reply to the message and none with that ID exists, so a retry after a lost audit row cannot create a second reply.
- One transaction: a crash before `COMMIT` changes nothing and the retry runs normally; after `COMMIT` the retry returns the stored result.

### 4.5 Late-result behavior

1. A late result is untrusted model output retained as evidence. It is never delivered by itself (current behavior, unchanged).
2. Visibility: senders see `hasLateResult` only. The owner listing shows size and SHA-256. The text is printed only by `held --show-late-result ID`, in a JSON field marked `untrusted: true`; terminal output read by a model becomes model input, so it is never included in the listing. The audit keeps the hash, never the text.
3. Decision: accept it as the reply, or close the record, which discards it and so needs the hash. Doing nothing leaves it held.
4. Replacement: a later reply replaces the stored text (checked). The listing always shows the hash of the current text; acting with an older hash fails `late_result_mismatch`.
5. After the fact: a chat replying after `mark-failed` gets `reply_not_accepted` (phase `failed`) and no text is stored, because only held or expired-executing records retain it (checked). After `accept-late-result`, the chat's exact retry reaches the completed-message path: because the accepted reply carries its own ID, the retry is judged on its content even though the chat names a different reply ID, so identical content is a duplicate and anything else fails `duplicate_id_conflict`.
6. Provenance: a new nullable `local_replies.reconcile_id` column, set only by this operation, surfaced by the reply view as `reconciled: {reconcileId}`. It is a column and not metadata because `send_reply` accepts caller metadata (checked). The reply carries no `senderProvenance`, and the sender treats its text as untrusted like any reply.

### 4.6 Sender-visible states

| Before | After `mark-failed` | After `mark-completed` | After `accept-late-result` |
| :--- | :--- | :--- | :--- |
| `held` / `lease_expired`, "ask the owner to reconcile" | `closed_by_owner` (phase `failed`) | `completed`, the existing reply | `completed`, reply present |
| wake snapshot: `Held tasks` N, `Late result` flag | held item gone | held item gone | held item gone, one unread reply |

The offline tool pushes nothing. `mark-failed` and `mark-completed` only remove an item from the sender's wake snapshot, which the notifier treats as covered, so they do not wake the sender: it learns from message status. `accept-late-result` adds an unread reply item, so a wake follows at the supervisor's next start. A closed record reads as the unified state `closed_by_owner`, not `failed`, which already means "reconcile again" for the peer lane.

### 4.7 Failure semantics

| Situation | Result |
| :--- | :--- |
| Supervisor running | `journal_busy`: stop the service |
| Journal under old file names / lock file missing | `journal_not_adopted` / `journal_incomplete` |
| Unknown message | `not_found` |
| Not `held` (queued, completed, failed) | `not_reconcilable` with the current phase |
| `executing` | `not_reconcilable`: start and stop the service once, then list again |
| Stale listing | `stale_view` with the current version; nothing written |
| No late text / hash differs or missing where required | `late_result_missing` / `late_result_mismatch` |
| A reply already exists | `reply_exists` (use `mark-completed`); `reply_missing` if `--expect-reply-id` names none |
| Pinned record on accept | `reply_route_pinned`; closing stays available |
| Malformed argument | `invalid_arguments` from the CLI (`invalid_params` from the journal) |
| Same ID, different parameters | `duplicate_id_conflict` |
| Exact retry | stored outcome, `isDuplicate: true` |
| Crash mid-operation | nothing written; retry |

### 4.8 Compatibility, retention and rollback

- Additive: one table, one nullable reply column, one new phase value (`failed`). Older runtimes degrade safely (checked): `describeMessageDelivery` reports `unknown` for an unrecognized phase, `status()` counts ignore it, wake obligations read only held and queued rows, and claims require `queued_local`, so nothing replays. Older compaction leaves `failed` rows in place.
- Retention: `failed` records compact with `completed` ones (8 days, run by the dispatcher). Audit rows are not compacted in the first slice.
- Rollback: reinstall the previous bundle; rows stay inert. A reconciled `completed` record with its reply is an ordinary completed record.
- Packaging: keep the code inside existing modules to avoid a new module, which would need the manifest bump and installer list change.

## 5. Security notes

| Concern | Handling |
| :--- | :--- |
| A model triggers reconciliation | No RPC, MCP tool or sender-facing command text exists. An agent that runs the CLI can see the version and hash, so human review of the late text and the harness's command approval are the controls (4.2). |
| Stale view acted on | Version and late-hash checks; nothing written on mismatch. |
| Hostile late text | Hash-only audit; shown only on request in an untrusted field; the accepted reply is untrusted data for its reader. |
| Discarding a result unseen | Closing a record with late text needs its hash. |
| Replayed side effects | Replay is excluded; closing never re-runs anything, and a stored reply blocks `mark-failed`. |
| Forged provenance | A column written only here, not caller metadata. |
| Wrong record touched | One exact message ID per call; no filter, bulk or wildcard. |
| Old backlog touched | The two held tasks, 14 pending replies and queued request are never named by tests; acting on them needs new exact owner authorization. |
| Lock stolen | Uses the existing owner lock; no override flag. |
| Secrets in output or audit | Claim tokens, wake IDs and credentials are never printed or stored. |

## 6. Verification plan

Disposable journals and state roots only; nothing reads installed state.

- Journal level: every cause in section 3, including the stored-reply variant, produces a listable record; each action's writes and sender-visible result; stale version; late-hash mismatch after a replacement; exact and conflicting retry (the note is part of the identity); crash injected inside the transaction; pinned, non-held and executing refusals; listing leaves the database byte-identical, needs no recovery and refuses legacy-named or lock-less journals; refused calls leave the database byte-identical; audit holds no text; compaction; wake obligations before and after.
- CLI level: in-process runs against a stopped state root; a service in another process holding the journal (the cross-process owner lock) refuses `held`, `reconcile-message` and the normal open; strict flags; failure output.
- Compatibility: load the baseline journal and server modules from git (as `r1-integration-v13.test.mjs` does) and prove they open a journal containing closed and reconciled records, report `unknown`, refuse claims and chat replies on them, and replay nothing.
- Installed acceptance (needs new exact owner authorization): fresh scratch records produced on the Mini, service stopped for the operation, before and after comparison of every original message, reply and route row (excluding the scratch ones), rollback rehearsal. The existing held tasks are not used.

## 7. Slices

| Slice | Delivers | Gate |
| :--- | :--- | :--- |
| O0 | `held` read-only listing and runbook text | tests only; read-only |
| O1 | audit table, `failed` phase, `mark-failed`, `mark-completed`, `closed_by_owner` explanation, compaction rule | owner approval, then install gate |
| O2 | `accept-late-result` for unpinned records, reply column, `reconciled` view | owner approval, then install gate |
| O3 | optional online owner channel | separate owner decision; not designed here |

## 8. Owner decisions

Recommendations, none settled.

1. **Offline first (recommended)** or an online owner channel. Offline costs a service stop per reconciliation, which also pauses the MESH, headless and ACP lanes, and any open (the reconcile call or the restart) holds in-flight interactive claims as `crash_recovery`: check that `triangle-local status` shows `executing: 0` before stopping, or accept that those chats' later replies become late results. Online needs a credential distinct from every turn credential and does not isolate same-user processes.
2. **Actions:** `mark-failed`, `mark-completed` and `accept-late-result` only (recommended); replay stays excluded.
3. **New terminal phase `failed` (recommended)** or `held` with a reason. The second leaves senders told to ask the owner forever.
4. **Pinned (R2) late results:** refuse acceptance in O2 (recommended) or design an owner path to advance the pin.
5. **Late text:** hash-only audit; closing needs the hash and then clears the text (recommended), or retain the text until compaction.
6. **Retention:** closed records with `completed` ones at 8 days and audit rows kept (recommended).
7. **Existing backlog:** untouched until the owner names exact IDs after O1 ships.

## 9. Unverified or open

- The dispatcher stores a runner's reply and completes the record in two separate writes. A crash between them is what produces the stored-reply case above; writing both in one transaction would remove the cause. It is outside this design and was not changed.
- Whether a read-only listing could run beside a live supervisor under `journal_mode=DELETE`; the offline design avoids the question and it was not tested.
- The notifier after a reconciliation was exercised on a disposable host with a stub wake adapter (`local-messaging-reconcile-lifecycle.test.mjs`: a real stop, list, reconcile and restart). `accept-late-result` woke the sender at the next start with the reply and no held item; `mark-failed` sent no wake and the status read `closed_by_owner`. `mark-completed` removes a held item the same way and was not run separately. The installed Codex wake path itself was not exercised.
- Whether any other process opens this journal besides the supervisor, `reconcile-wake`, `held` and `reconcile-message`; only those were checked.
- How an owner-authored reply could advance a reply route pin, if decision 4 goes the other way.
- Whether the owner accepts a service stop per reconciliation, or wants slice O3 earlier.

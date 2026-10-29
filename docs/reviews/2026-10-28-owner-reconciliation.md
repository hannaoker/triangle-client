# Owner reconciliation of held messages (slices O0 to O2)

Candidate branch: `claude/owner-reconcile-o0-o2`, stacked on `claude/owner-recovery-spec` (the design), based on main `451eb44`.
Source and tests only: nothing is installed and no live state was touched. The two existing held tasks, the 14 pending replies and the queued request were not used or named.

## Change

- `triangle-local held` lists held records (and `executing` rows, which have no version and no actions until a normal open holds them) with reason, `createdAt` and `updatedAt`, `pinned`, any stored reply IDs, late-result size and SHA-256, a `version` and the valid `actions`. It takes the owner lock on a `query_only` connection, never runs crash recovery, shows no bodies and creates nothing. `held --show-late-result ID` prints one retained late result in a field marked `untrusted`.
- `triangle-local reconcile-message` applies one action to one exact record, offline:
  - `mark-failed`: phase `failed`, reason `owner_marked_failed`, no reply. A record with late text needs `--expect-late-hash` (closing discards the text); a record that already has a reply is refused (`reply_exists`).
  - `mark-completed --expect-reply-id R`: completes a record whose reply is already stored, writing no reply. This covers the crash between the dispatcher's two writes (store the reply, complete the record).
  - `accept-late-result`: the exact reviewed late text becomes one ordinary reply, `rep-rc-<reconcileId>`, and the record completes with reason `owner_accepted_late_result`. A chat's exact retry, which names its own reply ID, is judged on content and is a duplicate.
  Replay, requeue, claim transfer, deletion and bulk actions do not exist.
- The CLI validates every argument and pre-checks the named record read-only before the normal open, so a refused call (unknown, executing, closed or stale record, bad action, missing hash) changes nothing: no recovery, no migration, no files. Both commands accept only their own flags, and the owner flags are refused on every other command.
- One `BEGIN IMMEDIATE` transaction per call: audit row in `local_reconciliations`, record change and reply commit together. A caller-supplied reconcile ID makes exact retries return the stored outcome (the note is part of the identity); the expected version (now covering stored replies too) and the expected SHA-256 refuse a stale or replaced view.
- Provenance is the new nullable `local_replies.reconcile_id`, surfaced as `reconciled: {reconcileId}` and written only here (the server's `send_reply` accepts caller metadata, so metadata would be forgeable).
- Sender view: phase `failed` with reason `owner_marked_failed` reads as `closed_by_owner`; the unified state is `closed_by_owner` too, not the peer lane's `failed`. Compaction treats `failed` like `completed`.
- A journal under its old file names fails `journal_not_adopted` and one without its lock database `journal_incomplete`, instead of reporting nothing or creating files. Failures print their code and message.
- No RPC, no MCP tool, no sender-facing mention of the commands, and no new module, so the installer file list is unchanged. `triangle-local status` is unchanged (it does not count `failed`).

## Verification

- `local-messaging-reconcile.test.mjs` (18 tests) was written first and failed on the missing exports, and was extended after review. It covers: every hold cause (`crash_recovery`, `runner_timeout` with and without late text, `lease_expired`, `runtime_error`, `uncompleted`, `persistence_failure`, `admission_failure`, and the stored-reply variant); a byte-identical database after listing and after each refused call; hash-only audit; exact and conflicting retries; stale and replaced late results; pinned and no-late-text refusals; an injected failure inside the transaction; the cross-process owner lock (a child process holds the journal and `held`, `reconcile-message`, the pre-check and the normal open all refuse); strict flags; legacy-named and lock-less journals; failure output through the real CLI process.
- The previous runtime (journal and server modules from `451eb44`) opens a journal containing closed and reconciled records, reports them as `unknown`, refuses claims and chat replies on them, never replays them, counts held and completed correctly and leaves closed records in place.
- Worker suite on this branch: 1216 tests, 1213 passed, 3 skipped, 0 failed (main `451eb44`: 1198 tests).
- Independent review (read-only Opus reviewer without the author's reasoning): no blockers, two majors and ten minors, all addressed here.
  - Major: a held record that already had a reply could be closed as failed, telling the sender to rerun finished work. Fixed by `mark-completed`, `reply_exists`, and showing stored replies in the listing.
  - Major: reconciling itself holds in-flight interactive claims, `executing` rows had an unusable version, and a refused call had already run recovery. Fixed by the read-only pre-check, no version for `executing` rows, and documenting the cost in the design (decision 1) and the runbook.
  - Minors: the chat's exact retry conflicting after an accepted late result; the unified `failed` state clashing with the peer lane's meaning; refused calls still writing; legacy names and a missing lock file; `held` not being strictly read-only; dropped error detail; overstated tests and docs (now backed by the tests above); `mark-failed` discarding a late result unacknowledged; accepted records keeping their hold reason; flags accepted by every command. The claim that peer text cannot supply the version and hash was withdrawn in the design (an agent running the CLI sees them next to the late text); the controls are human review, the harness's command approval and the audit row.
  - Left alone: closing sends the sender no wake (documented: it learns from status); the dispatcher's two separate writes, which cause the stored-reply case, are outside this change (design, section 9).
- Not verified: an installed runtime; the stop, list, reconcile and restart sequence on the Mini; how the notifier reacts at the next start; running the listing beside a live supervisor (offline only, by design); leftover SQLite rollback-journal handling after an unclean crash.

## Decisions applied

The design's section 8 recommendations were applied because the owner asked for the remaining items to be completed without further questions: offline first, three actions, a new terminal phase, no pinned-route acceptance, hash-only audit with an acknowledged discard, closed records compacted with completed ones and audit rows kept. All remain open for the owner to overturn in review.

## Gates still open

Merge, install and live acceptance on the Mini (fresh scratch records, service stop, before and after row comparison, rollback rehearsal) need new exact owner authorization. The older backlog stays untouched until the owner names exact IDs.

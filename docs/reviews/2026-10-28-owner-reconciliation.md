# Owner reconciliation of held messages (slices O0 to O2)

Candidate branch: `claude/owner-reconcile-o0-o2`, stacked on `claude/owner-recovery-spec` (the design), based on main `451eb44`.
Source and tests only: nothing is installed and no live state was touched. The two existing held tasks, the 14 pending replies and the queued request were not used or named.

## Change

- `triangle-local held` lists held records (and `executing` rows that the next start will hold) with reason, age, `pinned`, late-result size and SHA-256, a `version` and the valid `actions`. It takes the owner lock, only reads, never runs crash recovery and shows no bodies. `held --show-late-result ID` prints one retained late result in a field marked `untrusted`.
- `triangle-local reconcile-message` applies one action to one exact record, offline: `mark-failed` (phase `failed`, reason `owner_marked_failed`, late text cleared, no reply) or `accept-late-result` (the exact reviewed late text becomes one ordinary reply, `rep-rc-<reconcileId>`, and the record completes). Replay, requeue, claim transfer, deletion and bulk actions do not exist.
- One `BEGIN IMMEDIATE` transaction per call: audit row in `local_reconciliations`, record change and reply commit together. A caller-supplied reconcile ID makes exact retries return the stored outcome; the expected version and, for late results, the expected SHA-256 refuse a stale or replaced view. Pinned reply routes, missing late text and non-held records are refused.
- Provenance is the new nullable `local_replies.reconcile_id`, surfaced as `reconciled: {reconcileId}` and written only here (the server's `send_reply` accepts caller metadata, so metadata would be forgeable).
- Sender view: phase `failed` reads as `closed_by_owner` with "send a new request with new IDs"; the unified state is `failed`; compaction treats `failed` like `completed`.
- No RPC, no MCP tool, no sender-facing mention of the commands, and no new module, so the installer file list is unchanged. `triangle-local status` is unchanged (it does not count `failed`).

## Verification

- The tests in `local-messaging-reconcile.test.mjs` were written first and failed on the missing exports. They now pass (11): each hold cause is listable and reconcilable; listing leaves the database byte-identical and creates nothing; late text and bodies never appear in listings or the audit; exact and conflicting retries; stale version; a replaced late result cannot be accepted by its old hash; the chat's own later reply is a duplicate or a conflict; pinned and no-late-text refusals; an injected failure inside the transaction writes nothing and the retry succeeds; CLI runs against a stopped state root and refuses with `journal_busy` while a journal is open.
- The previous runtime (journal module from `451eb44`) opens a journal containing closed and reconciled records, never claims or replays them, counts held and completed correctly and leaves closed records in place.
- Worker suite on this branch: 1209 tests, 1206 passed, 3 skipped, 0 failed (main `451eb44`: 1198 tests, so +11).
- Not verified: an installed runtime; the stop, list, reconcile and restart sequence on the Mini; how the notifier reacts at the next start; running the listing beside a live supervisor (offline only, by design).

## Decisions applied

The design's section 8 recommendations were applied because the owner asked for the remaining items to be completed without further questions: offline first, the two actions only, a new terminal phase, no pinned-route acceptance, hash-only audit, closed records compacted with completed ones and audit rows kept. All remain open for the owner to overturn in review.

## Gates still open

Merge, install and live acceptance on the Mini (fresh scratch records, service stop, before and after row comparison, rollback rehearsal) need new exact owner authorization. The older backlog stays untouched until the owner names exact IDs.

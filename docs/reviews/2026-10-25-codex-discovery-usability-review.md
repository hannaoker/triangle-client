# Codex review: discovery usability and follow-up designs

Reviewed 2026-10-25 at `b98416e350c9b5366e7ea87b2dad10c88e42f16a`, relative to `66fdd70`. Read-only review of runtime source, tests, the seven listed documents and installation records. This is not approval of the identity design or proof of Desktop idle wake. No production configuration was changed.

## Findings

### P1 (fixed in follow-up): The bound Codex chat can acquire a second inbox and wake binding

`packages/agent-worker/src/claude-session-mcp-child.mjs:707-725` always derives a new `session-` identity for a calling thread. Neither this path nor the workspace broker checks whether that thread already owns the fixed desktop integration. This contradicts the workspace rule that the bound conversation keeps its own identity and inbox.

Reproduced with the existing isolated fixture, changing its bound thread to a UUID, reporting SessionStart for that same UUID and calling `triangle_get_status` through its session child. The fixed identity remained `aaaa…`, while the call returned a different `session-cd8b…` identity; the directory marked that second identity reachable and wake-capable. Reproduction: `/private/tmp/triangle-bound-attachment-repro.mjs`. No live chat or old messages were touched.

Before merging attachment, make the bound thread use its existing inbox or refuse duplicate session attachment with a clear instruction. Enforce the invariant at the broker as well as the child, cover rebind/restart, and test that only one inbox/wake owner exists for the bound thread. Preserve attachment for other threads.

### P2 (design): Wake acceptance is not a sufficient delivery boundary

`docs/plans/2026-10-25-unified-messaging-interface-design.md:138-139` calls a server-recorded room event remote receipt and permits wake acceptance to count as delivery. Neither proves the destination chat retrieved the request. Together with the delivery deadline in line 127, this can exempt a stale request from expiry merely because a notification was queued. Specify destination receipt separately from server custody and hint acceptance; enforce the deadline at receiver admission/claim before execution. A queued hint must not extend a request's validity.

### P2 (design): Compaction cannot imply delivery expiry

The same design, section 4.11, makes `status` return `expired` after the shortest retention window. A successfully completed record that was compacted must not be described as an expired undelivered request. Specify `history_pruned`/`unknown` or a bounded tombstone retaining the true terminal outcome. Define retry behavior once the deduplication record is gone; do not promise indefinite exactly-once execution.

### Documentation: checkpoint mixes current and superseded status

`docs/handoffs/2026-10-24-discovery-usability-checkpoint.md` still lists items 6 and 7 as not started while later sections and the two design documents record completed designs and owner decisions. Its early test counts and file summary also predate attachment. Update the summary to distinguish implemented/installed, designed, and acceptance pending; keep earlier evidence dated.

## Verification

- Branch clean before review; local head `b98416e`. No push, PR, merge or install performed.
- Current supervisor manifest: bundle `502630cfb87128b9219c1d9e5d6e93331df5fa2985074cf69f6508ced3d5b4db`, v12, 81 artifacts. Every installed artifact hash matches the manifest and current branch source. This verifies disk contents, not current process ownership.
- Both release records match the commits/bundles reported in the installation documents.
- Focused attachment/discovery/Claude/wake/closure suite: **125/125 passed**, no skip. Initial restricted run blocked three tests on process metadata or `/private/var/tmp`; permitted rerun passed all three. Log: `/private/tmp/triangle-discovery-review-tests-unrestricted.log`.
- `git diff --check 66fdd70..HEAD` passed.
- The new duplicate-inbox reproduction succeeds despite the existing suite passing: a missing invariant test.

## Release recommendation and remaining work

- Titles/presence: no blocking defect identified in the reviewed paths; can be separated for review/release.
- Codex attachment: the P1 ownership invariant is fixed by the follow-up below; no remaining merge blocker was identified in these reviewed paths. Desktop idle wake, restart and close/reopen acceptance remain open.
- Unified interface and identity reconciliation: design artifacts only. Recorded per-option owner decisions do not constitute overall design approval. This review does not independently validate the seven identity decisions or the server feature-branch assumptions; review those contracts before implementation.
- Still open: five new Desktop timing trials, real compaction, hardware sleep/wake, and the fresh attached Desktop idle-wake test. CLI/fake-notifier evidence does not close these gates.
- Keep cross-machine work and new-worker launch deferred per the owner's priority decision.

## Follow-up fix

The session child and broker now refuse the bound thread with `bound_codex_context`, reading the current integration on every admission/credential refresh. Directory and recipient validation also fence an existing attachment when its thread becomes the bound conversation. The row explains that the existing identity/inbox should be used. Regression covers direct broker bypass, an already-attached chat becoming bound, child recreation and supervisor restart; another thread still attaches normally. No raw thread id is added to the journal. Desktop idle acceptance is still open.

Follow-up verification: affected messaging/discovery/Claude/Grok/inbox/wake/closure/supervisor suite **312/312 passed**, zero skips/failures, under the permitted process-access run. `git diff --check` passed. Native helpers and installer sources are unchanged.

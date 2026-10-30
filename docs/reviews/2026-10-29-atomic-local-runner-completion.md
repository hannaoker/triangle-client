# Atomic local runner completion

Candidate branch: `codex/atomic-local-runner-completion`, based on `ea5e0d5`.
Source only; not installed. Claude independently reviewed head `637d1fe` through
Triangle and found no blockers or major findings. The original selected reviewer
had returned a model-capacity error; it supplied no review.

## Problem and change

The production local dispatcher stored a successful reply and then marked the
request completed in two separate writes. A crash between them left a visible
reply beside uncertain execution. Owner `mark-completed` reconciliation supports
that legacy case, but ordinary runner completion should not create it.

The journal now exposes `completeExecutionWithReply`. A single synchronous SQLite
transaction validates the original runner request, correlation, execution phase
and duplicate reply, stores the reply, and marks the request completed. There is
no await between writes. Held, owner-closed, pinned and interactive work cannot
be completed through this method. Exact retries return the existing reply;
conflicting retries roll back. The original helper methods remain for existing
callers and legacy reconciliation tests.

The production dispatcher requires this atomic journal method, including injected
journals at start. It fails closed rather than falling back to the old two-write
path. This is an internal backend contract change, not a new CLI/RPC/MCP operation.
No journal migration, new artifact type, permission change or message schema is
needed. Installation still requires a rebuilt supervisor bundle with new hashes.

## Verification

- 60 focused journal, dispatcher and reconciliation tests passed.
- Final worker suite: 1239 tests, 1236 passed, 3 skipped, zero failed in one run.
- Real SQLite trigger failure between reply insertion and completion rolls back
  the reply before the dispatcher holds the request with `persistence_failure`.
- Disposable child processes are killed with SIGKILL immediately before and after
  the transaction COMMIT. Reopen shows, respectively, held/no reply or completed/
  one reply, with no queued replay in either case.
- Exact/conflicting retries, original correlation, held and interactive fencing,
  successful restart, and non-atomic backend refusal are covered.
- Syntax and whitespace checks passed. No live service, policy or journal was
  changed. Installed runtime remains the accepted #141–143 release.

## Release boundary

Independent review of the original implementation is complete. Installed acceptance is still separate;
source crash tests must not be presented as a new installed-runtime crash test.
The owner recovery commands remain necessary for historical partial states and
other holds; this change does not reconcile or replay existing records.

## Review follow-up

Claude reported missing regression coverage for pinned runner requests, queued
and owner-closed phases, and a completed request with no stored reply. Added
explicit refusal tests that verify no request or reply mutation.

A new regression reproduced stale failure handling changing a completed request
back to held. `recordExecutionFailure` now updates only queued or executing work;
queued admission failures remain supported. The tests also preserve existing held
reasons. The recovery-only dispatcher fixture is explicitly labeled as not
modeling production atomic reply persistence. Legacy helpers remain available
for recovery and existing adapters; production dispatch has no two-write fallback.

These follow-up changes do not modify the installed runtime or protected backlog.

Final follow-up verification: `npm test --workspaces=false` in
`packages/agent-worker` passed 1236 of 1239 tests, with 3 skips and zero failures.
The preliminary restricted top-level run had four environment-access failures
(`/private/var/tmp`, process inspection, and the installed Hermes lock); the
complete run with normal local access passed those checks. Focused 60/60,
syntax and whitespace checks passed. Log:
`/private/tmp/pr146-review-worker-unrestricted.log`.

# Atomic local runner completion

Candidate branch: `codex/atomic-local-runner-completion`, based on `ea5e0d5`.
Source only; not installed. Independent review remains pending: the selected
reviewer twice returned a model-capacity error and supplied no review.

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
No journal migration, new artifact, permission change or message schema is needed.

## Verification

- 55 focused journal, dispatcher and reconciliation tests passed.
- Final worker suite: 1234 tests, 1231 passed, 3 skipped, zero failed in one run.
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

Obtain independent review before merge. Installed acceptance is still separate;
source crash tests must not be presented as a new installed-runtime crash test.
The owner recovery commands remain necessary for historical partial states and
other holds; this change does not reconcile or replay existing records.

# Messaging status explanations

Candidate branch: `codex/messaging-status-ux`, based on main `924e3df`.
Candidate source `bd357a3` is installed and running on the Mini. Read-only installed acceptance passed.

## Motivation

Live acceptance repeatedly required separating queue custody, notification
acceptance, model execution, tool approval and correlated reply delivery. Mailbox
emptiness after a claim and an accepted wake are insufficient execution evidence.

## Scope

Add safe, actionable delivery descriptions to local send receipts, per-message
status and session listings, shared by CLI and MCP callers. Preserve existing
fields and the underlying lifecycle. Notification evidence uses exact queued-item
fingerprint membership, not counts or timestamps. Approval remains unknown.
Owner reconciliation is recommended for held work and expired claims. Directory
hints are omitted if needed to preserve an otherwise valid bounded response.
No database migration, new packaged artifact or new permission is required.

## Verification

The first 107 focused tests passed across wire/MCP status, notifications,
attachments, exact grants and Grok. Additional boundary tests cover frame size,
raw phase preservation for expired claims, uncertain/legacy fingerprints and
safe offline/pull-only wire responses. Final full-suite results are recorded below.

Independent Codex review found no blocker. It identified misleading failure-retry
wording; that wording now requests owner reconciliation rather than suggesting an
idempotent resend can restart terminal work. Review-requested wire and fingerprint
edge cases received additional tests.

Final worker aggregate: 1198 tests, 1194 passed, 3 skipped, one initial failure.
The remaining failure was a Claude MCP directory assertion expecting the previous
exact object shape. It now checks the additive explanation and independently
retains its exact checks for all prior metadata. The affected Claude MCP, host and
new status test files reran together: 22/22 passed. This is combined aggregate and
focused-rerun evidence, not a fresh single all-green aggregate invocation.
Syntax and `git diff --check` passed. Existing CLI host tests verified send receipt
and completed-status explanations through actual disposable CLI/socket processes.
Source verification did not modify live state. The later installation is recorded below.


## Installed acceptance

Installed immutable bundles from `bd357a3`: supervisor 90 artifacts, each
Codex/Hermes/Antigravity worker 92; all file hashes verified. The existing service
was restarted; no additional supervisor was started. A delayed stop caused the
first transaction to refuse staging. The service was confirmed stopped before
staging continued successfully; rollback was not needed.

Read-only packaged CLI checks verified completed, held and queued explanations
against existing owner-accessible requests. All 43 current directory entries
included delivery explanations, with Grok correctly shown as pull-only. No request
was claimed, retried or consumed, and no new canary or grant was created.

Post-install comparison to the snapshot confirms all 78 message rows, 75 reply
rows and one reply-route row are unchanged. Local config and session policy are
byte-identical. The original 14 pending replies, two held tasks and one queued
request remain untouched.

This is existing-state CLI acceptance; notification, expired-lease and frame-size
edge cases remain source-test evidence. The shared server response is exercised;
no fresh Desktop MCP model turn is claimed. Machine-local record:
`releases/pr140-install-verification.json` under the application root. Backup:
`archive/pr140-20261029T051933Z` (October 28 in America/Los_Angeles).

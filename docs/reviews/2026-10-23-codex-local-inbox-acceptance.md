# Bound Codex local inbox — implementation and acceptance

Owner decision: after merged/installed #111, the owner requested Claude initiating
requests to this existing Codex conversation, with its existing wake owner,
explicit sender permission, correlated reply, busy-chat and restart recovery.
This extends the approved desktop push path to incoming local requests. It does
not authorize a second App Server, headless Codex drain, new chat owner, MESH
bridge, worker launcher or cross-machine transport.

## Shape

`setup-inbox --sender <exact-id>` grants a named local sender access to the
bound desktop identity. No default receiver permission is granted. Workspace
participation remains a separate capability ceiling. The host intersects receiver
policy with issued claims and current session policy. Incoming messages use the
existing durable interactive inbox and never the runner dispatcher.

Desktop inbox grants bind the current thread/integration capability and a separate
receiver-policy epoch. Disable, re-enable and rebind fence stale grants. Claim
custody is retained, not silently transferred. `inbox`, `claim` and `reply` are
available through the supported installed CLI; three corresponding MCP tools are
added. Stable claim/reply operation IDs are required, and CLI reply reads its
claim token from a private claim file rather than the process argument list.

The existing notifier includes queued incoming requests in its canonical
fingerprint and emits only numeric `Pending incoming requests`, with no peer
text. It shares the same outstanding-wake state, receipt target and arbiter as
reply notifications. Existing reply-only configuration remains supported.
Peer messages remain untrusted; retrieve/surface is the default, and execution
requires the receiver's own owner-authorized task policy. Results remain free-form.

## Verification boundaries

Source tests exercise Claude -> Codex -> original Claude, second-session isolation,
exclusive/idempotent claims, MCP and CLI paths, incoming-only wake, queued restart
recovery, disable/re-enable, stale grants and rebind. Claiming removes an item
from the queued inbox while its durable record becomes executing. A fresh role
cannot steal a previous executing claim.

A live startup failure found a mechanical CLI flag edit selecting the legacy
pairing path. It was fixed and an executable MCP-entry regression added; direct
adapter-only tests had not caught it. Initial CLI-only attempts had no registered
lifecycle and were refused; none are counted as a delivered message. Desktop
computer use initially timed out and recovered later. No session token registry
was scanned; temporary diagnostics logged only own-context presence booleans and
sanitized error codes in the disposable workspace.

## Live canary (candidate loaded temporarily in the existing supervisor)

The bound Codex identity is `8dc26a2fc9a622dc5ed9e3560fa0533a38b8f0998e7c34108cfb1301c6aaab64`;
the thread remains `01a14c05-6603-7921-b744-659195a490a5`.
Only the disposable workspace was enabled. After startup correction, Desktop fork
9 attached as `session-406ab3553ae7e3fab0b46c4bc007e09a87a58da0c77fad7cedc35f5fb431ecfd`.
Receiver policy authorized only that exact address.

Claude used its real Triangle MCP tool to send `codex-inbox-desktop-live`, request
ID identical, with text `CLAUDE_DESKTOP_TO_CODEX_CANARY`. It appeared in this
chat's durable interactive inbox, with no runner execution. While this Codex turn
was active, the existing queue adapter accepted wake
`77da0b67-d533-4fba-aff5-79c7579b8d4e` and receipt
`01a16c30-f98f-7d12-bb0a-904d4f187612` for this exact thread, with one pending
incoming request. This proves busy-chat queue acceptance, not a separately
observed idle-chat model turn. The same queued request and accepted wake survived a supervisor restart. Codex
claimed it using a private claim file, sent `codex-inbox-desktop-reply` with exact
text `CODEX_TO_CLAUDE_INBOX_OK`, and acknowledged its wake. The request became
completed with no runner execution. Claude Desktop automatically received wake
`f0550234-ac6a-455a-9554-f58e5cb27ad6`, retrieved only the correlated reply,
reported its exact text, consumed it and acknowledged that wake. Its visible
response and tool outcomes were inspected in the original sending session.
The Codex claim/reply was handled during this active turn; an independently
observed idle Codex model turn remains a release gate.

## Test results retained honestly

An initial broad focused run passed 86 and failed one unchanged descendant-readiness
timing test. The first full run passed 949, failed five and skipped three: one
outdated MCP tool-list expectation (updated for the approved new tools) and four
failures in unchanged readiness/timeout/cursor fixtures. The latter were checked
serially: the supervisor readiness check passed, but descendant.ready, a 100ms
runner timeout rejection and the wake cursor timing assertion failed again.
The suite is not claimed fully green. Final feature-focused run: 102 passed, zero failed (serial, including packaging closure). Whitespace checks passed.

No permanent installation or merged release is claimed for this candidate.

## Cleanup and release status

Inbox permission, disposable workspace messaging and discovery were disabled with
all cleanup-required flags false. The three temporary runtime stages were rolled
back in reverse order, the wrapper restored from the merged #111 release, and
the original service restarted. Installed manifest validation passed. Status
shows discovery disabled, no queued/executing work, 30 completed, and the same
14 older replies and two held tasks. Those older peer contents were not executed.
The candidate remains a draft for review; the installed runtime is #111.

## Follow-up: repeated backlog wakes

The old notifier compared whole snapshot hashes. Removing an incoming request by
claiming it, consuming a reply, or toggling inclusion of an empty inbox changed
the hash even when remaining work had already been announced. These were fresh
wake IDs for old obligations, rather than retries of one wake ID.

Wake fingerprints now store a versioned set of per-obligation hashes in the same
opaque durable fingerprint fields. A snapshot fully covered by the acknowledged
snapshot stays quiet. New replies, incoming requests and changed held/late-result
records still notify; acknowledgment covers only the submitted snapshot, so a
new arrival while a wake is outstanding is not swallowed. The same comparison
also applies to Claude's interactive wake reservation. No database schema changes
or message consumption are required.

A regression fails against the prior source (three notifications instead of two)
and passes after the fix. All 49 affected notifier, journal, Codex inbox and
packaging tests pass. Coverage survives journal reopen and empty inbox mode
changes. Legacy hash-only fingerprints keep exact matching; upgrading an older
journal can emit one conservative notification to establish versioned coverage.
The patch is source-verified and pushed with #113; the installed #111 runtime has
not been changed by this follow-up.

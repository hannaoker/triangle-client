# Exact chat grants implementation verification

Candidate branch: `codex/exact-chat-grants`, based on main `71b83c1`.
Candidate code `80bdf06` installed on the Mini. Installed scratch-chat acceptance passed; all temporary exact grants were removed. Existing workspace-wide sender lists were preserved.

## Behavior

Version 2 session policy adds bounded directional exact pairs while version 1
remains readable. The broker applies the same effective authorization to its
delivery directory, issued credential recipients and authoritative send-time
check. Discovery can still show an unauthorized chat as visibility-only. Revoking
an initiation grant does not cancel accepted work or its valid claim-bound reply.
Grok's separate pairing ACL remains an additional check.

The owner CLI adds grant/revoke/list and explicit `--exact-only` workspace setup.
List reports broad sender lists alongside pairs; revoking a pair cannot negate an
independent broad grant. All session-policy writers participate in a shared
private lock to prevent lost updates and restored revocations. Crashed edit locks
fail closed and require operator reconciliation as documented in the runbook.

## Verification

- Focused Codex/Claude attachment and Grok suites: 65 tests passed.
- Broad worker run: 1190 tests, 1181 passed, 4 skipped, 5 failed initially.
  Four failures were execution-environment restrictions (`/private/var/tmp`, two
  `/bin/ps` probes, installed Hermes help/lock access). Normal-access rerun of the
  three affected files: 56 passed, 1 skipped, no failures.
- The fifth failure was a preexisting documentation assertion expecting the old
  `Testing and builds` heading after the README had renamed it. The test now
  bounds the worker section by the next level-two heading, retaining its content
  checks. Its file rerun passed all 20 tests.
- The final focused Codex file rerun includes CLI subprocess migration, concurrent
  revoke/grant processes, contention with setup/disable, empty exact-only setup
  preservation, exact cross-harness delivery, stale credential revocation, reverse
  initiation denial, reply custody and malformed-policy checks.
- Syntax and whitespace checks passed. This is combined aggregate plus focused
  rerun evidence, not a single all-green aggregate invocation.

## Independent review

An independent Codex reviewer found and prompted fixes for lost concurrent policy
edits, same-owner exact-only setup preservation, and disabled-harness delivery
listing. Follow-up review found no remaining authorization blocker. A final empty
pair-list preservation edge was fixed and regression tested. The initially chosen
DeepSeek reviewer was unavailable for this account and supplied no review.

## Installed acceptance (2026-10-28)

The owner supplied three fresh attached Claude chats (A, B, C). A temporary
exact A→B grant allowed the fixed-token request and its correlated B→A reply.
A reported `recipient_not_allowed` for C; the denied ID has no journal admission.
After grant revocation, A reported the same denial for a new B request, also
absent from the journal. The original accepted request could still be answered
after revocation, and A consumed that exact reply.

No temporary pair remains; policy stays v2 with the prior broad lists intact.
All 74 original message rows, 71 original reply rows and one original reply-route
row match the pre-install snapshot byte-for-field. The 14 older pending replies,
two held tasks and original queued request are untouched. Fixed-token setup
reports were consumed and this chat’s corresponding wakes acknowledged.

Denial errors are peer reports corroborated by absent admissions, not a captured
raw tool transcript. Rejection using an earlier credential is covered by source
tests; the live heartbeat may have refreshed credentials. Machine evidence:
`releases/pr139-install-verification.json` and `releases/pr139-chat-acceptance.json`
under the application root. Supervisor has 90 verified artifacts; each worker has
92. Existing older session MCP processes may need reload to read v2 policy.

## Upgrade and rollback boundary

Install a matching supervisor, CLI and session MCP runtime before first creating
v2 policy; reload old MCP children. Older readers reject v2. Revoke retains v2,
so rollback requires a compatible private policy and runtime together, or disabling
messaging. Installed scratch-chat acceptance above covers exact target access, sibling denial,
revocation and cleanup. No live backlog or held task was consumed by this work.

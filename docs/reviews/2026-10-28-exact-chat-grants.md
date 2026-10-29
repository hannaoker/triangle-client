# Exact chat grants implementation verification

Candidate branch: `codex/exact-chat-grants`, based on main `71b83c1`.
Not installed or activated. Existing live permissions were not modified.

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

## Remaining release gate

Install a matching supervisor, CLI and session MCP runtime before first creating
v2 policy; reload old MCP children. Older readers reject v2. Revoke retains v2,
so rollback requires a compatible private policy and runtime together, or disabling
messaging. Real scratch-chat acceptance must separately prove exact target access,
sibling denial, immediate revoke, and grant cleanup. No such installed acceptance
is claimed here. No live backlog or held task was consumed by this work.

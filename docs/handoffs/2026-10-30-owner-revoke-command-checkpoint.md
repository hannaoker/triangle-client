# Owner revoke command checkpoint

2026-10-30 PDT. Codex quota pause after the bounded command implementation.
Branch `codex/owner-revoke-command`, based on merged #157 / main `89722e8`.

## Completed

- #153–#157 merged. Candidate `0.2.0-owner-approval.1` passed exact native password/
  cancel/full-detail acceptance on disposable records, but remains uninstalled and
  disabled. See the existing plan, review and private releases records.
- New source command: `triangle identity revoke <profile> --registry-root DIR` plans
  read-only. `--confirm PLAN_ID` requires a local terminal, no SSH, exact fresh plan
  and native owner authentication. It revokes only the local principal binding.
- Provider resolution is from this CLI release's private manifest, with an explicit
  `identity.revoke` capability and exact pinned helper. No caller helper path or
  `--yes`/approval-Boolean bypass. Ordinary/candidate/test-only packages refuse.
- Builder supports explicit `--owner-approval revoke` in addition to candidate.
  No installed package, real registry, credential or messaging permission changed.
- SIGINT/SIGTERM propagate cancellation; source tests verify cancellation preservation
  and interrupt-listener cleanup, not a real terminal interruption acceptance.
- Revoke bridge loads lazily, preserving other CLI commands when worker modules are
  missing. Tests cover missing dependencies with clean errors and no paths/stacks.

## Verification

Final focused run: **133 passed, zero failed/skipped**. Command:

```sh
TRIANGLE_OWNER_APPROVAL_NATIVE_BIN=/private/tmp/triangle-owner-approval-artifact-9x01fkd6/bin/triangle-owner-approval node --test packages/triangle-cli/test/identity-revoke-cli.test.mjs packages/triangle-cli/test/owner-approval*.test.mjs packages/triangle-cli/test/identity-migrate-cli.test.mjs packages/triangle-cli/test/identity-status-cli.test.mjs packages/triangle-cli/test/core.test.mjs packages/agent-worker/test/identity-registry.test.mjs
```

Log `/private/tmp/identity-revoke-final-acceptance.log`.
Full packaging run: **12 passed**, log `/private/tmp/identity-revoke-package-tests.log`.
It took about 260 s while the machine was busy; it completed, not stalled. No
leftover process from that run was cleaned up or inferred from unrelated old Node
processes. Package tests built/installed into disposable homes, not the Mini.

Package run was before final CLI interruption/error/render refinements. The final
focused run covered those. New native OS approval through the full command has
not been exercised; positive CLI/source tests use stand-ins with the actual
registry writer. Native validation mode was real and non-interactive.

## Next owner

1. Review the source PR, particularly release-capability selection, canonical target,
   plan hash, native-auth gating, SIGINT handling, unchanged sibling state and error
   behavior. Test dependencies do not represent a security boundary against an
   unrestricted same-user process.
2. Re-run package checks only for new changes or remaining package concerns. Build
   a private command-enabled package with `--owner-approval revoke`; do not publish
   or install it on the Mini yet.
3. Test the actual packaged command against a new disposable registry: read-only
   plan, non-terminal refusal, then an owner-led terminal/password Cancel and Apply
   with full details readable. Each application must append one audit record, no
   other records changed. Confirm plan staleness and interruption behavior. Owner
   presence is required for prompts; previous consent covered earlier native-helper
   tests, not a live identity mutation.
4. Merge/install only within the agreed scope after review and acceptance. No live
   principal revocation is authorized here. Preserve all old message backlog.

CLI modes remain CLI plus background service; no app/Keychain requirement. Linux/
Windows providers, identity moves/versioned audit/schema and remote routes remain
outside this slice. No source code changes are needed for ordinary messaging.

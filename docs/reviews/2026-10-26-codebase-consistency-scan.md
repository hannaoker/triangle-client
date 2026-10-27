# Client codebase consistency scan — 2026-10-26

Checkpoint, not a completed release. Base: merged main b1c8946. Worktree:
`/Users/zhenyuhou/Projects/The Triangle/worktrees/consistency-cleanup`, branch
`codex/consistency-cleanup`. Feature work is paused. No live service, messaging
permission, enrollment, custody or runtime configuration was changed by cleanup.
The separate MESH server repository and Rust peer-engine rebuild are outside this
scan; the aggregate covers the client JavaScript packages and native host tests.

## Findings and cleanup

1. **Aggregate test coverage drift:** the curated agent-worker release command
   omitted 35 top-level test files, including discovery, Grok, identity, routing,
   installed inventory and R2. Delegate it to the package's full existing test
   entry so new top-level tests are included automatically.
2. **Test group drift:** positional slices had assigned local lifecycle/native
   checks to the gateway group as suites were added. Explicit runtime/gateway
   membership now partitions all suites; gateway selects the SDK and two
   reference gateways. Unknown groups fail before running tests. Two focused
   contract tests cover this boundary.
3. **Node compatibility gap:** staging checked globSync but not the runtime's
   unflagged SQLite requirement. The probe now requires Node >=22.13, imports
   DatabaseSync, executes a disposable in-memory query and closes it. A fixture
   simulates glob support without SQLite and verifies rejection; the real Node
   probe passes. Agent-worker and client-console engine metadata/lock records now
   match the root and their SQLite-dependent CLI dependency. The old source
   contract assertion was updated accordingly.
4. **Documentation drift:** R2 still claimed v13/not installed and unmerged;
   replaced contradictory incremental status with the implemented contract and
   linked installed evidence. Handoff now records merge b1c8946. Main guides now
   distinguish local identities/transport from MESH, document Linux managed
   Codex/systemd support and Cursor ACP, and warn against using historical shared
   App Server procedures for desktop-owned chats. Existing historical procedures
   and dedicated headless App Server support were preserved.
5. **Hermes diagnostic quality:** the installed-help test now includes stderr in
   failures. Its initial restricted-run failure did not establish a broken
   install: normal-access `hermes chat --help` succeeded without model calls.

## Verification at checkpoint

- Focused runner/manifest/probe tests: 19 passed.
- Source/document contract plus runner tests after engine assertion correction:
  10 passed.
- macOS session delivery/discovery checks with normal host access: 44 passed.
- Isolated CLI lock-recovery check with normal access: 1 passed.
- `git diff --check` clean.
- Initial restricted aggregate: installer passed; worker 1175 passed, five failed,
  four skipped. One failure was the corrected engine assertion; three were
  forbidden process/temp-directory operations; one was restricted Hermes help.
  CLI suite then stopped progressing. Stopped only that verified test tree.
- Full normal-access aggregate is RUNNING at checkpoint. Do not claim a green
  aggregate yet. Process session: 46041. Log:
  `/private/tmp/triangle-consistency-normal-tests.log`.
  Packaged installer and runner contracts have passed; worker suite is in
  progress. This run includes the corrected assertions and current changes.
- Original restricted log: `/private/tmp/triangle-consistency-all-tests.log`.
  Supporting logs: `/private/tmp/triangle-cleanup-focused.log`,
  `triangle-cleanup-contract-tests.log`, `triangle-cleanup-host-access-tests.log`,
  `triangle-cleanup-lock-check.log`, and `triangle-cleanup-hermes-help.log`
  beneath `/private/tmp`.

## Resume

Read the running aggregate's final summary (wait on session 46041 if available).
Investigate real remaining failures without suppressing checks. Review the small
source/test changes and doc diff; then create a reviewable cleanup PR. No merge,
deployment or live activation is part of this checkpoint. Retain active/older
worktrees and runtime archives; they were not deleted as speculative cleanup.

The Codex quota guard requested a soft pause at 17% remaining. The owner must
choose whether Codex continues or another provider takes over. No provider
handoff has been sent yet.

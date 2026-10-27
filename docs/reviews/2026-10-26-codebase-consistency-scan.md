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

## Verification evidence

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
- Initial normal-access aggregate (`/private/tmp/triangle-consistency-normal-tests.log`):
  12/16 suites passed, 4 failed on pre-existing environment setup and stale fixture version.
  - Passing suites (12): test runner contracts, packaged installer,
    agent-worker (triangle-client: 1181 passed, 3 skipped, 0 failed),
    triangle-cli (115 passed), linux-runtime (39 passed), client-console (16 passed),
    cutover-headless-supervisor, enable-headless-engagement, hermes-exec-wrapper,
    worker-service-render, macos-mailbox-helper host, peer-proof-hermes.
  - Failing suites (4 initial):
    - `triangle-client-service`: asserted `runtime.version === 10` on line 171 of
      `tests/triangle-client-service.test.mjs`, while source was bumped to v14 in merge b1c8946.
    - `a2a-gateway`, `agents/codex`, `agents/hermes`: failed with `ERR_MODULE_NOT_FOUND`
      for `@the-triangle/a2a-gateway` due to missing workspace symlinks in fresh worktree.
- Setup prerequisites & corrective remediation:
  - Canonical setup check: `npm ci --ignore-scripts --no-audit --no-fund` fails closed in worktrees
    when workspace package entries diverge (`@the-triangle/linux-runtime@0.1.0` missing from lockfile).
    Standard `npm install --ignore-scripts --no-audit --no-fund --package-lock=false` safely established
    the ignored workspace symlinks in `node_modules/@the-triangle` without touching `package-lock.json`.
  - Fixture alignment: updated `tests/triangle-client-service.test.mjs:171` to assert current manifest version 14.
  - Corrected test gate run (`/private/tmp/triangle-consistency-correction-tests.log`):
    - `triangle-client-service`: 27 passed, 0 failed (exit 0).
    - `packages/a2a-gateway`: 105 passed, 1 skipped, 0 failed (exit 0).
    - `agents/codex`: 24 passed, 0 failed (exit 0).
    - `agents/hermes`: 20 passed, 0 failed (exit 0).
  - Combined verification evidence: 12 prior-pass normal suites + 4 corrected rerun suites (16/16 suites resolved).
- Gemini direct verification of changed contracts:
  - `tests/test-runner.test.mjs`: 2 passed (exit 0).
  - `packages/agent-worker/test/client-source-contract.test.mjs` + `worker-bundle-closure.test.mjs`:
    25 passed (exit 0).
  - `packages/agent-worker/test/runner-adapters.test.mjs`:
    12 passed, 1 skipped (keychain sandbox hermes pm repair), 0 failed (exit 0).

## PR Preparation

Review verified no behavioural or authority regressions. The allowlisted changes align
test coverage, group partitioning, staging probes, engine metadata, workspace setup guidance,
and platform documentation without modifying live services or credentials.


## Final verification correction

Codex's final review caught that the new README recommended npm ci while the lockfile lacked both Linux workspace records. Added only packages/linux-runtime metadata and its node_modules workspace-link record; no dependency versions changed. `npm ci --dry-run --ignore-scripts --no-audit --no-fund` now exits 0, superseding the earlier lockfile-divergence limitation. The gateway reruns above used standard npm install with package-lock=false before this metadata repair; this is recorded rather than presented as a successful npm ci installation. Codex independently reran the 19 runner/manifest checks (all passed), inspected the correction diff and four exit-0 rerun logs, and confirmed git diff --check is clean. No deployment or live permissions changed.

# Multi-Profile Headless Codex Cutover Implementation Plan

> **For implementer:** Use TDD throughout. Write failing test first. Watch it fail. Then implement.

**Goal:** Run every enabled headless Codex profile as an isolated drain inside the single Triangle Client supervisor and complete the Mini cutover with valid credentials and live post-restart canaries.

**Architecture:** Replace the singleton binding/bootstrap/drain contract with a bounded, sorted collection. Swift resolves one credential-bearing bootstrap entry per enabled Codex profile; Node validates the complete collection and starts one independently locked drain per entry with atomic startup/rollback. The cutover script writes a v2 multi-profile binding and refuses partial acceptance.

**Tech Stack:** Swift helper, Node.js ESM, macOS launchd, shell/Python cutover tooling, `node:test`, Swift host contracts, MESH mailbox helper.

---

### Task 1: Specify the multi-profile Swift bootstrap

**Files:**
- Modify: `packages/macos-mailbox-helper/Tests/TriangleMailboxTestSupport/ClientSupervisorContractCases.swift`
- Modify: `packages/macos-mailbox-helper/Tests/TriangleMailboxTestSupport/TriangleClientCLIContractCases.swift`
- Modify: `packages/macos-mailbox-helper/Sources/TriangleMailboxCore/ClientSupervisor.swift`

**Step 1: Write the failing contracts**

Add contract cases that provision two enabled Codex profiles in
`headless-app-server` mode and a v2 binding with two entries. Assert:

```swift
let wakes = bootstrap.headlessWakes
try expect(wakes.map(\.profile) == ["codex-bob-test", "codex-headless"], "headless wakes are not sorted")
try expect(Set(wakes.map(\.profileInstanceId)).count == 2, "headless instance IDs collided")
try expect(Set(wakes.map(\.stateRoot)).count == 2, "headless state roots collided")
```

Add negative cases for a missing binding entry, duplicate instance ID, loaded
dedicated drain for either profile, and one invalid credential. Every enabled
profile must be represented either in `headlessWakes` or by an explicit bounded
omission; release-preflight mode must reject any omission.

**Step 2: Run the host contract filter and confirm RED**

Command:

```bash
TRIANGLE_CONTRACT_FILTER=client-supervisor bash packages/macos-mailbox-helper/scripts/test-host.sh
```

Expected: FAIL because `PreparedBootstrap` exposes only `headlessWake` and the
binding fixture supports one profile.

**Step 3: Implement the minimal Swift collection contract**

- Replace `headlessWake` with `headlessWakes` in `PreparedBootstrap`.
- Parse the v2 binding into exact common keys plus exact profile entries.
- Sort enabled Codex members by profile.
- Match each member to exactly one binding entry.
- Resolve and confine each profile credential separately.
- Return one `PreparedHeadlessWakeBootstrap` per eligible profile.
- Detect duplicate profiles, instance IDs, and state roots.
- Preserve bounded omission reasons without exposing credentials.

**Step 4: Run the focused Swift contracts and confirm GREEN**

Run the command from Step 2. Expected: all selected contracts pass.

**Step 5: Commit**

```bash
git add packages/macos-mailbox-helper/Sources/TriangleMailboxCore/ClientSupervisor.swift \
  packages/macos-mailbox-helper/Tests/TriangleMailboxTestSupport/ClientSupervisorContractCases.swift \
  packages/macos-mailbox-helper/Tests/TriangleMailboxTestSupport/TriangleClientCLIContractCases.swift
git commit -m "feat(supervisor): emit all headless Codex profiles"
```

### Task 2: Start and stop one Node drain per profile

**Files:**
- Modify: `packages/agent-worker/test/client-supervisor-cli.test.mjs`
- Modify: `packages/agent-worker/test/client-supervisor.test.mjs`
- Modify: `packages/agent-worker/test/codex-runtime/headless-drain.test.mjs`
- Modify: `packages/agent-worker/src/client-supervisor-cli.mjs`
- Modify: `packages/agent-worker/src/client-supervisor.mjs`
- Modify: `packages/agent-worker/src/codex-runtime/headless-drain-service.mjs`

**Step 1: Write failing Node tests**

Add tests with two valid headless configs asserting:

```js
assert.deepEqual(supervisor.headlessInstanceIds, [BOB_ID, HEADLESS_ID]);
assert.equal(createdDrains.length, 2);
assert.deepEqual(createdGuards.map((guard) => guard.profile), ["codex-bob-test", "codex-headless"]);
```

Add one-behavior tests for:

- duplicate profile/instance/state-root rejection;
- per-profile lock paths derived from `helperPath` without `HOME`;
- atomic construction before start;
- rollback when the second start fails;
- reverse-order stop and guard release;
- collision with worker, event wake, desktop App Server, or Grok Bot IDs;
- strict rejection of legacy singleton/unknown top-level keys after v2 activation.

**Step 2: Run focused tests and confirm RED**

```bash
node --test \
  packages/agent-worker/test/client-supervisor-cli.test.mjs \
  packages/agent-worker/test/client-supervisor.test.mjs \
  packages/agent-worker/test/codex-runtime/headless-drain.test.mjs
```

Expected: FAIL because the parser and supervisor accept only `headlessWake`.

**Step 3: Implement the minimal multi-drain lifecycle**

- Add strict `headlessWakes` array parsing with a bounded maximum of 100.
- Normalize, freeze, and sort the array.
- Validate cross-mode IDs and per-profile uniqueness before side effects.
- Construct all guards and drains before startup.
- Use `Promise.all` only after construction succeeds.
- On startup failure, abort/stop started drains and release all acquired guards.
- On shutdown, settle all drains and release all guards.
- Expose read-only `headlessInstanceIds`, `headlessWakes`, and per-profile skip
  reasons for status/tests.

**Step 4: Run the focused tests and confirm GREEN**

Run the command from Step 2. Expected: all tests pass.

**Step 5: Commit**

```bash
git add packages/agent-worker/src/client-supervisor-cli.mjs \
  packages/agent-worker/src/client-supervisor.mjs \
  packages/agent-worker/src/codex-runtime/headless-drain-service.mjs \
  packages/agent-worker/test/client-supervisor-cli.test.mjs \
  packages/agent-worker/test/client-supervisor.test.mjs \
  packages/agent-worker/test/codex-runtime/headless-drain.test.mjs
git commit -m "feat(agent-worker): supervise isolated headless drains"
```

### Task 3: Generate and migrate the v2 binding

**Files:**
- Modify: `tests/cutover-headless-supervisor.test.mjs`
- Modify: `tests/triangle-client-service.test.mjs`
- Modify: `tests/worker-service-render.test.mjs`
- Modify: `scripts/macos/cutover-headless-supervisor.sh`
- Modify: `scripts/triangle-client-service.sh`
- Modify: `scripts/triangle-worker-install.py`

**Step 1: Write failing cutover tests**

Extend the fixture with two enabled Codex profiles. Assert that plan/apply writes:

```json
{
  "version": 2,
  "common": {
    "adapterVersion": "1",
    "installationId": "inst_test",
    "workingDirectory": "/...",
    "codexHome": "/...",
    "command": "/.../codex",
    "pollIntervalMs": 1000
  },
  "profiles": [
    {"profile":"codex-bob-test","instanceId":"...","stateRoot":".../codex-bob-test"},
    {"profile":"codex-headless","instanceId":"...","stateRoot":".../codex-headless"}
  ]
}
```

Assert deterministic sorting, no room pins, v1 repeat-apply migration, stale
entry rejection, and no Grok/non-Codex entries.

**Step 2: Run focused integration tests and confirm RED**

```bash
node --test tests/cutover-headless-supervisor.test.mjs \
  tests/triangle-client-service.test.mjs \
  tests/worker-service-render.test.mjs
```

Expected: FAIL because apply writes the singleton binding.

**Step 3: Implement v2 planning/apply**

- Derive entries from all enabled Codex headless profiles.
- Reuse safe v1 common values during migration.
- Derive a distinct default state root for every profile.
- Validate exact schema and prohibit room pins.
- Snapshot/restore v1 or v2 binding during rollback.
- Update runtime manifest/install validation for the new committed artifacts.

**Step 4: Run focused integration tests and confirm GREEN**

Run the command from Step 2. Expected: all tests pass.

**Step 5: Commit**

```bash
git add scripts/macos/cutover-headless-supervisor.sh \
  scripts/triangle-client-service.sh scripts/triangle-worker-install.py \
  tests/cutover-headless-supervisor.test.mjs \
  tests/triangle-client-service.test.mjs tests/worker-service-render.test.mjs
git commit -m "feat(cutover): bind every headless Codex profile"
```

### Task 4: Integrate the existing stripped-environment/runtime fixes

**Files:**
- Modify: `packages/macos-mailbox-helper/Sources/TriangleMailboxCore/WorkerLauncher.swift`
- Modify: `packages/macos-mailbox-helper/Tests/TriangleMailboxTestSupport/ClientSupervisorContractCases.swift`
- Modify: `packages/macos-mailbox-helper/Tests/TriangleMailboxTestSupport/TriangleClientCLIContractCases.swift`
- Modify: `packages/agent-worker/src/client-supervisor.mjs`
- Modify: `packages/agent-worker/src/codex-runtime/headless-drain-service.mjs`
- Modify: `packages/agent-worker/test/codex-runtime/headless-drain.test.mjs`

**Step 1: Preserve and extend the existing regression tests**

Keep the current uncommitted version-5 runtime and missing-`HOME` tests. Extend
the missing-`HOME` case to two profile-specific locks.

**Step 2: Run focused tests**

```bash
node --test packages/agent-worker/test/codex-runtime/headless-drain.test.mjs
TRIANGLE_CONTRACT_FILTER=client-supervisor bash packages/macos-mailbox-helper/scripts/test-host.sh
```

Expected: PASS after Tasks 1–3; any failure blocks integration.

**Step 3: Review the baseline diff**

Verify the retained changes are limited to helper-path lock derivation, runtime
version 4/5 resolution, safe repeat-apply parsing, and their tests. Remove
temporary diagnostic output.

**Step 4: Commit**

```bash
git add packages/macos-mailbox-helper/Sources/TriangleMailboxCore/WorkerLauncher.swift \
  packages/macos-mailbox-helper/Tests/TriangleMailboxTestSupport/ClientSupervisorContractCases.swift \
  packages/macos-mailbox-helper/Tests/TriangleMailboxTestSupport/TriangleClientCLIContractCases.swift \
  packages/agent-worker/src/client-supervisor.mjs \
  packages/agent-worker/src/codex-runtime/headless-drain-service.mjs \
  packages/agent-worker/test/codex-runtime/headless-drain.test.mjs
git commit -m "fix(supervisor): support stripped multi-profile runtime"
```

### Task 5: Review and release candidate verification

**Files:**
- Review: all files changed since design commit `12ea086`

**Step 1: Independent spec review**

Review the full diff against
`docs/plans/2026-09-21-multi-profile-headless-cutover-design.md`. Fix every
Critical or Important spec gap and add a regression test for any new invariant.

**Step 2: Independent quality/security review**

Review secret confinement, exact JSON schemas, path validation, duplicate/cross-
mode rejection, atomic startup/rollback, reply-before-ack preservation, and
bounded logs. Fix Critical/Important findings and re-run affected focused tests.

**Step 3: Run release checks once**

```bash
node packages/macos-mailbox-helper/scripts/run-tests.mjs host
node --test tests/triangle-client-service.test.mjs \
  tests/cutover-headless-supervisor.test.mjs \
  tests/worker-service-render.test.mjs
npm --prefix packages/agent-worker test
npm --prefix packages/client-console test
git diff --check
```

Expected: all pass.

### Task 6: Rebind credentials and apply on Mini

**Files/state:**
- Update through reviewed credential lifecycle only:
  `~/Library/Application Support/The Triangle/credentials/local/mailbox/codex-bob-test.json`
- Apply: `scripts/install-macos-mailbox-helper.sh`
- Apply: `scripts/triangle-client-service.sh`
- Apply: `scripts/macos/cutover-headless-supervisor.sh`

**Step 1: Resolve intended identities without exposing secrets**

Confirm `codex-headless` maps to
`agent_4aced27b92cb436dba06cc840756b072` and resolve the retained live
`codex-bob-test` identity. Refuse the retired
`agent_c31a37012d9745038dd9839308fc1e39`.

**Step 2: Rotate/recover the retained `codex-bob-test` credential**

Use the reviewed recovery/rotation endpoint or operator procedure. Write the
credential atomically with mode `0600`; do not print it. Verify with an
authenticated read-only request.

**Step 3: Build and stage committed artifacts**

```bash
./scripts/install-macos-mailbox-helper.sh --local-ad-hoc
./scripts/triangle-client-service.sh prepare-runtime
./scripts/macos/cutover-headless-supervisor.sh plan
```

Plan must show exactly the enabled Codex profiles and no room pins/omissions.

**Step 4: Apply and verify stable process state**

```bash
./scripts/macos/cutover-headless-supervisor.sh apply
launchctl print gui/$(id -u)/dev.thetriangle.client
```

Require one running coordinator, no shared/dedicated drain LaunchAgents, fresh
readiness, no restart loop, and an installed manifest matching committed hashes.

### Task 7: Live per-profile canaries

**Files/state:** Production MESH rooms and mailbox state only.

**Step 1: Send one nonce-bound work item to each enabled Codex identity**

Use a separate direct room or existing approved room for each identity. Require
the exact nonce in a substantive reply and `replyRequired: true`.

**Step 2: Verify settlement**

For each profile verify:

```text
inbound event -> claimed by intended profile -> Codex turn -> threaded reply -> ack
```

Confirm no profile claimed the other profile's delivery, both transaction
queues are empty, and both completion journals/state roots advanced.

**Step 3: Record the release result**

Report local tests, committed source, installed artifact hashes, process state,
identity mappings, event/reply IDs, and quiet mailbox evidence separately. Do
not mark complete if either profile lacks the full chain.

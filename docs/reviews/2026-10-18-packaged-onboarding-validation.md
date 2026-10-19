# Packaged onboarding validation

This slice replaces source-build/manual profile binding with a bundled macOS
CLI and background service plus `triangle setup`. It keeps the existing MESH
invitation, controller, workload-token and claim/reply/ack protocols.

## Scope and review

- Bundled Node, public file-custody Swift binaries, reviewed runtime assets,
  checksum verification before execution, and versioned local releases.
- Resumable setup with hidden invitation input or private invitation file,
  preflight before enrollment, existing-bound-identity adoption, and automatic
  harness/service configuration. No Apple app or Keychain dependency for MESH.
- Codex, Hermes, Antigravity and Cursor ACP remain supported. Existing delivery
  modes, custom Codex homes, shared working directories and harness settings are
  preserved. Linux service packaging and then Windows are follow-up work.
- Independent review found and corrected the Codex binding schema, bound-agent
  selection, custom Codex login-home adoption, actual SQLite compatibility, and
  preservation of non-headless delivery modes. Live integration also corrected
  the helper status JSON check (`lifecycle`, distinct from bind’s `status`).
- Live startup exposed the existing lifecycle's insufficient 10-second deadline.
  It now permits 60 seconds. Setup permits 180 seconds so an activation failure
  can also finish its restoration attempt.
- A repeated host test exposed intermittent concurrent private-directory
  creation. Atomic private-mode mkdir retains canonical-path, owner and symlink
  checks while eliminating the intermediate permissions window. Repeated
  32-way resolution tests and independent source review cover this correction.

## Verification

- Packaged installer: 9 tests passed, including corruption, unsafe archive,
  wrong architecture, collision refusal, legacy upgrade and a consumer PATH
  without external build tools.
- Owner CLI plus generic supervisor bundle: 82 tests passed; final runtime
  focused suite passed after the timeout and real helper lifecycle-status adjustments.
- Swift host executable: 192 contract cases passed after the concurrency fix.
- Swift focused launcher tests: 11 passed, including five repetitions of the
  32-way creation test. Lifecycle tests cover 16 readiness/rollback contracts.
- Release documentation and secret-boundary checks passed.
- The full repository run was not entirely green: an old Node-engine assertion
  was updated and passed, the host Hermes wrapper could not run in the test
  environment, and the unchanged D5 cursor test failed its timing assertion but
  passed in isolation. Gateway suites initially lacked workspace links; after
  dependency installation all three gateway suites passed (one server-source
  integration case skipped because that separate repository is absent).
- Dependency audit reports existing gateway web dependency advisories (3 high,
  1 critical). Those packages are outside this bundled CLI's payload; no
  dependency upgrades are included here.

## Evidence boundaries

Temporary-account installation proves archive/bootstrap and installed executable
launch without consumer build tools. Mock-authority enrollment tests prove
resumability and local state orchestration, not fresh-account hosted enrollment
or signed-in harness behavior on an untouched machine. A fresh-machine
Gatekeeper/quarantine exercise remains a release-distribution check. Checksums
must arrive through an authenticated channel; an adjacent hash and ad-hoc
signature alone do not establish publisher authenticity. No public download URL
or Linux/Windows background-service support is claimed by this change.

## Mac mini installation

Installed `0.2.0-onboarding.4` using the standalone package installer. Resuming
guided setup for the existing Cursor profile returned `state: running`; the
helper verified the same bound identity and the lifecycle activated the service.
The owner still has the same four agents; no duplicate enrollment was created.
The installed runtime also accepted the existing Codex v2 binding in preflight.

All four existing profiles completed disposable MESH reply tests using the fresh
packaged supervisor and binaries: gravity2 19s, ghost 31s, bob 37s, codex-headless
44s. These are observations from one run, not latency guarantees. Afterwards all
four transaction-status reports were empty, with no open or stuck transaction
and no quarantined delivery. The last CLI-only correction did not change those
Swift binaries or the worker runtime closure.

Final archive SHA-256:
`48b021e4fc0383cbe1d7110dbb4d8b61b6af4b0cf7c24b6f9a418c66b40c4272`.
Both binaries passed the public signing/file-custody readiness check, and the
final package installed into an isolated account with `PATH=/nonexistent`.
The versioned package, installer, checksum and smoke receipts are retained in the
Mini workspace's `releases/triangle-client-0.2.0-onboarding.4/` directory outside
this source repository. Public release publication is separate from this PR.

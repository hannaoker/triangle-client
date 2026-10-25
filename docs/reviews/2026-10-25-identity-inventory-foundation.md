# Independent Implementation and Review: Identity Inventory Foundation and CLI Exposure (Slice 1a)

Date: 2026-10-25
Author: Antigravity
Worktree: `/Users/zhenyuhou/Projects/The Triangle/worktrees/identity-inventory`
Branch: `codex/identity-inventory` (based on `main` `db5e28a`)
Status: Source CLI exposure and library foundation implemented and verified. Full Slice 1a is NOT complete.

---

## 1. Scope and Design Alignment

This step implements the source CLI exposure of the read-only identity inventory projection foundation specified in `docs/plans/2026-10-25-identity-reconciliation-design.md` (Sections 2–4 and 11, Slice 1a) and required by the Unified Messaging Interface plan (`docs/plans/2026-10-25-unified-messaging-interface-design.md`, Section 7, R1 dependency).

### Enforced Invariants

1. **Read-Only & Secret Prevention Boundary**:
   - Accepts the output of `readInstallationInventory` from `packages/agent-worker/src/installation-inventory.mjs`.
   - Performs zero filesystem writes, process launches, Keychain operations, or network calls.
   - Enforces strict output allowlists on all projected objects: caller-supplied credentials, private keys, passwords, and tokens cannot leak into reports.
   - Retains validated bounded `code` and `profile` from underlying blockers and warnings with fixed diagnostic text; arbitrary caller message strings are never copied into diagnostics.
   - Rejects and masks malformed origin, agent, instance, and session string values rather than echoing arbitrary malformed payloads in diagnostics.
   - Bounded display labels (profile names, handles) and valid identifiers are preserved as legitimate metadata when valid; no speculative regex scanning is performed over user metadata.
   - Defense-in-depth: drops unallowlisted secret keys via `stripSecretKeys` and applies deep object freezing to ensure immutability.

2. **Explicit Supervisor Client Root & No Conflation with MESH Custody**:
   - The CLI command `triangle identity inventory --client-root ABSOLUTE_PATH [--json]` requires an explicit, absolute path for `--client-root`.
   - Does not guess across platforms or infer paths from environment variables.
   - Does not conflate `--home` (MESH custody) with supervisor client root.
   - Does not call `openSession` or `openCustody` (which would initialize state or invoke the network).
   - Passing nonexistent `--home` and `--client-root` creates zero files or directories on disk.

3. **No Process Probes or Fabricated Liveness**:
   - When no read-only supported liveness probe is supplied, `pidAlive` and `advisoryHeldAt` default to returning `"unknown"`.
   - Never claims processes are dead (`pidAlive: false`) or locks are unlocked (`advisoryHeld: false`).
   - Launches zero process probes or lock acquire/probe operations.

4. **Authority Scoping & Bound Evidence Validation**:
   - MESH managed identities are keyed strictly by `(authorityOrigin, agentId)`.
   - Validates bare HTTPS origins without userinfo, path, query, or fragment (`isValidBareHttpsOrigin`).
   - Requires a valid matching derived instance ID (`deriveClientInstanceId(profile)`) for mapped profiles.
   - Missing origins, credential-bearing origins, invalid origins, missing instance IDs, and mismatched instance IDs are diagnosed as faults and remain unmapped profiles (`identityCount: 0`).
   - The same agent ID observed under different authority origins is never unified across servers, and generates an explicit `origin_mismatch` diagnostic.

5. **No-Merge, Ambiguity Preservation, and Reorder Stability**:
   - Preserves exact identifiers (`agent_<32-hex>`, 64-hex `profileInstanceId`, and `session-<64-hex>`).
   - Profiles sharing the same handle or display name are never merged into a single identity; they remain distinct principals and produce a `handle_collision` diagnostic.
   - Multiple local profiles binding to the same agent ID are explicitly reported with an `ambiguous_mapping` diagnostic rather than auto-merged.
   - When multiple profiles bind to the same agent with differing handles, the projection does NOT arbitrarily choose a winner based on traversal order; `ident.handle` is set to `null` (explicit ambiguity), `ident.handles` preserves all unique sorted handles, and individual profile bindings retain their observed handles.
   - Diagnostic messages list conflicting profiles in deterministic alphabetical order without embedding input traversal order.
   - Output is 100% byte-for-byte stable under reordering of conflicting inputs, duplicate profile records, duplicate instance claims, and session ties.

6. **Observed On-Disk Bindings vs. Verified Live Authority**:
   - Every managed identity explicitly notes `authority.observedOnDisk: true` and `authority.verifiedLiveAuthority: false`.
   - Human-readable rendering explicitly indicates that reports reflect host-local disk observations rather than verified live authority (`observed on disk; not live verified`).
   - Shows ambiguity, unmapped profiles, faults, and warnings clearly.

7. **Status/Doctor Isolation**:
   - Existing `triangle status` and `triangle doctor` commands are unchanged; their MESH status paths have different network/session semantics and are preserved.

---

## 2. Allowlisted Changes

This implementation was strictly confined to allowlisted files:

1. **`packages/triangle-cli/src/cli.mjs`**:
   - Added `identity inventory --client-root DIR` command routing and help text.
   - Validates required absolute explicit `--client-root` and disallows extra positional arguments or unknown options.
   - Supports `--json` flag and human-readable output via `print(io, flags, report, renderIdentityInventory)`.
   - Allows dependency injection via `identityDependencies`.

2. **`packages/triangle-cli/src/identity-inventory.mjs`**:
   - Thin command bridge exporting `identityInventory({ clientRoot, ... })` and `renderIdentityInventory(report)`.
   - Defaults `pidAlive` and `advisoryHeldAt` to returning `"unknown"` to prevent unauthorized probes or false claims.
   - Dynamically imports `@the-triangle/agent-worker` modules so CLI default/help remains fully operational without sibling modules.

3. **`packages/triangle-cli/test/identity-inventory-cli.test.mjs`**:
   - 8 comprehensive tests verifying real multi-profile fixtures, JSON and human-readable formatting, required absolute root validation, unknown subcommand/option/positional handling, graceful handling of missing installation root, duplicate/fault reporting, non-mutation of nonexistent paths, byte-for-byte before/after fixture immutability, and network fetch trap non-invocation.
   - Includes automatic cleanup of scratch directories in test `finally` blocks.

4. **`docs/reviews/2026-10-25-identity-inventory-foundation.md`**:
   - Architectural review, verification record, packaging audit, and boundary specification.

5. Pre-existing foundation files:
   - `packages/agent-worker/src/identity-inventory.mjs`
   - `packages/agent-worker/test/identity-inventory.test.mjs`

No other files in the repository were created or modified.

---

## 3. Packaging and Release Gate Analysis

### Packaging Closure Audit

1. **Installed CLI Bundle vs. Source CLI**:
   - `packages/triangle-cli/src/identity-inventory.mjs` dynamically imports `installation-inventory.mjs` and `identity-inventory.mjs` from `@the-triangle/agent-worker`.
   - The CLI statically imports the new thin bridge; only the identity command dynamically loads the agent-worker inventory modules. The source CLI regression suite passes. Installed CLI operation has not been exercised in this step.
   - The package archive builder (`scripts/release/build-client-package.mjs`) includes tracked source files matching `packages/(triangle-cli|agent-worker)/src/.*\.mjs`.

2. **Unresolved Release Gate (Manifest v12 vs v13)**:
   - `scripts/triangle-worker-install.py` defines `CURRENT_MANIFEST_VERSION = 12`. Its artifact lists (`SUPERVISOR_ARTIFACTS`, `WORKLOAD_CORE_ARTIFACTS`, etc.) currently omit `installation-inventory.mjs` and `identity-inventory.mjs`.
   - Per prompt constraints and Owner Decision 4 (Unified Messaging Interface design), neither `scripts/triangle-worker-install.py`, package manifests, nor Swift release scripts were modified. Manifest bump is deferred to a single release train (v13) for R1–R5.
   - This step represents **source CLI exposure only**. The archive builder and supervisor runtime manifest are separate packaging surfaces: omission from the supervisor manifest alone does not prove the packaged admin CLI is broken. Installed-package closure and execution remain untested; the later release train must verify each surface it activates.

---

## 4. Verification and Test Results

### Commands and Exit Status

1. CLI test suite execution:
   ```sh
   npm --prefix packages/triangle-cli test
   ```
   **Result**: Exit code `0`. **93/93 passed** (85 existing tests + 8 new identity inventory CLI tests), 0 failures, 0 skipped. Duration: ~5.67s.

2. Agent-worker identity and installation inventory tests:
   ```sh
   node --test packages/agent-worker/test/identity-inventory.test.mjs packages/agent-worker/test/installation-inventory.test.mjs
   ```
   **Result**: Exit code `0`. **45/45 passed** (13 identity inventory tests + 32 installation inventory tests), 0 failures, 0 skipped. Duration: ~1.35s.

3. Git diff check against origin/main:
   ```sh
   git diff --check origin/main
   ```
   **Result**: Exit code `0`. Clean whitespace and formatting.

---

## 5. Remaining Slice 1a and 1b Work (Do NOT Claim Full 1a Complete)

This change delivers **source CLI integration only**. It does NOT complete Slice 1a or Slice 1b:

1. **Status/Doctor Integration (Remaining Slice 1a)**:
   - `triangle status` and `triangle doctor` have not been wired to display the identity projection.
   - Supervisor default path resolution (removing the temporary explicit `--client-root` requirement) remains to be integrated once supervisor storage conventions are finalized.

2. **Release Train Manifest Bump (Remaining Slice 1a Release Gate)**:
   - Manifest v13 in `scripts/triangle-worker-install.py` and Swift release scripts must include `identity-inventory.mjs` and `installation-inventory.mjs` for installed package support.

3. **Registry Schema and Storage (Remaining Slice 1a)**:
   - `<TRIANGLE_HOME>/identity/` schema definitions and file storage layout remain to be finalized.
   - Cryptographic registry machinery is intentionally excluded from this slice.

4. **Owner-Confirmed Migration (Slice 1b)**:
   - `triangle identity migrate --confirm` and persistence of `local_profile_binding_v1` remain future Slice 1b work.

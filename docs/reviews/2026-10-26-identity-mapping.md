# Identity Mapping Implementation Review (Slice 1b First Cut)

Date: 2026-10-26
Branch: `antigravity/identity-mapping`
Baseline Commit: `48a90ba520343397be197afba65725b5226ae097`

## 1. Scope

Implements the owner-confirmed identity mapping step (Slice 1b first cut) specified in `docs/plans/2026-10-25-identity-reconciliation-design.md` (Sections 3, 4.1, 8, 11).
Translates read-only identity inventory observations into recorded `local_profile_binding_v1` entries in the host-local identity registry (`identity_registry_v1`), strictly requiring owner confirmation against the exact plan shown.

### Components
1. **Pure Planner (`packages/agent-worker/src/identity-mapping.mjs`)**:
   - `planIdentityMapping({ inventory, registry })`: computes a deep-frozen plan `{ schema: "identity_mapping_plan_v1", planId, registrySequence, proposals, unchanged, blocked, localOnly, summary }`.
   - `planId`: SHA-256 hex of `canonicalJson` over the plan without `planId`.
   - `proposals`: generated strictly for `mesh-managed` identities whose single profile has valid bound evidence and no fault or ambiguity diagnostic. Binding ID is deterministic: `"bind_"` followed by the first 32 hex characters of `sha256("triangle-binding-v1\0" + profile_instance_id + "\0" + principal_id + "\0" + authority_origin + "\0" + generation)`.
   - `unchanged`: profiles where the registry already holds an identical, unrevoked binding.
   - `blocked`: profiles with bounded reason codes: `ambiguous_mapping`, `duplicate_profile`, `duplicate_instance_id`, `origin_mismatch`, `malformed_record`, `custody_fault`, `conflicts_with_recorded`, `recorded_revoked`.
   - `localOnly`: unbound local profiles (`unbound_local_profile`).
   - Deterministic and collision-resistant: byte-identical outputs under reordered inputs; never merges identities or profiles by name or handle.

2. **Confirmed Apply (`packages/agent-worker/src/identity-mapping.mjs`)**:
   - `applyIdentityMapping({ root, confirmation, readInventory, now })`:
     - Re-reads inventory and registry to recompute the plan.
     - Refuses with `confirmation_mismatch` if confirmation does not match the seen plan ID.
     - Refuses with `plan_stale` if recomputed plan ID differs from confirmation (e.g. inventory or registry changed in between).
     - Sequentially calls `updateIdentityRegistry` with `action: "bind"`, subject `profile_instance_id`, expected sequence, and stamped `issued_at`.
     - On step failure, halts and returns/reports `{ applied, failed, remaining }` with a fresh plan showing the remainder.
     - Fully idempotent second runs.

3. **CLI Command (`packages/triangle-cli/src/identity-migrate.mjs`, wired in `cli.mjs`)**:
   - `triangle identity migrate --client-root ABS --registry-root ABS [--json]`: read-only plan mode. Prints human summary or JSON. Never creates `registry-root`.
   - `triangle identity migrate --client-root ABS --registry-root ABS --confirm PLAN_ID`: apply mode. Refuses with exit 2 if stdin/stdout are not a terminal or if `PLAN_ID` is not 64 lowercase hex characters. Exits 0 on success, exit 2 on `plan_stale`/`confirmation_mismatch`, exit 1 on partial failure.
   - Enforces explicit absolute paths and forbids registry root equaling or containing client root.

## 2. Plan and Confirmation Protocol

1. **Step 1 (Plan Inspection)**:
   The owner runs:
   ```bash
   triangle identity migrate --client-root /path/to/client --registry-root /path/to/registry
   ```
   The tool reads the client inventory and the registry (if present). If the registry does not exist, sequence is treated as 0 and the directory is not created.
   The tool prints:
   - Summary of proposals, unchanged, blocked, and local-only counts.
   - Each proposal: profile name, principal ID, authority origin.
   - Each blocked item: profile name and bounded reason code.
   - Each local-only profile.
   - The unique 64-hex `Plan ID`.
   - The exact `--confirm <planId>` command to execute.

2. **Step 2 (Owner Confirmation)**:
   The owner executes the exact command:
   ```bash
   triangle identity migrate --client-root /path/to/client --registry-root /path/to/registry --confirm <64-hex-planId>
   ```
   The tool verifies stdin and stdout are interactive terminals, re-reads inventory and registry, and verifies that the recomputed `planId` equals `--confirm`. If matched, bindings are committed via atomic compare-and-set updates with SHA-256 hash-chained audit logging.

## 3. Explicit Limits

As specified in the Slice 1b design:
- **Recorded Proof**: The proof kind is `disk_observation` (`observed_on_disk: true`, `verified_live_authority: false`). It records host-local disk observations, not live remote authority assertions or network-verified proofs.
- **Approval Check**: Approval requires an interactive terminal check plus the exact matching plan ID. The design's OS password re-entry (`sudo -v` / helper sheet) is not applied to mapping in this slice (an owner decision).
- **No Serverless Principals**: MESH-managed identities (`agent_<32-hex>`) are supported; serverless principals (`peer_<32-hex>`) are deferred to Slice 3a.
- **No Override or Rebind**: No `--map-profile` manual override, no revocation or rebind flows in this slice.
- **No Default Registry Location**: Roots must be explicitly supplied as absolute paths.
- **No Supervisor or Status Integration**: Does not alter the running supervisor process, runtime bundles, or `triangle status`/`triangle doctor`.

## 4. Verification Record

- **New Library & CLI Tests**:
  - `packages/agent-worker/test/identity-mapping.test.mjs` (13 tests): pure planning, proposal generation, unchanged classification, all 8 blocked reasons, input immutability, determinism under reordering, no name-based merge, confirmation mismatch, plan staleness, audit logs, partial failure recovery, client root immutability, boundary isolation (no external fs, no env reads, source-level import isolation).
  - `packages/triangle-cli/test/identity-migrate-cli.test.mjs` (7 tests): usage error validation, plan output in human and JSON modes, non-creation of nonexistent registry root in plan mode, terminal requirement enforcement, wrong/malformed plan ID rejection, full confirmation success, idempotent second run, network fetch trap verification.
  - Test result: 20 passed, 0 failed.
- **Full Regression Suite**:
  - All agent-worker tests (`identity-inventory.test.mjs`, `identity-registry.test.mjs`, `installation-inventory.test.mjs`, `worker-bundle-closure.test.mjs`, `supervisor-runtime-bundle.test.mjs`): 86 passed, 0 failed.
  - All CLI tests (`npm --prefix packages/triangle-cli test`): 100 passed, 0 failed.
  - Built client package test (`tests/client-package.test.mjs`): 9 passed, 0 failed.
- **Diff Check**: `git diff --check 48a90ba520343397be197afba65725b5226ae097` is clean with zero whitespace or formatting issues.

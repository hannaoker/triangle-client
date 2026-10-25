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
     - Refuses with `confirmation_mismatch` if the confirmation is not a 64-hex string, or differs from a seen plan or plan ID the caller passes in.
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
  - `packages/agent-worker/test/identity-mapping.test.mjs` (16 tests): pure planning, proposal generation, unchanged classification, all 8 blocked reasons, input immutability, determinism under reordering, no name-based merge, confirmation mismatch, plan staleness, audit logs, partial failure recovery, client root immutability, boundary isolation (no external fs, no env reads, source-level import isolation).
  - `packages/triangle-cli/test/identity-migrate-cli.test.mjs` (9 tests): usage error validation, plan output in human and JSON modes, non-creation of nonexistent registry root in plan mode, terminal requirement enforcement, wrong/malformed plan ID rejection, full confirmation success, idempotent second run, network fetch trap verification.
  - Test result: 25 passed, 0 failed (after the review fixes in section 5).
- **Full Regression Suite**:
  - All agent-worker tests (`identity-inventory.test.mjs`, `identity-registry.test.mjs`, `installation-inventory.test.mjs`, `worker-bundle-closure.test.mjs`, `supervisor-runtime-bundle.test.mjs`): 86 passed, 0 failed.
  - All CLI tests (`npm --prefix packages/triangle-cli test`): 102 passed, 0 failed.
  - Built client package test (`tests/client-package.test.mjs`): 9 passed, 0 failed.
- **Diff Check**: `git diff --check 48a90ba520343397be197afba65725b5226ae097` is clean with zero whitespace or formatting issues.

## 5. Reviewer verification and changes (reviewer: Claude, 2026-10-25)

### Independent probes
A script kept outside the repository drives the planner, the apply step and the CLI; 75 of 75 pass on the fixed branch.
- **Planner.** Plans are byte-identical under 40 random reorderings of a rich inventory. An ambiguous pair, one agent under two origins, a duplicate profile record, a malformed agent id and a custody state are all blocked with the specified reason and never proposed. An unbound profile is local-only. Identical handles on different agents stay separate (both proposed). Against a registry, an identical binding is `unchanged`, a different principal or origin is `conflicts_with_recorded`, and a revoked binding is `recorded_revoked`. Frozen inputs are accepted. The binding id and the plan id were recomputed independently and match.
- **Apply.** Malformed and stale confirmations write nothing, including when the registry changed after the plan was shown. A full run records each binding with a matching audit entry and a verified chain. A rerun is idempotent. A partial failure reports applied, failed and remaining, and the remaining plan then completes the mapping. A symlinked registry root is refused. Two processes applying the same plan at once record every binding exactly once.
- **CLI.** Plan mode leaves a missing registry root missing and the client tree unchanged. `--confirm` without a terminal exits 2. Under a real pseudo-terminal a wrong plan id exits 2, the exact id applies, a second plan has only unchanged entries, and the first id is then stale.

### Built package (nothing installed)
Two client packages were built with `scripts/release/build-client-package.mjs` in a scratch directory, using the installed public ad-hoc helper and client binaries and the bundled Node 22.22.3 of the installed 0.2.0-onboarding.4 release as prebuilt inputs: one from this branch (142 files) and one from the registry storage tip `48a90ba` (140 files). The difference is `identity-mapping.mjs` and `identity-migrate.mjs` added and `cli.mjs` changed; `worker-artifacts.json` is identical.
- The packaged CLI with the bundled Node ran under a macOS sandbox that denies network access and all file writes: `identity migrate --client-root <real client directory> --registry-root <path that does not exist> --json` exited 0 with a 2,206-byte plan, byte-identical to the source run. A fingerprint of path, mtime, size and mode over the client directory and `profiles-v1` (84 entries) was identical before and after, and the registry root was not created. The plan has 3 proposals (`codex-headless`, `ghost`, `gravity2`, all under `https://thetriangle.dev`), no blocked and no local-only profiles.
- Apply from the package, on a fixture, in a sandbox that denies network access and allows writes only inside the fixture directory: plan, then `--confirm` without a terminal (exit 2, nothing created), then `--confirm` under a pseudo-terminal (exit 0, "Recorded 2 identity binding(s) to registry (sequence 2)"). The registry holds `.registry.lock`, `identity-registry-v1.json` and `registry-audit.jsonl`; the proof is `disk_observation`; a second plan shows 0 proposals and 2 unchanged.
- Deleting `identity-mapping.mjs` from a copy of the package makes the command exit 1 (see open note 1).

### Changes made in review
- The mapping library and the CLI bridge imported the registry module through a concatenated specifier (`"identity-" + "registry.mjs"`), which hid the dependency from the registry's own source-level isolation test. Both now import it plainly, and that test names the two allowed importers.
- `planIdentityMapping` read an unrecognised registry value as an empty registry. It now throws `invalid_registry: unrecognized_registry_shape`; `null`, `undefined` and `{ state: "absent" }` still mean no registry.
- `applyIdentityMapping` replaced an invalid explicit `now` with the clock. It now throws `invalid_now` before reading or writing anything.
- The printed `--confirm` command did not quote paths, and the real client root contains spaces. Paths are now quoted for a POSIX shell.
- A registry root inside the client root was accepted, so an apply would have written into the client tree. It is now a usage error.
- The partial-failure test injected its fault through a counting `now` function. It now uses `faultHook`, which fails inside the registry commit.
- Four of the new tests (registry shapes, invalid `now`, registry inside the client root, shell quoting) fail on the code as first committed. The lane-health test documents behaviour that was already correct.

### Open notes (not blockers)
1. When the agent-worker modules are absent, a plain `Error` escapes as an uncaught exception with a stack trace and absolute paths, as with `identity inventory`. Decide with the `status` and `doctor` integration.
2. The plan lists only identity-evidence problems. A lane-health fault on a profile (for example `binding_missing`) does not block its mapping, and faults that belong to no profile are not shown, so read `identity inventory` before confirming.
3. From the CLI a well-formed plan id that differs from the recomputed plan always reports `plan_stale`; `confirmation_mismatch` is only reachable through the library.
4. The terminal check is not proof of human presence. A process running as the same user that can allocate a pseudo-terminal can run the confirm command, as the probes did with `script`. The plan id ties the confirmation to the exact plan, not to a person. The design's OS re-authentication is not applied to mapping in this slice (owner decision).
5. `summary` repeats each count under two names (`proposals` and `proposalCount`, and so on). Drop one set the next time the shape is touched.
6. The default registry location is undecided (assumption A4), so a real run needs an explicit `--registry-root`. Nothing in this change writes to the real application directory.

### Commands run
```sh
/Users/zhenyuhou/.local/bin/node --test packages/agent-worker/test/identity-mapping.test.mjs packages/agent-worker/test/identity-registry.test.mjs packages/triangle-cli/test/identity-migrate-cli.test.mjs
/Users/zhenyuhou/.local/bin/node --test packages/agent-worker/test/identity-inventory.test.mjs packages/agent-worker/test/installation-inventory.test.mjs packages/agent-worker/test/worker-bundle-closure.test.mjs packages/agent-worker/test/supervisor-runtime-bundle.test.mjs
npm --prefix packages/triangle-cli test
/Users/zhenyuhou/.local/bin/node --test tests/client-package.test.mjs
git diff --check 48a90ba
```
Results: 41 of 41, 70 of 70, 102 of 102, 9 of 9, and a clean diff check.

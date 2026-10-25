# Independent Implementation and Review: Identity Inventory Foundation (Slice 1a)

Date: 2026-10-25  
Author: Antigravity  
Worktree: `/Users/zhenyuhou/Projects/The Triangle/worktrees/identity-inventory`  
Branch: `codex/identity-inventory` (based on `main` `db5e28a`)  
Status: Library-only prerequisite implemented and verified. Full Slice 1a is NOT complete.

---

## 1. Scope and Design Alignment

This slice implements the bounded read-only identity inventory projection foundation specified in `docs/plans/2026-10-25-identity-reconciliation-design.md` (Sections 2–4 and 11, Slice 1a) and required by the Unified Messaging Interface plan (`docs/plans/2026-10-25-unified-messaging-interface-design.md`, Section 7, R1 dependency).

### Enforced Invariants

1. **Read-Only & Secret Prevention Boundary**:
   - Accepts the output of `readInstallationInventory` from `packages/agent-worker/src/installation-inventory.mjs`.
   - Performs zero filesystem, process, network, or Keychain operations.
   - Enforces strict output allowlists on all projected objects: caller-supplied credentials, private keys, passwords, and tokens cannot leak into reports.
   - Retains validated bounded `code` and `profile` from underlying blockers and warnings with fixed diagnostic text; arbitrary caller message strings are never copied into diagnostics.
   - Rejects and masks malformed origin, agent, instance, and session string values rather than echoing arbitrary malformed payloads in diagnostics.
   - Bounded display labels (profile names, handles) and valid identifiers are documented and preserved as legitimate metadata when valid; no speculative regex scanning is performed over user metadata.
   - Defense-in-depth: drops unallowlisted secret keys via `stripSecretKeys` and applies deep object freezing to ensure immutability.

2. **Authority Scoping & Bound Evidence Validation**:
   - MESH managed identities are keyed strictly by `(authorityOrigin, agentId)`.
   - Validates bare HTTPS origins without userinfo, path, query, or fragment (`isValidBareHttpsOrigin`).
   - Requires a valid matching derived instance ID (`deriveClientInstanceId(profile)`) for mapped profiles.
   - Missing origins, credential-bearing origins, invalid origins, missing instance IDs, and mismatched instance IDs are diagnosed as faults and remain unmapped profiles (`identityCount: 0`).
   - The same agent ID observed under different authority origins is never unified across servers, and generates an explicit `origin_mismatch` diagnostic.

3. **No-Merge, Ambiguity Preservation, and Reorder Stability**:
   - Preserves existing identifiers (`agent_<32-hex>`, 64-hex `profileInstanceId`, and `session-<64-hex>`).
   - Profiles sharing the same handle or display name are never merged into a single identity; they remain distinct principals and produce a `handle_collision` diagnostic.
   - Multiple local profiles binding to the same agent ID are explicitly reported with an `ambiguous_mapping` diagnostic rather than auto-merged.
   - When multiple profiles bind to the same agent with differing handles, the projection does NOT arbitrarily choose a winner based on traversal order; `ident.handle` is set to `null` (explicit ambiguity), `ident.handles` preserves all unique sorted handles, and individual profile bindings retain their observed handles.
   - Diagnostic messages list conflicting profiles in deterministic alphabetical order without embedding input traversal order.
   - Output is 100% byte-for-byte stable under reordering of conflicting inputs, duplicate profile records, duplicate instance claims, and session ties.

4. **Local-Only Isolation & No Fabricated Principals**:
   - Unbound local profiles and local sessions are explicitly marked `isPrincipal: false`.
   - No serverless principals (`peer_<32-hex>`) are fabricated for unbound profiles.
   - Disabled profiles are preserved in the projection with `enabled: false` and `status: "disabled"`.

5. **Observed On-Disk Bindings vs. Verified Live Authority**:
   - Every managed identity explicitly notes `authority.observedOnDisk: true` and `authority.verifiedLiveAuthority: false`.
   - The projection acknowledges on-disk custody bindings from `profiles-v1` without falsely claiming live MESH authority or online verification.

---

## 2. Allowlisted Changes

This implementation was strictly confined to three allowlisted files:

1. **`packages/agent-worker/src/identity-inventory.mjs`**:
   - Exports `buildIdentityInventory(installationInventory, options)` (and alias `projectIdentityInventory`).
   - Exports `isValidBareHttpsOrigin(value)` for strict bare HTTPS origin validation.
   - Exports patterns: `AGENT_ID_PATTERN`, `INSTANCE_ID_PATTERN`, `SESSION_ID_PATTERN`.
   - Exports diagnostic codes: `DIAGNOSTIC_CODES` (`malformed_record`, `duplicate_profile`, `duplicate_instance_id`, `ambiguous_mapping`, `handle_collision`, `origin_mismatch`, `custody_fault`, `unregistered_binding`, `orphan_binding`).
   - Implements full deterministic tie-breaking and order-independent sorting across reordered inputs.
   - Replaces arbitrary underlying messages with fixed diagnostic text and masks invalid string payloads.
   - Builds frozen, deterministic reports under schema `identity_inventory_v1`.

2. **`packages/agent-worker/test/identity-inventory.test.mjs`**:
   - 13 comprehensive test cases covering all required invariants, regression coverage for conflicting mappings, reordered duplicate records, invalid/missing origins, and secret prevention in diagnostic strings.
   - Includes test cleanup hooks in `finally` blocks for all temporary fixture directories so repeat test runs do not leak scratch files.

3. **`docs/reviews/2026-10-25-identity-inventory-foundation.md`**:
   - Architectural review, verification record, and boundary specification.

No other files in the repository were created or modified.

---

## 3. Verification and Test Results

### Commands and Exit Status

1. Test execution:
   ```sh
   node --test packages/agent-worker/test/identity-inventory.test.mjs packages/agent-worker/test/installation-inventory.test.mjs
   ```
   **Result**: Exit code `0`. **45/45 passed** (13 identity inventory tests + 32 installation inventory tests), 0 failures, 0 skipped. Duration: ~1.41s.

2. Git diff check:
   ```sh
   git diff --check
   ```
   **Result**: Exit code `0`. Clean whitespace and formatting.

### Verification Checklist

- [x] **Representative valid managed bindings**: Verified against real multi-profile disposable fixtures (Codex headless, Cursor ACP, Antigravity worker, Hermes worker).
- [x] **Unbound profile remains local-only**: Unbound profile has `isPrincipal: false`, `reason: "unbound_local_profile"`, and no `peer_*` principal is generated.
- [x] **Disabled profile retained**: Disabled profiles retain `enabled: false` and `status: "disabled"`.
- [x] **Same display name never merges identities**: Shared handle produces 2 distinct identity records with a `handle_collision` warning.
- [x] **Different origins never merge agent IDs**: Same agent ID under two origins produces 2 distinct identity records with an `origin_mismatch` warning.
- [x] **Deterministic conflicting mappings**: Conflicting handles set `handle: null` (explicit ambiguity), preserve all observations in `handles: ["first", "second"]`, and produce byte-equal output when inputs are reversed.
- [x] **Reorder stability for duplicates and session ties**: Reordered duplicate profile records, duplicate instance IDs, and session ties produce byte-equal output.
- [x] **Missing / invalid origin and instance evidence**: Missing origin, credential-bearing origin, invalid origin, missing instance ID, and mismatched instance ID remain unmapped faults (`identityCount: 0`).
- [x] **Secret-free diagnostics and underlying messages**: Sentinels in underlying warning/blocker messages are not copied; malformed payload strings in invalid agent IDs, session IDs, and origins are masked; valid identifiers and display labels are preserved as metadata.
- [x] **Fixture cleanup**: Temporary fixture directories cleaned in test `finally` blocks without leaking scratch files.
- [x] **Existing inventory suite regression**: All 32 existing tests in `installation-inventory.test.mjs` pass without regression.

---

## 4. Remaining Slice 1a and 1b Work (Do NOT Claim Full 1a Complete)

This change delivers only the **read-only library foundation**. It is a prerequisite for R1 and does NOT complete Slice 1a or Slice 1b:

1. **CLI and Status/Doctor Wiring (Remaining Slice 1a)**:
   - CLI command `triangle identity inventory` is not yet created.
   - `triangle status` and `triangle doctor` have not been wired to display the identity projection.
   - Neither the manifest nor Swift release scripts have been updated. Per Owner Decision 4 (Unified Messaging Interface design), manifest changes are deferred to a single release train (v13) for R1–R5.

2. **Registry Schema and Storage (Remaining Slice 1a)**:
   - `<TRIANGLE_HOME>/identity/` schema definitions and file storage layout remain to be finalized.
   - Cryptographic registry machinery is intentionally excluded from this slice.

3. **Owner-Confirmed Migration (Slice 1b)**:
   - `triangle identity migrate --confirm` and persistence of `local_profile_binding_v1` remain future Slice 1b work.

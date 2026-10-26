# Review: Identity Status and Doctor Integration

Date: 2026-10-26
Branch: `antigravity/identity-status-doctor`
Baseline Commit: `aa21bc2101b5e7bd7f966ff86c16c40f80907347`

## 1. Scope

Delivers a read-only, host-local identity section for `triangle status --identity` and `triangle doctor --identity`, closes the four review findings from the identity inventory foundation (`docs/reviews/2026-10-25-identity-inventory-foundation.md`), and adds the pure `buildIdentityView` library in `packages/agent-worker/src/identity-view.mjs`.

Everything remains local and read-only:
- Zero network calls or credentials accessed.
- No modifications to client configuration or profile trees outside test temporary fixtures.
- Nothing in the supervisor runtime imports the new modules.
- No changes to manifest version, installer, Swift code, or runtime bundles.

Roots: `--client-root` defaults to `client/` beside the custody home (the resolved `--home`), and `--registry-root` defaults to `identity/` beside the client directory (owner decision A4). Both must be absolute and both can be overridden.

## 2. Identity View Shape (`identity_view_v1`)

The view library exports `buildIdentityView({ inventory, registry })`, which calls `planIdentityMapping` and projects an immutable, deep-frozen JSON object:

```json
{
  "schema": "identity_view_v1",
  "registry": {
    "state": "absent|ok|unreadable",
    "sequence": 0,
    "auditVerifiedThrough": 0,
    "auditUncommittedTail": 0,
    "errorCode": null
  },
  "summary": {
    "profiles": 0,
    "recorded": 0,
    "notRecorded": 0,
    "blocked": 0,
    "localOnly": 0,
    "recordedOnly": 0,
    "faults": 0,
    "warnings": 0
  },
  "profiles": [
    {
      "profile": "",
      "profileInstanceId": "",
      "state": "recorded|not_recorded|blocked|local_only|recorded_only",
      "principalId": null,
      "authorityOrigin": null,
      "bindingId": null,
      "generation": null,
      "reason": null
    }
  ],
  "diagnostics": [
    {
      "severity": "warning|fault",
      "code": "",
      "profile": null,
      "message": "",
      "action": null
    }
  ]
}
```

Rows are sorted by `profile`, then `profileInstanceId` in UTF-16 code-unit order:
- `recorded`: profile matches an active, identical registry binding (`plan.unchanged`).
- `not_recorded`: valid observed profile without registry binding (`plan.proposals`).
- `blocked`: profile mapping is blocked with bounded reason code (`plan.blocked`).
- `local_only`: unbound local profile (`plan.localOnly`).
- `recorded_only`: registry binding whose `profile_instance_id` has no local profile in inventory.

Diagnostics are sorted by severity (faults first), then code, profile, and message in code-unit order:
- `registry_unreadable` (fault)
- `registry_unfinished_write` (warning, when `auditUncommittedTail === 1`)
- `identity_not_recorded` (warning, when `notRecorded > 0`)
- `identity_blocked` (fault for conflict/duplicate/malformed/custody; warning for ambiguous/origin mismatch/revoked)
- `recorded_profile_missing` (warning, per `recorded_only` row)
- Passthrough inventory diagnostics (excluding covered blocker diagnostics).

## 3. Resolution of Review Findings

1. **Finding 1 (Lane-Health Diagnostics Dropped from Identity Facts)**:
   - `buildIdentityInventory` now copies only allowlisted identity health codes: `registry_absent`, `registry_unreadable`, `registry_unsafe`, `registry_empty`, `registry_stray_file`, `registry_entry_invalid`, and `profile_bindings_unavailable`.
   - Other well-formed health codes (e.g., `claimer_not_held`, `progress_evidence_unavailable`, `binding_missing`) are omitted from identity diagnostics and counted in `summary.omittedHealthDiagnosticCount`.
   - Non-well-formed codes fall back to `underlying_blocker` / `underlying_warning` and are retained.
   - `renderIdentityInventory` prints `Installation-health diagnostics omitted: N (see triangle-local status).` when count > 0.

2. **Finding 2 (Typed Error When Worker Modules Missing)**:
   - `identityInventory` and `identityMigrate` catch import failures of `@the-triangle/agent-worker` modules and throw `LocalStateError` with fixed messages, preserving `cause`.
   - `main` catches `LocalStateError` and writes a single clean error line to stderr, exiting 1 with no stack trace or absolute paths leaked.

3. **Finding 3 (Exit Status Alignment & Documented Decision)**:
   - **Decision**: `triangle identity inventory` remains exit 0 whenever a report is successfully produced (even when faults are present), as it is an informational report command. Callers inspect `summary.faultCount`.
   - `triangle doctor --identity` is the diagnostic command whose exit status signals problems: every identity diagnostic is added to `report.warnings` as `Identity: <message> <action>`, causing `doctor` to exit 1 until issues (such as unrecorded bindings) are reconciled.
   - `triangle status --identity` preserves exit 0.

4. **Finding 4 (Locale-Independent Code-Unit Ordering)**:
   - Replaced `localeCompare` across `identity-inventory.mjs` and `identity-view.mjs` with code-unit comparisons (`a < b ? -1 : a > b ? 1 : 0`).
   - Verified that profile names such as `a_b` and `a-b` sort deterministically (`a-b` before `a_b`), eliminating ICU and host locale dependencies.

## 4. Verification and Commands Run

All tests were executed against Node 22 (`/Users/zhenyuhou/.local/bin/node`):

1. **New and Changed Tests**:
   - `node --test packages/agent-worker/test/identity-inventory.test.mjs` (15/15 passed)
   - `node --test packages/agent-worker/test/identity-mapping.test.mjs` (16/16 passed)
   - `node --test packages/agent-worker/test/identity-registry.test.mjs` (16/16 passed)
   - `node --test packages/agent-worker/test/identity-view.test.mjs` (3/3 passed)
   - `node --test packages/triangle-cli/test/identity-status-cli.test.mjs` (9/9 passed)
   - `node --test packages/triangle-cli/test/identity-inventory-cli.test.mjs` (10/10 passed)
   - `node --test packages/triangle-cli/test/identity-migrate-cli.test.mjs` (11/11 passed)

2. **Regression Suites**:
   - `node --test packages/agent-worker/test/identity-mapping.test.mjs packages/agent-worker/test/identity-registry.test.mjs packages/agent-worker/test/installation-inventory.test.mjs packages/agent-worker/test/worker-bundle-closure.test.mjs packages/agent-worker/test/supervisor-runtime-bundle.test.mjs` (89/89 passed)
   - `npm --prefix packages/triangle-cli test` (115/115 passed)
   - `node --test tests/client-package.test.mjs` (9/9 passed)

3. **Diff Cleanliness**:
   - `git diff --check aa21bc2101b5e7bd7f966ff86c16c40f80907347`: zero whitespace errors or format warnings.

## 5. Explicit Limits

- **Disk Observations Only**: All identity and registry projections represent local disk observations; neither remote MESH authority nor cryptographic live presence is asserted.
- **No Routes, Sessions, or Pairings in View**: The view schema scopes strictly to host-local profile bindings and registry status. Active sessions, route tables, and serverless pairings are not listed in this section.
- **Opt-in Exposure**: `--identity` is strictly opt-in; running `triangle status` or `triangle doctor` without `--identity` produces byte-identical output to the baseline.
- **Unrecorded Profiles Block Doctor**: An unrecorded profile will cause `triangle doctor --identity` to exit 1 until an owner reviews and applies the mapping via `triangle identity migrate --confirm`.
- **No Supervisor Modification**: Does not change running supervisor processes, runtime launch configurations, or worker closures.

## 6. Reviewer verification and changes (reviewer: Claude, 2026-10-25)

### Independent probes
A script kept outside the repository drives the inventory, the view and the CLI; 57 of 57 pass.
- **Inventory.** Only the seven identity-relevant installation codes are kept, plus the `underlying_blocker` fallback. The four dropped health codes are counted, and the fault and warning counts cover only what is kept. Order is by code unit (`a-b` before `a_b`, `Zed` before `alpha`), and the bytes are identical under 25 reorderings of the input.
- **View.** Every row state appears with the right data: `recorded` with the registry generation, `not_recorded`, `blocked` for a conflict, a revoked record and an ambiguous pair, `local_only` and `recorded_only`. The diagnostics have the fixed texts and severities, inventory diagnostics pass through without duplicating the blocked rows, and faults sort first. Counts match the rows. The view is deep-frozen, byte-identical under 30 reorderings, accepts frozen inputs and holds nothing secret-shaped. Absent, unreadable and unfinished-write registries are handled.
- **CLI.** `status` without `--identity` is unchanged. With it, the identity section sits before the trust copy and creates nothing. `doctor --identity` exits 1 while profiles are unrecorded and the `Identity:` warnings appear only in `doctor`. After the mapping is applied both profiles are `recorded` and the warnings are gone. An explicit `--registry-root` wins. A corrupt registry file is a fault, with exit 1 and no stack trace. `identity inventory` exits 0 even for a wrong root. The identity part runs with network access and all writes denied. A copy of the CLI without the agent-worker modules prints one line and exits 1 for `identity inventory`, `identity migrate` and `status --identity`.

### Built package (nothing installed)
Two client packages were built with `scripts/release/build-client-package.mjs` in a scratch directory, using the installed public ad-hoc helper and client binaries and the bundled Node 22.22.3 of the installed 0.2.0-onboarding.4 release as prebuilt inputs: one from this branch (144 files) and one from main at `aa21bc2` (142 files). The difference is `identity-view.mjs` and `identity-status.mjs` added and five existing modules changed; `worker-artifacts.json` is identical.
- The packaged CLI with the bundled Node ran under a macOS sandbox that denies network access and all file writes: `status --identity --home <missing temp home> --client-root <real client directory> --json` exited 0 with a 2,580-byte report, byte-identical to the source run. A fingerprint of path, mtime, size and mode over the client directory, `profiles-v1` and the identity directory (84 entries) was identical before and after, and the temporary home was not created.
- `doctor --identity` on the real client directory exits 1. It shows the three unrecorded profiles (`codex-headless`, `ghost`, `gravity2`, all under `https://thetriangle.dev`) and one warning for profile `bob`, which has an on-disk custody binding that is not registered in the client instances.
- `identity inventory` on the real client directory now reports 3 identities, 0 faults and 1 warning, with "Installation-health diagnostics omitted: 4". Before this change the same directory showed 5 warnings.

### Changes made in review
- A relative `--home` made the derived client root relative, so the command failed with "--client-root must be an absolute path" although the flag was not given. The default now resolves `--home` first.
- The defaults (client root beside the custody home, registry root beside the client directory) had no test, because every test passed explicit roots. A new test covers them, including a relative `--home`; it fails on the code as first committed.
- `renderDoctor` chose the registry root through a chain of guessed fallbacks. It now reads `report.identityRegistryRoot` only.
- Test counts in section 4 are corrected to the final values.

### Open notes (not blockers)
1. In `doctor --identity` each diagnostic appears twice: once as `! Identity: ...` in the warnings list and once as `[warn]` in the identity section. This is what the task asked for; drop one when the section grows.
2. `identityRegistryRoot` is a top-level key of the report next to `identity`, because the view is pure and does not know its root. Fold it into the view's `registry` object when the view gains more fields.
3. Any passed-through inventory warning (for example `unregistered_binding` for `bob`) also makes `doctor --identity` exit 1, not only an unrecorded profile.
4. For a joined home, `status --identity` makes the same MESH calls as `status` does today. Only the identity part is local.
5. The view lists no sessions, routes or pairings; that stays for later slices.

### Commands run
```sh
/Users/zhenyuhou/.local/bin/node --test packages/agent-worker/test/identity-view.test.mjs packages/agent-worker/test/identity-inventory.test.mjs packages/triangle-cli/test/identity-status-cli.test.mjs packages/triangle-cli/test/identity-inventory-cli.test.mjs packages/triangle-cli/test/identity-migrate-cli.test.mjs
/Users/zhenyuhou/.local/bin/node --test packages/agent-worker/test/identity-mapping.test.mjs packages/agent-worker/test/identity-registry.test.mjs packages/agent-worker/test/installation-inventory.test.mjs packages/agent-worker/test/worker-bundle-closure.test.mjs packages/agent-worker/test/supervisor-runtime-bundle.test.mjs
npm --prefix packages/triangle-cli test
/Users/zhenyuhou/.local/bin/node --test tests/client-package.test.mjs
git diff --check aa21bc2
```
Results: 48 of 48, 89 of 89, 115 of 115, 9 of 9, and a clean diff check.

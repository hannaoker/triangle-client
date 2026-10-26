# Candidate Review and Disposable Package Rehearsal for PR #134 (v13 Release Train)

- **Date:** 2026-10-26
- **Candidate Commit:** `e134ee0ad90afc29135bb3fc03040902d4cc34e0` (branch `codex/r1-integration-v13`, PR #134 unmerged draft)
- **Base Commit:** `2e074043606960b46a37b1a7cb1a6e57641b9250` (PR #133 merged)
- **Reviewer:** Antigravity (Gemini 3.8 Flash)
- **Scope:** Candidate evidence strictly on `e134ee0ad90afc29135bb3fc03040902d4cc34e0`. Owner gates G1 (merge), G2 (helper install), G3 (live runtime stage/restart), and G4 (router enable) are NOT authorized and were NOT performed.

---

## 1. Prioritized Security & Reliability Findings

Independent review and concrete probes of the full diff `2e07404..e134ee0` identified the following findings:

### Finding 1: Ambiguity Candidate Filtering Confirms Principal Multiplicity on Complete Denial
- **Severity:** Medium (Information Disclosure / Leakage)
- **Location:** `packages/agent-worker/src/unified-router.mjs:319-348`, `packages/agent-worker/test/r1-integration-v13.test.mjs:963`
- **Scenario:** When a sender addresses an ambiguous principal (`agent_<32-hex>` mapped to multiple instances), `resolveSend` filters candidates through `canMessage` (combining ACL check and turn token `allowedRecipients`). According to the release specification (`docs/reviews/2026-10-26-r1-integration-v13.md`, Section 1.2 and 2.2), if zero permitted candidates remain, resolution must fail closed with `recipient_not_found` or `route_unavailable` without confirming candidate existence.
- **Probe Result:** In `unified-router.mjs`, when all candidates are filtered out (`filteredCandidates.length === 0`), line 337 still throws `RouterResolutionError` with `code: res.code` (`"recipient_ambiguous"`) and `candidates: []`. Line 963 of `r1-integration-v13.test.mjs` was broadened to accept `|| err.code === "recipient_ambiguous"` to allow the test to pass. An unauthorized caller who queries a non-existent principal receives `recipient_not_found`, but querying an unauthorized multi-instance principal receives `recipient_ambiguous` (with empty candidates), leaking the fact that the principal exists and has multiple internal instances.

### Finding 2: Unrelated Hermes Shebang Parser Modification & Portability Risk
- **Severity:** Low-to-Medium (Code Hygiene / Unrelated Scope / Portability)
- **Location:** `scripts/triangle-worker-install.py:357-360`
- **Scenario:** The diff introduces modified shebang parsing logic into `discover_runtime_roots`:
  ```python
  shebang_path = first[2:].strip()
  if " " in shebang_path and not os.path.exists(shebang_path):
      shebang_path = shebang_path.split()[0]
  interpreter = managed[3] if managed else checked_file(os.path.realpath(shebang_path), executable=True, owners={os.getuid(), 0})
  ```
- **Probe Result:**
  1. This change is unrelated to Slice R1.4 / unified-router / v13 closure and was not requested in the R1 plan.
  2. The installer elsewhere strictly forbids whitespace in interpreter paths (`line 687: fail("triangle-local needs an absolute, whitespace-free interpreter path...")`).
  3. If a shebang contains a path with spaces AND arguments (e.g. `#!/path with spaces/python -u`), `os.path.exists(shebang_path)` is false, and `.split()[0]` evaluates to `"/path"`, failing completely.
  4. If a shebang specifies `#!/usr/bin/env python3`, `.split()[0]` evaluates to `/usr/bin/env`, which satisfies `checked_file` but is not a python interpreter.

### Finding 3: Lack of Frame Bounding on Public `list_inbox`
- **Severity:** Low (Denial of Service / Unbounded RPC Response)
- **Location:** `packages/agent-worker/src/local-messaging-server.mjs:860-877`
- **Scenario:** While `list_replies` applies `boundRepliesToEnvelope` after route decoration (preventing responses from exceeding `MAX_PAYLOAD_BYTES` / `MAX_FRAME_BYTES`), `list_inbox` decorates items with `decorateInbox` but performs no payload bounding.
- **Probe Result:** If an interactive inbox accumulates up to 100 messages with large payloads (up to 128 KiB text each), the serialized response can exceed `MAX_FRAME_BYTES` (320 KiB), causing `encodeFrame` to throw an unhandled `frame_too_large` error and preventing the client from listing or consuming inbox messages.

---

## 2. Test Execution & Contract Verification

All tests executed with System Node `/Users/zhenyuhou/.local/bin/node` (v22.22.3) and Python `/usr/bin/python3` (3.9.6):

| Suite / Command | Scope | Result | Exit |
| :--- | :--- | :--- | :--- |
| `TMPDIR=/private/tmp bash packages/macos-mailbox-helper/scripts/test-host.sh` | Swift host contracts, FileWorkerCommandResolver v13 acceptance, file custody | **ALL PASS** (160+ cases) | 0 |
| `node --test packages/agent-worker/test/r1-integration-v13.test.mjs ...` (5 files) | v13 integration, bundle closure, supervisor bundle, keychain contracts, inventory | **80 / 80 PASS** | 0 |
| `node --test packages/agent-worker/test/local-messaging-server-client.test.mjs ...` (9 files) | Server RPC, SQLite journal, CLI setup, unified router, resolver, snapshot, identity | **91 / 91 PASS** | 0 |
| `./scripts/release/check-release-readiness.sh --mode docs` | Documentation and secret-boundary preflight check | **PASSED** | 0 |

*Note on Swift Host Tests:* The default script `test-host.sh` expects `TMPDIR` to be set. In headless/subagent environments where `TMPDIR` is unset, line 7 (`test_root="${TMPDIR%/}/triangle-mailbox-host-tests"`) expands to `/triangle-mailbox-host-tests`, failing due to macOS read-only root filesystem. Explicit `TMPDIR=/private/tmp` runs cleanly to completion.

---

## 3. Package Build & Archive Inspection

Package build executed in disposable scratch directory `/private/tmp/triangle-r15-rehearsal`:

### 3.1 Candidate Package (Isolated v13 Helper & Client Build)
Built from candidate commit `e134ee0` with isolated Swift build (`-c release -DTRIANGLE_FILE_CUSTODY_REQUIRED`):
- **Command:** `TMPDIR=/private/tmp node scripts/release/build-client-package.mjs --version 0.2.0-r15.0 --output /private/tmp/triangle-r15-rehearsal/output`
- **Archive Path:** `/private/tmp/triangle-r15-rehearsal/output/triangle-client-0.2.0-r15.0-darwin-arm64.tar.gz`
- **Archive SHA256:** `26e7fa73a0c203b2b16ad9f261ab339ba8686999d29b46be104fe37d599a32f6`
- **Installer Path:** `/private/tmp/triangle-r15-rehearsal/output/triangle-install-0.2.0-r15.0.sh`
- **Installer SHA256:** `be2e6cb95e4274ebeeaa9bf172d7dcc33bc9d96cb9982e861eb59ef730c00de1`
- **Total Tracked Files:** 148

### 3.2 Rehearsal-Only Package (Prebuilt Installed v12 Inputs)
Built explicitly using installed binaries (`$HOME/Library/Application Support/The Triangle/bin/triangle-mailbox` and `triangle-client`) as prebuilt inputs:
- **Archive Path:** `/private/tmp/triangle-r15-rehearsal/output-v12rehearsal/triangle-client-0.2.0-v12rehearsal.0-darwin-arm64.tar.gz`
- **Archive SHA256:** `bfa13545ddde4b7a342d39351df519b23d55e0afa69ca57dece8f17a202b58ea`
- **Label:** Source/runtime-closure rehearsal only, NOT deployable v13 helper acceptance.

### 3.3 Atomic Runtime Closure Inspection (`worker-artifacts.json`)
- **Manifest Version:** 13
- **Supervisor Artifacts:** Exactly **87**
- **Worker Artifacts (`codex`, `hermes`, `antigravity`):** Exactly **89** each
- **Included R1 Modules (6 files):**
  - `packages/agent-worker/src/unified-router.mjs`
  - `packages/agent-worker/src/recipient-resolver.mjs`
  - `packages/agent-worker/src/router-registry-snapshot.mjs`
  - `packages/agent-worker/src/identity-registry.mjs`
  - `packages/agent-worker/src/identity-primitives.mjs`
  - `packages/agent-worker/src/transport-adapter-contract.mjs`
- **Excluded Modules:** `packages/agent-worker/src/local-adapter.mjs` stays strictly out of all bundles.

---

## 4. Scratch Runtime Staging & Rollback Rehearsal

Staging and rollback rehearsed in scratch `--application-root /private/tmp/triangle-r15-rehearsal/app-root`:

1. **Stage Runtime for all 4 kinds:**
   - `supervisor`: Staged and validated (87 artifacts, CLI omitted).
   - `antigravity`: Staged and validated (89 artifacts, CLI `/Users/zhenyuhou/.local/bin/agy` [actual]).
   - `hermes`: Staged and validated (89 artifacts, CLI `/Users/zhenyuhou/.local/bin/hermes` [actual]).
   - `codex`: Staged and validated (89 artifacts, CLI `/private/tmp/triangle-r15-rehearsal/bin/codex-stub` [stubbed]).
   - Validation command: `python3 scripts/triangle-worker-install.py validate-runtime --manifest <path> --agent <kind>` -> exit 0 for all 4 manifests.
2. **Commit Path Rehearsal:**
   - Executed `commit-runtime` on supervisor rollback record.
   - Record file removed; supervisor v13 manifest remains valid and intact.
3. **Rollback Path Rehearsal:**
   - Staged update on `hermes` creating rollback record with `previousExisted: true`.
   - Executed `rollback-runtime <record_path>`.
   - Staged temporary bundle unlinked; prior manifest restored and passed `validate-runtime`.

---

## 5. Disposable Local Socket Canaries (Isolated Scratch State)

Exercised via `/private/tmp/triangle-r15-rehearsal/rehearsal-runner.mjs` on unix socket `/private/tmp/triangle-r15-rehearsal/socket-scratch/local-control.sock` with synthetic identity registry (`agent_8636c244651ab602b082ee3df6eb902b` -> `3356f7bfb8e902f4b519d8238e3555e4974217898af96bed249cf0cfb729c1eb`):

1. **Router OFF (Default):**
   - Initial `local_status` reported `router.enabled: false`.
   - Send to principal failed closed with `recipient_not_allowed` (no authority addition).
2. **Dynamic Enablement via CLI:**
   - `setupRouter` created `router.json` (mode 0600, `version: 1, enabled: true`).
   - Dynamic `createRouterStatCache` detected file change on next request without server restart.
3. **Principal Resolution & Route Decoration:**
   - Principal send accepted; decorated receipt returned `route: "local"`, `target: { via: "principal", principal: ..., profile: "bob" }`.
   - SQLite journal persisted `to_principal` and `resolved_via: "principal"` with two-way schema compatibility.
4. **ACL & Turn Credential Capability Scope Denial:**
   - Send with restricted token (`allowedRecipients: ["unrelated"]`) failed closed (`recipient_not_allowed`).
5. **Immutable Duplicate Retry & Conflict Detection:**
   - Exact retry (same `messageId` and `requestId`) returned cached receipt with `isDuplicate: true` and zero additional limiter charges.
   - Retrying with altered destination or direct instance ID threw `duplicate_id_conflict`.
6. **Kill Switch & Rollback:**
   - `setupRouter --disable` updated config atomically. Statcache detected disablement on next request without restart; subsequent principal sends failed closed.
7. **Server Restart & Work Preservation:**
   - Server restarted against existing SQLite journal; status queries preserved message state, and public DTO sanitization stripped raw internal columns (`to_principal`, `resolved_via`).

---

## 6. Release Gate Status Summary

- **Gate 1 (Source & Unit Tests):** PASSED (171 Node tests, 160+ Swift host tests).
- **Gate 2 (Closure & Packaging Rehearsal):** PASSED (Candidate archive built, exact 87/89 closure, scratch staging, commit, and rollback verified).
- **Gate 3 (Simulated Canary Probes):** PASSED (Isolated socket host proved routeroff, dynamic enable, resolution, denial, immutable retry, kill switch, and restart).
- **Gate 4 (Installed Live Acceptance):** **NOT PERFORMED / UNVERIFIED** (Requires owner authorization for gates G1-G4).

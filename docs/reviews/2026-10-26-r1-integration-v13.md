# Review: R1.4 Integration and v13 Release Train

Date: 2026-10-26
Branch: `codex/r1-integration-v13`
Base Commit: `2e074043606960b46a37b1a7cb1a6e57641b9250` (PR #133 merged)

---

## 1. Scope & Release Summary

Slice **R1.4** delivers the integration of the unified messaging router into the active runtime and executes the atomic manifest version 13 release train:
1. **Server & Host Wiring**: `unified-router.mjs` is integrated into `local-messaging-server.mjs` and `local-messaging-host.mjs`. Recipient resolution (`resolveSend`) executes strictly before ACL enforcement, capability scope validation, rate limiter reservations, conversation loop tracking, pair exchange limiter checks, journal persistence, and execution dispatching.
2. **Ambiguity Candidate Filtering**: When resolving principal addresses with multiple candidates, ambiguity candidates are filtered through BOTH sender ACL permissions and token capability scope (`canMessage`). Unauthorized candidate labels are never leaked; if zero candidates remain, resolution fails closed with `recipient_not_found` or `route_unavailable`.
3. **Database Migration & Journal Compatibility**: Added nullable columns `to_principal` and `resolved_via` to `local_messages` in `local-messaging-journal.mjs` via safe, idempotent `PRAGMA table_info` presence checks. Named column `INSERT` statements guarantee two-way v12/v13 forward and backward read/write compatibility without backfills.
4. **Isolated Router Configuration & Kill Switch**: Router configuration is persisted exclusively in `client/local/router.json` (`version: 1`, `enabled: false` by default). It is never written to `local-messaging.json` (preserving instant rollback to v12, whose config parser rejects unknown keys). The file is governed by strict custody permissions (mode 0600, owner UID, regular file, max 4 KiB), validated by `setupRouter` (`triangle-local setup-router --enable|--disable [--registry-root <abs>]`), and monitored dynamically per-request via `createRouterStatCache` without requiring process restart.
5. **Status & DTO Sanitization**: `local_status` is extended with a dedicated `router` block reporting `{ enabled, registry: { state, sequence }, resolved, errors }` (with redacted diagnostic error codes when config is invalid). Public DTO decorators (`decorateSend`, `decorateStatus`, `decorateReplies`, `decorateSessions`) sanitize responses and strip raw internal journal columns (`to_principal`, `resolved_via`) in both enabled and disabled modes.
6. **Atomic v13 Runtime Closure**: Manifest version bumped from 12 to 13. The exact set of six R1 source files (`unified-router.mjs`, `recipient-resolver.mjs`, `router-registry-snapshot.mjs`, `identity-registry.mjs`, `identity-primitives.mjs`, `transport-adapter-contract.mjs`) is added to the runtime bundle while excluding `local-adapter.mjs`. Supervisor bundle artifact count is verified at exactly **87**; worker bundles (`codex`, `hermes`, `antigravity`) are verified at exactly **89**. Swift `WorkerLauncher.swift`, Swift contract cases, and `installation-inventory.mjs` accept manifest version 13 while retaining full support for version 12 rollback.

---

## 2. Key Architectural Decisions

### 2.1 Resolution Before Admission & No Authority Addition
Principal addressing (`agent_<32-hex>`) is an alias resolution mechanism and adds no authority:
- When a send arrives, `activeRouter.resolveSend` resolves the target to a concrete instance ID (`effectiveTo`).
- `effectiveTo` is immediately subjected to `acl.checkAllowed(senderId, effectiveTo)` and `claims.allowedRecipients` validation.
- Rate limiter reservations (`reserve(senderId)`) and pair exchange checks operate on the concrete recipient, charging quotas exactly once.
- Duplicate retries stably return the original receipt and requestId; if a principal's mapping is changed to a different concrete recipient between sends with the same messageId, the journal's immutable envelope check rejects the second send with `duplicate_id_conflict`.

### 2.2 Ambiguity Candidate Filtering Without Label Leakage
Ambiguity candidates from the identity registry are passed through the dual ACL and capability filter (`canMessage`):
- Candidates that the caller does not have permission to message are filtered out.
- If multiple permitted candidates remain, `recipient_ambiguous` is returned containing *only* permitted candidates.
- If zero permitted candidates remain, resolution fails closed with `recipient_not_found` without exposing unauthorized profile labels or confirming candidate existence.

### 2.3 Safe Two-Way Journal Migration
In `local-messaging-journal.mjs`:
- `CREATE TABLE IF NOT EXISTS local_messages` contains nullable `to_principal TEXT, resolved_via TEXT`.
- For existing databases, `PRAGMA table_info(local_messages)` inspects existing column definitions and issues `ALTER TABLE local_messages ADD COLUMN to_principal TEXT` and `... resolved_via TEXT` only when missing.
- Existing rows are never touched or backfilled.
- Named `INSERT` columns allow a v12 binary to read and write rows on a migrated v13 database without failing, and allow v13 to read legacy rows seamlessly with `to_principal: null` and `resolved_via: null`. Verified against baseline schema in `r1-integration-v13.test.mjs`.

### 2.4 Dedicated `router.json` Configuration & Statcache
- Stored at `<stateRoot>/router.json` (default `Library/Application Support/The Triangle/client/local/router.json`).
- Written atomically with mode `0o600` via `writePrivateJson`.
- CLI commands `triangle-local setup-router --enable|--disable` accept optional `--registry-root <abs>`.
- `createRouterStatCache` stats the file before requests using `ino:size:mtimeMs:mode`. When modified on disk, the new config takes effect on the next send with zero server restart or IPC interruption.
- Invalid configuration (wrong mode, malformed JSON, excessive size, symlink) fails closed to disabled mode and reports structured, safe diagnostics (`unsafe_router_config`, `invalid_router_config`) in `local_status.router.error` without leaking file paths or content.

### 2.5 Strict Atomic Runtime Closure (v13)
Manifest artifact requirements are enforced across Python installer, Swift launcher, inventory doctor, and test contracts:
- `ROUTER_ARTIFACTS`:
  - `packages/agent-worker/src/unified-router.mjs`
  - `packages/agent-worker/src/recipient-resolver.mjs`
  - `packages/agent-worker/src/router-registry-snapshot.mjs`
  - `packages/agent-worker/src/identity-registry.mjs`
  - `packages/agent-worker/src/identity-primitives.mjs`
  - `packages/agent-worker/src/transport-adapter-contract.mjs`
- `scripts/triangle-worker-install.py`:
  - `CURRENT_MANIFEST_VERSION = 13`
  - `expected_artifacts`: supervisor adds `ROUTER_ARTIFACTS` (81 -> 87); worker kinds add `ROUTER_ARTIFACTS` (83 -> 89).
  - `strict_manifest`: accepted version range updated to `{3..13}`.
- `packages/macos-mailbox-helper/Sources/TriangleMailboxCore/WorkerLauncher.swift`:
  - Accepted manifest versions updated to `(5...13)` and `(8...13)`.
  - Added union for `manifestVersion >= 13` containing the six router artifacts.
- `packages/agent-worker/src/installation-inventory.mjs`:
  - `WORKER_MANIFEST_VERSIONS` updated to `Set([3, ..., 13])`.

---

## 3. Verification Evidence

All tests executed with System Node `/Users/zhenyuhou/.local/bin/node` (v22.22.3) and Python `/usr/bin/python3` (3.9.6):

| Suite | Scope | Result |
| :--- | :--- | :--- |
| `r1-integration-v13.test.mjs` | v12/v13 SQLite journal read/write interop, setupRouter CLI, kill switch & statcache, ACL & capability resolution, ambiguity candidate filtering, idempotency duplicate/conflict, registry corruption fail-closed, DTO decoration | **9 / 9 PASS** |
| `worker-bundle-closure.test.mjs` | Static import closures, Python installer artifact sets (87 supervisor, 89 workers), Swift launcher parity through v13 | **16 / 16 PASS** |
| `supervisor-runtime-bundle.test.mjs` | Standalone supervisor staging, v13 manifest validation, node/symlink/mode tamper resistance | **10 / 10 PASS** |
| `keychain-launch-contract.test.mjs` | Clean runtime preparation, v13 manifest rendering, v6/v7 legacy downgrade and upgrade parity | **8 / 8 PASS** |
| `installation-inventory.test.mjs` | Manifest versions 3 through 13 acceptance, v14 rejection, custody invariants | **32 / 32 PASS** |
| `local-messaging-server-client.test.mjs` | Server/client RPC lifecycle, rate limiting, duplicate send, ACL & capability checks, message parsing | **18 / 18 PASS** |
| `local-messaging-journal.test.mjs` | Memory and SQLite journal contract, execution transitions, hold/recover | **12 / 12 PASS** |
| `local-messaging-cli.test.mjs` | Local messaging CLI operations, setup-router commands, private JSON permissions | **4 / 4 PASS** |
| `unified-router.test.mjs` | Unit tests for router core: resolveSend, decorators, statusBlock, counters | **10 / 10 PASS** |
| `recipient-resolver.test.mjs` | Table-driven recipient resolver rules, pass-through, peer rejection, ambiguity | **15 / 15 PASS** |
| `router-registry-snapshot.test.mjs` | Snapshot provider caching, mtime/inode change invalidation, unreadable handling | **10 / 10 PASS** |
| `identity-registry.test.mjs` | Identity registry storage, sequence validation, hash chain auditing, multi-process stress | **16 / 16 PASS** |
| `identity-primitives.test.mjs` | ID patterns, instance derivation, profile name validation | **6 / 6 PASS** |
| `transport-adapter-contract.test.mjs` | Transport adapter state mapping and contract assertions | **12 / 12 PASS** |
| `test-host.sh` (Swift) | Full host test suite: launcher, credentials, transactions, gate, v13 manifest contracts | **ALL PASS** (0 failures) |

---

## 4. Rollback Guarantee

- **Safe Rollback**: `router.json` is a distinct configuration file. No fields were added to `local-messaging.json`. If rolled back to version 12 binaries, `local-messaging.json` remains valid and `router.json` is simply ignored.
- **Accepted Versions**: The Swift launcher and Python installer continue to explicitly accept manifest versions 8 through 12, ensuring zero friction if reverting to a v12 runtime bundle.
- **Journal Forward/Backward Interoperability**: Nullable `to_principal` and `resolved_via` columns with named insert statements allow v12 and v13 processes to share the journal table without constraint or syntax errors.

---

## 5. Next Steps (Slices R1.5 & R1.6)

This completes slice **R1.4** source implementation and verification. The following operations are strictly reserved for subsequent slices and require explicit owner authorization:
- **R1.5 (Candidate & Rehearsal)**: Building candidate distribution packages, staging runtime bundles on disposable scratch app roots, executing rollback rehearsal.
- **R1.6 (Live Acceptance)**: Owner gates G1-G4, staging onto installed application roots, helper replacement, LaunchAgent reloads, and live canary sending.

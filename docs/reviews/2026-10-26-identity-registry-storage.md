# Review: Host-Local Identity Registry Storage (Slice 1a Remainder)

Date: 2026-10-26
Worktree: `/Users/zhenyuhou/Projects/The Triangle/worktrees/identity-registry-storage`
Branch: `antigravity/identity-registry-storage` (based on `origin/main` `5e091da`)

---

## 1. Scope

This change implements the host-local identity registry storage foundation specified in `docs/plans/2026-10-25-identity-reconciliation-design.md` (Section 4.1, Section 7 row 8, Section 8 steps 2–4, and Section 11 Slice 1a/1b and Assumption A4):

- **`packages/agent-worker/src/identity-registry.mjs`**: Closed-schema validation (`identity_registry_v1` and the Slice 1a reduced `local_profile_binding_v1`), deterministic `canonicalJson` serialization, descriptor-based private path/file custody checks, SQLite exclusive lock acquisition (`<root>/.registry.lock`), atomic compare-and-set updates (`updateIdentityRegistry`) with exact action-to-mutation diff verification, and an append-only SHA-256 hash-chained audit log (`<root>/registry-audit.jsonl`).
- **`packages/agent-worker/test/identity-registry.test.mjs`**: Unit, action-mutation diff, crash-debris recovery, descriptor-custody/retry race, multi-process stress, hash-chain tampering, and boundary isolation tests.

Nothing in production imports this module yet. No CLI command is added, and no manifest, installer, supervisor, `package.json`, or Swift file is modified.

---

## 2. File Formats and Closed Schemas

All objects reject unknown keys at every nesting level. Serialization uses `canonicalJson(value)` (UTF-16 code-unit sorted object keys, no whitespace) followed by a single trailing newline (`\n`).

### 2.1 Registry File (`<root>/identity-registry-v1.json`, mode `0600`, max 1 MiB)

```json
{
  "auditHead": {
    "hash": "<64 lowercase hex>",
    "sequence": 1
  },
  "bindings": {
    "<profile_instance_id (64 lowercase hex)>": {
      "authority_origin": "https://example.test",
      "binding_generation": 1,
      "binding_id": "bind_<32 lowercase hex>",
      "issued_at": "2026-10-25T12:00:00.000Z",
      "principal_id": "agent_<32 lowercase hex>",
      "profile_instance_id": "<64 lowercase hex>",
      "profile_name": "<valid profile name>",
      "proof": {
        "kind": "disk_observation",
        "observed_on_disk": true,
        "verified_live_authority": false
      },
      "revoked_at": null,
      "schema": "local_profile_binding_v1",
      "trust_mode": "mesh-managed"
    }
  },
  "createdAt": "2026-10-25T12:00:00.000Z",
  "schema": "identity_registry_v1",
  "sequence": 1,
  "updatedAt": "2026-10-25T12:00:00.000Z"
}
```

Validation invariants (`validateIdentityRegistry`):
- `schema` must be `"identity_registry_v1"`.
- `sequence` is a safe integer $\ge 0$; `auditHead.sequence === sequence`. When `sequence === 0`, `auditHead.hash` is 64 zeros; when `sequence > 0`, `auditHead.hash` is a non-zero 64-character lowercase hex digest.
- `createdAt` and `updatedAt` are valid ISO-8601 UTC timestamps (`YYYY-MM-DDTHH:MM:SS(.sss)Z`) with `updatedAt >= createdAt`.
- `bindings` contains at most 1,000 entries (`MAX_REGISTRY_BINDINGS = 1000`), and the serialized registry (`canonicalJson(registry) + "\n"`) is at most 1 MiB (`MAX_REGISTRY_BYTES = 1048576`).
- Each key in `bindings` must equal its value's `profile_instance_id`, which must be 64 lowercase hex characters equal to `deriveClientInstanceId(profile_name)`.
- `trust_mode` accepts only `"mesh-managed"` in this slice (`"serverless-peer"` is rejected).
- `principal_id` matches `^agent_[a-f0-9]{32}$`; `binding_id` matches `^bind_[a-f0-9]{32}$` and is unique across all bindings in the registry.
- `authority_origin` satisfies `isValidBareHttpsOrigin`.
- `binding_generation` is a safe integer $\ge 1$.
- `proof` must be `{ kind: "disk_observation", observed_on_disk: true, verified_live_authority: false }`.
- Validation returns a deep-frozen copy or throws a coded `invalid_registry` error whose message contains only a bounded reason code and never echoes caller input.

### 2.2 Action-to-Mutation Diff Rules (`assertMutationMatchesAction`)

Every `updateIdentityRegistry` call compares the previous and new `bindings` maps and requires that the mutation matches `(action, subject)` exactly, or throws `invalid_registry` with bounded reason `mutation_does_not_match_action` and writes nothing:
- **`init`**: Allowed only when the registry is currently `"absent"`; `subject` must be `null` and the resulting `bindings` must be empty (`{}`).
- **`bind` (subject absent before)**: Creates the binding for `subject` with `binding_generation === 1` and `revoked_at === null`; no other binding may be added, removed, or modified.
- **`bind` (subject present before — rebind)**: Updates only `subject` with `binding_generation === old.binding_generation + 1`, `revoked_at === null`, a different `binding_id`, and identical `profile_name` and `profile_instance_id` (`issued_at`, `principal_id`, and `authority_origin` may change); no other binding may differ.
- **`revoke`**: Requires an existing active binding for `subject` (`old.revoked_at === null`); the new binding must be identical to the old binding in every field except `revoked_at`, which is set to an ISO-8601 UTC timestamp $\ge$ `issued_at` (with `binding_generation` unchanged); no other binding may differ.

### 2.3 Audit Log (`<root>/registry-audit.jsonl`, mode `0600`, max 8 MiB)

Each line is `canonicalJson(entry) + "\n"` with closed keys:

```json
{"action":"bind","at":"2026-10-25T12:05:00.000Z","bindingId":"bind_<32 hex>","hash":"<64 hex>","prevHash":"<64 hex>","sequence":2,"subject":"<64 hex profile_instance_id>"}
```

- `sequence`: contiguous integer starting at `1`.
- `at`: ISO-8601 UTC timestamp.
- `action`: `"init"` | `"bind"` | `"revoke"`. For `"init"`, `subject` and `bindingId` are `null`; for `"bind"` and `"revoke"`, `subject` is the 64-hex `profile_instance_id` and `bindingId` is the target binding's `binding_id`.
- `prevHash`: 64 zeros (`"0".repeat(64)`) for `sequence === 1`, and the preceding line's `hash` for `sequence > 1`.
- `hash`: `sha256(canonicalJson(entry without hash))`.
- Audit entries contain no secrets, profile contents, or message text.
- Updates that would cause `registry-audit.jsonl` to exceed 8 MiB (`MAX_AUDIT_BYTES = 8388608`) fail with `registry_audit_full` before writing.

### 2.4 Lock File (`<root>/.registry.lock`, mode `0600`)

Writers acquire an exclusive SQLite transaction (`BEGIN EXCLUSIVE`) on `<root>/.registry.lock`, polling up to 5 seconds (`LOCK_TIMEOUT_MS = 5000`) before failing with `registry_busy`. Read operations (`readIdentityRegistry`) are strictly read-only and never create directories or lock files.

---

## 3. Commit Protocol, Crash Recovery, and Concurrent Reader Race Handling

### 3.1 Custody and Descriptor-Based Reads

Path and directory checks reuse `ancestors`, `privateDir`, and `privateFile` from `packages/agent-worker/src/delivery-private-path.mjs`: `root` must be a canonical `0700` directory owned by the current UID with safe ancestors, and files inside `root` are never repaired or chmodded on error.

To prevent false-positive `registry_unsafe` errors when a reader runs concurrently with committing writers:
- **Descriptor-based verification (`readNoFollowDescriptor`)**: Each data file (`identity-registry-v1.json` and `registry-audit.jsonl`) is opened first with `O_RDONLY | O_NOFOLLOW`, and custody checks (regular file, current UID, mode `0600`, `nlink === 1`) are evaluated on `fstatSync(fd)` of that open file descriptor before reading from the same descriptor, so a concurrent `rename` cannot replace what was checked.
- **Vanished files and `nlink === 0`**: A path that vanishes (`ENOENT`) between the directory scan and `openSync`, or an open/stat result showing `nlink === 0` (briefly observable on APFS/POSIX while a file is being unlinked or atomically replaced), is treated as vanished rather than `registry_unsafe`.
- **Transient lock journal tolerance**: Both the root directory scan and writer lock acquisition tolerate the transient SQLite rollback journal `.registry.lock-journal` (whether present with mode `0600`, absent, or `nlink === 0`) while still rejecting symlinks, non-regular files, foreign owners, or group/other permission bits.
- **Non-regular files**: the open flags include `O_NONBLOCK`, so a FIFO planted at either data path is rejected with `registry_unsafe` instead of blocking the reader; a symlink (`ELOOP`) or a directory at either path is rejected the same way. Any other open failure is reported as `registry_unsafe: file_open_failed`.
- **Bounded reader retries**: `readIdentityRegistry` retries the read up to 5 times (`READ_MAX_RETRIES = 5`, with backoff `[2, 4, 8, 12, 20]` ms, 46 ms in total) when the only problem is a transient writer timing artifact: a vanished file (`file_vanished_during_read`) or one of the audit-chain reasons `audit_log_behind_registry`, `audit_log_too_many_uncommitted_lines`, `audit_log_missing`, `audit_log_empty`, `audit_line_truncated` or `orphan_audit_log`. A persistent error still throws after the retries, so a genuinely damaged chain is reported after at most 46 ms of backoff. Updates hold the lock and never retry.
- **Test seam (`fsHooks`)**: `readIdentityRegistry` accepts an optional `fsHooks` object (`lstatSync`, `openSync`, `fstatSync`, `readFileSync`) that tests use to simulate these races deterministically. While it is present the extra `privateFile` check on non-data entries is skipped, so production callers must not pass it.

### 3.2 Two-Step Commit Protocol and Crash Rules

Under the exclusive `.registry.lock`, `updateIdentityRegistry` executes:

1. **Re-read and verify**: Reads and verifies the current registry and audit chain. Requires `currentSequence === expectedSequence` (`0` when absent) or throws `registry_sequence_conflict` without writing.
2. **Mutate, validate, and diff**: Passes a deep clone of the current registry to `mutate(clone)`, verifies `mutate` did not alter `sequence`, `updatedAt`, `auditHead`, or existing `createdAt`, validates the candidate registry against the closed schema, and enforces `assertMutationMatchesAction`.
3. **Step 1 — Audit append**: If a previous crash left 1 uncommitted tail item (`uncommittedTail === 1`, either a complete uncommitted line or a torn trailing fragment), truncates `registry-audit.jsonl` back to `committedByteLength`, appends the new line (`sequence = currentSequence + 1`), and calls `fsyncSync`.
4. **Step 2 — Atomic registry replacement (Commit Point)**: Writes the serialized registry to `<root>/identity-registry-v1.json.tmp-<pid>-<random>`, calls `fsyncSync`, closes, renames it over `identity-registry-v1.json`, and fsyncs `<root>`.

Crash rules:
- **Crash during Step 1 (torn trailing audit line)**: If a write is cut short before the trailing newline (`\n`), `parseAndVerifyAuditLog` treats the final incomplete fragment as uncommitted crash debris (`uncommittedTail: 1`) when all complete lines before it verify through `registry.auditHead` (or when the registry is absent and no complete line precedes it). Reads succeed and ignore the torn fragment, and the next locked `updateIdentityRegistry` truncates the file back to `committedByteLength` before appending. A torn line inside the committed region, or complete lines that stop short of `registry.auditHead`, still throws `registry_chain_broken`.
- **Crash after Step 1 and before Step 2 rename**: `registry-audit.jsonl` has one complete hash-chained line beyond `registry.auditHead.sequence` (or 1 initial `init`/`bind` line when the registry file is still absent). `readIdentityRegistry` reports `uncommittedTail: 1` (or `state: "absent"` when the registry file was never installed), and the next locked `updateIdentityRegistry` truncates back to `committedByteLength` before appending its new line. Leftover `.tmp-*` files are ignored by reads.
- **Crash after Step 2 rename**: The commit point has passed; subsequent reads see `sequence + 1` and `uncommittedTail: 0`.
- **Any other discrepancy**: Missing committed lines, >1 uncommitted items beyond `auditHead`, edited/reordered/duplicated lines, a line cut inside the committed region, or an `auditHead` hash mismatch throws `registry_chain_broken`.

---

## 4. Verification Commands and Results

Executed from `/Users/zhenyuhou/Projects/The Triangle/worktrees/identity-registry-storage`:

1. **Identity registry unit, fault, race, and boundary tests**:
   ```sh
   /Users/zhenyuhou/.local/bin/node --test packages/agent-worker/test/identity-registry.test.mjs
   ```
   Result: **16/16 passed** (0 failed). The stress test runs 4 writer processes and 1 reader process for about 3 seconds.

2. **Agent-worker inventory and bundle closure regression suites**:
   ```sh
   /Users/zhenyuhou/.local/bin/node --test packages/agent-worker/test/identity-inventory.test.mjs packages/agent-worker/test/installation-inventory.test.mjs packages/agent-worker/test/worker-bundle-closure.test.mjs packages/agent-worker/test/supervisor-runtime-bundle.test.mjs
   ```
   Result: **70/70 passed** (0 failed).

3. **Triangle CLI regression suite**:
   ```sh
   npm --prefix packages/triangle-cli test
   ```
   Result: **93/93 passed** (0 failed).

4. **Client package regression suite**:
   ```sh
   /Users/zhenyuhou/.local/bin/node --test tests/client-package.test.mjs
   ```
   Result: **9/9 passed** (0 failed).

5. **Whitespace and formatting check**:
   ```sh
   git diff --check 5e091da
   ```
   Result: Exit code `0` (clean).

---

## 5. Explicit Limits

1. **Integrity vs. same-user rewrite or two-file rollback**: The SHA-256 hash chain in `registry-audit.jsonl` and `registry.auditHead` detects accidental or partial corruption and a partial rollback of one file relative to the other. However, it is **not** cryptographically signed: a process running as the same OS user that rewrites both `identity-registry-v1.json` and `registry-audit.jsonl` consistently, or restores an older snapshot of both files together, is not detected locally by this module. Tracking a supervisor-held last-seen sequence is deferred to a later slice.
2. **No host installation key**: No host installation signing key or hardware-backed sealing exists yet.
3. **No audit log rotation**: `registry-audit.jsonl` is capped at 8 MiB (`registry_audit_full`); log rotation and compaction are out of scope for this slice.
4. **Undecided default registry location**: `root` is always an explicit caller-supplied absolute path; default path resolution (`<TRIANGLE_HOME>/identity` vs. supervisor state root, Assumption A4) is undecided and omitted here.
5. **Library-only**: No production code or CLI imports `identity-registry.mjs` yet, so this change does not alter the running supervisor or packaged runtime manifests.

---

## 6. Reviewer verification and changes (reviewer: Claude, 2026-10-25)

Independent probes (a script kept outside the repository, run against the finished branch): 9 of 9 pass.
- Integrity: a principal swap at the same generation, a second unrelated binding in one bind, a revoke that also changes the origin, and an un-revoke at the same generation are all refused with `mutation_does_not_match_action`.
- Crash debris: a torn trailing audit line reads as `uncommittedTail: 1` and the next update repairs it.
- Races: 4 writer processes with 15 updates each all landed exactly once and the chain verified with no uncommitted tail. A concurrent reader made about 8,400 reads with zero errors.

Changes made in review:
- A FIFO planted at the registry or audit path blocked the descriptor-first read forever, where the earlier code rejected it in 1 ms. The open now uses `O_NONBLOCK`, and open failures other than `ELOOP`/`EFTYPE` are reported as `file_open_failed` instead of as a link problem. New test: a FIFO, a symlink and a directory at each data path, checked from a child process with a timeout. Without the fix it times out.
- The stress test used worker threads. It now runs separate processes, as the review item asked and as this document states.
- New test for the lock-journal states: `nlink` 0 is tolerated by a read; a symlink, group-readable or hard-linked journal is rejected by both a read and an update, with both files unchanged.
- Removed a dead `lstat` hook from the race-seam test (the registry is checked on its descriptor, not by path).

Open note: `fsHooks` is part of the exported `readIdentityRegistry` signature. It is documented as test-only, but nothing stops a production caller from passing it.

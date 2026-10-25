# Review: Host-Local Identity Registry Storage (Slice 1a Remainder)

Date: 2026-10-26
Worktree: `/Users/zhenyuhou/Projects/The Triangle/worktrees/identity-registry-storage`
Branch: `antigravity/identity-registry-storage` (based on `origin/main` `5e091da`)

---

## 1. Scope

This change implements the host-local identity registry storage foundation specified in `docs/plans/2026-10-25-identity-reconciliation-design.md` (Section 4.1, Section 7 row 8, Section 8 steps 2–4, and Section 11 Slice 1a/1b and Assumption A4):

- **`packages/agent-worker/src/identity-registry.mjs`**: Closed-schema validation (`identity_registry_v1` and the Slice 1a reduced `local_profile_binding_v1`), deterministic `canonicalJson` serialization, safe private path/file custody checks, SQLite exclusive lock acquisition (`<root>/.registry.lock`), atomic compare-and-set updates (`updateIdentityRegistry`), and an append-only SHA-256 hash-chained audit log (`<root>/registry-audit.jsonl`).
- **`packages/agent-worker/test/identity-registry.test.mjs`**: Unit, concurrency, fault-injection, custody, hash-chain tampering, and boundary isolation tests.

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
- `binding_generation` is a safe integer $\ge 1$; updates disallow decreasing `binding_generation` or deleting existing binding keys (revocation sets `revoked_at` to an ISO-8601 UTC timestamp $\ge$ `issued_at`).
- `proof` must be `{ kind: "disk_observation", observed_on_disk: true, verified_live_authority: false }`.
- Validation returns a deep-frozen copy or throws a coded `invalid_registry` error whose message contains only a bounded reason code and never echoes caller input.

### 2.2 Audit Log (`<root>/registry-audit.jsonl`, mode `0600`, max 8 MiB)

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

### 2.3 Lock File (`<root>/.registry.lock`, mode `0600`)

Writers acquire an exclusive SQLite transaction (`BEGIN EXCLUSIVE`) on `<root>/.registry.lock`, polling up to 5 seconds (`LOCK_TIMEOUT_MS = 5000`) before failing with `registry_busy`. Read operations (`readIdentityRegistry`) are strictly read-only and never create directories or lock files.

---

## 3. Commit Protocol and Crash Recovery

All custody checks reuse `ancestors`, `privateDir`, and `privateFile` from `packages/agent-worker/src/delivery-private-path.mjs`: `root` must be a canonical `0700` directory owned by the current UID with safe ancestors, and every file inside `root` must be a regular single-link (`nlink === 1`) `0600` file owned by the current UID (no symlinks; never repaired or chmodded on error).

Under the exclusive `.registry.lock`, `updateIdentityRegistry` executes:

1. **Re-read and verify**: Reads and verifies the current registry and audit chain. Requires `currentSequence === expectedSequence` (`0` when absent) or throws `registry_sequence_conflict` without writing.
2. **Mutate and validate**: Passes a deep clone of the current registry to `mutate(clone)`, verifies `mutate` did not alter `sequence`, `updatedAt`, `auditHead`, or existing `createdAt`, enforces monotonic `binding_generation` and non-deletion of bindings, and validates the next registry and audit entry in memory.
3. **Step 1 — Audit append**: If a previous crash left 1 uncommitted tail line (`uncommittedTail === 1`), truncates `registry-audit.jsonl` back to the last committed byte offset, appends the new line (`sequence = currentSequence + 1`), and calls `fsyncSync`.
4. **Step 2 — Atomic registry replacement (Commit Point)**: Writes the serialized registry to `<root>/identity-registry-v1.json.tmp-<pid>-<random>`, calls `fsyncSync`, closes, renames it over `identity-registry-v1.json`, and fsyncs `<root>`.

Crash rules:
- **Crash before Step 1 completes**: Neither file changes (or a truncated/partial line is detected as `registry_chain_broken`).
- **Crash after Step 1 and before Step 2 rename**: `registry-audit.jsonl` has exactly one valid hash-chained line beyond `registry.auditHead.sequence`. `readIdentityRegistry` reports `audit: { verifiedThrough: registry.sequence, uncommittedTail: 1 }` and returns the committed `registry`. The next locked `updateIdentityRegistry` truncates that uncommitted line before appending its new line. Any leftover `.tmp-*` file is ignored by reads and cleaned up or ignored.
- **Crash after Step 2 rename**: The commit point has passed; subsequent reads see `sequence + 1` and `uncommittedTail: 0`.
- **Any other discrepancy**: Missing lines, >1 extra lines, edited/reordered/duplicated/truncated lines, or `auditHead` hash mismatch throws `registry_chain_broken`.

---

## 4. Verification Commands and Results

Executed from `/Users/zhenyuhou/Projects/The Triangle/worktrees/identity-registry-storage`:

1. **Identity registry unit and boundary tests**:
   ```sh
   /Users/zhenyuhou/.local/bin/node --test packages/agent-worker/test/identity-registry.test.mjs
   ```
   Result: **10/10 passed** (0 failed).

2. **Agent-worker inventory and bundle closure regression suites**:
   ```sh
   /Users/zhenyuhou/.local/bin/node --test packages/agent-worker/test/identity-inventory.test.mjs packages/agent-worker/test/installation-inventory.test.mjs packages/agent-worker/test/worker-bundle-closure.test.mjs packages/agent-worker/test/supervisor-runtime-bundle.test.mjs
   ```
   Result: **70/70 passed** (0 failed).

3. **Client package regression suite**:
   ```sh
   /Users/zhenyuhou/.local/bin/node --test tests/client-package.test.mjs
   ```
   Result: **9/9 passed** (0 failed).

4. **Whitespace and formatting check**:
   ```sh
   git diff --check 5e091da12e38ec273b8e5941c6da99d526043f41
   ```
   Result: Exit code `0` (clean).

---

## 5. Explicit Limits

1. **Integrity vs. same-user rewrite or two-file rollback**: The SHA-256 hash chain in `registry-audit.jsonl` and `registry.auditHead` detects accidental or partial corruption and a partial rollback of one file relative to the other. However, it is **not** cryptographically signed: a process running as the same OS user that rewrites both `identity-registry-v1.json` and `registry-audit.jsonl` consistently, or restores an older snapshot of both files together, is not detected locally by this module. Tracking a supervisor-held last-seen sequence is deferred to a later slice.
2. **No host installation key**: No host installation signing key or hardware-backed sealing exists yet.
3. **No audit log rotation**: `registry-audit.jsonl` is capped at 8 MiB (`registry_audit_full`); log rotation and compaction are out of scope for this slice.
4. **Undecided default registry location**: `root` is always an explicit caller-supplied absolute path; default path resolution (`<TRIANGLE_HOME>/identity` vs. supervisor state root, Assumption A4) is undecided and omitted here.
5. **Library-only**: No production code or CLI imports `identity-registry.mjs` yet, so this change does not alter the running supervisor or packaged runtime manifests.

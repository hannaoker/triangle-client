# Identity registry v2 (D1): implementation plan

Status: plan, 2026-11-07. No code. All seven owner decisions (D1-1 to D1-7) were settled the same day at the recommended options (section 10); the plan as a whole still awaits the owner's go-ahead to start building. Written by Claude Code and not yet reviewed by anyone else. It turns owner decision D1 of `2026-10-30-identity-destination-design-delta.md` (option A, approved 2026-10-30: a new schema version with a runtime floor) into buildable pieces. It authorizes no code, install, upgrade of the live registry, `peer_` id, pairing, alias or destination rule; each of those stays behind the gates in section 7. Baseline: client main `d418fb1` (PR #162), supervisor manifest v14. Every claim about shipped behavior cites source at that baseline; paths are under `packages/agent-worker/src/` unless they start with `docs/`, `test/`, `packages/` or `scripts/`.

## 1. What D1 is

Prerequisite F.1 of the U3 delta asks for "a registry schema version that can hold `peer_` principals, `serverless-peer` bindings, aliases and destination rules". The schema is the easy part. The expensive part is the compatibility event: once a v2 file exists on disk, every reader of the registry has to understand it. D1 therefore pays that cost once, for everything the October designs already specify, and changes no behavior.

| In D1 | Not in D1 |
| :--- | :--- |
| `identity_registry_v2`: a closed schema with widened bindings and three new collections (pairings, aliases, destinations), validators and caps | Minting `peer_` ids, keys or signatures; pairing, endpoint binding, rotation (identity design Slice 3a) |
| One audited, backed-up v1 to v2 upgrade step and a restore path | Commands that set or clear aliases and destination rules, and the approval kinds they need |
| Readers that understand v2: registry reader, snapshot provider, resolver, `status`/`doctor` identity view, `identity inventory`/`migrate`/`revoke` | Any routing change: `peer_` sends keep failing with `peer_not_supported`; no alias or destination is consulted; no inbound path (U3 3.C, 3.F.2) |
| The runtime floor: the upgrade refuses until the running supervisor reports it can read v2 | Signed proofs (`mesh_dpop_bind_proof`, verification of `principal_sig`); they arrive with the slices that verify authority |
| Fail-closed tests against a frozen copy of today's reader | MESH server work (Slice 4), Iroh adapters (R3, R5), new action kinds in the Swift approval provider |

## 2. Starting point (checked)

- **Files and caps.** The v1 registry is `identity-registry-v1.json` beside `registry-audit.jsonl` and `.registry.lock` in `<application root>/identity/` (`identity-registry.mjs:50-55`). Caps: 1000 bindings, 1 MiB registry, 8 MiB audit (`:57-59`).
- **Closed schema.** Top-level keys are `schema, sequence, createdAt, updatedAt, auditHead, bindings` (`:78-85`); binding keys are fixed (`:89-101`); `trust_mode` can only be `mesh-managed` (`:314`), `principal_id` only `agent_<32-hex>` (`:317`), `proof` only `disk_observation` with `verified_live_authority: false` (`:372-378`). Unknown keys are refused at every level, and `validateIdentityRegistry` (`:404`) refuses any other `schema` value (`:416-418`).
- **Read failures are loud.** Every validation error on read becomes `registry_corrupt` (`:1066-1068`). The audit log accepts only the actions `init`, `bind` and `revoke` (`:119`), and a reader meeting any other action reports `registry_chain_broken` / `invalid_audit_action` (`:549`).
- **Writer.** `updateIdentityRegistry` (`:1433`) takes the lock, verifies the chain, validates the mutated registry, checks that the diff matches the declared action (`assertMutationMatchesAction`, `:1315`), appends the audit line, then renames the registry into place (the commit point). D2 and D3 live in that check: a plain `bind` cannot change `principal_id` or `authority_origin` (`identity_change_requires_move`, `:1366`) or duplicate an unrevoked principal (`principal_already_bound`, `:1373`).
- **Supervisor readers.** The router builds a snapshot provider from `router.json` (`local-messaging-server.mjs:22`, `:93-136`). The provider re-reads when the file's stat key changes (`router-registry-snapshot.mjs:26`) or after 2 s (`:128`), and any read error becomes an `unreadable` snapshot. The resolver then answers `route_unavailable` / `registry_unreadable` for `agent_` ids (`recipient-resolver.mjs:105-118`) while exact ids keep routing. It accepts only `trust_mode === "mesh-managed"` bindings (`:128`) and answers `peer_` ids with `recipient_not_found` / `peer_not_supported` before it touches the snapshot (`:88-98`; `unified-router.mjs:239`, `:286`).
- **Owner CLI readers and writers.** `triangle identity status|inventory|migrate|revoke` import the registry module from the sibling `agent-worker` package of whichever installation they run from (`packages/triangle-cli/src/identity-status.mjs:45`, `identity-migrate.mjs:70`, `identity-revoke.mjs:7`, `owner-approval-registry.mjs:4`). The client package therefore carries its own copy of `identity-registry.mjs`, separate from the supervisor bundle's copy. The only writers are `identity migrate` (`bind`, `identity-mapping.mjs:562`) and `identity revoke` through the OS approval path (`revoke`, `owner-approval-registry.mjs:24`).
- **Approval kinds.** The OS approval contract and the Swift provider know exactly two actions, `profile.move` and `profile.revoke` (`packages/triangle-cli/src/owner-approval.mjs:24`; `scripts/probes/owner-approval-provider.swift:42`).
- **The floor precedent is weak.** Reply identity's floor is a setup-time check: `setupReplyIdentity` reads the live supervisor manifest and refuses below v14 (`local-messaging-cli.mjs:955`). A manifest number cannot tell a v14 bundle that reads v2 from one that does not, so D1 needs a stronger probe (5.2).
- **Release mechanics.** `CURRENT_MANIFEST_VERSION` is 14 (`scripts/triangle-worker-install.py:110`) and the identity modules sit in the router artifact group (`:101-108`). A change that stays inside listed modules installs as a supervisor-only restage; the class grants and `grok wait` installs of 2026-11-07 changed 3 and 2 artifacts with no manifest or helper change.
- **Live state, checked 2026-11-07 with `triangle-local status`.** Manifest v14, supervisor bundle `9034909d…`, router enabled, registry `state: ok`, `sequence: 3`. The registry's contents were not read.

## 3. Registry v2

### 3.1 File, lock and audit chain

- **Same path, new schema.** The file stays `identity/identity-registry-v1.json` and carries `"schema": "identity_registry_v2"`. A v1 reader opens exactly that name, rejects the unknown top-level keys (and would reject the schema too) and reports the registry unreadable, which fails principals closed and shows as a `registry_unreadable` fault in `doctor` (`identity-view.mjs:231-236`). A new file name would make v1 readers see `absent` (a silent "no registry") and a leftover v1 file would be read as valid but stale. The name keeps its misleading "v1"; rename it only when no v1 reader remains (decision D1-2).
- **Same lock and chain.** The upgrade appends to the existing `registry-audit.jsonl`; the entry's `prevHash` is the last v1 hash, so history stays verifiable by v2 readers. A v1 reader rejects the new action name as well (`:549`), a second loud refusal.

### 3.2 Bindings (`local_profile_binding_v2`)

| Field | v1 | v2 |
| :--- | :--- | :--- |
| `schema` | `local_profile_binding_v1` | `local_profile_binding_v2` |
| `trust_mode` | `mesh-managed` only | `mesh-managed` or `serverless-peer` |
| `principal_id` | `agent_<32-hex>` | `agent_<32-hex>` for `mesh-managed`; `peer_<32-hex>` for `serverless-peer`, an opaque random id, never key-derived (identity design decision 1) |
| `authority_origin` | bare https origin | same for `mesh-managed`; `null` for `serverless-peer` (no MESH authority) |
| `principal_public_key` | not stored | `null` for `mesh-managed`; base64url Ed25519 public key for `serverless-peer` |
| `proof` | `disk_observation` only | `disk_observation` for agent bindings (meaning unchanged: observed on disk, authority not verified); `local_principal_self_sig` with `principal_sig` for serverless bindings (identity design 4.1) |
| `binding_id`, `profile_name`, `profile_instance_id`, `binding_generation`, `issued_at`, `revoked_at` | as today | unchanged, including the derived instance id and the D2 and D3 rules |

Identity design 4.1 fields that stay omitted: `installation_id` (one registry per installation) and `expires_at` (local owner bindings do not expire). D1 validates the serverless shapes and refuses everything else. It mints no `peer_` id, key or signature, verifies no `principal_sig`, and never lets the resolver return a serverless binding.

### 3.3 New collections

| Collection | Key | Record (closed) | Constraints | Cap |
| :--- | :--- | :--- | :--- | :--- |
| `pairings` | `pairing_id`, `pair_<32-hex>` | `schema` `serverless_pairing_v1`; `local_principal_id`, `remote_principal_id` (both `peer_`); `remote_principal_public_key`; `remote_endpoint_ids` (1 to 8 values of 64-hex); `petname`; `binding_generation`; `issued_at`; `expires_at` (explicit; 365-day default from identity design decision 7); `remote_invitation_sig`; `local_owner_approval_sig`; `next_key_digest` (`null`, reserved by decision 5); `pending_rotation` (`null` or pending rotation object); `pending_endpoint_update` (`null` or pending endpoint update object); `revoked_at` | one unrevoked pairing per (local, remote) pair; petname unique per local principal among unrevoked; an endpoint id may be shared by live pairings only when they have the same `remote_principal_id` (one principal per endpoint, decision 3); `local_principal_id` must be a `serverless-peer` binding in this registry. Pending approval state (October design section 6) is held in `pending_rotation` and `pending_endpoint_update`. `min_remote_binding_generation` is the pairing's own `binding_generation`, `display_collision` is derived at display time, and `trust_mode` on a pairing is implied (`serverless-peer`). Managed-Iroh proofs (`mesh_dpop_bind_proof`, workload key) are NOT reserved and require schema v3 with Slices 4/5 (so D1-4's "no second floor cycle" covers Slice 3a and the alias/destination commands only). | 256 |
| `aliases` | alias text | `principal_id`, `set_at`, `generation` | pattern `^[a-z0-9][a-z0-9._-]{0,31}$`, never principal-, session- or 64-hex-shaped; the target must be a bound or paired principal; one alias names one principal. Collisions with local ids and labels are decided at resolve time, not storage time, because labels are not registry data (U3 3.D.2) | 256 |
| `destinations` | `principal_id` | `harness` (`claude` or `codex`), `workspace` (absolute path, bounded), `set_at`, `generation` | one rule per principal; the principal must exist (U3 3.C.2) | 256 |

### 3.4 Audit actions

v2 knows `init`, `bind`, `revoke` (unchanged), `upgrade` (implemented by D1) and the reserved names `alias_set`, `alias_clear`, `destination_set`, `destination_clear`, `pair`, `pair_update`, `pair_revoke`. Reserving matters: an audit action that a v2 reader does not know breaks its chain check exactly as in v1 (`:549`), so each later feature would force another floor cycle. In D1.0 reserved actions in writer input are refused with `invalid_audit_action` (in D1.1 `updateIdentityRegistry` will refuse them with `action_not_available`); `bind` refuses `trust_mode: serverless-peer` the same way. Each later slice implements its action together with its approval gate.

### 3.5 Caps and closure

Bindings stay at 1000, the registry at 1 MiB and the audit log at 8 MiB. A full audit log makes the registry read-only (`registry_audit_full`); rotation is not part of D1 (risk 4). Unknown schemas, keys, proof kinds and audit actions are refused everywhere, never ignored.

### 3.6 Refinements made while building D1.0

Details the plan left open, now fixed in code and tests (`identity-registry.mjs`, `test/identity-registry-v2.test.mjs`):

- **Audit fields per action.** The entry keys stay the same; what `subject` and `bindingId` mean depends on the action.

| Action | `subject` | `bindingId` |
| :--- | :--- | :--- |
| `init`, `upgrade` | `null` | `null` |
| `bind`, `revoke` | 64-hex profile instance id | `bind_<32-hex>` (as in v1) |
| `alias_set`, `alias_clear` | the alias text | `null` |
| `destination_set`, `destination_clear` | `agent_` or `peer_` principal id | `null` |
| `pair`, `pair_update`, `pair_revoke` | `pair_<32-hex>` | `null` |

- **`upgrade` in the chain.** A v2 registry may contain at most one `upgrade` entry. A v1 registry's committed chain may contain none, but its uncommitted tail may be an `upgrade`: the audit line is appended before the registry file is replaced, so a crash in between leaves exactly that, and the registry stays readable as v1 (the next v1 write discards the tail, as for any tail). Reserved actions are structurally valid in a v2 chain; nothing writes them yet.
- **Alias and destination targets.** An alias may name the principal of any binding or the remote principal of any pairing in the registry; revoked records still count, because the resolver ignores revoked ones at resolve time. A destination rule is keyed by the principal of a binding in this registry, since it names where the receiving identity's inbound goes, so remote paired principals are refused.
- **One representation per value.** Endpoint ids in a pairing are stored strictly increasing; public keys and signatures are canonical unpadded base64url of exactly 32 and 64 bytes (no padding, no malleable tail bits).
- **Endpoint ordering and signature.** Endpoint ids in a pairing are stored strictly increasing; `remote_invitation_sig` (which covers `remote_endpoint_ids`) must be signed over the sorted endpoint list.
- **Reader permissiveness vs integrity.** Principle: the reader is permissive on policy (expiry length stays unbounded; expiry policy is enforced by writers) and strict on integrity (one key per `peer_` id across live serverless bindings and live pairings; endpoint sharing only among pairings to the same remote principal).
- **No legacy break.** The validator still tolerates two unrevoked bindings of one principal, so an old v1 file with duplicates can be upgraded and then revoked; the D3 guard stays in the writer.
- **Writer (D1.1).** `updateIdentityRegistry` dispatches on the stored schema. `upgrade` is the only action that changes it: it needs a stored v1 registry (`upgrade_requires_registry`, `registry_already_v2`; both are checked before the sequence, so a retry after a successful upgrade learns why it cannot run again), a null subject, and a mutation equal to the pure conversion, which the action check recomputes and compares so nothing else can ride along. Its audit entry is `upgrade` with no subject or binding id, chained from the last v1 hash. On a stored v2 registry `bind` and `revoke` work for agent bindings with the D2 and D3 guards and leave pairings, aliases and destinations untouched; the reserved action names are refused with `action_not_available`, and so is any bind, rebind or revoke of a serverless binding, because those records belong to a later slice. A new registry is still created as v1 by `init`. Every other mutation that changes the schema is refused (`mutate_modified_schema`), checked on a snapshot of the mutate result and again on the validated output. The owner revoke flow (`triangle identity revoke`) needed no change: its adapter only sets `revoked_at` through this writer, so it now works on a v2 registry.

## 4. Compatibility and fail-closed behavior

| Reader | v1 file | v2 file |
| :--- | :--- | :--- |
| Today (v14 and older) | reads | refuses: `registry_corrupt` (reason `unknown_registry_key`, because v2 adds top-level keys and that check runs before the schema check; proven by a test against the frozen reader); snapshot `unreadable`; `agent_` sends get `route_unavailable` / `registry_unreadable`; exact ids keep routing; `doctor` shows the fault |
| D1 | reads (as v1; nothing added) | reads |
| Any future schema | refuses | refuses |

Writers: before the upgrade the D1 writer keeps writing v1; after it, only v2. Invariants that tests must pin:

1. A v1 registry gives the same resolver, router and status results under D1 code as under v14 code.
2. A v2 registry that holds only `mesh-managed` agent bindings gives those same results.
3. No other v2 record changes a send: `peer_` ids keep `peer_not_supported`; serverless bindings are skipped by the resolver filter; aliases and destinations are never consulted.
4. Anything unknown is refused, never best effort.

## 5. Upgrade, runtime floor, backup and restore

### 5.1 Command and gate

`triangle identity upgrade-registry --registry-root DIR [--confirm PLAN_ID]` (placement is decision D1-3). Without `--confirm` it prints a plan and writes nothing: current schema, sequence, binding count, audit head, the floor results, the backup path and what an older reader will do. Applying needs stdin and stdout to be terminals, the same gate as `identity migrate --confirm` and `grant-session-class` (D5-B). The upgrade grants no authority and creates no identity, which is why D5-B is proposed; D5-C keeps OS authentication for writes that grant or move authority (decision D1-6).

### 5.2 The floor

All of these must hold, each with its own refusal code, and nothing is written otherwise:

1. The registry reads, its chain verifies, it is v1 and has no unfinished write (`auditUncommittedTail` 0).
2. The live supervisor manifest is v14 or later (the reply-identity check, `local-messaging-cli.mjs:955`).
3. The **running** supervisor reports `router.registry.supportedSchemas` containing `identity_registry_v2` in `local_status`. This is a new additive field next to `state` and `sequence`; a supervisor from before D1 omits it, which reads as "cannot read v2". This is the real floor: it asks the process that will read the file, not a version number, and it also proves the new bundle was restarted into.

### 5.3 The step

Inside the registry lock: re-verify the chain; copy the registry file and the audit log to `identity/backup-v1-<timestamp>/` (mode 0700, files 0600, fsynced); then one `updateIdentityRegistry` call with action `upgrade`. The mutation converts each binding to v2 and adds the three empty collections, and the action check recomputes the conversion and compares it, so a mutation cannot smuggle other changes into an upgrade. `sequence` advances by one and the audit entry has no subject or binding id. A crash leaves either the v1 pair or the v2 pair (the existing append-then-rename order and fault hooks), plus a backup directory. Note: "leaves a readable v1 pair" holds only for D1+ readers; pre-D1 readers (such as d418fb1) throw `registry_chain_broken` / `invalid_audit_action` if an uncommitted `upgrade` tail entry is present. If rolled back to a pre-D1 supervisor after a crashed upgrade, the tail must be discarded or backup restored; D1.3 prints this repair.

### 5.4 The way back

`triangle identity restore-registry --registry-root DIR --from BACKUP [--confirm PLAN_ID]` copies a backup back under the lock. It refuses while the live registry holds v2-only data (a serverless binding, pairing, alias or destination) unless the owner passes `--discard-v2-data`, and its plan lists what would be lost. Anything done in v1 terms since the upgrade (a new bind or a revoke) is lost and must be redone. There is no in-place downgrade: a v1 reader rejects the `upgrade` entry in the chain (`:549`), and rewriting history would make the log non-append-only (decision D1-5).

## 6. Work breakdown

Each piece is its own PR. D1.0 to D1.2 touch the same file, so they stack and cannot be built in parallel; D1.3 (CLI package) can start once D1.1 has merged. Each code PR gets one independent read-only review (a model review is not a human or Codex review) with my own probes, and CLI pieces are verified from a built package in a no-write, no-network sandbox as #123 was.

| # | Piece | Content | Verified by |
| :--- | :--- | :--- | :--- |
| D1.0 | Schema and codec | `identity_registry_v2`, `local_profile_binding_v2`, pairing, alias and destination validators, caps, `SUPPORTED_REGISTRY_SCHEMAS`, a pure `upgradeRegistryV1ToV2`, canonical JSON. The reader accepts v1 and v2; the writer still writes v1 only. Inside `identity-registry.mjs` (no new module). | Table-driven validator tests for every field and constraint; property test (upgrade then validate, determinism, canonical stability); generated registries |
| D1.1 | Writer | `updateIdentityRegistry` dispatches on the stored schema; `upgrade` implemented; reserved actions and serverless `bind` refused; D2 and D3 kept and extended to `peer_` ids; audit continuity across the upgrade; fault hooks at every step | Fault injection at each hook; the 4-process stress test from #124 against v2; chain verification across the upgrade |
| D1.2 | Readers | Snapshot provider exposes `schema`; resolver keeps its `mesh-managed` filter (explicit test that a serverless binding never resolves) and `peer_` refusal; `local_status.router.registry` gains `schema` and `supportedSchemas`; `status`/`doctor` identity view prints the schema and collection counts (currently `identity-view.mjs:192-208` displays serverless bindings as `recorded_only` with a misleading `recorded_profile_missing` warning; pairings/aliases/destinations invisible); `identity inventory`/`migrate` treat serverless bindings and the new collections as untouched and never propose to edit them (`identity-mapping.mjs:313-324` currently proposes v1-shaped bindings); `identity revoke` keeps working for agent bindings (currently plans against v2 but prompts for OS authentication before `writer_requires_v1` refuses; fence should be lifted for revoke in D1.1 or checked at plan time). | Golden tests: identical resolver, router and status output for a v1 registry and its upgraded v2 form; revoke through the approval path on a v2 agent binding |
| D1.3 | Upgrade command, floor and restore | `upgrade-registry`, `restore-registry`, the floor probe, backups, help and runbook docs | Scratch-root tests; one refusal test per floor condition; **old-reader refusal test** that extracts today's reader with `git show d418fb1:...` (the pattern `r1-integration-v13` already uses; it needs a worktree, not a history-less archive) and runs it against a v2 file |
| D1.4 | Candidate and rehearsal | Candidate client package and supervisor bundle, scratch application root, disposable host; run the **installed v14 bundle's** reader against a scratch v2 registry to show the fail-closed behavior on real installed code | Evidence document |
| D1.5 | Installed acceptance | Section 7 with the owner's gates | Evidence document |

## 7. Release train, gates and rollback

**Shape.** Everything in D1.0 to D1.3 stays inside existing modules, so there is no manifest bump and no helper change, and the runtime installs as a supervisor-only restage like 2026-11-07's (scratch dry run, artifact diff, quiet gate, backups, automatic rollback). If review decides `identity-registry.mjs` (roughly 2250-2380 lines after D1.0) should be split, the new modules join the router artifact group and force manifest v15 with the helper release path (R1 plan 5.2 and 5.3); that is decision D1-1. The CLI part ships in the client package, whose install is the same owner decision that #154 to #159 (the owner approval and revoke command) are waiting on.

**Gates before merge.** The R1 plan 5.4 list: trust-boundary regression (the ACL and limit family, the router golden comparison, registry fail-closed cases), `keychain-launch-contract`, the full suite compared with the known baseline (the `ps` host-probe test fails on plain main in this environment; known timing flakes are rerun in isolation), the readiness check, a repository boundary check, and one independent review per code PR.

**Owner gates, each a separate yes.**

| Gate | Step | Live effect |
| :--- | :--- | :--- |
| G1 | Merge D1.0 to D1.3 | None |
| G2 | Install the D1 supervisor runtime (supervisor-only) | Reads v1 exactly as before; verify `router.registry` still `ok`/3, principal canaries and backlog counts unchanged |
| G3 | Install the client package with the new CLI | Adds `upgrade-registry` and `restore-registry` |
| G4 | Rehearse on a scratch copy of the registry | None |
| G5 | Upgrade the live registry from the owner's terminal | Registry becomes v2; verify the same principals resolve, `status` shows the schema, backup exists |

**Rollback.**

| Fault | Action |
| :--- | :--- |
| D1 runtime misbehaves before G5 | Restore the saved supervisor manifest and restart, as in the 2026-11-07 install records; the registry is untouched |
| After G5 the supervisor must go back to a bundle that cannot read v2 | Principals fail closed and exact ids keep routing; roll forward, or restore the backup (5.4) and then roll back |
| The upgrade fails midway | The registry is v1 or v2, never half (for D1+ readers; pre-D1 readers see `invalid_audit_action` if `upgrade` tail is present); the backup directory remains |

## 8. Verification and acceptance

- **Unit and property:** every validator row of 3.2 and 3.3; upgrade determinism and canonical stability; audit chain continuity across the upgrade; caps; every unknown-key, unknown-action and unknown-schema refusal.
- **Golden:** invariants 1 and 2 of section 4 for the resolver, router, `describeAddresses`, status and the identity view.
- **Fail-closed:** a frozen v14 reader against a v2 file (D1.3), and the installed v14 bundle against a scratch v2 registry (D1.4).
- **Concurrency and faults:** the writer fault hooks and the multi-process stress against both schemas; a reader racing the upgrade never sees a half state.
- **Installed acceptance (D1.5):** (1) after G2 the live v1 registry resolves exactly as before; (2) the scratch rehearsal passes; (3) after G5 the `gravity2` principal send works and the journal row is identical apart from timestamps; (4) negative set: unknown principal, a `peer_` id, a sender without permission; (5) restart preserves state; (6) backlog isolation: the 14 pending replies and 2 held tasks untouched; (7) the backup restores cleanly on a scratch root.
- **D1 is done when** the above passes on the installed system, the review findings are closed and the owner has accepted the evidence. It claims no remote capability.

## 9. Risks

| # | Risk | Handling |
| :--- | :--- | :--- |
| 1 | The registry is upgraded before a supervisor that can read it is running | Floor 5.2: refused unless the running process reports support; and older readers fail closed, loudly |
| 2 | The reserved shapes are wrong, which costs a v3 and another floor cycle | Review the shapes against the October designs before D1.0 merges; strict validators; shapes are validated but nothing produces them |
| 3 | The audit chain is unsigned, and an older snapshot of both files is not detected | Unchanged and recorded in R1 plan 3.7 and the identity design; D1 does not claim otherwise |
| 4 | A full audit log (8 MiB) makes the registry read-only; v2 adds record types | Add rotation or a larger cap before pairings are used at scale; not a D1 blocker, but record it |
| 5 | Two installed copies of the registry code (client package and supervisor bundle) drift | The floor asks the running supervisor; the CLI that performs the upgrade is new by construction; an older CLI copy meets a v2 file and fails closed |
| 6 | `identity-registry.mjs` grows past what review can hold | Decision D1-1 (split with a v15 bump) |
| 7 | Authority-granting writes of later slices need new approval kinds in the Swift provider (it knows `profile.move` and `profile.revoke` only) | Flagged as a dependency of those slices, not of D1 |
| 8 | Restoring a backup loses later work | Plan lists what is lost; refuses when v2-only data exists without an explicit flag |
| 9 | A same-user process can edit the registry | Accepted residual risk, as for v1; the file stays 0600 in a private directory with the existing custody checks |

## 10. Owner decisions

**Decision log**

- 2026-11-07, D1-1 to D1-7: the owner accepted the recommended option, A, on all seven ("Accept all" in chat). Together: v2 stays inside the existing modules with no manifest bump; the file keeps its v1 name; the upgrade and restore commands live in `triangle identity`; the whole designed set is frozen now; the way back is backup restore only; the upgrade is gated by a terminal plus plan id with an automatic backup; the new collections are capped at 256 each.
- These are design decisions, not authorization to build or install. D1.0 starts on a separate go-ahead, and every production step stays behind the gates G1 to G5 in section 7.

Options as proposed, with the chosen one marked:

1. **D1-1 Release shape.** **A (chosen):** keep v2 inside the existing modules, so D1 installs as a supervisor-only restage plus the client package, with no manifest bump and no helper change. **B:** split the v2 code into new modules (cleaner) and bump to v15 with the helper release path.
2. **D1-2 File name.** **A (chosen):** keep `identity-registry-v1.json` and put the v2 schema inside, so v1 readers refuse loudly. **B:** use `identity-registry-v2.json`, which leaves v1 readers seeing a stale file or none, silently.
3. **D1-3 Command home.** **A (chosen):** `triangle identity upgrade-registry` and `restore-registry` beside `inventory`, `migrate` and `revoke` (needs the client package install). **B:** `triangle-local` offline commands, installable with the supervisor like `grant-session-class`, at the price of splitting identity commands across two CLIs.
4. **D1-4 Reserved shapes.** **A (chosen):** freeze the whole designed set now (serverless binding fields, pairing, alias, destination, reserved audit actions) so Slice 3a and the alias and destination commands need no second floor cycle. **B:** ship agent bindings plus empty collections and add shapes as they are built, each one another schema version and floor event.
5. **D1-5 Way back.** **A (chosen):** backup restore only, with the loss rules of 5.4. **B:** also an in-place downgrade, which needs a separate audit stream or rewritten history; not recommended.
6. **D1-6 Gate for the upgrade.** **A (chosen):** terminal plus plan id (D5-B) with an automatic backup. **B:** OS authentication (D5-A), which needs a new action kind in the Swift provider and the owner's live acceptance, as class grants would have.
7. **D1-7 Caps.** **A (chosen):** 256 each for pairings, aliases and destinations; bindings stay at 1000. **B:** other values.

## 11. After D1

Not authorized by this plan, in dependency order: alias set and clear commands with `alias_unresolved` (U3 3.D.2); a destination-rule command (U3 3.F.3); Slice 3a of the identity design (`peer_` ids and keys, pairing, endpoint binding, the OS re-authentication feasibility check), which needs the new approval kinds; then `admitInbound`, hold-after-receipt and the Iroh and MESH adapters (U3 3.F.2, 3.F.4 to 3.F.7). None of them is started by D1.

## 12. Evidence and limits

Read at the baseline: the files cited above, the U3 delta in full, the identity design (4.1 to 4.4, 8, 11, 12), and the R1 plan (sections 4 to 9). Live checks on 2026-11-07: supervisor manifest v14, bundle `9034909d…`, router enabled, registry `ok` at sequence 3, 4 local branches and no open pull requests on the client repository. Not read or verified: the live registry's contents, whether the Swift provider validates the principal shape beyond what its two actions need, the MESH server, the Rust peer engine, and any installed behavior after this plan. No code was run for this document; the old-reader refusal claim in section 4 follows from the cited read path (`:1066-1068`, `recipient-resolver.mjs:105-118`) and is exactly what D1.3 and D1.4 must prove by running it.

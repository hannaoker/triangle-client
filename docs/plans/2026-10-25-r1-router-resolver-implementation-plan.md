# R1 implementation plan: router, resolver and the v13 release train

Status: plan, 2026-10-25. No code. It turns slice R1 of the item 6 design (`2026-10-25-unified-messaging-interface-design.md`, section 7) into buildable pieces, using the identity work now on main (#123 to #127). Facts marked "checked" were read in the code or on this Mac on 2026-10-25. The three owner decisions in section 9 are settled. Nothing here authorizes an install; the owner gates are in section 6.

## 1. What R1 is

R1 puts the first piece of the router into the supervisor: a resolver that understands a principal id (`agent_<32-hex>`) next to today's local ids, and result fields that name the route. Everything else about local messaging stays as it is: the ACL, the limits, the journal, the dispatcher and the wake adapters. For legacy `to` values (profile instance ids, `session-<hex>`, desktop and Grok addresses) the behavior and the error codes do not change.

Today the value is small: only `gravity2` is a configured runner recipient, and the mapping that gives it a principal is not applied yet. R1 matters because it is the first change that must ship inside a runtime bundle, and R2 to R5 build on it.

| In R1 | Not in R1 |
| :--- | :--- |
| Principal id resolution to a local recipient, through the identity registry | Alias or petname resolution (needs a registry extension; see decision 3) |
| Additive result fields: `route`, `state`, `target` on send and status; `route` on replies; `principal` on discovery | `via`, `deliverBy`, `waitMs`, tool description rewording (the last one needs a session reload) |
| A kill switch file, a `triangle-local setup-router` command and a `router` block in `local_status` | `admitInbound`, provenance, reply routes, destination rules, any remote adapter |
| Two nullable journal columns | Aggregated discover or system status views (R4) |
| Manifest v13, Swift launcher, installer and test updates; candidate build, rehearsal, installed acceptance | Remote installation, MESH, Iroh |

## 2. Starting point (checked)

- **One handler.** `send_message` in `local-messaging-server.mjs` runs validate, ACL, turn-claim recipient check, rate reservation, duplicate and loop depth, pair cap, `journal.recordSend`, limit commit, dispatcher and receipt in a single case. A recipient is keyed by its profile instance id: the directory entry is `{id: instanceId, label: profile}` and the ACL rules use the same ids. A registry binding is keyed by the same 64-hex instance id, so mapping a principal to a recipient needs no translation table.
- **Clients pass fields through.** The MCP adapter returns `{messageId, requestId, ...response}` and the CLI prints the response, and `to` has no pattern in the MCP schema (the server accepts the bounded identifier form). New result fields and principal ids therefore need no client change and no session reload.
- **Retries already behave.** `recordSend` compares a canonical envelope hash, so a retried `messageId` that resolves to a different recipient fails with the existing `duplicate_id_conflict`. Its INSERT names its columns, so an older module ignores extra nullable columns.
- **Registry read path.** `readIdentityRegistry` takes no lock and loads SQLite only for writes. It imports `identity-inventory.mjs` and `installation-inventory.mjs` for five small helpers (about 97 KB of source the supervisor does not otherwise load).
- **Live state.** Manifests are v12 (81 artifacts for the supervisor, 83 per worker kind). `triangle-mailbox` and `triangle-client` were rebuilt and hand-installed on 2026-10-24 for the v12 cut (#117), so `package-install.json` (0.2.0-onboarding.4) no longer matches their hashes. The local messaging config has one runner recipient (`gravity2`) plus Claude, three Grok bindings, the desktop inbox, discovery and session messaging. The identity registry does not exist yet.
- **Existing `route` field.** `local_status` already returns `route: "same-device"`. The new message-level field is `route: "local"` (as the R0 adapter reports) and the two are documented as different things.
- **Baseline.** The local messaging, supervisor, R0 conformance and Grok suites run 188 tests in about 5 seconds, all passing.

## 3. Design

### 3.1 Where the router sits

R1 does not restructure the single large RPC handler. A new `unified-router.mjs` is called twice from `local-messaging-server.mjs`: before the ACL, to turn `to` into a concrete local recipient id and metadata; and after the existing logic, to add fields to the response. The resolved id is what the ACL, the turn-claim check, the limiter, the journal and the dispatcher see, so the router can only add checks. R2 and R3 can move more logic behind the router later; R1 keeps the diff small and reviewable.

### 3.2 Resolver (`recipient-resolver.mjs`, pure)

The input is told apart by shape. Anything that is not a principal id goes to the existing path untouched.

| `to` | Outcome |
| :--- | :--- |
| Router disabled or not principal-shaped | Existing path, existing errors |
| `agent_<32-hex>` and no registry | `recipient_not_found`, reason `registry_absent` |
| `agent_<32-hex>` and the registry cannot be read | `route_unavailable`, reason `registry_unreadable`; legacy forms keep working |
| `agent_<32-hex>` with no unrevoked binding | `recipient_not_found` |
| One binding whose profile is not a configured local recipient | `route_unavailable`, reason `not_a_local_recipient` |
| One binding that is a configured recipient | Resolves to that instance id, then the existing ACL runs on it (`recipient_not_allowed` as today) |
| Several unrevoked bindings for one principal | `recipient_ambiguous`, listing only profile labels the sender may message |
| `peer_<32-hex>` | `recipient_not_found` (the registry holds no serverless bindings yet) |

Principal ids are not guessable, so telling "unknown principal" from "not allowed" is not a practical oracle. That changes when aliases arrive; revisit it then.

### 3.3 Registry snapshot (`router-registry-snapshot.mjs`)

A read-only provider that wraps `readIdentityRegistry` and indexes bindings by principal and by instance id. It re-reads when the registry file's stat (inode, size, mtime) changes or after 2 seconds, so a send never re-verifies the audit chain unless something changed. Failure rules: absent means principal forms fail with `registry_absent`; unreadable means principal forms fail closed and the last good snapshot is not served; legacy forms never depend on the registry. The registry root comes from `router.json` (`registryRoot`) and otherwise from the supervisor's state root (`client/local` is two levels below the application root, so the default is `<application root>/identity`, owner decision A4).

### 3.4 Result fields (all optional, so no reload)

```json
{ "accepted": true, "messageId": "...", "requestId": "...", "status": "queued_local", "isDuplicate": false,
  "route": "local", "state": "received",
  "target": { "via": "principal", "principal": "agent_...", "profile": "gravity2" } }
```

- `send_message` and `get_message_status` add `route`, `state` (R0's `localState` projection) and `target`. For a legacy `to` the router adds `target.via: "id"` and the principal if the recipient is bound.
- `list_replies` entries add `route: "local"`. `list_sessions` entries add `principal` (nullable). `discover_recipients` keeps its `recipients` array of ids and adds `entries` beside it, because changing the element type would not be additive.
- With the router disabled, responses are byte-identical to v12.

### 3.5 Journal

Two nullable columns on `local_messages`: `to_principal` and `resolved_via`, added with the existing `ALTER TABLE ... ADD COLUMN` presence-check pattern. A v12 module reads and writes a v13 journal without trouble (named columns), which is tested in both directions with the v12 module from git history. Nothing is backfilled.

### 3.6 Kill switch

`client/local/router.json`: `{"version": 1, "enabled": false, "registryRoot": "/abs"}`. It is a separate file read only by v13 code, not a new key in `local-messaging.json`: the v12 loader rejects unknown top-level keys, so a new key there would make a rollback to v12 disable local messaging. Absent or invalid means disabled (the invalid case is reported in `local_status.router.error`). `triangle-local setup-router --enable|--disable` writes it atomically with mode 0600, like `setup-inbox` and its neighbours. The file is checked per request through a stat cache, so disabling takes effect on the next send without a restart.

`local_status` gains `router: {enabled, registry: {state, sequence}, resolved: {principal, id}, errors}`, with counters in memory.

### 3.7 Security notes

- The registry is unsigned, so a process running as the same user that rewrites both registry files can redirect a principal to another profile. Such a process can already read the keys and the journal; this is recorded, not mitigated.
- The resolver adds no authority: the ACL and turn-claim checks run on the resolved id, and the rate limiter, pair cap and loop tracker see the resolved pair, so changing the form of `to` cannot bypass them.
- A registry problem never takes down legacy messaging.
- The mapping records disk observations, not verified authority (`disk_observation`), and R1 says so in its docs and status output.

## 4. Work breakdown

Each piece is its own PR. The first four are libraries that no installed module imports, so they cannot affect a bundle.

| # | Piece | Content | Built by | Verified by |
| :--- | :--- | :--- | :--- | :--- |
| R1.0 | Identity primitives | Extract `identity-primitives.mjs` (the id and origin patterns, `deriveClientInstanceId`, `isValidProfileName`, `isValidBareHttpsOrigin`); old modules re-export, so every existing import and test keeps working. The registry then imports only the leaf and `delivery-private-path.mjs`. | Claude | Existing identity suites unchanged; new test that the registry's import closure is exactly those files |
| R1.1 | Resolver | `recipient-resolver.mjs` and table-driven tests for every row of 3.2 | Gemini 3.8 Flash | Review plus probes (shapes, determinism, no mutation) |
| R1.2 | Snapshot provider | `router-registry-snapshot.mjs` with fs hooks for deterministic races | Gemini 3.8 Flash | Review plus a race probe like the registry's |
| R1.3 | Router core | `unified-router.mjs`: `resolveSend`, `decorateSend`, `decorateStatus`, `decorateReplies`, `decorateSessions`, counters; no server import | Claude | Unit tests with a fake server context |
| R1.4 | Integration and v13 | Server and host wiring, journal columns, `router.json`, `setup-router`, `local_status.router`, the manifest bump (section 5), docs | Claude, then an independent review | Section 7 |
| R1.5 | Candidate and rehearsal | Candidate build, scratch application root, disposable host, rollback rehearsal | Claude | Evidence document |
| R1.6 | Installed acceptance | Section 6, with the owner's gates | Claude and the owner | Evidence document |

## 5. The v13 release train

### 5.1 Why R1.3 and R1.4 cannot be split

The installed closure is every module reachable from the supervisor entry points. If the server imports `unified-router.mjs` while the manifest still lists v12 files, `prepare-runtime` from main stages a bundle that fails at runtime, and the closure tests go red. The rule is: no PR may make a manifest-listed module import a file the current manifest does not list. So the libraries merge first, and the PR that wires them in is also the PR that bumps the manifest.

### 5.2 What the bump touches

Taken from the bump part of the v12 cut (#117):

- `scripts/triangle-worker-install.py`: a `ROUTER_ARTIFACTS` group, `CURRENT_MANIFEST_VERSION = 13`, version 13 added to every version set in `expected_artifacts` (supervisor `{8..13}`, common `{4..13}`, and the others), and `extras += ROUTER_ARTIFACTS if version >= 13`.
- `packages/macos-mailbox-helper/Sources/TriangleMailboxCore/WorkerLauncher.swift`: the `(5...12)` and `(8...12)` ranges become 13, plus `if manifestVersion >= 13 { artifacts.formUnion([...]) }`.
- `Tests/TriangleMailboxTestSupport/WorkerLauncherContractCases.swift`: the version list and the fixture's artifact chains.
- `packages/agent-worker/src/installation-inventory.mjs`: 13 in `WORKER_MANIFEST_VERSIONS`.
- Tests: `keychain-launch-contract.test.mjs`, `supervisor-runtime-bundle.test.mjs`, `worker-bundle-closure.test.mjs`, `installation-inventory.test.mjs`.
- The new group (6 files): `unified-router.mjs`, `recipient-resolver.mjs`, `router-registry-snapshot.mjs`, `identity-registry.mjs`, `identity-primitives.mjs`, `transport-adapter-contract.mjs` (for `localState`). The supervisor kind goes from 81 to 87 artifacts and each worker kind from 83 to 89, and every kind gets a new content-addressed bundle. `local-adapter.mjs` stays out: it is the client-side R0 wrapper, not needed in the supervisor.

### 5.3 Compatibility and order

| Helper | Runtime manifest | Result |
| :--- | :--- | :--- |
| Old (accepts up to 12) | v12 | Works today |
| New (accepts 12 and 13) | v12 | Works; this is the state after install phase 1 |
| New | v13 | Works |
| Old | v13 | The launcher rejects the manifest and the supervisor does not start |

So the helper goes first and the v13 runtime second, never together. Rollback never needs to roll the helper back unless the helper itself is faulty, because the new helper still accepts v12.

### 5.4 Gates (from `release-workflow.md` and the helper upgrade release gate)

1. Trust-boundary change, so: ACL and limit regression (the 188-test family, the router's golden comparison with the router off), journal compatibility in both directions, and registry fail-closed cases.
2. `node --test packages/agent-worker/test/keychain-launch-contract.test.mjs` and `bash packages/macos-mailbox-helper/scripts/test-host.sh` (Swift 6.4 is installed).
3. `node scripts/run-all-tests.mjs` compared with the known baseline, not with zero (4 suites fail on main in this environment: `triangle-client-service` 1 test, and `a2a-gateway`, `agents/codex`, `agents/hermes` need workspace links). Known flakes are rerun in isolation, never skipped: the agent-worker timing tests (wake-scheduler, runner 100 ms, codex timeout cleanup) and the `triangle-cli` `recovery.test.mjs` lock test (kill its holder processes and rerun).
4. `./scripts/release/check-release-readiness.sh --mode docs`, then `--mode public --artifact <bin/triangle-mailbox> --artifact <bin/triangle-client>` on the rebuilt helper.
5. A repository boundary check and one independent security and reliability review of the R1.4 diff, with my own probes.

## 6. Install runbook (needs the owner)

Owner gates, each a separate yes: **G1** merge the PRs; **G2** install the helper (phase 1); **G3** stage v13 and restart (phase 2); **G4** enable the router (phase 3). Before G4 the owner also applies the identity mapping (`triangle identity migrate --client-root ... --confirm ...`, from a terminal), because the principal canaries need a real registry.

**Phase 0, snapshot (read-only).** Record the baseline: journal counts by phase through `sqlite3 -readonly` on `client/local/local-messaging.sqlite` (expect no queued or executing work; the last record had 36 completed, 14 pending replies and 2 held), wake idle, `local_status`, the four live manifests and bundle ids, hashes of `bin/triangle-mailbox`, `bin/triangle-client` and `bin/triangle-local`, and `client/local-messaging.json`. Copy the binaries, manifests, the plist and the config to `archive/r1-<date>/`. Do not touch `~/.codex` (the shared Codex app-server reads it).

**Phase 1, helper only (G2).** Build and install from a clean checkout of the merge commit with `scripts/install-macos-mailbox-helper.sh --install-client` (public ad-hoc signing, file custody, atomic replace, its own rollback if a step fails), then `codesign` strict verify and the `--mode public` readiness check. Restart the service behind a quiet gate. The v12 manifests are unchanged, so a good result here proves the new helper runs the current runtime. Record that `package-install.json` was already out of date for these two binaries.

**Phase 2, runtime (G3).** Stop the service and copy every `client/local/local-messaging*` file with its `-journal`, `-wal` and `-shm` siblings while it is stopped, because v13 migrates the journal. From the same checkout, stage the supervisor runtime with `/usr/bin/python3 scripts/triangle-worker-install.py stage-runtime --agent supervisor` (the node the live manifest records, a scratch dry run first, and keep its rollback record until the checks pass, then `commit-runtime`; `stage-runtime` overwrites the live manifest, it is not a dry run). Stage the worker kinds with `scripts/triangle-client-service.sh prepare-runtime`, which is transactional, rolls back on failure or interrupt, and stages the kinds whose CLI is installed. Run `validate-runtime` on each manifest. Start the service: it runs `triangle-mailbox preflight-supervisor`, refuses to restart while more than one supervisor process exists, and waits for its readiness gate. The router is still off. A `stop` that reports failure while `launchctl` shows the job gone is the known sticky-launchctl response from the v12 install, not a failure.

**Phase 3, enable (G4).** `triangle-local setup-router --enable`, then the canaries in section 7.

**Rollback, by phase.**

| Fault | Action | Restart |
| :--- | :--- | :--- |
| Router misbehaves | `triangle-local setup-router --disable` | No |
| v13 runtime misbehaves | Write the four saved v12 manifests back atomically (mode 0600); the old bundles are still on disk | Yes |
| Journal problem | Restore the stopped-journal copy, then the v12 manifests | Yes |
| Helper misbehaves | Restore the saved binaries, then the v12 manifests | Yes |

Afterwards write `releases/r1-install-verification.json` (hashes, bundle ids, counts, canary ids) and keep the snapshot directory.

## 7. Verification and acceptance

- **Unit and integration:** resolver (every row of 3.2), snapshot (stat change, TTL, unreadable, absent), router with the router off against v12 (golden responses for all legacy inputs and errors), principal send against the same send by instance id (identical journal row apart from `to_principal`), ACL and turn-claim denial on the resolved id, one limiter charge, duplicate retry, status, replies and discovery fields, journal compatibility with the v12 module in both directions.
- **Candidate and rehearsal (R1.5):** package built from main, manifest diff against v12 (exactly the 6 new files and the changed ones), scratch `--application-root` staging with `validate-runtime` for all four kinds, a disposable host run of the canaries below, and the rollback table rehearsed on the scratch root.
- **Installed acceptance (R1.6), recorded like #117:**
  1. Grok to the Codex bound conversation by the legacy id: unchanged result and automatic wake, now with `route`.
  2. A send to the `gravity2` principal from a sender that may message it: the worker runs, one journal row, `to_principal` set.
  3. Negative set: unknown principal, a sender without permission, a principal bound to a profile that is not a recipient, router disabled (same responses as v12).
  4. Registry corrupted on a copy or made unreadable: legacy sends still work, principal sends fail closed.
  5. Restart: ids and states preserved, an exact retry returns `isDuplicate: true`.
  6. Backlog isolation: no pre-existing row's `updated_at` changed, the 14 pending replies and 2 held tasks untouched.
  7. A live Claude retrieval, which #117 left unproved, if the owner picks a session.
- **R1 is done when** the above passes on the installed supervisor, the rollback was rehearsed, the review findings are closed, and the owner has accepted the evidence. Codex Desktop wake after sleep stays an open owner test.

## 8. Risks

| Risk | Handling |
| :--- | :--- |
| Main goes red or stages an incomplete bundle | The closure rule in 5.1; libraries first, one integration PR |
| A faulty router breaks live messaging | Ships dark; per-request kill switch; golden comparison with the router off |
| Rolling back leaves a config the old code rejects | `router.json` is a separate file; no new key in `local-messaging.json` |
| Helper and manifest versions out of step | Helper first, runtime second (5.3) |
| Journal migration | Two nullable columns, copy taken while stopped, tested against the v12 module both ways |
| `package-install.json` already stale | Phase 1 records it; reconcile through a proper package install after R1 settles |
| Principal addressing mistaken for verified identity | Status and docs say `disk_observation`; registry limits stated in 3.7 |
| Flaky tests hide a real failure | Known flakes are listed in the gates; rerun in isolation, never skip |
| Shared Mac | Nothing under `~/.codex`; no second daemon; owner gates before every production step |

## 9. Owner decisions

**Decision log**

- 2026-10-25, decision 1: owner chose A. R1 gets its own v13 install now; R3 and R5 bring v14 when they exist.
- 2026-10-25, decision 2: owner chose A. The router ships dark and is enabled for acceptance; the default flips to on in the next cut.
- 2026-10-25, decision 3: owner chose A. R1 handles principal ids only; aliases come with a registry extension before R3.
- All three are settled. The plan as a whole still awaits the owner's go-ahead to start building, and every production step stays behind the gates in section 6.

1. **Release shape.** Item 6 decision 4 chose one manifest bump for R1 to R5. R3 and R5 (Iroh and MESH adapters) are deferred by the 2026-10-23 priority update, and an explicit file list cannot name modules that do not exist yet, so a literal single bump would hold the first install until the remote slices exist. **A (chosen):** install v13 for R1 now, and let R3 and R5 bring v14 when they exist (each bump costs the section 5.2 changes and a helper install). **B:** keep R1 merged but uninstalled until R4 (read-only aggregated status) is done, so one local install carries R1 and R4. **C:** hold everything for R5.
2. **State after install.** **A (chosen):** the router ships dark and is enabled for acceptance; the default flips to on in the next cut, once the evidence is in. **B:** on from the first install, as item 6 section 7 says, with the kill switch as the safety.
3. **Aliases.** **A (chosen):** R1 handles principal ids only; petnames arrive with a registry extension (an `aliases` map, a set and clear command, an audit action) before R3, where guessable names matter. **B:** include the registry extension in R1, which adds a schema change and a command to the first install.

## 10. After R1

R2 (`admitInbound`, provenance columns, destination selection) needs the local session binding and reply routes from the identity design, which are not built. R4 needs only what exists now. R3 and R5 need the Iroh and MESH prerequisites listed in the item 6 design, section 9, and the owner's priority change for remote work.

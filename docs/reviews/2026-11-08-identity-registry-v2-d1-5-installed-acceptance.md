# Identity registry v2 (D1.5): installed acceptance, G2 to G4

- **Dates:** 2026-11-08 (Pacific); the install records are stamped 2026-11-09 UTC.
- **Plan:** `docs/plans/2026-11-07-identity-registry-v2-d1-plan.md`, piece D1.5 and the gates of section 7.
- **Status:** G2, G3 and G4 are done. **G5 (the upgrade of the live registry) has not been performed**: it is run from the owner's terminal and is described in section 5. This document is completed after it.
- **Evidence kept outside the repository:** the install records `releases/d1-g2-install-verification.json` and `releases/d1-g3-install-verification.json`, and the archives `archive/d1-g2-20261109T054623Z/`, `archive/d1-g2-20261109T054442Z/` (the aborted first attempt) and `archive/d1-g3-20261109T061059Z/`, all under the application root.

## 1. Gates

| Gate | Result |
| :--- | :--- |
| G1 merge D1.0 to D1.3 | done (#163 to #167); D1.4 merged as #168 |
| G2 supervisor restage | **installed** 2026-11-09 05:46Z, the owner's "Install it"; bundle `9034909d…` to `c01e78bb…` |
| G3 client package | **installed** 2026-11-09 06:11Z, the owner's choice of the full package and "Install it"; `0.2.0-identity.1` to `0.2.0-identity.2` |
| G4 rehearsal on a copy of the live registry | **done**, 29 of 29 steps (section 4) |
| G5 upgrade of the live registry | **not performed**; the owner's terminal (section 5) |

## 2. G2: the supervisor runtime that reads v2

Source `main` at `46c0923` (the merge of the D1.4 evidence). Supervisor-only restage by a guarded script modelled on the 2026-11-07 install: manifest v14 unchanged, node unchanged, 90 artifacts, exactly five changed (`identity-primitives`, `identity-registry`, `local-messaging-server`, `router-registry-snapshot`, `unified-router`). The staged bundle id equalled the one rehearsed in D1.4 (`c01e78bb…`). The worker manifests were not restaged (the live worker bundles already differed from the supervisor bundle in four files).

- **First attempt rolled itself back, correctly and cleanly.** At 05:44Z the script restarted onto the new bundle, then failed its own post-check because the journal `completed` count fell from 21 to 18. That fall is retention: the dispatcher calls journal `compact()` at start, which deletes finished records older than 8 days (`RETENTION_MS`) and never touches held, queued or executing records or unconsumed replies (`completed` had gone 79 to 21 over earlier restarts the same way). The rollback restored the manifest byte for byte and the old bundle. The check was my error (a line carried over from the previous install script); it now hard-checks held, queued, pending replies and executing, and only records `completed`.
- **Second attempt** (05:46Z) passed every check: `validate-runtime`; the launchd supervisor child runs the new bundle; held 2, queued 1, queued_local 1, pending replies 14, executing 0; router enabled; `router.registry` `ok` at sequence 3, schema `identity_registry_v1`, `supportedSchemas` `[v1, v2]`, `rootSha256` equal to the digest of `<app>/identity`; `triangle-local discover` entries (id, principal, state, route, send permission) identical before and after; registry files unchanged; configs and session grants byte-identical.
- **Not done:** no principal send canary (a send runs a worker).

## 3. G3: the full client package

Package `0.2.0-identity.2` (archive sha256 `ae7952edc939e33a808a17f1b29a96da279ccc5557d206d002778950bf33494f`, 156 files), built by `scripts/release/build-client-package.mjs` from a clean checkout of `main` at `46c0923`; the D1.4 rehearsal passes 28 of 28 against it. A plain build: no `--owner-approval` provider, so the revoke command arrives but fails closed.

- **Finding: the install receipt was stale.** `package-install.json` (`0.2.0-identity.1`, written by an "owner CLI only" flow that is not in the repository) listed seven owned files, and only `bin/triangle` matched its hash. Both helper binaries and their four install-manifest files had been replaced by the 2026-10-26/27 helper installs after the receipt's hashes were recorded. The standard installer therefore refuses to run ("Existing file is not an unchanged package-owned file"). This was proved in a scratch home on a replica of the installed state before any live step.
- **Reconciliation.** With the owner's "Install it", exactly those six receipt entries were set to their on-disk hashes, each only because the helper's own install record agreed (version 1, public ad-hoc signing, file custody, the same sha256 in the record and in its `.sha256` file). The installer then ran normally.
- **Result:** the receipt is `0.2.0-identity.2` with all seven owned hashes matching disk; the helper binaries are a rebuild of the same Swift source (`triangle-mailbox` `977c2709…` to `ddfa9661…`, `triangle-client` `62103933…` to `b5a7a897…`) and pass `codesign --verify --strict`; the release directory holds all 156 files; the older releases are untouched; the `~/.local/bin/triangle` symlink and the LaunchAgent plist are unchanged. The service was restarted under the quiet gate so the rebuilt helper is proven (wrapper pid now on the new helper, supervisor child still on `c01e78bb…`). The same invariants as G2 held; `discover` was identical; the installed `triangle` lists `identity upgrade-registry`, `restore-registry` and `revoke`, and its read-only plan against the live client root is `ready` with no refusals (registry v1, sequence 3, 3 bindings). No `identity-backups` directory exists.

## 4. G4: the rehearsal on a copy of the live registry

The two live registry files were copied (read only) into a private scratch directory and the D1.4 rehearsal was run on that copy: `rehearsal.mjs --registry-copy DIR`, with the post-G2 and post-G3 baselines given by `--baseline-manifest` (the manifest G2 saved) and `--baseline-release 0.2.0-identity.1` (so that the old supervisor and the old CLI are the ones meeting the v2 registry). Result: **29 of 29 steps pass** (`rehearsal-assets/results-g4-live-registry-copy.json`; identifiers of the registry are shortened to eight characters in that file, and the live registry's files are byte-identical before and after the run).

The copy: schema v1, sequence 3, three bindings (`ghost`, `gravity2`, `codex-headless`; all mesh-managed, generation 1, none revoked), audit `bind, bind, bind` with no `init` entry (the plan allows a first entry that is `init` or `bind`). The installed client has one local recipient, `gravity2`.

- **The upgrade converts the real data.** The plan was ready; the apply made a backup equal to the pre-upgrade bytes and a v2 registry at sequence 4 whose audit log is the three old entries plus `upgrade`. New step D2b: every one of the three bindings equals its v1 form plus the new schema name and a null public key, no revoke appeared or disappeared, and the new collections are empty.
- **Routing is the same before and after.** `gravity2` by principal and an exact-id send reach their runners on the candidate host after the upgrade; a principal send to each of the other two bindings (`ghost`, `codex-headless`, bound but not local recipients) is refused with `route_unavailable` and reaches no runner both before and after.
- **The installed code fails closed on the real v2 file** (reader, writer, a restarted host, a host running when the write lands, the old client CLI), and `restore-registry` puts the v1 pair back byte for byte, archives the v2 pair, and the running installed host recovers without a restart.
- **A harness finding:** the product's pair-exchange limit (10 exchanges per pair per 10 minutes, durable in the journal) stopped the first copy-mode run, because with one local recipient everything went to one pair. A single-recipient client now gets a second recipient without a binding (`scratch-b`) for the exact-id sends. This is the limiter doing its job, not a defect.

## 5. G5: the upgrade, from the owner's terminal (not yet performed)

The installed `triangle` is the new CLI and the supervisor reports v2 support for the registry it reads, so the floor passes (read-only plan: `ready`, no refusals). From the owner's terminal:

```bash
triangle identity upgrade-registry --client-root "$HOME/Library/Application Support/The Triangle/client"
triangle identity upgrade-registry --client-root "$HOME/Library/Application Support/The Triangle/client" --confirm PLAN_ID
```

The first command prints the plan and its id and writes nothing; the second applies it (it needs a terminal on both standard streams), makes the backup `identity-backups/backup-v1-<time>/` first and then upgrades. The way back, which a failed run also prints, is `triangle identity restore-registry --client-root … --from <that backup>`. After it, the checks are: `triangle-local status` shows the router registry as `ok`, sequence 4, schema `identity_registry_v2`; `triangle-local discover` entries are identical to before; the held, queued and pending-reply counts are unchanged; `triangle status --identity` shows the registry; and the owner's own principal checks (plan section 8, items 3 and 4) if wanted, which send real messages and run a worker.

## 6. Plan section 8, item by item

| Item | State |
| :--- | :--- |
| (1) after G2 the live v1 registry resolves exactly as before | done for what can be read without sending: `discover` entries and the router block unchanged; no live send |
| (2) the scratch rehearsal passes | done: D1.4 (28 of 28) and G4 on the copy (29 of 29) |
| (3) after G5 the `gravity2` principal send works and its journal row is identical apart from timestamps | pending G5; needs a live send (runs a worker), so the owner's yes; no tool compares journal rows yet |
| (4) negative set: unknown principal, a `peer_` id, a sender without permission | pending; not in the rehearsal runner |
| (5) restart preserves state | G2 and G3 restarts preserved the backlog and the router state; after G5 pending |
| (6) backlog isolation (14 pending replies, 2 held tasks) | unchanged through G2 and G3; after G5 pending |
| (7) the backup restores cleanly on a scratch root | done in G4 (F1, F2, F4) |

## 7. Limits

- The hosts of the rehearsal are the production host class with echo runners in plain processes; launchd, the Swift `run-supervisor` path and real runners are exercised only by the live G2 and G3 restarts, which show the supervisor starting and the invariants holding, not message flows through real runners.
- No live principal send has been made; the live evidence for routing is `discover`, the router block and the read-only plan.
- The copy was taken once, on 2026-11-08, and the live registry has not changed since (its file hashes are unchanged since 2026-10-31).
- G5 and items 3 to 6 after it are open.

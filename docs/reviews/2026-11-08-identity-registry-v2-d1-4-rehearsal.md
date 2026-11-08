# Identity registry v2 (D1.4): candidate build and scratch rehearsal

- **Date:** 2026-11-08
- **Candidate:** `main` at `58df2def45a0e1fadf5606b70abc93dc0b06e440` (the merge of D1.3, PR #167)
- **Plan:** `docs/plans/2026-11-07-identity-registry-v2-d1-plan.md`, piece D1.4 ("Candidate and rehearsal")
- **Result:** 28 of 28 rehearsal steps pass (`rehearsal-assets/results.json`, about 20 seconds)
- **Not done, on purpose:** G2 (supervisor install), G3 (client package install), G4 (rehearsal on a copy of the live registry) and G5 (the live upgrade). Nothing was installed, restarted or changed. The installed application root was fingerprinted before and after the run and is identical (step H1).

## 1. What this shows, in short

1. A **real candidate** was built and checked: the client package, built by `scripts/release/build-client-package.mjs` from `58df2de` (Swift helper compiled, ad-hoc signed, strict codesign verification passes), and a supervisor bundle staged from that package by its own installer.
2. A **scratch application root** ran both supervisors: the **installed** bundle (`9034909d…`, copied byte for byte from the live root, 90 artifacts checked against the live manifest) and the **candidate** bundle (`c01e78bb…`). Each ran the production host class with echo runners on a unix socket, and every check went through the installed `triangle-local` wrapper and the real CLIs, not through test seams.
3. The whole path works: the floor refuses the installed supervisor and passes the candidate; the upgrade makes a byte-checked backup and a v2 registry; principals and exact ids route the same before and after; the installed code **fails closed** on v2 (reader, writer, running host, restarted host, client CLI); `restore-registry` puts the v1 pair back and the installed host recovers, with or without a restart.
4. The rehearsal found **no defect in D1.0 to D1.3**. It found facts that change what the owner gates mean; they are in section 4, the first one being that **G3 as written understates what a client install does**.

## 2. Inputs

| Input | Value |
| :--- | :--- |
| Installed supervisor | manifest v14, bundle `9034909d37978c2602c8f519787cad92b0200dbe86ce195b8858a4e73b059ca1`, 90 artifacts, node sha256 `5d9d3872911e2340a43b707962e68143de8a4e8d54628845c0c4f2de1fb7cd5c` |
| Installed client package | `0.2.0-identity.1` (151 files) |
| Candidate package | `0.2.0-d14-rehearsal.1`, 156 files, `public_ad_hoc` signing, file custody, archive sha256 `a59520edbc6c83712a75f1aaf24825892aaa3b84584360915e1a5266de616716` |
| Candidate vs commit | all 151 tracked files in the package equal the blobs of `58df2de`; the other five are `worker-artifacts.json`, the node license and the three binaries |
| Candidate node | same sha256 as the installed bundle's node (so staging changes project artifacts only) |
| Candidate supervisor bundle | `c01e78bbf404c8690c956c7da9a8edd1ea63bd20342d354fe6ada14bfaf60e80`; staging, rolling back and staging again gave the same id. **The installer should report this id at G2 if the supervisor artifacts are unchanged since `58df2de`.** |

The archive hash belongs to this build. G3 builds its own package, and Swift output is not required to be byte-identical between builds.

## 3. How the rehearsal is built

`rehearsal-assets/rehearsal.mjs` drives everything; `host.mjs` runs under a bundle's own node and imports only from that bundle; `pty-run.py` gives a command a real terminal for the `--confirm` steps. The runner only **reads** the installed root (manifest, bundle, wrapper, client package code). It never opens the live journal or registry, uses no live credential, signals no live process and does not touch launchd.

Scratch layout, under a short temporary directory (a unix socket path may not exceed 100 bytes): `a/` is the application root (`bin/triangle-local`, `worker-runtime/` with the bundles and manifest, `client/` with the config and the state root `client/l/`, `identity/`, and later `identity-backups/`).

| Piece | Real | Stand-in |
| :--- | :--- | :--- |
| Installed supervisor code | the live bundle, copied and hash-verified; its own node | run as a plain process, not by launchd or the Swift helper |
| `triangle-local` | the installed wrapper, with its one root constant pointed at the scratch root | |
| Client config, router, v1 registry | created with the **installed** bundle's own `setupLocalMessaging`, `setupRouter` and registry writer | two synthetic profiles (`alpha`, `beta`), registry at sequence 3 |
| Host | `createInstalledLocalMessagingHost`, the class the production supervisor uses | echo runners instead of model runners; no wake, inbox or discovery |
| Candidate | the package's CLI, installer (`stage-runtime`, `validate-runtime`, `rollback-runtime`, `install-local-wrapper`) and staged bundle | |
| Terminal gate | a pseudo-terminal on stdin and stdout | not the owner's Terminal window |

## 4. Findings

1. **G3 is bigger than its row in the plan says.** The plan lists G3 as "adds `upgrade-registry` and `restore-registry`". A package built from `main` with a fresh Swift build differs from the installed `0.2.0-identity.1` in 19 files (5 added, 14 changed, 137 unchanged, none removed). Added: `identity-upgrade.mjs` (D1.3) and four modules of the owner-approval and revoke command (`identity-revoke.mjs`, `owner-approval.mjs`, `owner-approval-macos.mjs`, `owner-approval-registry.mjs`; that command is #154 to #159, still waiting on the owner). Changed: the two Swift binaries (rebuilt; their hashes differ from the installed helper's `977c2709…` and `62103933…`), `cli.mjs`, `doctor.mjs`, and ten `agent-worker` sources (the five of finding 2 plus `identity-mapping.mjs`, `identity-view.mjs`, `grok-local-session.mjs`, `local-messaging-cli.mjs` and `local-messaging-interactive-session.mjs`). The Swift package on `main` also differs from what the installed helper was built from by one change, #137's `WorkerLauncher.swift` (accepts manifest v14 and adds the reply-identity runtime floor): the helper was installed 2026-10-26 21:19 PDT and #137's commit is dated 21:56 PDT the same evening. The previous client install avoided a helper change: `0.2.0-identity.1` (source commit `77fcf89`) used the installed binaries as prebuilt inputs and recorded "owner CLI only; helper binaries and service unchanged" (`releases/owner-cli-identity-install-verification.json`). Options for the owner; this document does not choose: (a) install the full package, which swaps the helper and brings in the revoke command, the same decision #154 to #159 are waiting on; (b) repeat the `identity.1` way, building the package with the installed helper binaries as prebuilt inputs so that only JavaScript changes (the revoke command still arrives); (c) skip the client install and run the two commands from the checksum-verified extracted candidate package, as this rehearsal does (the floor needs only the installed `triangle-local`).
2. **G2 is a five-file supervisor restage.** The candidate supervisor differs from the installed bundle in `identity-primitives.mjs`, `identity-registry.mjs`, `local-messaging-server.mjs`, `router-registry-snapshot.mjs` and `unified-router.mjs`; no artifact is added or removed, the manifest stays v14 and the node is unchanged (as the plan expected: no manifest bump). The same five files are members of the codex, hermes and antigravity bundle lists. A supervisor-only restage leaves those worker bundles as they are, which is current practice: the live worker bundles already differ from the live supervisor bundle in four files, among them `local-messaging-server.mjs`. No file under `packages/agent-worker/runners/` names any of the five (a text search, not an import-graph proof).
3. **The installed client CLI cannot read v2, so G3 (or running the candidate CLI) has to come before G5.** Against the v2 registry, the installed `triangle identity migrate` ends in an uncaught `Error: registry_corrupt: unknown_registry_key` with a Node stack trace (exit 1, registry unchanged). `triangle status --identity` exits 0 and prints `Registry: unreadable · sequence 0` with an installation blocker labelled `registry_absent`, which is a misleading label from the old code. The plan's gate order (G3 before G5) already avoids this; the point is that after G5 the owner's day-to-day `status --identity` shows an unreadable registry until the CLI is updated.
4. **The installed supervisor fails closed on v2, as designed.** Both when restarted onto a v2 registry (step E2) and when a v2 write lands under a **running** process (step E4, a forced write that bypasses the floor): `local_status.router.registry` becomes `{state: "unreadable", sequence: 0}` with the router still enabled and no error field; a principal send exits 1 with `route_unavailable`; an exact-id send to a profile still reaches its runner; the same process keeps answering. The refused send's CLI state is labelled `send_outcome_unknown`, but a status lookup for that message id returns `not_found`, so nothing was admitted or queued. After `restore-registry` the running installed host reads v1 again at once, with no restart (step F4). The installed registry module itself reports `registry_corrupt: unknown_registry_key` for read and for write, and the write changes no byte (step E1).
5. **The floor works end to end.** Through the real wrapper, CLI and socket: the installed supervisor gives `supervisor_cannot_read_v2` and nothing is written, not even the backup directory (B3); the candidate passes (D1); a second registry directory in the same application root gives exactly `supervisor_reads_another_registry` (G2); a `router.json` without `registryRoot` reports the default directory and plans cleanly (D1b); the planned `--confirm` is refused without a terminal (exit 2) and with a wrong plan id (`plan_stale`, exit 2). `rootSha256` equals the sha256 of the registry directory path in every case, so the server-side and CLI-side formulas agree outside unit tests.
6. **Rollback at the runtime level is exact.** `rollback-runtime` restored the supervisor manifest **byte for byte** and removed the bundle that staging had created, twice (C3, E2), and the installed host then served again. A repeated stage reproduced the same bundle id. This is the rollback row of the plan's section 7 (restore the saved manifest and restart), on the real installer.
7. **What the rehearsal's own development caught** (harness faults, all fixed; none is a product defect): copied bundle directories need mode 0700 for the installer's checks; a first comparison of live processes included short-lived `watch-poll` helpers of the live system, so only the supervisor wrapper and its node child are compared now; the installed package's wrapper is `~/.local/bin/triangle`; and a second registry directory made with a plain copy had the wrong mode, which made one refusal assertion too loose, now exact.

## 5. Results by step

| Step | What it proves | Observed |
| :--- | :--- | :--- |
| A1 | installed state is v14 | manifest v14, 90 artifacts, client package `0.2.0-identity.1` |
| A2 | the copy is the installed bundle | 90 artifacts and the node match the live manifest; modes 0700/0600/0500 |
| A3 | the candidate is `58df2de` | 156 files; 151 equal committed blobs; node equals installed node; codesign strict passes |
| A4, A5 | what G2 and G3 would change | findings 1 and 2 |
| B1, B2 | baseline | v1 registry at sequence 3, 2 bindings; installed block `{state: ok, sequence: 3}` with **no** `schema`, `supportedSchemas` or `rootSha256`; principal and exact sends reach the runners |
| B3 | floor refuses the installed supervisor | `supervisor_cannot_read_v2`, exit 1; apply refused; registry and backups untouched |
| C1 | G2 transaction | `stage-runtime` and `validate-runtime` pass; exactly the five artifacts differ; node unchanged; rollback record written |
| C2 | candidate on the same v1 registry and journal | block `{ok, 3, identity_registry_v1, [v1, v2], rootSha256}`; sends work; the earlier message is still readable |
| C3 | G2 rollback | manifest byte-identical; candidate bundle removed; installed host serves; restage gives the same bundle id |
| D1, D1b | plan ready; default registry directory | floor passes (manifest v14; supervisor reports v1 and v2 and the right registry); the plan id changes from run to run (it covers the audit head, which carries timestamps); no backup directory made by planning |
| D2 | the upgrade | exit 0 with a terminal; backup `backup-v1-<time>` holds exactly the two files, equal to the pre-upgrade bytes, modes 0700/0600; registry v2, sequence 4, audit `init, bind, bind, upgrade` |
| D3, D4 | after the upgrade | block `{ok, 4, identity_registry_v2}`; principals `alpha`, `beta` and the exact id route as before; a second plan says `registry_already_v2`; restart keeps v2 |
| E1 to E3 | installed code against v2 | findings 3 and 4 |
| F1 to F3 | restore | relation `ahead`, discarded entry: the `upgrade`, no routing change, no v2-only data; live files equal the backup, the v2 pair is archived; the installed host recovers without restart, and again after one |
| E4, F4 | running installed host | finding 4 |
| G1 | the G3-style wrapper | a wrapper installed by the candidate installer, a committed restage, and the plan still passes the floor |
| G2 | negatives | finding 5 |
| G3 | the package's own installer | installed into a scratch home through its `--test-root` mode; the installed `triangle` lists both commands and its plan is ready |
| H1 | the installed root is untouched | 8 hashed files, 3 registry entries (stat only), bundle and release listings, supervisor wrapper and node processes: identical |

`results.json` holds the full recorded values, including the restore plan, the floor structure and the refusal messages.

## 6. Limits

- The host is `createInstalledLocalMessagingHost` with echo runners in a plain process. The launchd path, the Swift helper's `run-supervisor`, real model runners, wake, inbox and discovery are not exercised.
- The registry is synthetic (two profiles). The live registry's contents have still not been read; G4 repeats this on a copy of it, and the runner would need a small change to accept one (not made here).
- The package install (G3 variant) is a fresh install into an empty scratch home. The upgrade over `0.2.0-identity.1` with its ownership receipt is covered by `tests/client-package.test.mjs`, not by this run, because the old archive is not available.
- The terminal is a pseudo-terminal. It satisfies the code's `isTTY` test; it is not the owner's Terminal.
- The unreadable-registry behaviour of the installed supervisor is shown for a supervisor with no other work in flight. Backlog isolation (the 14 pending replies and 2 held tasks) is a D1.5 check on the live system.
- The Swift difference between the installed helper and `main` (one change, #137) was read from the repository, not run, and the installed helper's own source commit is not recorded; its age relative to #137 is taken from the install time and the commit date.
- This rehearsal is evidence about `58df2de`. A later change to a supervisor artifact or to the CLI needs the rehearsal again.

## 7. Rerunning it

```bash
node scripts/release/build-client-package.mjs --version 0.2.0-d14-rehearsal.1 --output /path/to/package-out
node docs/reviews/2026-11-08-identity-registry-v2-d1-4-rehearsal-assets/rehearsal.mjs \
  --candidate-archive /path/to/package-out/triangle-client-0.2.0-d14-rehearsal.1-darwin-arm64.tar.gz \
  --source-commit 58df2def45a0e1fadf5606b70abc93dc0b06e440 --out /path/to/results-dir
```

The installer script `triangle-install-0.2.0-d14-rehearsal.1.sh` must sit beside the archive (the build leaves it there). `--keep` leaves the scratch root for inspection; `--installed-app-root` defaults to `~/Library/Application Support/The Triangle`. The rehearsal needs Node 22 and macOS, and exits non-zero on the first failing step. `packages/agent-worker/test/rehearsal-tooling.test.mjs` keeps the helper scripts working against the code they import.

## 8. State of the gates

| Gate | State |
| :--- | :--- |
| G1 merge D1.0 to D1.3 | done (#163 to #167) |
| D1.4 candidate and rehearsal | this document |
| G2 install the supervisor restage | not started; needs the owner's yes; expected bundle `c01e78bb…` |
| G3 client package | not started; **needs the owner's choice among the options in finding 1** |
| G4 rehearsal on a copy of the live registry | not started; needs the owner's yes and a small runner change |
| G5 upgrade of the live registry | not started; needs the owner's terminal |

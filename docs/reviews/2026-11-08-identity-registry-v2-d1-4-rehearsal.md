# Identity registry v2 (D1.4): candidate build and scratch rehearsal

- **Date:** 2026-11-08
- **Candidate:** `main` at `58df2def45a0e1fadf5606b70abc93dc0b06e440` (the merge of D1.3, PR #167)
- **Plan:** `docs/plans/2026-11-07-identity-registry-v2-d1-plan.md`, piece D1.4 ("Candidate and rehearsal")
- **Result:** 28 of 28 rehearsal steps pass (`rehearsal-assets/results.json`, about 20 seconds)
- **Not done, on purpose:** G2 (supervisor install), G3 (client package install), G4 (rehearsal on a copy of the live registry) and G5 (the live upgrade). Nothing was installed, restarted or changed. The installed application root was fingerprinted before and after the run and is identical (step H1).

## 1. What this shows, in short

1. A **real candidate** was built and checked: the client package, built by `scripts/release/build-client-package.mjs` from `58df2de` (Swift helper compiled, ad-hoc signed, strict codesign verification passes), and a supervisor bundle staged from that package by its own installer.
2. A **scratch application root** ran both supervisors: the **installed** bundle (`9034909d…`, copied byte for byte from the live root, 90 artifacts checked against the live manifest) and the **candidate** bundle (`c01e78bb…`). Each ran the production host class with echo runners on a unix socket, and the status and send checks go through the installed `triangle-local` wrapper and the registry commands through the real CLIs, not through test seams; only the direct reads and writes of a bundle's registry module (E1, and E4's forced write) call that module, through a helper that imports from the bundle alone.
3. The whole path works: the floor refuses the installed supervisor and passes the candidate; the upgrade makes a byte-checked backup and a v2 registry; principals and exact ids route the same before and after; the installed code **fails closed** on v2 (reader, writer, running host, restarted host, client CLI); `restore-registry` puts the v1 pair back and the installed host recovers, with or without a restart.
4. The rehearsal found **no defect in D1.0 to D1.3** and one behaviour worth the owner's decision (finding 8). It found facts that change what the owner gates mean; they are in section 4, the first one being that **G3 as written understates what a client install does**.

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

`rehearsal-assets/rehearsal.mjs` drives everything; `host.mjs` runs under a bundle's own node and imports only from that bundle; `pty-run.py` gives a command a real terminal for the `--confirm` steps. The runner only **reads** the installed root: the supervisor and worker manifests, the baseline bundle (copied), the `triangle-local` and `triangle` wrappers, `package-install.json`, the client package's code and package manifest, the stat data of `identity/`, `client/local-messaging.json` and `client/local/router.json`, the bundle and release listings, and the process list. It never opens the live journal or registry, uses no live credential, signals no live process and does not touch launchd. Everything it starts runs with HOME and TMPDIR inside the scratch root; the one thing outside is the package installer's own verification directory, `/private/tmp/triangle-package-verify.*`, which its exit trap removes.

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

1. **G3 is bigger than its row in the plan says.** The plan lists G3 as "adds `upgrade-registry` and `restore-registry`". A package built from `main` differs from the installed `0.2.0-identity.1` in 19 files (5 added, 14 changed, 137 unchanged, none removed). Added: `identity-upgrade.mjs` (D1.3) and four modules of the owner-approval and revoke command (`identity-revoke.mjs`, `owner-approval.mjs`, `owner-approval-macos.mjs`, `owner-approval-registry.mjs`; the PRs of that command, #154 to #159, are merged and its install waits on the owner). Changed: the two Swift binaries, `cli.mjs`, `doctor.mjs`, and ten `agent-worker` sources (the five of finding 2 plus `identity-mapping.mjs`, `identity-view.mjs`, `grok-local-session.mjs`, `local-messaging-cli.mjs` and `local-messaging-interactive-session.mjs`). **The Swift sources are not what changed.** The installed helper was built from `98be801` (`releases/r2-install-verification.json`, `independentReview.codeCommit`; `docs/handoffs/2026-10-26-r2-installed-disabled.md`: "native helper code is unchanged from reviewed `98be801`") and installed 2026-10-26 21:19 PDT, and the Swift package on `main` is identical to it (`git diff 98be801 58df2de -- packages/macos-mailbox-helper` is empty; #137's merge commit `b1c8946`, 21:56 PDT, merged work that was already in `98be801`). The two binaries differ because they were rebuilt: new hashes (installed: `977c2709…` and `62103933…`) and a new ad-hoc signature from the same source. The previous client install (`0.2.0-identity.1`, source commit `77fcf89`) kept the installed binaries by using them as prebuilt inputs, and recorded "owner CLI only; helper binaries and service unchanged" (`releases/owner-cli-identity-install-verification.json`). Options for the owner; this document does not choose: (a) install the full package, which replaces the helper binaries with a rebuild of the same source and brings in the revoke command, the same decision #154 to #159 are waiting on; (b) repeat the `identity.1` way, building the package with the installed helper binaries as prebuilt inputs so that only JavaScript changes (the revoke command still arrives); (c) skip the client install and run the two commands from the checksum-verified extracted candidate package, as this rehearsal does (the floor needs only the installed `triangle-local`). The candidate installer's frozen `triangle-local` is byte-identical to the installed one apart from the root path (step G1), so a wrapper refresh changes nothing.
2. **G2 is a five-file supervisor restage.** The candidate supervisor differs from the installed bundle in `identity-primitives.mjs`, `identity-registry.mjs`, `local-messaging-server.mjs`, `router-registry-snapshot.mjs` and `unified-router.mjs`; no artifact is added or removed, the manifest stays v14 and the node is unchanged (as the plan expected: no manifest bump). The same five files are members of the codex, hermes and antigravity bundle lists. A supervisor-only restage leaves those worker bundles as they are, which is current practice: the live worker bundles already differ from the live supervisor bundle in four files, among them `local-messaging-server.mjs`. No file under `packages/agent-worker/runners/` names any of the five (a text search, not an import-graph proof).
3. **The installed client CLI cannot read v2, so G3 (or running the candidate CLI) has to come before G5.** Against the v2 registry, the installed `triangle identity migrate` ends in an uncaught `Error: registry_corrupt: unknown_registry_key` with a Node stack trace (exit 1, registry unchanged). `triangle status --identity` exits 0 and prints `Registry: unreadable · sequence 0` with an installation blocker labelled `registry_absent`, which is a misleading label from the old code. The plan's gate order (G3 before G5) already avoids this; the point is that after G5 the owner's day-to-day `status --identity` shows an unreadable registry until the CLI is updated.
4. **The installed supervisor fails closed on v2, as designed.** Both when restarted onto a v2 registry (step E2) and when a v2 write lands under a **running** process (step E4, a forced write that bypasses the floor): `local_status.router.registry` becomes `{state: "unreadable", sequence: 0}` with the router still enabled and no error field; a principal send exits 1 with `route_unavailable`; an exact-id send to a profile still reaches its runner; the same process keeps answering. The refused send's CLI state is labelled `send_outcome_unknown`, but a status lookup for that message id returns `not_found`, so nothing was admitted or queued. After `restore-registry` the running installed host reads v1 again at once, with no restart (step F4). The installed registry module itself reports `registry_corrupt: unknown_registry_key` for read and for write, and the write changes no byte (step E1).
5. **The floor works end to end.** Through the real wrapper, CLI and socket: the installed supervisor gives `supervisor_cannot_read_v2` and nothing is written, not even the backup directory (B3); the candidate passes (D1); a second registry directory in the same application root gives exactly `supervisor_reads_another_registry` (G2); a `router.json` without `registryRoot` reports the default directory and plans cleanly (D1b); the planned `--confirm` is refused without a terminal (exit 2) and with a wrong plan id (`plan_stale`, exit 2). `rootSha256` equals the sha256 of the registry directory path in every case, so the server-side and CLI-side formulas agree outside unit tests.
6. **Rollback at the runtime level is exact.** `rollback-runtime` restored the supervisor manifest **byte for byte** and removed the bundle that staging had created, twice (C3, E2), and the installed host then served again. A repeated stage reproduced the same bundle id. This is the rollback row of the plan's section 7 (restore the saved manifest and restart), on the real installer.
7. **What the rehearsal's own development caught** (harness faults, all fixed; none is a product defect): copied bundle directories need mode 0700 for the installer's checks; a first comparison of live processes included short-lived `watch-poll` helpers of the live system, so only the supervisor wrapper and its node child are compared now; the installed package's wrapper is `~/.local/bin/triangle`; and a second registry directory made with a plain copy had the wrong mode, which made one refusal assertion too loose, now exact.
8. **`upgrade-registry` exits 0 when the registry is already v2, even if the running supervisor cannot read v2.** In the state of step E2 the plan lists `registry_already_v2` and `supervisor_cannot_read_v2` and exits 0, because "nothing to do" is true of the registry. A check after a G2 rollback that trusts the exit status reads that as fine while principal sends are failing closed; read the refusals instead (the runbook now says so). Whether the command should exit 1 in that combination is a D1.3 behaviour question left to the owner; this PR does not change the command.

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
| G1 | the G3-style wrapper | the candidate installer replaces a deliberately marked wrapper with its frozen copy (byte-identical to the installed wrapper apart from the root: the installer source has not changed since that wrapper was written), a committed restage, and the plan still passes the floor |
| G2 | negatives | finding 5 |
| G3 | the package's own installer | installed into a scratch home through its `--test-root` mode; the installed `triangle` lists both commands and its plan is ready |
| H1 | the installed root is untouched, as far as it is compared | 10 hashed files (four manifests, the two wrappers, both helper binaries, the package receipt and the release manifest), stat data with ctime for the 3 registry entries and the two client files, a digest over the 101 entries of the baseline bundle's tree, bundle and release listings, no `identity-backups` directory, and the supervisor wrapper and node process: identical. The journal, credentials and other client files are not compared. The comparison also runs, and fails the verdict, when an earlier step fails |

`results.json` holds the full recorded values, including the restore plan, the floor structure and the refusal messages.

## 6. Limits

- The host is `createInstalledLocalMessagingHost` with echo runners in a plain process. The launchd path, the Swift helper's `run-supervisor`, real model runners, wake, inbox and discovery are not exercised.
- The registry is synthetic (two profiles). The live registry's contents have still not been read; G4 repeats this on a copy of it, and the runner would need a small change to accept one (not made here).
- The package install (G3 variant) is a fresh install into an empty scratch home. An upgrade of one packaged version over another's ownership receipt is not exercised by this run (the old archive is not available), and I found no test of it: `tests/client-package.test.mjs` covers fresh and repeated installs and a legacy-install upgrade.
- The terminal is a pseudo-terminal. It satisfies the code's `isTTY` test; it is not the owner's Terminal.
- The unreadable-registry behaviour of the installed supervisor is shown for a supervisor with no other work in flight. Backlog isolation (the 14 pending replies and 2 held tasks) is a D1.5 check on the live system.
- Whether a Swift build is byte-reproducible, and whether a rebuilt helper's new hash or ad-hoc signature matters to anything (for example the `protectedHashes` of earlier install records), was not tested.
- This rehearsal is evidence about `58df2de`. A later change to a supervisor artifact or to the CLI needs the rehearsal again.
- After G2 the live supervisor manifest is the candidate's. The runner then needs `--baseline-manifest` (section 7).

## 7. Rerunning it

```bash
node scripts/release/build-client-package.mjs --version 0.2.0-d14-rehearsal.1 --output /path/to/package-out
node docs/reviews/2026-11-08-identity-registry-v2-d1-4-rehearsal-assets/rehearsal.mjs \
  --candidate-archive /path/to/package-out/triangle-client-0.2.0-d14-rehearsal.1-darwin-arm64.tar.gz \
  --source-commit 58df2def45a0e1fadf5606b70abc93dc0b06e440 --out /path/to/results-dir
```

The installer script `triangle-install-0.2.0-d14-rehearsal.1.sh` must sit beside the archive (the build leaves it there). `--keep` leaves the scratch root for inspection; `--installed-app-root` defaults to `~/Library/Application Support/The Triangle`. `--baseline-manifest FILE` names the supervisor manifest to treat as "installed" (default: the live one); after G2 pass the manifest the install saved under `archive/`, whose old bundle still sits in `worker-runtime/bundles`. The rehearsal needs Node 22 and macOS, and exits non-zero on the first failing step. `packages/agent-worker/test/rehearsal-tooling.test.mjs` keeps the helper scripts working against the code they import.

## 8. State of the gates

| Gate | State |
| :--- | :--- |
| G1 merge D1.0 to D1.3 | done (#163 to #167) |
| D1.4 candidate and rehearsal | this document |
| G2 install the supervisor restage | not started; needs the owner's yes; expected bundle `c01e78bb…` |
| G3 client package | not started; **needs the owner's choice among the options in finding 1** |
| G4 rehearsal on a copy of the live registry | not started; needs the owner's yes and a runner change (section 9) |
| G5 upgrade of the live registry | not started; needs the owner's terminal |

## 9. What D1.5 and G4 still need

- **A baseline that survives G2.** The runner's "installed" side is the supervisor in the live manifest. Before G2 that is the rehearsed baseline; after G2 it is the candidate's. D1.5 item (2), "the scratch rehearsal passes", therefore means this run's recorded result, or a rerun with `--baseline-manifest` pointing at the manifest the install saves.
- **Routing negatives** (plan section 8, item 4: an unknown principal, a `peer_` id, a sender without permission) are not in the runner.
- **A journal-row comparison** for item 3 ("identical apart from timestamps") does not exist; the runner never opens a journal.
- **A restore of a backup that lives outside the scratch root**, item 7, is not exercised: the runner restores its own backup.
- **The scratch client has two synthetic profiles** with no grok, interactive-session, inbox or reply-identity configuration. Whether the live system has these was not checked.
- **G4 is more than a small change.** B1, B2, C2, D2 and D3 hard-code the synthetic registry's facts (sequence 3, two bindings, profiles `alpha` and `beta`, an audit log of four entries); they must take them from the copy of the live registry.

## 10. Independent review

A read-only Opus model review (a model review, not a human or Codex review) of commits `a500722`, `27da360` and `8be8718`. It read the runner end to end, ran it 13 times unmodified (once alone, then four and eight in parallel), once against a read-only fake installed root and 19 times in mutated copies, and recomputed the document's numbers. It found no way for the runner to write to the installed root; its own snapshot of that root (with ctime and a tree hash) was identical across all runs. Findings: one High (the helper-provenance claim in finding 1 was wrong; corrected above and checked against the R2 install record and git), two Medium (a host dying after its ready line made a failed run exit 0 with no results and a left-over scratch root; the runner could not pass once G2 is installed, now `--baseline-manifest`), ten Low and fourteen nits (assertions looser than this document's claims, an isolation check that ran only when every step passed and compared less than its title said, a smoke test that failed under a long `TMPDIR`, wording that overclaimed). All were fixed except one Low that concerns D1.3 behaviour (finding 8) and the D1.5 gaps (section 9), which are stated rather than fixed. The fixes were checked by rerunning the rehearsal (28 of 28), the smoke tests (4 of 4, also with a long `TMPDIR`) and a mutated copy whose host dies after its ready line (now exit 1, results written, nothing left behind); they were not re-reviewed.

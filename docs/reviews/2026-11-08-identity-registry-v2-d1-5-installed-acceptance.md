# Identity registry v2 (D1.5): installed acceptance, G2 to G5

- **Dates:** 2026-11-08 (Pacific); the install records are stamped 2026-11-09 UTC.
- **Plan:** `docs/plans/2026-11-07-identity-registry-v2-d1-plan.md`, piece D1.5 and the gates of section 7.
- **Status:** G2 to G5 are done: **the live registry is v2** (sequence 4), upgraded by the owner from their own terminal and verified read only (section 5). The negative set (plan section 8, item 4) was run on the live system afterwards (section 5); items 3 and 5 (a live principal send, a restart after G5) were not run (section 6).
- **Evidence kept outside the repository:** the install records `releases/d1-g2-install-verification.json` and `releases/d1-g3-install-verification.json`, and the archives `archive/d1-g2-20261109T054623Z/`, `archive/d1-g2-20261109T054442Z/` (the aborted first attempt) and `archive/d1-g3-20261109T061059Z/`, all under the application root.

## 1. Gates

| Gate | Result |
| :--- | :--- |
| G1 merge D1.0 to D1.3 | done (#163 to #167); D1.4 merged as #168 |
| G2 supervisor restage | **installed** 2026-11-09 05:46Z, the owner's "Install it"; bundle `9034909d…` to `c01e78bb…` |
| G3 client package | **installed** 2026-11-09 06:11Z, the owner's choice of the full package and "Install it"; `0.2.0-identity.1` to `0.2.0-identity.2` |
| G4 rehearsal on a copy of the live registry | **done**, 29 of 29 steps (section 4) |
| G5 upgrade of the live registry | **done** 2026-11-09 07:00:56Z (23:00 Pacific, 2026-11-08) by the owner from their terminal; verified read only, 11 of 11 checks (section 5) |

## 2. G2: the supervisor runtime that reads v2

Source `main` at `46c0923` (the merge of the D1.4 evidence). Supervisor-only restage by a guarded script modelled on the 2026-11-07 install: manifest v14 unchanged, node unchanged, 90 artifacts, exactly five changed (`identity-primitives`, `identity-registry`, `local-messaging-server`, `router-registry-snapshot`, `unified-router`). The staged bundle id equalled the one rehearsed in D1.4 (`c01e78bb…`). The worker manifests were not restaged (the live worker bundles already differed from the supervisor bundle in four files).

- **First attempt rolled itself back, correctly and cleanly.** At 05:44Z the script restarted onto the new bundle, then failed its own post-check because the journal `completed` count fell from 21 to 18. That fall is retention: the journal's `compact()` deletes finished records older than 8 days (`RETENTION_MS`) that nothing references, and never touches held, queued or executing records or unconsumed replies. The dispatcher runs it when it starts and, at most hourly, when work is enqueued, so "at start" is likely for this case but not proven. `completed` had gone 79 (2026-10-31) to 19 (2026-11-07 18:16Z), up to 21 through new traffic, then 21 to 18 at G2. The rollback restored the manifest byte for byte and the old bundle. The check was my error (a line carried over from the previous install script); it now hard-checks held, queued, pending replies and executing, and only records `completed`.
- **Second attempt** (05:46Z) passed every check: `validate-runtime`; the launchd supervisor child runs the new bundle; held 2, queued 1, queued_local 1, pending replies 14, executing 0; router enabled; `router.registry` `ok` at sequence 3, schema `identity_registry_v1`, `supportedSchemas` `[v1, v2]`, `rootSha256` equal to the digest of `<app>/identity`; `triangle-local discover` entries (id, principal, state, route, send permission) identical before and after; registry files unchanged; configs and session grants byte-identical.
- **Not done:** no principal send canary (a send runs a worker).

## 3. G3: the full client package

Package `0.2.0-identity.2` (archive sha256 `ae7952edc939e33a808a17f1b29a96da279ccc5557d206d002778950bf33494f`, 156 files), built by `scripts/release/build-client-package.mjs` from a clean checkout of `main` at `46c0923`; the D1.4 rehearsal passes 28 of 28 against it. A plain build: no `--owner-approval` provider, so the revoke command arrives but fails closed.

- **Finding: the install receipt was stale.** `package-install.json` (`0.2.0-identity.1`, written by an "owner CLI only" flow that is not in the repository) listed seven owned files, and only `bin/triangle` matched its hash. Both helper binaries and their four install-manifest files had been replaced by the 2026-10-26/27 helper installs, but that flow wrote the receipt on 2026-10-31 with the older helper hashes carried over from the previous package receipt, although its own record lists the on-disk helper hashes as protected. So the receipt was not overtaken by later installs: the flow wrote stale entries, and it will do so again if it is used again (follow-up below). The standard installer therefore refuses to run ("Existing file is not an unchanged package-owned file"). This was proved in a scratch home on a replica of the installed state before any live step.
- **Reconciliation.** With the owner's "Install it", exactly those six receipt entries were set to their on-disk hashes, each only because the helper's own install record agreed (version 1, public ad-hoc signing, file custody, the same sha256 in the record and in its `.sha256` file; the record's signing identifier was not part of the check). The installer then ran normally.
- **Result:** the receipt is `0.2.0-identity.2` with all seven owned hashes matching disk; the helper binaries are a rebuild of the same Swift source (`triangle-mailbox` `977c2709…` to `ddfa9661…`, `triangle-client` `62103933…` to `b5a7a897…`) and pass `codesign --verify --strict`; the release directory holds all 156 files; the older releases are untouched; the `~/.local/bin/triangle` symlink and the LaunchAgent plist are unchanged. The service was restarted under the quiet gate so the rebuilt helper is proven (wrapper pid now on the new helper, supervisor child still on `c01e78bb…`). The same invariants as G2 held; `discover` was identical; the installed `triangle` lists `identity upgrade-registry`, `restore-registry` and `revoke`, and its read-only plan against the live client root is `ready` with no refusals (registry v1, sequence 3, 3 bindings). No `identity-backups` directory exists.

## 4. G4: the rehearsal on a copy of the live registry

The two live registry files were copied (read only) into a private scratch directory and the D1.4 rehearsal was run on that copy: `rehearsal.mjs --registry-copy DIR`, with the post-G2 and post-G3 baselines given by `--baseline-manifest` (the manifest G2 saved) and `--baseline-release 0.2.0-identity.1` (so that the old supervisor and the old CLI are the ones meeting the v2 registry). Result: **29 of 29 steps pass** (`rehearsal-assets/results-g4-live-registry-copy.json`; in that file principal ids are shortened to 12 characters and every other identifier, the digests of the registry files and of the audit chain, and the plan ids to eight, and the scratch path is replaced; the live registry's files were unchanged by the run, which was checked with hashes taken outside the runner).

The copy: schema v1, sequence 3, three bindings (`ghost`, `gravity2`, `codex-headless`; all mesh-managed, generation 1, none revoked), audit `bind, bind, bind` with no `init` entry (the plan allows a first entry that is `init` or `bind`). The installed client has one local recipient, `gravity2`.

- **The upgrade converts the real data.** The plan was ready; the apply made a backup equal to the pre-upgrade bytes and a v2 registry at sequence 4 whose audit log is the three old entries plus `upgrade`. New step D2b: every one of the three bindings equals its v1 form plus the new schema name and a null public key, no revoke appeared or disappeared, and the new collections are empty.
- **Routing is the same before and after.** `gravity2` by principal and an exact-id send reach their runners on the candidate host after the upgrade; a principal send to each of the other two bindings (`ghost`, `codex-headless`, bound but not local recipients) is refused with `route_unavailable` and reaches no runner both before and after.
- **The installed code fails closed on the real v2 file** (reader, writer, a restarted host, a host running when the write lands, the old client CLI), and `restore-registry` puts the v1 pair back byte for byte, archives the v2 pair, and the running installed host recovers without a restart.
- **A harness finding:** the product's pair-exchange limit (10 exchanges per pair per 10 minutes, durable in the journal) stopped the first copy-mode run, because with one local recipient everything went to one pair. A single-recipient client now gets a second recipient without a binding (`scratch-b`) for the exact-id sends. This is the limiter doing its job, not a defect.

## 5. G5: the upgrade of the live registry

Run by the owner from their own terminal (a terminal on both standard streams is required): the plan first, which writes nothing, then the same command with its plan id. The backup `identity-backups/backup-v1-20261109T070056Z` was made first and the `upgrade` audit entry is stamped 2026-11-09T07:00:56Z. The floor had been shown to pass beforehand by a read-only plan (G3), and the whole path had been rehearsed on a copy of this registry (G4).

Verified afterwards by the assistant, read only, with `rehearsal-assets/verify-g5.mjs` against a baseline taken at 06:51Z (`rehearsal-assets/results-g5-verification.json`, identifiers not included): **11 of 11 checks pass**.

- The router reports the registry `ok`, sequence 4, schema `identity_registry_v2`, `supportedSchemas` `[v1, v2]`, `rootSha256` equal to the digest of the identity directory.
- Held 2, queued 1, queued_local 1 and pending replies 14 are unchanged; nothing is executing; dispatcher and wake are idle; the router is enabled; `triangle-local discover` entries are identical to before; **the supervisor was not restarted** (same wrapper and node child), since the running process re-reads the registry.
- `identity-backups/` holds exactly one folder, with exactly the two registry files, equal to the pre-upgrade bytes, modes 0700 and 0600.
- Read with the installed reader (which verifies the hash chain): v2, sequence 4, three bindings, no unfinished write. The audit log is the three old `bind` entries unchanged plus one `upgrade` entry. Every binding equals its v1 form plus the new schema name and a null public key, the new collections are empty, `createdAt` is unchanged.
- A new plan says `registry_already_v2` with the floor still passing; `triangle status --identity` prints `Registry: ok · v2 · sequence 4 · pairings 0 · aliases 0 · destinations 0`.

**History of the check script.** `verify-g5.mjs` changed after its first run, and the saved baseline predates the later versions, so this is on record. The first version was written at 06:51:43Z (sha256 `6157efbb…`, as reconstructed by the independent review) and took the baseline at 06:51:52Z; its first run after the upgrade (07:01:34Z) passed 11 of 11. Its record of the supervisor child's bundle was wrong (it split the command line on spaces, which breaks on "Application Support" and stored the user name), so the saved baseline carries that wrong label. At 07:02:22Z the label extraction and check 4 were patched, check 4 then comparing pids only, and the script was re-run (11 of 11; sha256 `1c39d668…`, the version in this PR's first commit). After the independent review it was strengthened: check 4 requires exactly one wrapper and one child, the same pids as the baseline, and the child's bundle to equal the live manifest's; check 6 is always emitted; check 11 matches `Registry: ok · v2 · sequence <next>`; the digests of the registry files are shortened in the output. `results-g5-verification.json` is the run of that final version (sha256 `119910d1…`, taken 2026-11-09T07:39:22.642Z, 11 of 11, read only). The baseline's wrong label is not used by the final script.

**The way back with the real files** (added after the review). `rehearsal-assets/restore-live-backup-rehearsal.mjs` restores the real `backup-v1-20261109T070056Z` over a scratch copy of the real v2 pair with the installed `triangle` (plan, then the plan id in a pseudo-terminal): 8 of 8 checks (`results-g5-restore-rehearsal.json`). The plan is ready with relation `ahead`, only the `upgrade` entry discarded, no routing change and no v2-only data; the registry afterwards equals the backup's bytes, the v2 pair is archived byte for byte, the backup folder is unchanged, and the installed reader reads v1 at the old sequence with the same bindings. The live files were unchanged by the rehearsal.

**The negative set on the live system** (added 2026-11-09 about 07:53Z, at the owner's request: "Negative set only"). Five refusals plus one extra, none of which can run a worker, sent through normal interfaces: the owner CLI as the desktop sender, and this Claude chat's own Triangle session tool. This chat is permitted to message `gravity2` (a send would run the worker), so no probe was sent to it.

| Probe | Sender | Answer | Layer |
| :--- | :--- | :--- | :--- |
| unknown principal (`agent_` and 32 random hex) | desktop sender, owner CLI | `recipient_not_found` | server (router) |
| unknown principal (same form) | this Claude session | `recipient_not_found: no_binding` | server |
| a `peer_` id | desktop sender, owner CLI | `recipient_not_allowed` | the CLI, before the server |
| a `peer_` id | this Claude session | `recipient_not_found: peer_not_supported` | server |
| a sender without permission: an exact id outside this chat's permitted recipients | this Claude session | `recipient_not_allowed` ("Sender session-b991… is not authorized to message …") | server (ACL) |
| (extra) the principal of a binding that is not a local recipient (`ghost`) | desktop sender, owner CLI | `route_unavailable` | server |

Nothing was queued or run: the journal counts are identical before and after (held 2, queued 1, queued_local 1, pending replies 14, completed 18, nothing executing), the dispatcher and wake stay idle, a status lookup of each refused message id says `not_found`, this chat's inbox is unchanged, the `discover` entries are identical, and the registry block is still `ok`, v2, sequence 4. The router's own counters moved as expected: `recipient_not_found` 0 to 3 and `route_unavailable` 0 to 1 (the four server-side refusals other than the ACL denial), `resolved.id` 0 to 1 (the ACL denial, after resolution) and `resolved.principal` still 0, so no principal send was accepted. **Not tested:** a sender without permission addressing the `gravity2` principal itself, because no sender that lacks that permission is available without changing grants; the same ACL denied an unpermitted exact id.

The way back, rehearsed in G4, is `triangle identity restore-registry --client-root … --from …/identity-backups/backup-v1-20261109T070056Z` (a plan first, then the plan id). A bind or revoke made since the upgrade would be lost by it and must be redone.

## 6. Plan section 8, item by item

| Item | State |
| :--- | :--- |
| (1) after G2 the live v1 registry resolves exactly as before | done for what can be read without sending: `discover` entries and the router block unchanged; no live send |
| (2) the scratch rehearsal passes | done: D1.4 (28 of 28) and G4 on the copy (29 of 29) |
| (3) after G5 the `gravity2` principal send works and its journal row is identical apart from timestamps | **not run**: needs a live send, which runs a worker, so the owner's yes; no tool compares journal rows yet. G4 showed the send on the scratch host and the router block shows the registry in use |
| (4) negative set: unknown principal, a `peer_` id, a sender without permission | **done** on the live system 2026-11-09: five refusals plus one extra, nothing queued or run (section 5); the unpermitted sender was tested against an exact id, not the `gravity2` principal |
| (5) restart preserves state | G2 and G3 restarts preserved the backlog and the router state; **G5 needed no restart**, and a restart after G5 has not been made |
| (6) backlog isolation (14 pending replies, 2 held tasks) | **done**: unchanged through G2, G3 and G5 (held 2, queued 1, queued_local 1, pending replies 14) |
| (7) the backup restores cleanly on a scratch root | **done**: in G4 (F1, F2, F4) on a backup made from the copy, and with the real backup over a copy of the real v2 pair (section 5) |

## 7. Left as it is, and follow-ups

- Two live session MCP children (pids 28021 and 72188) still run the older bundle `7eb3b2f0…`, and the worker bundles still carry the pre-D1 identity modules. The independent review checked that neither reaches any identity or router module, so this is harmless now; a later worker restage should not be forgotten.
- Fix or retire the "owner CLI only" install flow before the next install (it wrote the stale receipt).
- The standard installer's refusal over a stale receipt is an uncaught exception with a stack trace (`scripts/release/install-client-package.mjs`); a clean message would help.
- Open owner questions: whether `upgrade-registry` should exit 1 when the registry is already v2 but the running supervisor cannot read v2 (D1.3 behaviour), and the owner-approval provider and activation for the revoke command (a separate decision).
- Plan section 8 items 3 and 5 (a live `gravity2` principal send, which runs a worker, and a restart after G5) and the owner's acceptance of the evidence.

## 8. Limits

- The hosts of the rehearsal are the production host class with echo runners in plain processes; launchd, the Swift `run-supervisor` path and real runners are exercised only by the live G2 and G3 restarts, which show the supervisor starting and the invariants holding, not message flows through real runners.
- No live principal send has been made; the live evidence for routing is `discover`, the router block and the read-only plan.
- The copy was taken once, before the upgrade; the live registry did not change between the copy and G5 (its file hashes are equal from 2026-10-31 through the G5 baseline).
- Items 3 and 5 of plan section 8 (a live principal send, a restart after G5) were not run; the evidence for the live registry in use is the router block, `discover` and the installed reader, not a message flow.

## 9. Independent review

A read-only Opus model review (a model review, not a human or Codex review) of commits `0183290` and `a0bec8a`. It read the tooling end to end, re-ran the rehearsal in both modes (alone and in parallel; its fingerprint of the installed root was identical after every run), ran nine mutations, probed the verification script for false passes in a fake home, scanned the committed files for the registry's identifiers, and checked the evidence against the install records, archives, code and git history. **No High finding**: every live change matched the records, the tooling only reads the installed root, and no full identifier of the registry is in a committed file. One Medium (the G5 check script was patched after its first run and the PR did not say so: now disclosed in section 5, and the checks strengthened), ten Low and ten nits, all fixed or answered above: the Limits line; plan item 7 (now also rehearsed with the real backup); weak checks 4 and 11 of the verification script; a recipient-selection fallback; no assertion of the expected outcome for bindings that are not local recipients; a redaction claim that did not match the file (it now does, and the digests, plan ids and scratch path are shortened too); the cause of the stale receipt; the retention wording; a guard against `--registry-copy` or `--out` inside the installed root; wording. The missing items of plan section 8 are listed in section 7. The fixes were checked by rerunning the rehearsal in synthetic and copy mode (29 of 29 each), a case that used to fail spuriously, both new guards, the verification script (11 of 11) and the restore rehearsal (8 of 8); **they were not re-reviewed**.

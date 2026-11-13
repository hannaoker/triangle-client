# Identity aliases (AD.3): candidate build and scratch rehearsal

- **Date:** 2026-11-12 (Pacific)
- **Candidate:** `main` at `725f13da59c5bbb7f6ff7a6bb9fcdafb801a6511` (the merge of AD.2, PR #176; AD.0 and AD.1 are #172 and #173)
- **Plan:** `docs/plans/2026-11-10-identity-aliases-and-destination-rules-plan.md`, piece AD.3 ("Candidate and rehearsal"), the release train of section 6 and the verification of section 8
- **Result:** 31 of 31 rehearsal steps pass with 0 warnings (`rehearsal-assets/results.json`, about 40 seconds), the same on four parallel runs, and the rehearsal catches 27 of 27 deliberate defects in the candidate (section 7)
- **Not done, on purpose:** gates H2 (supervisor restage), H3 (client package) and H4 (the first alias), which are AD.4 and each need the owner's yes. Nothing was installed, restarted or changed. The installed application root was fingerprinted before and after the run and is identical (step Z1; Z1 detects live-root changes rather than sandboxing children to prevent them).

## 1. What this shows, in short

1. A **real candidate** was built and checked: the client package, built by `scripts/release/build-client-package.mjs` from `725f13d` (Swift helpers compiled, ad-hoc signed, strict codesign passes), and a supervisor bundle staged from that package by its own installer. Gate H2 is a restage of **eleven supervisor modules and nothing else**, exactly the list that plan section 6 gives, with no manifest bump.
2. A **scratch application root** ran both supervisors: the **installed** bundle (`c01e78bb…`, copied byte for byte from the live root, 90 artifacts checked) and the **candidate** bundle (`45c2317e…`). The registry has the shape of the live one (three binds, no `init` entry, upgraded to v2 by the real `upgrade-registry` command). Sends, status, discovery and the Grok principal go through the installed `triangle-local` wrapper; the alias commands, `status --identity` and the restore go through the real CLIs, the alias ones through the `triangle` that the candidate package's own installer put in a scratch home.
3. **The whole release train works in the order of plan section 6, and so does the way back.** With no aliases the candidate answers exactly as the installed supervisor does (C2). An alias is planned, applied in a terminal with its plan id, listed in discovery for exactly the one entry, used, retried, cleared and set again (E1 to E6, E10). A sender that may not message the target gets the unknown name's answer in code, counters, journal and discovery (E6). Reserved names, look-alikes, bad names, profile names, an existing alias and targets that cannot route are refused at plan time (E7); a profile added after an alias of its name makes the server answer `alias_unresolved` to a sender that can see both (E8).
4. **The installed supervisor fails closed on aliases and does not break.** Rolled back to the installed bundle with two aliases in the registry, it reads the registry, serves principals and exact ids as before, shows no alias in discovery and answers an alias as an unknown name (F1). The installed client package and writer tolerate the registry (F2). An alias set while the old supervisor runs is recorded, ignored, and honored by the restaged supervisor with no registry change (F3, F4): the order "supervisor first" is right, and a wrong order costs nothing but a warning. Rolling back by hand after a committed install (restoring the saved manifest and restarting) and restaging again also leaves the registry untouched and restores the same bundle id (F5).
5. The rehearsal found **no defect in AD.0 to AD.2**. Section 4 lists the facts it did settle for AD.4, and what its own development caught (harness faults, none a product defect).

## 2. Inputs

| Input | Value |
| :--- | :--- |
| Installed supervisor | manifest v14, bundle `c01e78bbf404c8690c956c7da9a8edd1ea63bd20342d354fe6ada14bfaf60e80` (the D1 restage of 2026-11-09, source `46c0923`), 90 artifacts, **all 90 equal to the blobs of `46c0923`**, node sha256 `5d9d3872911e2340a43b707962e68143de8a4e8d54628845c0c4f2de1fb7cd5c` |
| Installed client package | `0.2.0-identity.2` (156 files) |
| Candidate package | `0.2.0-ad3-rehearsal.1`, 157 files, `public_ad_hoc` signing, file custody, archive sha256 `4bbfe13354d2bc7ae7dbea78e12588fecdff559ede07f8b68001a6e87783df94` |
| Candidate vs commit | all 152 tracked files in the package equal the blobs of `725f13d`; the other five are `worker-artifacts.json`, the node license and the three binaries |
| Candidate node | same sha256 as the installed bundle's node (so staging changes project artifacts only) |
| Candidate supervisor bundle | `45c2317e49c6031dea1386b76b569d9a2726a539f89c1c0856a9085c8ac662cb`; staging, rolling back (both staged and committed) and staging again gave the same id. **The installer should report this id at H2 if the supervisor artifacts and node binary hash (`5d9d3872…`) are unchanged since `725f13d`** (the bundle id includes the node hash; if either differs, `stage-runtime` / `validate-runtime` will report a different id). |
| Supervisor diff (H2) | 11 of 90 artifacts differ, none added or removed, manifest stays v14, node unchanged: `grok-local-session`, `identity-primitives`, `identity-registry`, `local-messaging-cli`, `local-messaging-client`, `local-messaging-journal`, `local-messaging-protocol`, `local-messaging-server`, `recipient-resolver`, `router-registry-snapshot` and `unified-router` (all in `packages/agent-worker/src`). That is the list of plan section 6, and it is also what git says changed in the supervisor group between `46c0923` and `725f13d`. The same eleven are members of the codex, hermes and antigravity bundle lists; a supervisor-only restage leaves those bundles as they are, which is the current practice. |
| Client package diff (H3) | 1 added (`identity-alias.mjs`), 18 changed, 138 unchanged, none removed. Changed: `bin/triangle-client` and `bin/triangle-mailbox` (the Swift helpers, rebuilt), `cli.mjs`, `doctor.mjs`, `identity-status.mjs`, `identity-upgrade.mjs` (triangle-cli), `identity-view.mjs` and the eleven supervisor modules (agent-worker). |
| Live install receipt | `package-install.json` names `0.2.0-identity.2` and seven owned files; **all seven match the disk** (A6; recorded in `inputs.liveReceipt`, and mismatches emit a warning in `results.warnings` rather than failing the run), so the standard installer should not refuse as it did at G3 until the receipt was reconciled |

The archive hash belongs to this build. H3 builds its own package, and Swift output is not required to be byte-identical between builds.

## 3. How the rehearsal is built

`rehearsal-assets/rehearsal-aliases.mjs` drives everything; `alias-host.mjs` runs under a bundle's own node and imports only from that bundle; `lib.mjs` holds helpers shared with the D1.4 runner's design; `pty-run.py` (the D1.4 file, a test keeps the two equal) gives a command a real terminal for the `--confirm` steps; `mutation-check.py` is section 7. The D1.4 runner stays as it was: it is the evidence for `58df2de`, and its flow (a baseline supervisor that cannot read v2) no longer describes the installed bundle. The runner only **reads** the installed root: the manifests, the baseline bundle (copied), the `triangle-local` wrapper, `package-install.json` and the seven files it owns (hashed, A6), the client package's code and manifest, stat data of `identity/`, `identity-backups/`, `bin/`, `worker-runtime/`, `releases/`, `releases/<v>/`, `client/l` and two client files plus `~/.local/bin/triangle` (stat and symlink target), the bundle and release listings, and the process list (A1 warns in `results.warnings` if 0 supervisor processes are seen). It never opens the live journal or registry, uses no credential, signals no live process and does not touch launchd. Z1 detects live-root changes rather than sandboxing children to prevent them.

| Piece | Real | Stand-in |
| :--- | :--- | :--- |
| Installed supervisor code | the live bundle, copied and hash-verified; its own node | run as a plain process, not by launchd or the Swift helper |
| `triangle-local` | the installed wrapper, with its one root constant pointed at the scratch root; it runs whichever bundle the scratch manifest names | |
| Client config, router, registry | made with the **installed** bundle's own `setupLocalMessaging`, `setupRouter` and registry writer: recipients `alpha`, `beta`, `scratch-b` (no binding, D1.5's second recipient); bindings `alpha`, `beta`, `ghost` (bound, not a local recipient, as in the live registry); first audit entry a bind | two synthetic bindings of the live shape, not the live contents |
| The upgrade to v2 | the real `upgrade-registry` of the candidate CLI, plan then apply in a pseudo-terminal, against the running installed host (the floor passes) | |
| Senders | the paired desktop sender (the owner CLI: `triangle-local send`, `status`, `discover`); a Grok principal `limited` made by `triangle-local setup-grok`, with an outgoing grant for `beta`, `scratch-b` and `late` and not for `alpha`, which sends through `triangle-local grok send` | it stands for a chat or agent that may message some workers and not others |
| Host | `createInstalledLocalMessagingHost`, the class the production supervisor uses | echo runners instead of model runners; no wake, inbox or discovery brokers |
| H2 | the candidate package's installer (`stage-runtime`, `validate-runtime`, `rollback-runtime`, `commit-runtime`) over the scratch manifest | |
| H3 | the package's own installer script into a scratch home (`--test-root`); the installed `triangle` wrapper runs the alias commands | a fresh install, not an upgrade over a receipt |
| Terminal gate | a pseudo-terminal on stdin and stdout | not the owner's Terminal window |

## 4. Findings

1. **H2 is the eleven modules and nothing else** (A4, C1). The diff was computed twice, from the bundle against the package and from git against the installed bundle's source, and they agree. The restage keeps manifest v14 and the node. Rolling the stage back restores the manifest byte for byte and removes the new bundle; staging again gives the same bundle id (F1, F4).
2. **H3 is the whole package again, helper binaries included, as G3 was** (A5, D1). The two Swift helpers are rebuilt; nothing else in the package is surprising (one new module, five changed CLI and view files, the eleven supervisor modules). The live receipt matches the disk today (A6); look again just before H3. The scratch install shows the package's installer places a `triangle` that lists `identity alias set` and `clear`.
3. **With no aliases the candidate supervisor answers like the installed one** (C2, invariant 1 of plan section 5). The router block differs only by the additive fields (`addressForms` is `alias, id, principal`; `resolved.alias` and `errors.alias_unresolved` are 0); a set of six refusals (unknown principal, `peer_` id, a bound principal that is not a local recipient, an exact id outside a grant, an unknown alias-shaped name from a grant-limited sender and from the owner CLI) gets the same answers, the same counter deltas and no journal row on both supervisors; the discovery entries are equal, with no `send.aliases` key; a message sent through the installed host is still readable, completed, through the candidate host (one journal).
4. **The first alias, end to end** (E1 to E4, E10). The plan is ready, shows the supervisor as honoring aliases, names the target and writes nothing. The apply needs a terminal and the exact plan id (the id of the apply equals the plan's); it moves the sequence by one, adds an `alias_set` entry, stores `{principal, generation = the committing sequence}` and the installed reader reads the chain. Discovery lists the name for exactly one entry and leaves the others alone. A send to the name reaches `alpha`'s runner; the admission and the status lookup name the principal and profile and do not contain the alias; `resolved.alias` moves by one and nothing else does; principal and exact sends are unchanged. A restart changes none of it.
5. **An alias a sender may not use is an unknown name** (E6). The Grok principal, which may not message `alpha`, gets the same record for `builder` as for `nobody` (`rejected`, `recipient_not_allowed`, and via `grok-send` both code and message are `Grok outgoing grant denies recipient`; the owner CLI hides the server message and prints only the code), the same counter movement (`resolved.id` by one, no `alias` counter, no error counter), no journal row (checked via the Grok sender itself), and its own discovery names neither the alias nor `alpha`. The desktop sender, which may, uses the alias. This is the "known gap" of plan section 8: it cannot be shown live with the only local recipient, and the rehearsal shows it on the production host.
6. **Retries across `clear` and `set` behave as plan 3.5 says** (E5). A retry by the alias or by the principal is a duplicate; by exact id it is `duplicate_id_conflict`. After `clear` the name is an unknown name for a sender that could see it (`recipient_not_allowed`), and the original message can still be asked about by its id. After `clear` and `set` to **another** principal a retry is `duplicate_id_conflict`; after `clear` and `set` to the **same** principal it is a duplicate again.
7. **Names and collisions** (E7, E8). Seventeen plans are refused with the expected codes (six reserved words and prefixes, three malformed names, two profile names, an existing alias twice, `ghost` as a non-local target, three targets that do not exist or have no binding), a clear of a missing alias is refused, no refused plan can be applied, a piped apply is refused for lack of a terminal (exit 2) and a wrong plan id is `plan_stale` (exit 2); the registry is byte for byte unchanged by all of it. A profile added **after** an alias of its name (`late`, the resolve-time collision that the set-time check cannot prevent): the Grok principal, which may message both the alias's target and the profile, is answered `rejected` / `alias_unresolved` and `errors.alias_unresolved` moves by one; the owner CLI maps profile names first and so reaches the profile (the documented asymmetry); `status --identity` shows the row as `collides`. Once the alias is cleared the same word is an unknown name to the Grok principal, which does not map profile names, and its exact id works.
8. **The installed supervisor, client and writer meet aliases without harm** (F1 to F3). Rolled back with `builder` and `reviewer` in the registry, the installed host: reads it (the hash chain included) and serves it as v2 at the current sequence with no `addressForms`; routes principal and exact-id sends; lists no alias in discovery (the entries equal what they were); answers two alias-shaped sends from the Grok principal (an alias it could use under the candidate and one it could not) with `recipient_not_allowed` and counts them as exact ids (`resolved.id` +2), while the owner CLI refuses the alias-shaped name client-side before sending; and gives the same negative-set answers and counter deltas as before there were aliases. The installed client package reads the registry (`aliases 2` in `status --identity`) and its upgrade plan says `registry_already_v2`. The installed bundle's writer binds a new profile in a copy of the registry, leaves the aliases alone and leaves a chain that reads. The candidate CLI's plan against that supervisor is **ready**, with `not_honored` / `address_forms_not_reported` and a human warning that the alias will be recorded and not honored until the supervisor is restaged; set anyway, the alias is recorded, the running installed host keeps serving, and the name is an unknown name to it.
9. **"Supervisor first" is confirmed, and committed-install rollback works** (F3 to F5). Restaging the candidate over the same registry honors the aliases already there with no registry change (the owner CLI reaches `builder`, the Grok principal reaches `other`, and discovery lists `reviewer` and `other` for `beta`), and the restage can be committed (F4). Rolling back by hand after commit (restoring the saved manifest and restarting) returns to the installed supervisor with the registry unchanged, and staging and committing again produces the same bundle id (F5).
10. **The kill switch** (E9). With the router disabled the supervisor reports `addressForms` as `id` only, `builder` is an unknown name for both senders, the alias plan says `not_honored` with `router_disabled`, and enabling the router brings the alias back.
11. **A client from before the restage** (E3). The installed bundle's own CLI, run against the candidate host with an alias present, keeps the entry's `send` explanation, drops the field it does not know and cannot send to the name (plan invariant 9, here with the real code of the installed bundle).
12. **The way back past aliases** (G2). `restore-registry` to the pre-D1 backup is refused without `--discard-v2-data` (`restore_would_lose_v2_data`); with it the plan is ready, counts the alias in its v2-only data, lists the discarded audit entries (sequence, time, action and subject, which for an alias entry is the alias name, never its target: no principal appears in the plan), and applied it puts the v1 pair back byte for byte; the running candidate host recovers without a restart, discovery lists no alias and the name is an unknown name.
13. **What the rehearsal's own development caught** (harness faults, none a product defect): the `bind` probe wrote a v1-shaped binding into a v2 registry (`invalid_registry: missing_binding_key`); the first complete run was stopped by the product's pair-exchange limit (the 11th accepted desktop-to-`alpha` exchange within ten minutes is refused, `exchange_limit_exceeded`; sends are now spread over `alpha`, `beta` and `scratch-b`, at most seven per pair, and the runner fails if any pair gets past nine); a Grok principal does not map profile names to ids (the expected answer in E8 was corrected); adding a recipient adds a discovery entry, which the later comparisons now account for; and the mutation harness first committed the 113 MB node binary to its scratch repository and failed under parallel jobs (it now commits only files that git tracks).

## 5. Results by step

| Step | What it proves | Observed |
| :--- | :--- | :--- |
| A1 | installed state is v14 | manifest v14, bundle `c01e78bb…`, 90 artifacts, node `5d9d3872…`, client package `0.2.0-identity.2`; the live root fingerprinted (warns in `results.warnings` if 0 supervisor processes are seen; warn path not exercised) |
| A2 | the copy is the installed bundle | 90 artifacts and the node equal the live manifest; modes 0700/0600/0500 |
| A3 | the candidate is `725f13d` | 157 files; 152 tracked files equal committed blobs; node equals the installed node; strict codesign passes for both helpers |
| A4 | what H2 changes | exactly the eleven modules; none added or removed; v14; equal to git's list since `46c0923`; the 90 installed artifacts equal the blobs of `46c0923` |
| A5 | what H3 changes | 1 added, 18 changed (two rebuilt helpers), 138 unchanged, none removed |
| A6 | what H3's installer will find | live receipt `0.2.0-identity.2`: 7 of 7 owned files match the disk (recorded in `inputs.liveReceipt`; mismatches warn in `results.warnings` rather than failing; warn path not exercised) |
| B1 | the baseline world | recipients `alpha`, `beta`, `scratch-b`; bindings `alpha`, `beta`, `ghost`; v1 registry at sequence 3 (`bind` three times); Grok principal `limited` from `setup-grok` |
| B2 | installed supervisor on v1 | block `{ok, 3, v1, supportedSchemas, rootSha256}` with no `addressForms` or alias counters; principal and exact sends reach their runners; three discovery entries, no `send.aliases` |
| B3 | the upgrade to v2 (matching G5) | floor passes; applied in a terminal; backup equals the pre-upgrade bytes; v2 at sequence 4; audit `bind` three times then `upgrade`; the running installed host serves v2 with no restart |
| B4 | the negative set, installed | six probes refused (`recipient_not_found`, `recipient_not_allowed` twice by the client, `route_unavailable`, `recipient_not_allowed` twice as `rejected`), none reached a runner or left a journal row; counters `resolved.id` +2, `recipient_not_found` +1, `route_unavailable` +1 |
| C1 | H2: stage and validate | `stage-runtime` and `validate-runtime` pass; the manifest differs in exactly the eleven artifacts; node and version unchanged; rollback record written; bundle `45c2317e…` |
| C2 | candidate, no aliases | block equal apart from `addressForms` and zero alias counters; the six probes answered and counted as on the installed host; discovery entries equal; sends work; the earlier message is readable |
| D1 | H3: the package's installer | installed into a scratch home; receipt names the candidate; `triangle --help` lists `identity alias set` and `clear` |
| E1 | alias set, plan | ready; target `alpha`'s principal; supervisor `honored`; the human plan shows the apply command; nothing written |
| E2 | alias set, apply | terminal and plan id (equal to E1's); sequence +1; audit `alias_set`; record is `alpha`'s principal at the committing sequence; the installed reader reads the chain; `status --identity` shows `active · builder → alpha` |
| E3 | discovery and an old client | `send.aliases` is `builder` on `alpha`'s entry only; other entries unchanged; the installed CLI keeps `send`, drops the field, cannot send to the name |
| E4 | the honored send | `echo[alpha]`; target `{via: principal, principal, profile: alpha}` in the admission and the status lookup; the alias in neither; `resolved.alias` +1 only; principal and exact sends unchanged |
| E5 | retry across clear and set | duplicate by alias and by principal; `duplicate_id_conflict` by exact id; Grok on a visible alias accepted, duplicate, then `recipient_not_allowed` after the clear with the original still askable; `duplicate_id_conflict` after set to another principal; duplicate after set to the same principal |
| E6 | a sender without permission | `nobody` and `builder` give the same record, `resolved.id` +1 each, no journal row (checked by the Grok sender); `grok-send` prints `Grok outgoing grant denies recipient` for both; Grok's discovery names neither the alias nor `alpha`; the desktop sender uses the alias |
| E7 | refusals and the apply gate | 17 refused plans by code, a missing alias on clear, a refused plan's id cannot be applied; no terminal exit 2; wrong plan id `plan_stale` exit 2; registry unchanged |
| E8 | resolve-time collision | Grok (may message both): `rejected` / `alias_unresolved`, `errors.alias_unresolved` +1, no journal row; the owner CLI reaches the profile; `status --identity` says `collides`; after the clear the word is unknown to Grok, its exact id works |
| E9 | the kill switch | router off and restarted: `addressForms` is `id` only; the alias is unknown to both senders; the plan says `router_disabled`; router on: the alias works |
| E10 | a restart | same sequence, `addressForms`, discovery and a working send |
| F1 | H2 rolled back, aliases present | manifest byte-identical, new bundle removed; the installed host reads the registry (two aliases) and serves v2 with no `addressForms`; principal and exact sends work; discovery has no alias; the owner CLI refuses an alias-shaped name client-side, while two Grok sends are `recipient_not_allowed` and counted as exact ids (`resolved.id` +2); the negative set equals the baseline |
| F2 | installed CLI and writer | `status --identity` reads it (`aliases 2`); upgrade plan `registry_already_v2`; a bind on a copy leaves the aliases and a chain that reads |
| F3 | candidate CLI, installed supervisor | plan ready, `not_honored` / `address_forms_not_reported`, human warning; set anyway: recorded, the running host keeps serving, the name is unknown to it, discovery unchanged |
| F4 | H2 again | same bundle id; registry byte-identical across the restage; the aliases honored; committed |
| F5 | committed-install rollback | manual restore of the saved manifest + restart returns to the installed supervisor with the registry unchanged; staging and committing again gives the same bundle id |
| G1 | clear everything | eight sets and eight clears in the chain; no alias left; discovery equals the start; the name is refused |
| G2 | the way back | refused without `--discard-v2-data`; with it ready, relation `ahead`, one alias counted, discards listed with action and name, no target; applied: v1 at sequence 3 equal to the backup; the host recovers; discovery has no alias |
| Z1 | the installed root is untouched | ten hashed files, directory entries (`identity/`, `identity-backups/`, `bin/`, `worker-runtime/`, `releases/`, `releases/<v>/`, `client/l`), `~/.local/bin/triangle` (stat and target) and the two supervisor processes: identical; at most 7 accepted exchanges per sender and recipient pair (limit 10). Z1 detects changes; it does not sandbox children |

`results.json` holds the full recorded values (all ids are synthetic; the scratch path is replaced).

## 6. Limits

- The host runs echo runners in a plain process (only the echo reply is checked, not the request payload delivered to the runner). No worker ran and no model was called; launchd, the Swift helper's `run-supervisor`, wake, inbox and the discovery broker are not exercised. The one positive canary of AD.4 (a real send to the only local recipient, which runs a worker) is therefore still needed and has its own gate.
- The senders are the paired desktop and a Grok principal. A Claude or Codex chat through the MCP tools is not driven here; AD.1's wire tests cover that projection, and AD.4's negative probes use this chat.
- The registry is synthetic, with the live registry's shape. The live registry's contents were not read (the D1.4 rule); a run on a copy of it, as G4 did for the upgrade, would need the owner's yes and a registry-copy mode that this runner does not have.
- The package install is a fresh install into an empty scratch home. An upgrade over the live receipt is not exercised; A6 only shows the live receipt matches the disk today.
- The terminal is a pseudo-terminal. It satisfies the code's terminal test; it is not the owner's Terminal.
- The journal is never opened: that a stored row carries the principal and not the alias is shown by AD.1's tests, and here only through receipts and status lookups.
- Timing differences between an invisible alias and an unknown name (plan 3.3) were not measured. `triangle doctor` was not run; the alias rows in `status --identity` were.
- Whether a Swift build is byte-reproducible was not tested. The helpers in the candidate package are a rebuild and differ from the installed ones.
- This rehearsal is evidence about `725f13d`. A change to a supervisor artifact or to the CLI before H2 needs the rehearsal again. After H2 the runner needs `--baseline-manifest` (the manifest the install saves under `archive/`) and, after H3, `--baseline-release` (the previous package version), as the D1.4 runner did.

## 7. Is the rehearsal sensitive? A mutation check of the candidate

`rehearsal-assets/mutation-check.py` copies the candidate archive with **one** source line changed (the package manifest is updated to match; a scratch git repository holds the mutated tracked files so that "packaged files equal the commit" still holds) and runs the rehearsal on it. A mutant is caught when the run fails at the step it should. The unchanged archive, repacked the same way, passes (control).

| Mutant (what was broken) | Caught at |
| :--- | :--- |
| the router asks no permission before treating an alias as visible | E6 (the counters differ from an unknown name's) |
| a label equal to the alias no longer collides | E8 |
| the journal treats an alias send and a principal send as different intents | E5 |
| discovery does not list aliases | E3 |
| `addressForms` lacks `alias` | C2 |
| `resolved.alias` never moves | E4 |
| reserved names are allowed | E7 |
| `status --identity` never says `collides` | E8 |
| the Grok rejected list lacks `alias_unresolved` | E8 |
| the owner CLI sends any alias-shaped name without the discovery check | C2 |
| the plan allows an alias that exists | E7 |
| the plan allows a name that is a profile | E7 |
| the plan always says the supervisor honors aliases | F3 |
| the apply needs no terminal | E7 |
| `alias clear` does not remove the alias | E5 (caught by the registry writer's own post-mutation check) |
| the restore plan forgets v2-only data | G2 |
| `r01`: discovery ignores a label collision | E8 |
| `r02`: the router skips label permission when checking collisions | E8 |
| `r03`: the owner CLI passes any alias-shaped name once any alias is listed | E6 |
| `r06`: `apply` ignores a refused plan | E7 |
| `r07`: restore plan counts zero aliases | G2 |
| `r08`: advice gives the wrong reason when the router is disabled | E9 |
| `r10`: the alias writer is no longer create-only | E7 |
| `r12`: supervisor bundle content address leaves out the node hash | C2 |
| `r15`: the client drops `send.aliases` | E3 |
| `r19`: discovery explains entries while the router is disabled | E9 |
| `r21`: discovery adds `"alias"` to `addressKinds` | E3 |

27 of 27 are caught, each at the step expected (the 16 original mutants plus 11 from the independent review). One earlier choice of mutant was **equivalent**: removing the "none of its recipients is messageable" line inside `decideAlias` changes nothing observable, because the router tests the same condition (`permittedIds.size > 0`) before it calls `decideAlias` (defence in depth); the rule is mutated at the router instead. Ten other reviewer mutants were also equivalent or out of the rehearsal's scope (e.g., `r04` is hidden by the single-principal-per-row invariant / hash, and the label-collision loop appears in both `recipient-resolver.mjs` and `unified-router.mjs` and is mutated in both). This shows the rehearsal notices those 27 defects, not all possible ones.

## 8. Rerunning it

```bash
node scripts/release/build-client-package.mjs --version 0.2.0-ad3-rehearsal.1 --output /path/to/package-out
node docs/reviews/2026-11-12-identity-aliases-ad3-rehearsal-assets/rehearsal-aliases.mjs \
  --candidate-archive /path/to/package-out/triangle-client-0.2.0-ad3-rehearsal.1-darwin-arm64.tar.gz \
  --source-commit 725f13da59c5bbb7f6ff7a6bb9fcdafb801a6511 \
  --installed-source-commit 46c0923a76f12157974a19bd9d894c0cec509673 --out /path/to/results-dir
/usr/bin/python3 docs/reviews/2026-11-12-identity-aliases-ad3-rehearsal-assets/mutation-check.py \
  --archive /path/to/package-out/triangle-client-0.2.0-ad3-rehearsal.1-darwin-arm64.tar.gz --work /path/to/mutation-work --jobs 3
```

The installer script `triangle-install-0.2.0-ad3-rehearsal.1.sh` must sit beside the archive (the build leaves it there). `--keep` leaves the scratch root for inspection; `--installed-app-root` defaults to `~/Library/Application Support/The Triangle`; `--installed-source-commit` is optional and adds the git cross-check of A4. The rehearsal needs Node 22 and macOS and exits non-zero on the first failing step. `packages/agent-worker/test/rehearsal-aliases-tooling.test.mjs` keeps the helper scripts working against the code they import.

## 9. State of the gates, and what AD.4 still needs

| Gate | State |
| :--- | :--- |
| H1 merge AD.0 to AD.2 | done (#172, #173, #176) |
| AD.3 candidate and rehearsal | this document |
| H2 install the supervisor restage | not started; needs the owner's yes. Expected: the eleven modules above, bundle `45c2317e…` if nothing under the supervisor artifacts or node hash (`5d9d3872…`) has changed since `725f13d` (if either differs, `stage-runtime` / `validate-runtime` will report the new id), manifest v14, node unchanged. Subcommands: `stage-runtime`, `validate-runtime`, `commit-runtime` (and `rollback-runtime` or restoring the saved manifest + restart). Verify with the D1.5 negative set and the read-only status and backlog checks, and look for `addressForms`; **no positive send** |
| H3 install the client package | not started; needs the owner's yes. The package build brings rebuilt helpers (as G3); the live receipt matches the disk today (A6), and should be looked at again first |
| H4 the first alias | the owner's terminal, after H2 and H3. `gravity2` is the only local recipient the live registry can target, so a positive canary would run the worker and needs its own yes |

What AD.4 can take from the runner: the negative set of step B4 and its counter deltas (all refusals that cannot run a worker; D1.5 already ran "an exact id outside a grant" from the Claude session), the discovery check of E3 (the name appears in `send.aliases` of exactly one entry, which shows discovery lists the alias; the send resolver is exercised by E4/E8), the `alias set` refusals of E7 that need no write (`claude`, `gravity2` as a name, an existing alias, `ghost`), the clear of E5/G1 and the restart of E10. The backlog counts of D1.5 (held 2, queued 1, queued_local 1, pending replies 14, completed 18) are read from the live journal, which this runner never opens.

## 10. Independent review

Reviewed once (read-only Opus review, 2026-11-12; 0 High, 4 Medium, 10 Low, 7 Nit), findings answered:

- **Runner and helper fixes:** added `alias-write` and `grok-send` helper modes (`grok-send` prints both code and message); `noRow(who, id)` queries the sender that sent the message; asserted `router_disabled` in E9, `aliases === 1` in G2, refused plan apply with `alias_target_not_local` in E7, and per-sender aliases + `hidden` profile in E8; checked both v1 backup files and every principal in G2; added strict `host.stop()` exit code `1`; fixed `SIGINT` cleanup with a shared `finalize()` promise (retested: exit `130`, verdict `interrupted`, no stray `ad3r-*` dir or host process); expanded Z1 directory/symlink checks and A1 empty-process warning; used `realpathSync.native` for `--out`, `setEncoding` for chunks, path masking in failure details, and `failedStep` attribution; added step F5 (committed-install rollback by hand).
- **Mutation and tooling checks:** added 11 reviewer mutants and `Popen` `SIGTERM` → `SIGKILL` timeout handling to `mutation-check.py` (27 of 27 caught); added tooling tests for `alias-write`, `grok-send`, and strict stop exit code, and derived test 8's module list from plan section 6 (11 of 11 pass).
- **Documentation fixes:** clarified A6 (`inputs.liveReceipt` / `warnings`), E6 (`grok-send` vs owner CLI message), F1 (client-side vs supervisor refusals), Z1 detection vs sandboxing, H2 bundle id / node hash / subcommands, section 9 slips (D1.5 exact-id probe, `E5/G1`, send-resolver wording), and section 7 (`clear-does-not-clear`, reviewer mutants, `r04`).

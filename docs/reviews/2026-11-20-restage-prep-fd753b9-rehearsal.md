# v15 Restage Prep (`fd753b9`): Candidate Build and Scratch Rehearsal

- **Date:** 2026-11-20 (Pacific)
- **Baseline:** Live Mini v15 supervisor bundle `009977d1…` (manifest `f9bc30d0…`, `91` artifacts equal to `06e0bd2` committed blobs, `nodeSHA256 5d9d3872…`), client receipt `0.2.0-identity.3` (`157` files, `1/7` matching disk, `6/7` skewed from the `2026-11-14` helper install).
- **Candidate:** `hannaoker/triangle-client` `main` at `fd753b9` (`fd753b9b8e11133bee98aff4b48f3a3e66bdc1b0`, merges `#183` + `#184` + `#185`), built as plain client package `0.2.0-restage-rehearsal.1` (`161` files, `public_ad_hoc`, `file` custody, `testOnly: false`, archive SHA-256 `8affc20d…`).
- **Observed candidate supervisor bundle ID:** `cc602ac014586beff8ba08e24003115ea8ce16d646d2eef72457fa287ac26f4f` (`cc602ac0…`, deterministic across initial staging and post-rollback re-staging).
- **Result:** **17 of 17 rehearsal steps pass** (`verdict: "pass"`, 1 expected `A6` receipt-skew warning; `docs/reviews/2026-11-20-restage-prep-fd753b9-rehearsal-assets/results.json`), **2-way parallel isolation passes**, **`SIGINT` exits `130`** with `liveRoot.identical: true` and zero leaked processes/scratch dirs, and **`mutation-check.py` passes control + catches 12 of 12 mutants** at their exact expected steps.
- **Zero live changes:** Gate S and Gate P remain owner-gated and unexecuted. Live application root comparison (`Z1`) is byte-for-byte identical across all 10 checked categories (`15` hashed files, `3` `identity/` entries, `102` baseline bundle tree entries, `2` running processes).

---

## 1. Inputs & Exact Diffs (`06e0bd2` / `0.2.0-identity.3` -> `fd753b9`)

| Input | Observed Value |
| :--- | :--- |
| **Installed supervisor (read-only)** | Manifest **v15** (`f9bc30d0…`), bundle `009977d1…`, `91` artifacts (all `91` match `06e0bd242a088eb163db60505e8df0b1391b0219`), `nodeSHA256 5d9d3872…` (Node `v22.22.3`), `bin/triangle-local` SHA-256 `d27cc1ca…`. |
| **Installed worker bundles (read-only)** | All **v15** (`93/93` artifacts match `06e0bd2`): `codex` `36aaa25e…`, `hermes` `c89a464e…`, `antigravity` `fa82facd…`. While the 93-artifact worker manifests copy the same 12 files, static import traversal from `packages/agent-worker/src/cli.mjs` (`10` modules) reaches **0 of the 12** changed supervisor modules, so worker bundles do not need restaging in Gate S. |
| **Candidate package** | `0.2.0-restage-rehearsal.1`, `161` files in `manifest.files` (`156` tracked files equal `fd753b9` committed blobs, plus `worker-artifacts.json`, `LICENSES/node-LICENSE`, `bin/node`, `bin/triangle-mailbox`, `bin/triangle-client`), `nodeSHA256` identical to installed Node (`5d9d3872…`), `codesign --verify --strict` passes on both helpers. |
| **Gate S supervisor artifact diff (`A4`)** | Exact **12 of 91** artifacts changed (`0` added, `0` removed, manifest stays **v15**, equals `git diff --name-only 06e0bd2..fd753b9` intersected with supervisor artifacts): `client-supervisor-cli.mjs`, `grok-local-session.mjs`, `local-chat-mapping.mjs`, `local-messaging-dispatcher.mjs`, `local-messaging-host.mjs`, `local-messaging-interactive-session.mjs`, `local-messaging-journal-contract.mjs`, `local-messaging-journal.mjs`, `local-messaging-server.mjs`, `local-messaging-supervisor-seam.mjs`, `local-sender-authentication.mjs`, `unified-router.mjs` (all under `packages/agent-worker/src/`). |
| **Gate P package diff vs `0.2.0-identity.3` (`A5`)** | `157 -> 161` files: **4 added** (`local-chat-mapping.mjs`, `identity-chat-map.mjs`, `identity-destination.mjs`, `owner-approval-package.mjs`), **27 changed** (rebuilt Swift helpers `triangle-mailbox` + `triangle-client`, `worker-artifacts.json`, `triangle-worker-install.py`, 14 `agent-worker` modules, 9 `triangle-cli` modules), **130 unchanged**, **0 removed**. |
| **Live receipt audit (`A6`)** | `package-install.json` (`0.2.0-identity.3`) matches disk on `1/7` (`bin/triangle`) and mismatches on `6/7` (`bin/triangle-mailbox`, `bin/triangle-client`, and all `4` `install-manifest/*` files from the `2026-11-14` helper install). Helper `.sha256` and `-install.json` (`v1`, `public_ad_hoc`, `file`) match disk for both helpers. |

---

## 2. Step-by-Step Results (`17/17` Pass, `1` Expected `A6` Warning)

| Step | What Was Tested | Observed Outcome |
| :--- | :--- | :--- |
| `A1` | Read-only live fingerprint (`dev.thetriangle.client` running, v15 manifests, `0.2.0-identity.3` receipt) | **PASS** — `manifestVersion: 15`, `bundleIdPrefix: 009977d183b3`, `liveProcesses: 2`. |
| `A2` | Copy installed v15 bundle & verify all 91 artifacts + Node hash | **PASS** — `91/91` artifacts and `nodeSHA256` verified (`0` mismatches). |
| `A3` | Extract candidate archive `0.2.0-restage-rehearsal.1`, verify manifest, tracked git blobs, Node hash, strict codesign | **PASS** — `156` tracked files match `fd753b9`, `testOnly: false`, Node identical, strict codesign OK. |
| `A4` | Cross-check supervisor bundle artifact diff against `git diff 06e0bd2..fd753b9` | **PASS** — exact `12` modules changed, `0` added/removed, manifest stays v15. |
| `A5` | Compare `0.2.0-identity.3` (`157`) vs candidate (`161`) package manifests | **PASS** — `4` added, `27` changed, `130` unchanged, `0` removed. |
| `A6` | Read-only audit of live `package-install.json` vs disk and helper `install-manifest/*` | **PASS** (`WARN A6`) — `1/7` match, `6/7` skew confirmed; helper manifests match disk (`triangle-mailbox`, `triangle-client`). |
| `B1` | Baseline outage reproduction (`009977d1…` with `gravity2` omitted) | **PASS** — failed start `local_recipient_unavailable`, `local-control.sock` not created. |
| `B2` | Prepare baseline scratch world (`gravity2`, `helper`, `rhea` destination, `nora`, `m2chat`, `gemini` alias, Grok `restricted`) + baseline host + seed queued rows | **PASS** — healthy v2 baseline host + `pre-off-1` & `pre-gone-1` seeded as `queued_local`. |
| `C1` | Gate S `stage-runtime` + `validate-runtime` onto scratch manifest | **PASS** — exact `12`-artifact diff, v15 unchanged, Node unchanged, bundle `cc602ac0…`, `.rollback-supervisor-*` written. |
| `C2` | `#184` host fix (single-recipient `gravity2`-only & multi-recipient with `gravity2` omitted) | **PASS** — both hosts start with socket; `triangle_client_local_recipient_not_running` notice emitted; `unavailableRecipients: ["gravity2"]`; `helper` delivers `rep-*`; desktop + Grok sends to `gravity2` refused `local_recipient_unavailable` with no journal rows; `pre-off-1` stays `queued_local` and duplicates exact retry; `pre-gone-1` transitions to `held(runtime_error)`. |
| `C3` | `#185` reply-ID reuse guard (CLI, Grok, direct journal, direct server RPC) | **PASS** — CLI reuse to `helper`/`gravity2` refused `message_id_in_use` (`status --message-id <replyId>` remains `unknown`, `phase: undefined`); Grok returns `rejected`/`message_id_in_use`; `journal-reply-guard` confirms `message_id_in_use` + same-ID message retry `isDuplicate: true`; `server-reply-guard` confirms `message_id_in_use`, `recordSendCalled: false`, `rateRolledBack: true`. |
| `C4` | `#183` `M1` ACL-first destination indistinguishability across all 5 states (`absent`, `pending`, `corrupt`, `confirmed_online`, `offline`) | **PASS** — unauthorized chat receives identical `route_unavailable` matching non-destination `nora` across all `5` states; desktop sees exact `chat_mapping_missing` / `chat_mapping_unconfirmed` / `chat_mapping_corrupt` / `accepted` / `destination_session_offline`. |
| `C5` | `#183` `M2` + `M3` mapped chat provenance & reply pinning (`reply-identity` enabled) | **PASS** — `unmapped -> null`, `pending -> null`, `confirmed -> m2chat` principal + pinned `triangle_reply_message` received by requester, `afterRevoke -> null`. |
| `D1` | Gate P scratch install over `6/7`-skewed `0.2.0-identity.3` replica (`--test-root`) | **PASS** — refuses pre-reconciliation (`Existing file is not an unchanged package-owned file`), reconciles `6` helper/manifest entries after verifying helper `install-manifest` & binary hashes, installs cleanly (`9/9` owned entries verified). |
| `D2` | `#183` `M5` CLI surface checks on scratch-installed `triangle` | **PASS** — `--help` lists `identity destination set` & `identity chat-map set`; `status --identity` shows active `rhea` destination; destination plan allows `nora` and refuses `gravity2` (`destination_target_has_runner`) & `rhea` (`destination_exists`); `chat-map set` omits `--store-root` to select `stateRoot` from `local-messaging.json`, falls back to `<empty-client>/local` when config is absent, and prints `--client-root`; non-TTY `--confirm` exits `2`; PTY `--confirm` on plain build fails closed `owner_approval_unavailable` (exit `1`). |
| `E1` | Post-stop journal integrity (`pre-off-1`, `pre-gone-1`, `helperReplyId`), `rollback-runtime`, re-stage + `commit-runtime`, manual committed rollback, deterministic re-stage | **PASS** — `helperReplyId` intact on disk (`phase: null`, `inReplyTo` present); `rollback-runtime` restores pre-stage manifest byte-for-byte and removes staged bundle; manual restore of baseline manifest + `validate-runtime` recovers `009977d1…`; re-staging produces identical bundle `cc602ac0…`. |
| `Z1` | Live application root integrity comparison (`fingerprintLive` before/after) | **PASS** — `identical: true` across all `10` categories (`0` differences). |

---

## 3. Robustness & Sensitivity Checks

### Concurrency & Signal Safety

- **2-way parallel isolation:** Two concurrent runs (`--out /private/tmp/rstr-par1` and `/private/tmp/rstr-par2`) both exited `0` (`verdict: "pass"`, `17/17` steps each, `liveRoot.identical: true`).
- **`SIGINT` cleanup:** Signalling a live run after host startup exited `130` (`verdict: "interrupted"`, `liveRoot.identical: true`) with `0` leftover `restage-host.mjs` processes and `0` leftover `/private/tmp/rstr-*` scratch directories.

### Mutation Check (`12/12` Caught + Control Pass)

`mutation-check.py` repacks `0.2.0-restage-rehearsal.1` with one single-hunk defect at a time (updating `package-manifest.json` and a scratch git repo):

| Mutant ID | Targeted Module & Defect | Caught At |
| :--- | :--- | :--- |
| `control` | Unmutated repacked archive | `ok` (`pass`) |
| `m184-host-throws-on-missing-runner` | `local-messaging-host.mjs`: throws `local_recipient_unavailable` when runner absent | `C2` |
| `m184-server-drops-unavailable-guard` | `local-messaging-server.mjs`: bypasses `!runnerAvailable(effectiveTo)` guard | `C2` |
| `m184-dispatcher-claims-unavailable-runner` | `local-messaging-dispatcher.mjs`: recovery runs job without checking `runnable` | `C2` |
| `m184-grok-drops-local-recipient-unavailable` | `grok-local-session.mjs`: omits `local_recipient_unavailable` from `GROK_REJECTED_CODES` | `C2` |
| `m185-server-drops-reply-id-check` | `local-messaging-server.mjs`: bypasses `typeof existingRecord.phase !== "string"` check | `C3` |
| `m185-journal-drops-reply-id-check` | `local-messaging-journal.mjs`: bypasses `local_replies` collision check in `recordSend` | `C3` |
| `m185-journal-checks-reply-before-retry` | `local-messaging-journal.mjs`: checks `local_replies` before `local_messages` exact-retry dedupe | `C3` |
| `m185-grok-drops-message-id-in-use` | `grok-local-session.mjs`: omits `message_id_in_use` from `GROK_REJECTED_CODES` | `C3` |
| `m183-m1-leaks-destination-before-policy` | `local-messaging-server.mjs`: bypasses `if (!mayKnow) return hidden;` in `resolveDestinationPrincipal` | `C4` |
| `m183-m2-m3-drops-mapped-principal` | `local-sender-authentication.mjs`: drops `principal` / `authorityOrigin` from `authenticateAttachedLocalSender` | `C5` |
| `m183-m5-chat-map-wrong-store-root` | `identity-chat-map.mjs`: wrong no-config fallback `path.join(clientRoot, 'client', 'local')` | `D2` |
| `bundle-content-address-ignores-node` | `scripts/triangle-worker-install.py`: omits `node_hash` from bundle content-address hash | `C1` |

---

## 4. Scope Limits

1. **Plain build (no Touch ID):** `0.2.0-restage-rehearsal.1` was built without `--owner-approval`, so `D2` verifies the fail-closed `owner_approval_unavailable` path. If Gate P selects `--owner-approval identity` (`Option P-Auth`), physical macOS Touch ID / password acceptance (`cancel`, `apply`, `interrupt`, `expire`) on a disposable extract is still required before live install.
2. **Echo runners & plain host process:** Rehearsal runs `createInstalledLocalMessagingHost` directly with echo runners on synthetic identities/configs and does not exercise live `launchd`, wake adapters, `M4` (covered by repo unit tests), or a live positive canary to `gravity2` (kept disabled per owner decision).
3. **Synthetic `--test-root` package install:** Reproduces the exact `6/7` skewed receipt layout in scratch `/private/tmp`; does not modify `~/Library/Application Support/The Triangle/`.

---

## 5. Rerunning

```sh
# 1. Build candidate package from a clean fd753b9 checkout
node scripts/release/build-client-package.mjs \
  --version 0.2.0-restage-rehearsal.1 \
  --output /path/to/pkg-out

# 2. Run scratch rehearsal (requires macOS + Node >= 22 + live read-only app root)
node docs/reviews/2026-11-20-restage-prep-fd753b9-rehearsal-assets/rehearsal-restage.mjs \
  --candidate-archive /path/to/pkg-out/triangle-client-0.2.0-restage-rehearsal.1-darwin-arm64.tar.gz \
  --source-commit fd753b9 \
  --installed-source-commit 06e0bd2 \
  --out /path/to/results-dir

# 3. Run mutation sensitivity suite
/usr/bin/python3 docs/reviews/2026-11-20-restage-prep-fd753b9-rehearsal-assets/mutation-check.py \
  --archive /path/to/pkg-out/triangle-client-0.2.0-restage-rehearsal.1-darwin-arm64.tar.gz \
  --work /private/tmp/restage-mut-check \
  --jobs 3
```

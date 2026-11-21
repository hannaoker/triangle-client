# Unrecorded 2026-11-14 v15 Install & Local-Messaging Outage Record

- **Date recorded:** 2026-11-20 (Pacific)
- **Prior recorded baseline:** `2026-11-12` (Pacific) AD.4 H2–H4 acceptance (`docs/reviews/2026-11-12-identity-aliases-ad4-installed-acceptance.md`) at `hannaoker/triangle-client` `main` `738bd65`: supervisor manifest **v14** (bundle `45c2317e…`), client package `0.2.0-identity.3` (`7/7` receipt match), identity registry `v2` sequence `5` (`gemini → gravity2` active).
- **Observed live code commit:** `06e0bd2` (merges of Antigravity slices PR `#180` Slice 1, PR `#181` Slice 2, and PR `#182` Slice 3 on `2026-11-14`; 0 GitHub reviews on `#179`–`#182`; plan PR `#179` still open, updated `2026-11-20` at `3af27a7`).
- **Verification method:** Strictly read-only inspection (`ps`, `launchctl list`, `stat`, `shasum -a 256`, `codesign --verify --strict`, JSON diff against git blobs, and sanitized log counts under `~/Library/Logs/the-triangle/client.error.log`). No live file was modified, no process was signalled, and the local messaging journal (`client/local/local-messaging.sqlite`) was not opened.
- **Note on digests and identifiers:** All live SHA-256 digests and opaque instance/registry IDs in this document are truncated to 8–12 hex characters; no tokens or secrets are recorded.

---

## 1. Reconstructed 2026-11-14 v15 Install Timeline (02:30–02:33 PST)

Between `2026-11-14 02:30:15` and `02:33:16` PST (`10:30`–`10:33Z`), the Swift helpers, `bin/mesh`, all four v15 runtime manifests/bundles, and `bin/triangle-local` were replaced in `~/Library/Application Support/The Triangle` without running `install-client-package.mjs`, without updating `package-install.json`, and without writing an install-verification record or rollback archive under `releases/` or `archive/`.

| Local Time (PST) | Artifact / Target | Observed State & Verification |
| :--- | :--- | :--- |
| `2026-11-14 02:30:15` | `bin/mesh` | Replaced (`mode 0755`, `13322` bytes, `sha256 d72f6299…`). |
| `2026-11-14 02:31:01` | `bin/triangle-mailbox`, `bin/triangle-client`, `install-manifest/*` | Rebuilt ad-hoc signed, file-custody Swift helpers installed via `scripts/install-macos-mailbox-helper.sh`: `triangle-mailbox` (`6d8bb5af…`, `3407296` bytes) and `triangle-client` (`0bac5dfe…`, `3309472` bytes) both pass `codesign --verify --strict --verbose=2`. Install manifests stamped `installedAt`/`verifiedAt: 2026-11-14T10:31:01Z`, `version: 1`, `identifier: "dev.thetriangle.mailbox"`, `signingMode: "public_ad_hoc"`, `credentialCustody: "file"`; `triangle-mailbox-install.json` records `cliSurface: ["watch-ensure", "watch-poll", "watch-status", "watch-revoke"]`. Both `.sha256` files match disk. |
| `2026-11-14 02:31:02` | `worker-runtime/codex.manifest.json` | Staged to **v15** (`manifest sha256 8e6301c8…`), bundle `36aaa25e…` (`93` artifacts, `nodeSHA256 5d9d3872…`). |
| `2026-11-14 02:31:03` | `worker-runtime/hermes.manifest.json` | Staged to **v15** (`manifest sha256 69bd544f…`), bundle `c89a464e…` (`93` artifacts, `nodeSHA256 5d9d3872…`). |
| `2026-11-14 02:31:04` | `worker-runtime/antigravity.manifest.json` | Staged to **v15** (`manifest sha256 043ada24…`), bundle `fa82facd…` (`93` artifacts, `nodeSHA256 5d9d3872…`). |
| `2026-11-14 02:33:09` | `worker-runtime/supervisor.manifest.json` | Staged to **v15** (`manifest sha256 f9bc30d0…`), bundle `009977d1…` (`91` artifacts, `nodeSHA256 5d9d3872…`). All **91 of 91** supervisor artifacts match the committed blobs of `06e0bd2` (`93/93` in each worker manifest likewise). |
| `2026-11-14 02:33:16` | `bin/triangle-local` | Replaced (`mode 0700`, `37874` bytes, `sha256 d27cc1ca…`). Differs from `scripts/triangle-worker-install.py` at `06e0bd2` only by the 3-line managed wrapper header (`#!/Library/Developer/CommandLineTools/usr/bin/python3`, `# TRIANGLE_MANAGED_LOCAL_WRAPPER_V1`, `TRIANGLE_LOCAL_APPLICATION_ROOT = ...`). (`scripts/triangle-worker-install.py` is unchanged between `06e0bd2` and `fd753b9`.) |

### What Was Omitted (Receipt Skew)

- `releases/0.2.0-identity.3` (`2026-11-12 22:25`), `bin/triangle` (`345eaf00…`), `~/.local/bin/triangle` (symlink), and `package-install.json` (`version: 0.2.0-identity.3`) were not updated.
- As a result, `package-install.json` matches disk on only **1 of 7** owned files (`bin/triangle`: `345eaf00…`) and mismatches on **6 of 7**:
  - `bin/triangle-client` (recorded `e3a1a24d…` vs disk `0bac5dfe…`)
  - `bin/triangle-mailbox` (recorded `37236d84…` vs disk `6d8bb5af…`)
  - `install-manifest/triangle-client-install.json` (`568a3442…` vs `095894fa…`)
  - `install-manifest/triangle-client.sha256` (`0dc94eec…` vs `73825fea…`)
  - `install-manifest/triangle-mailbox-install.json` (`fff193ce…` vs `4ff14ee8…`)
  - `install-manifest/triangle-mailbox.sha256` (`36eb0f1d…` vs `135b23da…`)
- The standard client package installer (`scripts/release/install-client-package.mjs`) refuses to overwrite any owned file whose disk hash disagrees with `package-install.json` (`Existing file is not an unchanged package-owned file`), so reconciling those 6 receipt entries (verified via the matching v1 helper install manifests and `.sha256` files) is a prerequisite for Gate P.
- No `releases/*install-verification.json` file or `archive/` backup newer than `ad4-h4` / `ad4-h3` (`2026-11-12`) exists for the v15 install.
- Because `releases/0.2.0-identity.3` was not upgraded, the live `triangle` CLI (`~/.local/bin/triangle`) predates Slices 1–3 (`AD.5` `identity destination` and `D4` `identity chat-map` commands are absent from the installed CLI).

---

## 2. Reconstructed 2026-11-14 Local-Messaging Outage Timeline (12:39–12:44 PST)

Approximately ten hours after the v15 install, `gravity2` — the sole configured recipient in `client/local-messaging.json` — was disabled, which halted the local messaging socket host:

| Local Time (PST) | Event / Evidence |
| :--- | :--- |
| `2026-11-14 12:39:49` (`20:39:49.548Z`) | `client/local` directory mtime updated (`12:39`); `client/local/local-control.sock` removed and never recreated. `~/Library/Logs/the-triangle/client.error.log` records the first `instance cycle failed (local_recipient_unavailable) [local_messaging_failed]`. |
| `2026-11-14 12:42:03` | Backup `client/backups/30966e45….json.bak-20261114-agy` saved (`profile: "gravity2"`, `deliveryMode: "worker"`, `runtimeAdapter: "antigravity"`, `enabled: true`). |
| `2026-11-14 12:43:24` (`20:43:24.100Z`) | 3 `instance cycle failed (invalid_local_config) [local_messaging_failed]` errors logged while config was rewritten. |
| `2026-11-14 12:43:50` | `client/local-messaging.json` rewritten (diff vs `local-messaging.json.bak-20261114-agy` from `2026-10-26 01:46:12`: `/wake/enabled` changed `true -> false`). |
| `2026-11-14 12:44:36` | `client/instances/30966e45….json` (`gravity2`) rewritten (diff vs `30966e45….json.bak-20261114-agy`: `/enabled` changed `true -> false`). |
| `2026-11-18 16:20:35` | LaunchAgent `dev.thetriangle.client` restarted during `cursor-acp` CPU-mitigation binding updates (`cursor-acp-runtime-binding.json.before-cpu-mitigation-20261118`): wrapper PID `25207` (`bin/triangle-mailbox run-supervisor`), child PID `25245` on the same v15 supervisor bundle `009977d1…`. `ghost` (`27234fb4…`, `headless-cursor-acp`) and `codex-headless` (`5eb92088…`, `headless-app-server`) remain `enabled: true`. |
| `2026-11-14` → `2026-11-20 19:37` | `client.error.log` continues logging `local_recipient_unavailable [local_messaging_failed]` roughly every 5 minutes (~275/day) alongside MESH `watch_rejected/402 [install_watch_failed]` (from `2026-11-19`, after earlier `watch_credential_invalid/401`). `client/local/local-control.sock` remains absent (`bin/triangle-local status` returns `connection_error`). |

### Root Cause & Owner Decision

- Under `06e0bd2`, `packages/agent-worker/src/local-messaging-host.mjs` throws `local_recipient_unavailable` when any recipient listed in `client/local-messaging.json` lacks an active runner (`gravity2` is `enabled: false`, so no runner is constructed for `30966e45…`), and `loadLocalMessagingConfig` rejects `recipients.length < 1` (`invalid_local_config`), so removing `gravity2` from `local-messaging.json` also prevents startup.
- On `2026-11-20`, the owner decided **"Yes, keep it off"** (`gravity2` remains disabled) and approved fixing the supervisor host (`#184`) rather than re-enabling `gravity2` or reassigning local messaging recipients.

---

## 3. Read-Only State & Dormancy Verification (2026-11-20)

Inspected without modifying any live state:

- **Identity registry (`identity/identity-registry-v1.json`, `registry-audit.jsonl`):** Untouched since `2026-11-12 22:46:41 PST` (AD.4 H4). `schema: "identity_registry_v2"`, `sequence: 5`, registry `sha256 14c15b87…`, audit `sha256 a3d6f75f…` (`bind`, `bind`, `bind`, `upgrade`, `alias_set`), `bindings: 3` (`ghost`, `gravity2`, `codex-headless`), `aliases: ["gemini"]`, `destinations: []`, `pairings: 0`.
- **Chat mappings (`client/local/chat-mappings-v1.json`):** Absent.
- **Reply identity (`client/reply-identity.json`):** `{ "version": 1, "enabled": false }`.
- **Local journal (`client/local/local-messaging.sqlite`):** File mtime `2026-11-12 22:52:49 PST` (`897024` bytes), untouched since AD.4 H4 (not opened).
- **Dormancy of `06e0bd2` review findings (`M1`–`M5`):** Because no destination rule (`destinations: []`), no chat-mapping store (`chat-mappings-v1.json` absent), and no `06e0bd2` `triangle` CLI (`0.2.0-identity.3` installed) exist live, review findings M1–M5 from `#180`–`#182` could not trigger on the live Mini.

---

## 4. Remediation Landed on `origin/main` (`fd753b9`, Not Yet Installed)

The following PRs are merged into `main` at `fd753b9` but are **not installed** on the Mini until owner-approved Gates S and P (see `docs/reviews/2026-11-20-restage-install-plan-fd753b9.md`):

| PR | Merge Commit | Summary | Effective Live At |
| :--- | :--- | :--- | :--- |
| `#183` | `7703860` (`2026-11-19`) | Fixes M1–M5 from the `#180`–`#182` review: ACL-first destination indistinguishability (`M1`), mapped-chat reply pinning & principal provenance (`M2`–`M3`), 31/32 review mutant tests (`M4`), `identity chat-map` store root & printed `--client-root` fixes (`M5`). | M1–M3 at Gate S; M5 at Gate P |
| `#184` | `fa70c89` (`2026-11-20`) | Host starts cleanly when configured local recipients are disabled (`unavailableRecipients`, `notice()` in owner log); new sends to disabled recipients fail `local_recipient_unavailable` before admission; queued work stays `queued_local` (`canRun`); `GROK_REJECTED_CODES` includes `local_recipient_unavailable`. | Gate S |
| `#185` | `fd753b9` (`2026-11-20`) | Blocks reply-ID reuse on new sends (`message_id_in_use` in server, journal, and `GROK_REJECTED_CODES`; rate reservation rolled back); messages whose ID a reply reused still answer exact retries. | Gate S |

### Related Restage Prep Documents

- Operator runbook (M6): `docs/triangle-client/identity-destinations-and-chat-maps.md`
- Scratch rehearsal report (`009977d1…` → `fd753b9`): `docs/reviews/2026-11-20-restage-prep-fd753b9-rehearsal.md`
- Owner-gated install plan (Gates S & P): `docs/reviews/2026-11-20-restage-install-plan-fd753b9.md`

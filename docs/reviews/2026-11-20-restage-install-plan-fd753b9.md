# Owner-Gated Install Plan: `fd753b9` Supervisor Restage (Gate S) & Client Package (Gate P)

- **Date prepared:** 2026-11-20 (Pacific)
- **Target commit:** `hannaoker/triangle-client` `main` at `fd753b9` (`fd753b9b8e11133bee98aff4b48f3a3e66bdc1b0`, merges `#183` + `#184` + `#185`)
- **Live state baseline:** `06e0bd2` v15 runtime bundles + `0.2.0-identity.3` client receipt (`6/7` skewed from the unrecorded `2026-11-14` v15 install)
- **Status:** **Not executed.** Both gates require explicit owner approval before any change to `~/Library/Application Support/The Triangle/`, `~/Library/LaunchAgents/`, or running processes.
- **Prerequisites & evidence:**
  - Unrecorded install & outage record: [`2026-11-20-v15-install-record.md`](2026-11-20-v15-install-record.md)
  - Scratch rehearsal report: [`2026-11-20-restage-prep-fd753b9-rehearsal.md`](2026-11-20-restage-prep-fd753b9-rehearsal.md)
  - Operator runbook (`M6`): [`../triangle-client/identity-destinations-and-chat-maps.md`](../triangle-client/identity-destinations-and-chat-maps.md)

---

## 1. Current Live Snapshot (`2026-11-20`, Read-Only Verified)

| Component | Current Live State on Mini |
| :--- | :--- |
| **LaunchAgent `dev.thetriangle.client`** | Running wrapper PID `25207` (`bin/triangle-mailbox run-supervisor`) -> child PID `25245` on supervisor bundle `009977d1…`. |
| **Supervisor manifest (`worker-runtime/supervisor.manifest.json`)** | Schema **v15** (`manifest sha256 f9bc30d0…`), bundle `009977d1…`, `91/91` artifacts equal to `06e0bd2`, `nodeSHA256 5d9d3872…` (Node `v22.22.3`). |
| **Worker manifests (`codex`, `hermes`, `antigravity`)** | All **v15** (`93/93` artifacts equal to `06e0bd2`): `codex` `36aaa25e…`, `hermes` `c89a464e…`, `antigravity` `fa82facd…`. While their 93-artifact bundle lists copy those files, worker entrypoint `packages/agent-worker/src/cli.mjs` (10-module import closure) reaches **0 of the 12** changed supervisor modules, so worker bundles do **not** need restaging in Gate S (consistent with AD.4 H2). |
| **Local messaging outage (`2026-11-14 12:39:49 PST`)** | `gravity2` (`30966e45…`, sole recipient in `client/local-messaging.json`) has `enabled: false` and `wake.enabled: false`; `06e0bd2` throws `local_recipient_unavailable`, leaving `client/local/local-control.sock` absent (`connection_error`). Owner decided: **"Yes, keep it off"** (`gravity2` stays disabled). `ghost` (`27234fb4…`) and `codex-headless` (`5eb92088…`) remain `enabled: true`. |
| **Client package receipt (`package-install.json`)** | Still `0.2.0-identity.3` (`2026-11-12`): matches disk on `1/7` (`bin/triangle`, `345eaf00…`) and mismatches on `6/7` (`bin/triangle-mailbox` `6d8bb5af…`, `bin/triangle-client` `0bac5dfe…`, and 4 `install-manifest/*` files from the `2026-11-14` `install-macos-mailbox-helper.sh` run, whose `.sha256` + `-install.json` v1 `public_ad_hoc`/`file` records match disk and pass strict codesign). |
| **Identity & routing dormancy** | `identity-registry-v1.json` untouched since `2026-11-12 22:46:41 PST` (`v2`, `sequence: 5`, `14c15b87…`, 3 bindings, 1 alias `gemini`, `destinations: []`, `pairings: 0`); `client/local/chat-mappings-v1.json` absent; `client/reply-identity.json` `{ version: 1, enabled: false }`; `local-messaging.sqlite` untouched since `2026-11-12 22:52:49 PST`. |

---

## 2. Gate S — Supervisor-Only Restage (`009977d1…` -> `fd753b9`)

**Requires explicit owner approval (for example: `"Go Gate S"`).**

### Scope & Invariants

- Restages **only** `worker-runtime/supervisor.manifest.json` from a clean `fd753b9` checkout using the existing verified Node runtime (`nodeSHA256 5d9d3872…`).
- Changes **only these 12 modules** in `packages/agent-worker/src/` (`0` added, `0` removed, manifest stays **v15**, Node unchanged, worker manifests untouched):
  - `client-supervisor-cli.mjs`
  - `grok-local-session.mjs`
  - `local-chat-mapping.mjs`
  - `local-messaging-dispatcher.mjs`
  - `local-messaging-host.mjs`
  - `local-messaging-interactive-session.mjs`
  - `local-messaging-journal-contract.mjs`
  - `local-messaging-journal.mjs`
  - `local-messaging-server.mjs`
  - `local-messaging-supervisor-seam.mjs`
  - `local-sender-authentication.mjs`
  - `unified-router.mjs`
- **Expected candidate bundle ID:** `cc602ac014586beff8ba08e24003115ea8ce16d646d2eef72457fa287ac26f4f` (`cc602ac0…`, observed twice across scratch restages with Node `5d9d3872…`). Abort before restarting if `validate-runtime` / `supervisor.manifest.json` reports any other bundle ID.
- Keeps `gravity2` disabled (`enabled: false`, `wake.enabled: false`), keeps `reply-identity.json` `enabled: false`, and leaves `identity-registry-v1.json` and `bin/triangle` untouched.

### Pre-Flight Snapshot & Backup (No Live Change Yet)

1. Confirm `gravity2` instance config (`enabled: false`), `reply-identity.json` (`enabled: false`), and live checksums of `identity-registry-v1.json`, `registry-audit.jsonl`, and `worker-runtime/supervisor.manifest.json`.
2. Verify `git -C "$CLEAN_SRC" rev-parse HEAD` equals `fd753b9b8e11133bee98aff4b48f3a3e66bdc1b0` in a clean detached checkout of `origin/main` (not the dirty primary checkout).
3. Save an immutable `0600` pre-Gate-S backup directory under `~/Library/Application Support/The Triangle/archive/restage-fd753b9-<UTC-STAMP>/` containing:
   - `supervisor.manifest.pre.json` (copy of `worker-runtime/supervisor.manifest.json`, expected `f9bc30d0…`)
   - `service-state.pre.json` (wrapper PID, child PID, baseline bundle ID `009977d1…`)

### Execution Sequence (Run Only After Owner `"Go Gate S"`)

```sh
APP="$HOME/Library/Application Support/The Triangle"
NODE_BIN="$APP/worker-runtime/bundles/009977d183b3f593ccb5fec7bc5472426696308625566200a76332040f45d10c/bin/node"
INST="$CLEAN_SRC/scripts/triangle-worker-install.py"

# 1. Stage and validate v15 supervisor bundle
REC=$(/usr/bin/python3 "$INST" stage-runtime \
  --application-root "$APP" \
  --project-root "$CLEAN_SRC" \
  --agent supervisor \
  --node "$NODE_BIN")
/usr/bin/python3 "$INST" validate-runtime \
  --manifest "$APP/worker-runtime/supervisor.manifest.json" \
  --agent supervisor
```

Check before restarting:
- `"projectRoot"` in `$APP/worker-runtime/supervisor.manifest.json` ends in `cc602ac014586beff8ba08e24003115ea8ce16d646d2eef72457fa287ac26f4f`.
- `version === 15` and `nodeSHA256 === 5d9d3872911e2340a43b707962e68143de8a4e8d54628845c0c4f2de1fb7cd5c`.
- **If validation or bundle ID check fails:** immediately run `/usr/bin/python3 "$INST" rollback-runtime "$REC"` (no restart needed).

```sh
# 2. Restart LaunchAgent with readiness verification (ceiling 60000 ms)
TRIANGLE_READY_TIMEOUT_MS=60000 /bin/bash "$CLEAN_SRC/scripts/triangle-client-service.sh" start
```

### Post-Restart Readiness & Invariant Verification (Before `commit-runtime`)

Verify all of the following read-only checks before committing:
1. **LaunchAgent & socket restored:** `launchctl print "gui/$(id -u)/dev.thetriangle.client"` shows `state = running` with new PIDs on bundle `cc602ac0…`, and `$APP/client/local/local-control.sock` exists (`0600` socket).
2. **`triangle-local status` health:**
   - `running: true`
   - `unavailableRecipients: ["gravity2"]`
   - `replyIdentity: { enabled: false, ... }` (exact disabled policy)
   - `chatBinding.binding === "unbound"`
   - `router.registry.state === "ok"`, `schema: "identity_registry_v2"`, `sequence: 5`
3. **Owner log notice:** `~/Library/Logs/the-triangle/` contains a single `triangle_client_local_recipient_not_running` notice per startup cycle for `gravity2` rather than `local_recipient_unavailable` crash loops.
4. **Negative refusal check (zero worker execution):**
   - `$APP/bin/triangle-local send --to gravity2 --text "gate-s-unavailable-check" ...` fails closed with `local_recipient_unavailable` and creates no journal row (`status --message-id` returns `not_found`).
   - Do **not** run any send that would invoke `gravity2` (it remains disabled).
5. **Preserved state:** `identity-registry-v1.json` (`14c15b87…`) and `registry-audit.jsonl` (`a3d6f75f…`) unchanged; worker manifests (`codex`, `hermes`, `antigravity`) unchanged; `client.log` / `client.error.log` free of new `local_messaging_failed` errors.

If all checks pass, commit the staged runtime and record the Gate S evidence under `$APP/releases/`:

```sh
/usr/bin/python3 "$INST" commit-runtime "$REC"
```

### Gate S Rollback Paths

- **Pre-commit failure (during or right after restart, while `$REC` exists):**
  ```sh
  /usr/bin/python3 "$INST" rollback-runtime "$REC"
  TRIANGLE_READY_TIMEOUT_MS=60000 /bin/bash "$CLEAN_SRC/scripts/triangle-client-service.sh" start
  ```
- **Manual post-commit rollback (bundle `009977d1…` remains on disk after `commit-runtime`, and `supervisor.manifest.pre.json` is saved in `$ARCHIVE_DIR`):**
  ```sh
  /bin/cp -p "$ARCHIVE_DIR/supervisor.manifest.pre.json" "$APP/worker-runtime/supervisor.manifest.json"
  /bin/chmod 600 "$APP/worker-runtime/supervisor.manifest.json"
  /usr/bin/python3 "$INST" validate-runtime \
    --manifest "$APP/worker-runtime/supervisor.manifest.json" \
    --agent supervisor
  TRIANGLE_READY_TIMEOUT_MS=60000 /bin/bash "$CLEAN_SRC/scripts/triangle-client-service.sh" start
  ```
  (Note: because baseline `009977d1…` expects `gravity2` to have a running adapter, rolling back to `009977d1…` while `gravity2` stays `enabled: false` returns local messaging to the `local_recipient_unavailable` paused state.)

---

## 3. Gate P — Client Package Install (`0.2.0-identity.3` -> `fd753b9` Release)

**Requires explicit owner approval (`"Go Gate P"`) AND an explicit owner choice between Option P-Plain and Option P-Auth.**

### Owner Build Choice (Required Before Building the Gate P Package)

| Option | Build Command Flag | Capabilities Live After Gate P | Pre-Install Requirement |
| :--- | :--- | :--- | :--- |
| **Option P-Plain** | *(omit `--owner-approval`)* | Updates CLI (`~/.local/bin/triangle` -> `releases/<ver>`), helpers (`triangle-mailbox`, `triangle-client`), `identity destination` / `identity chat-map` **read-only planning**, `status --identity`, and `doctor --identity`. Any `--confirm` for `identity destination` / `identity chat-map` / `identity revoke` **fails closed** with `owner_approval_unavailable`. | Standard build + scratch `--test-root` pass. |
| **Option P-Auth** | `--owner-approval identity` | Same as P-Plain **plus** packaged `bin/triangle-owner-approval` (`commands: ["identity.revoke", "identity.destination", "identity.chat-map"]`) enabling macOS `LAContext` Touch ID / password `--confirm` writes. | **Blocking pre-gate (Plan `#179` §5 step 4):** Extract release into a disposable `/private/tmp` dir on the Mini and run **physical macOS Touch ID / password acceptance (`cancel`, `apply`, `interrupt`, `expire`)** across the commands before any live install. |

Note: The rehearsal package `0.2.0-restage-rehearsal.1` was a plain (`P-Plain`, non-`--owner-approval`) build used to validate `fd753b9`. At Gate P, build a clean versioned package from `fd753b9` matching the chosen option (using `--node "$NODE_BIN"` to preserve the verified Node `5d9d3872…` runtime):

```sh
node "$CLEAN_SRC/scripts/release/build-client-package.mjs" \
  --version <RELEASE_VERSION> \
  --node "$NODE_BIN" \
  [--owner-approval identity] \
  --output "$PKG_OUT"
```

Verify `--testOnly === false`, verify `<archive>.sha256`, run `check-release-readiness.sh --mode public` on the extracted helpers, and (if Option P-Auth) run the disposable Touch ID/password physical acceptance suite before touching the live root.

### Step P0 — Pre-Install Receipt Reconciliation (Mandatory Because `6/7` Live Entries Are Skewed)

`install-client-package.mjs` refuses to overwrite any owned file whose disk SHA-256 differs from `package-install.json` (`0.2.0-identity.3` vs the `2026-11-14` `install-macos-mailbox-helper.sh` files). Before running `triangle-install-<ver>.sh`:

1. Save a `0600` backup of `$APP/package-install.json`, `$APP/bin/triangle*`, and `$APP/install-manifest/*` under `$ARCHIVE_DIR/gate-p-pre/`.
2. Independently verify the `6` live files that differ from `package-install.json`:
   - `codesign --verify --strict --verbose=2 "$APP/bin/triangle-mailbox" "$APP/bin/triangle-client"` passes.
   - Both `$APP/install-manifest/triangle-{mailbox,client}-install.json` have `version === 1`, `signingMode === "public_ad_hoc"`, `credentialCustody === "file"`, and `sha256` equal to the disk binary SHA-256 and `.sha256` file.
   - `bin/triangle` (`345eaf00…`) matches `package-install.json` (`1/7`) and `~/.local/bin/triangle` resolves canonically to `$APP/bin/triangle`.
3. Update **only** those 6 helper/manifest entries in `package-install.json` atomically (`0600`), matching the exact verification gate rehearsed cleanly in step `D1`. Abort Step P0 if any of the 6 files fails verification.

### Gate P Install, Restart, & Post-Install Verification

1. Run the installer without `--test-root`:
   ```sh
   /bin/bash "$PKG_OUT/triangle-install-<RELEASE_VERSION>.sh" \
     --archive "$PKG_OUT/triangle-client-<RELEASE_VERSION>-darwin-arm64.tar.gz" \
     --sha256 "$ARCHIVE_SHA256"
   ```
   Confirm JSON output `"state": "installed"`.
2. Run release-readiness public check against the installed `$APP/bin/triangle-mailbox` and `$APP/bin/triangle-client`:
   ```sh
   /bin/bash "$CLEAN_SRC/scripts/release/check-release-readiness.sh" \
     --mode public \
     --artifact "$APP/bin/triangle-mailbox" \
     --artifact "$APP/bin/triangle-client"
   ```
3. Restart `dev.thetriangle.client` so the running helper and supervisor match the newly installed binaries:
   ```sh
   TRIANGLE_READY_TIMEOUT_MS=60000 /bin/bash "$CLEAN_SRC/scripts/triangle-client-service.sh" start
   ```
4. Verify live health & CLI surfaces:
   - `package-install.json` lists `<RELEASE_VERSION>` and **all** owned files (`7/7` in P-Plain; `8/8` if P-Auth adds `triangle-owner-approval`, plus release tree) match disk hashes.
   - `triangle --help` lists `identity destination set|clear` and `identity chat-map set|confirm|revoke`.
   - `triangle status --identity --client-root "$APP/client"` reports `v2` seq `5`, `gemini → gravity2`, `Destinations: none`, and `refusals` check cleanly.
   - Read-only refusal plan check (writes nothing):
     - `triangle identity destination set gravity2 --harness claude --workspace <EXISTING_DIR> --client-root "$APP/client" --json` -> `destination_target_has_runner`
     - `triangle identity chat-map set --client-root "$APP/client" ...` fails closed cleanly if wrong args / missing principal or plans against `--store-root "$APP/client/local"`.
   - `"$APP/bin/triangle-local" status` continues reporting `unavailableRecipients: ["gravity2"]`, `chatBinding.binding === "unbound"`, and `router.registry.state === "ok"`.

### Gate P Rollback Constraint (`v15` Helpers Last)

- **Critical v15 ordering rule (`identity-destinations-and-chat-maps.md`):** If rolling back to a pre-v15 helper (for example `0.2.0-identity.3`, whose `WorkerLauncher` rejects manifest version `15`), you **must** revert `worker-runtime/*.manifest.json` back to v14 **and** remove any `client/local/chat-mappings-v1.json` **before** downgrading `bin/triangle-mailbox` / `bin/triangle-client` (helpers always install first and roll back last).
- To roll back only a Gate P install while remaining on v15 (`fd753b9` supervisor): restore the saved `0600` pre-Gate-P `package-install.json` (or reconciled receipt), `bin/triangle`, `bin/triangle-mailbox`, `bin/triangle-client`, and `install-manifest/*` from `$ARCHIVE_DIR/gate-p-pre/` (after checking their `.sha256` + `-install.json` digests and strict codesign), then run `TRIANGLE_READY_TIMEOUT_MS=60000 bash "$CLEAN_SRC/scripts/triangle-client-service.sh" start`.

---

## 4. Explicitly Deferred / Out of Scope

| Item | Status & Reason |
| :--- | :--- |
| **`gravity2` & `wake.enabled`** | Stays `enabled: false` per owner instruction (`2026-11-20`: `"Yes, keep it off"`). No wake or positive worker canary runs in Gates S/P. |
| **`client/reply-identity.json`** | Stays `{ version: 1, enabled: false }` until separately opted in. |
| **PR `#186` (`claude/supervisor-warn-notices`)** | Separate stacked draft PR (`warn`/`notice` refinement); untouched by restage prep, retarget/review only on owner instruction. |
| **Plan PR `#179` (`3af27a7`)** | Owner's call whether to merge or close. |
| **Follow-up hardening PR (`L1`–`L10`, `K18`–`K20`)** | Low review findings from `#180`–`#183` and `fd753b9` (including whether aliases follow destination rules) deferred to a separate follow-up PR. |
| **Remote branch pruning** | Keep merged remote branches untouched for at least 24 hours; prune only after owner approval. |

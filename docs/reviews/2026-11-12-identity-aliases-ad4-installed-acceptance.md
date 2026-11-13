# Identity aliases (AD.4): installed acceptance, H2 to H4

- **Dates:** 2026-11-12 (Pacific); install and verification records are stamped 2026-11-13 06:15Z to 06:53Z UTC.
- **Plan:** `docs/plans/2026-11-10-identity-aliases-and-destination-rules-plan.md`, piece AD.4, section 6 (gates H2 to H4), and section 8.
- **Source:** `hannaoker/triangle-client` `main` at `738bd65` (merge of PR #177: AD.0 to AD.3 complete).
- **Status:** Gates H2, H3, and H4 are **done** on the installed system, including restart persistence and one live positive canary to `gemini` (`gravity2`). The owner chose to **keep `gemini` active** on `gravity2`.
- **Evidence kept outside the repository (mode `0600`, under `~/Library/Application Support/The Triangle/`):**
  - Records: `releases/ad4-h2-install-verification.json`, `releases/ad4-h3-install-verification.json`, `releases/ad4-h4-install-verification.json`
  - Archives: `archive/ad4-h2-20261113T061409Z/`, `archive/ad4-h3-20261113T062505Z/` (earlier aborted H3 script attempts left prior rollback archives under `archive/ad4-h3-*`)

## 1. Gates

| Gate | Result |
| :--- | :--- |
| H1 merge AD.0 to AD.2 | done (#172, #173, #176); AD.3 merged as #177 (`738bd65`) |
| H2 supervisor restage | **installed** 2026-11-13 06:15Z (owner `"proceed"`): bundle `c01e78bb…` → `45c2317e…`, manifest v14, 11 modules; 4 negative probes passed |
| H3 client package | **installed** 2026-11-13 06:25Z (owner `"yes"`): plain build `0.2.0-identity.3` (157 files), 7/7 receipt matched disk, service restarted, read-only plans `ready` with supervisor `honored` |
| H4 first alias, probes, restart, canary | **done** 2026-11-13 06:46Z–06:53Z (owner applied `gemini → gravity2` in terminal, then `"run canary and restart check, keep gemini"`): `sequence 4 → 5`, `discover` lists `gemini` on `gravity2` only, 6 CLI plan refusals + 4 negative send probes passed, LaunchAgent restart preserved alias, canary ping `OK` (`resolved.alias` `0 → 1`) |

## 2. H2: supervisor-only restage

From `origin/main` (`738bd65`), staged against a scratch dry-run first and then live via `stage-runtime`, `validate-runtime`, service restart, and `commit-runtime`:

- **Artifact diff:** manifest stays v14 (`90` artifacts), `nodeSHA256` unchanged (`5d9d3872…`), bundle `45c2317e…` (exact match to AD.3 rehearsal). Exactly the 11 modules of plan section 6 changed (`grok-local-session`, `identity-primitives`, `identity-registry`, `local-messaging-cli`, `local-messaging-client`, `local-messaging-journal`, `local-messaging-protocol`, `local-messaging-server`, `recipient-resolver`, `router-registry-snapshot`, `unified-router`), 0 added, 0 removed.
- **Launchd restart & invariants:** restarted under quiet gate (`wrapperPid: 42150`, `pid: 42755`). `triangle-local status` reported `router.enabled: true`, `registry.state: "ok"`, `sequence: 4`, `schema: "identity_registry_v2"`, `addressForms: ["alias", "id", "principal"]`, `rootSha256: "987e727a…"`. Journal (`held: 2`, `queued: 1`, `queued_local: 1`, `pendingReplies: 14`, `executing: 0`, `completed: 18`), `wake.deliveryState: "idle"`, `discover`, `list-session-grants`, config files, and `identity/` file hashes were identical before and after.
- **Pre-alias negative set (owner CLI, none able to run a worker):** unknown principal (`agent_0000…`) → `recipient_not_found`, `peer_` id (`peer_0000…`) → `recipient_not_allowed`, unknown alias-shaped name (`nobody`) → `recipient_not_allowed`, non-local bound principal (`ghost`, `agent_e19ead63…`) → `route_unavailable`. All 4 returned `not_found` on journal status lookup; `errors.recipient_not_found` moved `0 → 1`, `errors.route_unavailable` moved `0 → 1`, `resolved` stayed `{principal: 0, id: 0, alias: 0}`, and journal counts were unchanged.
- **Manual rollback path (documented in H2 record):** restore `archive/ad4-h2-20261113T061409Z/supervisor.manifest.pre.json` (mode `0600`) and restart `dev.thetriangle.client`; bundle `c01e78bb…` remained on disk.

## 3. H3: plain client package (`0.2.0-identity.3`)

Built from a clean detached worktree of `origin/main` (`738bd65`) without `--owner-approval` (`157` files, archive sha256 `dd5b4477…`), verified first in a scratch `--test-root`, then installed live via `triangle-install-0.2.0-identity.3.sh`:

- **Pre-install receipt check:** `package-install.json` (`0.2.0-identity.2`) matched disk on `7/7` owned files (`0` mismatches).
- **Harness retries before success:** the first two `install-h3.py` runs rolled back cleanly to `0.2.0-identity.2` on script bugs in `install-h3.py` itself (parsing multi-line JSON from `upgrade-registry --json` and asserting `advice.supervisor` on a refused alias plan), and the third exited immediately before restart because `TRIANGLE_READY_TIMEOUT_MS=90000` exceeded `scripts/triangle-client-service.sh`'s `60000` ms ceiling (`invalid readiness timeout`). With `TRIANGLE_READY_TIMEOUT_MS=60000`, live install and service restart succeeded cleanly (`wrapperPid: 60576`, `pid: 61776`, bundle `45c2317e…`). Detached build worktree `/private/tmp/ad4-h3-src` was removed afterward.
- **Post-install verification:** `package-install.json` updated to `0.2.0-identity.3` (`7/7` owned files match disk), `157/157` release manifest files match sha256, `codesign --verify --strict` passed on `triangle-mailbox` (`37236d84…`) and `triangle-client` (`e3a1a24d…`), and `~/.local/bin/triangle` symlink + `dev.thetriangle.client.plist` are unchanged.
- **Read-only CLI checks against live `--client-root`:**
  - `triangle --help` includes `identity alias set`, `identity alias clear`, `upgrade-registry`, `restore-registry`, and `revoke`.
  - `triangle identity upgrade-registry --json` → `ready: false`, `refusals: ["registry_already_v2"]`.
  - `triangle identity alias set claude gravity2 --json` → `ready: false`, `refusals: ["alias_name_reserved"]`.
  - `triangle identity alias set testalias gravity2 --json` → `ready: true`, `refusals: []`, `advice.supervisor.state: "honored"`.
- **Invariants:** journal (`held: 2`, `queued: 1`, `queued_local: 1`, `pendingReplies: 14`, `executing: 0`, `completed: 18`), `wake.deliveryState: "idle"`, `router.registry` (`sequence: 4`), `discover`, `list-session-grants`, configs, `identity/`, and `identity-backups/` were unchanged.

## 4. H4: first alias (`gemini`), probes, restart, and live canary

1. **Apply (`2026-11-13T06:46:41.525Z`):** Owner ran the read-only plan (`planId: 48336156…`) and applied `triangle identity alias set gemini gravity2 --confirm …` from an interactive terminal. Registry moved `sequence 4 → 5`, creating `aliases.gemini` at `generation: 5` targeting `agent_3764a37c…` (`bind_d36618f5…`, `gravity2`; sha256 `14c15b87…`).
2. **Live reload & discovery (no restart):** `triangle-local status` showed the running supervisor picked up `registry.sequence: 5` (`addressForms: ["alias", "id", "principal"]`). `triangle-local discover` listed `"aliases": ["gemini"]` inside `send` (with `addressKinds: ["id", "principal"]` unchanged) for **only** `gravity2`'s entry (`30966e45…`) and no `aliases` field on the other three unbound entries.
3. **Read-only CLI plan refusals & clear preview:**
   - `set gravity2 gravity2` → `alias_collides_with_label` (exit 1)
   - `set claude gravity2` → `alias_name_reserved` (exit 1)
   - `set gemini gravity2` → `alias_exists` (exit 1)
   - `set myghost ghost` → `alias_target_not_local` (exit 1)
   - `set mycodex codex-headless` → `alias_target_not_local` (exit 1)
   - `set BadName gravity2` → `alias_name_invalid` (exit 1)
   - `clear gemini` (plan only) → `ready: true`, `existing.profile: "gravity2"`, `currentState: "active"` (exit 0)
4. **Negative send probes (`triangle-local send`, none able to run a worker):** `nobody` (`recipient_not_allowed`), `agent_0000…` (`recipient_not_found`, `errors.recipient_not_found` `0 → 1`), `peer_0000…` (`recipient_not_allowed`), `ghost` `agent_e19ead63…` (`route_unavailable`, `errors.route_unavailable` `0 → 1`). All 4 returned `not_found` on journal status lookup; `router.resolved` stayed `{principal: 0, id: 0, alias: 0}`; journal, registry sha256 (`14c15b87…`), and `list-session-grants` stayed identical.
5. **Restart persistence:** Restarted `dev.thetriangle.client` via `scripts/triangle-client-service.sh start` with `TRIANGLE_READY_TIMEOUT_MS=60000` (`wrapperPid` `60576 → 77043`, child `pid` `61776 → 77734`, bundle `45c2317e…`). Post-restart `status` kept `registry.sequence: 5` and journal unchanged; `discover` still listed `send.aliases: ["gemini"]` on only `gravity2`'s entry.
6. **Live positive canary (`triangle-local send --to gemini --wait-ms 180000`):** Sent one minimal ping (`messageId: e1d63de3…`, `requestId: e1d63de3…-r`). `admission` returned `status: "queued_local"`, `target: {via: "principal", principal: "agent_3764a37c…", profile: "gravity2"}`; `gravity2` replied `"OK"` (`rep-5569031b…`, sender `30966e45…`). `triangle-local status --message-id` reported `state: "completed"` with `target: {via: "principal", ...}`. Neither `admission`, `replies`, nor journal `status` contained `"gemini"`. `router.resolved.alias` incremented `0 → 1` (`principal: 0`, `id: 0`, all error counters `0`). Consuming `rep-5569031b…` and acknowledging canary wake `2bca560c…` (gen `1`) returned the journal cleanly to `completed: 19` (`18 → 19`), `held: 2`, `queued: 1`, `queued_local: 1`, `pendingReplies: 14`, `executing: 0`, and `wake.deliveryState: "idle"`.

## 5. Plan section 8, item by item

| Item | State |
| :--- | :--- |
| (1) after H2, with no aliases, D1.5 negative set, read-only status/backlog, `addressForms` | **done** (section 2) |
| (2) scratch rehearsal AD.3 passes | **done** (31 of 31, PR #177) |
| (3) after H3 and H4, `discover` shows the alias on only the target entry | **done** (`gemini` on `gravity2` `30966e45…` only; section 4.2) |
| (4) negative probes (`unknown alias-shaped`, `profile name`, `claude`, existing alias, non-local targets) | **done** (sections 4.3 and 4.4; see section 6 for the unpermitted-sender gap) |
| (5) one positive canary, with its own yes | **done** (`--to gemini` resolved `resolved.alias` `0 → 1`, replied `OK`; section 4.6) |
| (6) backlog isolation (`held 2`, `queued 1`, `queued_local 1`, `pendingReplies 14`) | **done** (unchanged across H2, H3, H4, restart, and post-canary cleanup) |
| (7) `alias clear` returns to starting state | **skipped by owner choice** (owner chose to keep `gemini`; dry-run `clear` plan `ready: true` verified live, and `clear` + `restore-registry` exercised in AD.3 steps E5, G1, G2) |
| (8) restart keeps the alias | **done** (`77043`/`77734` on `45c2317e…`, `sequence: 5`, `discover` preserved `gemini`; section 4.5) |

## 6. Limits and follow-ups

- **Invisible alias live gap (plan §8):** The only bound local recipient (`gravity2`) is permitted to the owner CLI, so a live send from an unpermitted sender targeting `gemini` cannot run without adding a restricted test sender. Invisibility for unpermitted senders is established in AD.1 wire tests and AD.3 rehearsal step E6; live `nobody`, unknown `agent_`, `peer_`, and non-local `ghost` probes all failed closed without queuing or running a worker.
- **`alias clear` not applied live:** Kept `gemini` active per owner instruction; `clear` is verified live at plan level (`ready: true`) and applied end-to-end in AD.3.
- **Unfinished backlog & deferred work:** Standing backlog (`held 2`, `queued 1`, `queued_local 1`, `pendingReplies 14`) remains untouched. Destination rules and inbound adapters (plan §11) remain deferred and not started.
- **Cleanup:** Remote branch `origin/claude/identity-aliases-rehearsal` (PR #177) was left untouched pending owner approval after retention window; earlier failed-attempt H3 archives (`archive/ad4-h3-*`) and build folder `/private/tmp/ad4-h3-pkg-out` remain on disk outside git.

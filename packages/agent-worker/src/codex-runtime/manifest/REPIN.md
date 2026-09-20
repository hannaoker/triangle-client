# Re-pinning the Codex runtime manifest (Mini Darwin)

Phase 0 pinned sandbox and approval enum allowlists from the upstream App Server
v2 JSON Schema artifact because this Linux environment has no bundled Codex
binary (`ChatGPT.app` Resources `codex`).

## Phase 1 status (shadow single-slot)

| Item | Status |
| --- | --- |
| `sharedHomeConcurrency.status` | **`passed`** (Mini live) |
| `forcedPoolSize` | **`1`** (Phase 1 single-slot cap — do not raise until Phase 3) |
| `fallbackToUserCodexHomeForbidden` | **`true`** |
| Global `featureFlags.headlessRuntime` | **`false`** (production unchanged) |
| Shadow test profile opt-in | See design doc Phase 1 operator note |

### Operator: enable Phase 1 shadow test profile only

1. Create an **isolated** test profile (never production Bob / mcp-interactive):
   - `runtimeAdapter: "codex-app-server"`
   - `runtimeMode: "headless"`
   - `shadowTestProfile: true`
   - `profileId: "<your-test-profile-id>"`
2. Enable the shadow path without flipping the global flag:

   ```sh
   # all shadow-shaped profiles on this host
   export TRIANGLE_HEADLESS_SHADOW_ENABLE=1

   # or allowlist one profile id
   export TRIANGLE_HEADLESS_SHADOW_PROFILES=codex-shadow-test
   ```

3. Keep dedicated `TRIANGLE_CODEX_HOME` (never `~/.codex`). Leave desktop
   `appServerWake` / mcp-interactive profiles untouched.
4. Phase 1 does **not** enable desktop handoff or multi-slot pools.

## Gap

| Item | Status |
| --- | --- |
| Upstream schema commit | Pinned in `runtime-manifest.json` → `provenance.sourceCommit` |
| Bundled Codex binary version | **Set on Mini** — `codex-cli 0.155.0-alpha.9.2` |
| Live `clientUserMessageId` survival through `thread/read` | **Blocked** — still open on Mini |
| Dual App Server shared `CODEX_HOME` concurrency | **Passed** — Mini live 2026-09-20 (seed turns then resume/restart) |

## Mini re-pin procedure

1. Resolve the exact bundled binary used by Triangle Desktop / ChatGPT.app, for
   example:
   `/Applications/ChatGPT.app/Contents/Resources/codex`
2. Record `codex --version` (or equivalent) into
   `provenance.bundledCodexBinary`.
3. Prefer generating enums from that binary when it exposes schema/export:

   ```sh
   node packages/agent-worker/scripts/generate-codex-runtime-manifest.mjs \
     --codex-bin /Applications/ChatGPT.app/Contents/Resources/codex \
     --out packages/agent-worker/src/codex-runtime/manifest/runtime-manifest.json
   ```

4. If the binary cannot emit schemas, re-fetch the matching upstream
   `codex_app_server_protocol.v2.schemas.json` for the **same** Codex version
   commit/tag and run the generator with `--schema-url` / `--source-commit`.
5. Run the focused suite:

   ```sh
   node --test packages/agent-worker/test/codex-runtime/*.test.mjs
   ```

6. Only after the shared-home concurrency probe passes on Darwin may pool size
   leave `1` and desktop handoff leave disabled. A failed probe must never fall
   back to `~/.codex`.


## Mini evidence log (2026-09-20 PT)

- Bundled binary: `/Applications/ChatGPT.app/Contents/Resources/codex` -> `codex-cli 0.155.0-alpha.9.2`
- Schema re-pin: openai/codex tag `rust-v0.155.0-alpha.9.2` commit `4607249e430dac1c961df4dc615beae88e33cec8`
- Node Phase 0 suite: 17/17 after Darwin `realpath` test expects (`/var` vs `/private/var`)
- Live shared-home probe (`live: true`, dual `codex app-server` stdio, dedicated TRIANGLE home): **failed** on `thread/resume` with `no rollout found for thread id ...` after concurrent slot start. Dedicated home was created and wrote sqlite/locks; do **not** promote `sharedHomeConcurrency.status` to `passed`. Recovery must not use `~/.codex`.
- Live `clientUserMessageId` survival through real `thread/read`: **not yet run** (blocked on stable live probe/session).

### Root cause (2026-09-20 follow-up)

Live Codex App Server (confirmed by upstream
`thread_resume_rejects_unmaterialized_thread` and Claude Code plugin issue
[#31158](https://github.com/openai/codex/issues/31158)) creates the durable
rollout **lazily on the first `turn/start`**, not at `thread/start`. Calling
`thread/resume` immediately after `thread/start` returns
`rpc_error: no rollout found for thread id …` even with `ephemeral: false`.

This matches the Mini symptom. SQLite/WAL + `thread-writer-locks/` after start
only show partial bookkeeping; they do not imply a resumeable rollout.

Fix in-tree: the shared-home probe now runs a seed `turn/start` and waits for
`turn/completed` on each slot before any resume or forced restart, matching the
desktop mint path in `native-desktop-wake-experiment.mjs`. Synthetic fakes use
`requireMaterializedRollout: true` plus a shared materialized-id store so this
ordering is regression-covered without ChatGPT.app.

**Update:** Mini live probe later **passed**; manifest `sharedHomeConcurrency.status`
is now `passed`. Phase 1 still keeps `forcedPoolSize: 1` (single-slot shadow).
Do **not** raise `forcedPoolSize` until Phase 3. Desktop handoff remains disabled.

### Mini live re-run steps (historical; probe already passed)

Prerequisites:

1. Dedicated home already exists (or will be created by the probe):
   `~/Library/Application Support/The Triangle/model-state/codex-runtime-home`
2. That home is authenticated via a supported Codex login for the Triangle
   runtime (seed turns require model auth). Never copy cookies into the helper
   and never fall back to `~/.codex`.
3. Bundled binary:
   `/Applications/ChatGPT.app/Contents/Resources/codex`

Commands:

```sh
cd /path/to/triangle-client
node --test packages/agent-worker/test/codex-runtime/*.test.mjs

CODEX_BIN="/Applications/ChatGPT.app/Contents/Resources/codex" \
  node packages/agent-worker/scripts/run-shared-home-concurrency-probe.mjs --live
```

Promotion rules (Mini operator only):

- If `status === "passed"`: update `runtime-manifest.json`
  `sharedHomeConcurrency.status` to `"passed"` and keep
  `fallbackToUserCodexHomeForbidden: true`. **Phase 1 still keeps
  `forcedPoolSize: 1`**; only Phase 3 may raise the pool cap.
- If seed turns fail (auth / network): leave status `unproved` / `failed`; fix
  dedicated-home login; do **not** point `CODEX_HOME` at `~/.codex`.
- If resume still fails after successful seeds: capture stderr (redacted) and
  home layout (`sessions/`, sqlite, locks) for a follow-up; still no user-home
  fallback.

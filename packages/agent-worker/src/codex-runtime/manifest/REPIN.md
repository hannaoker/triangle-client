# Re-pinning the Codex runtime manifest (Mini Darwin)

Phase 0 pinned sandbox and approval enum allowlists from the upstream App Server
v2 JSON Schema artifact because this Linux environment has no bundled Codex
binary (`ChatGPT.app` Resources `codex`).

## Phase 1 status (shadow single-slot → Phase 3 supersedes pool size)

| Item | Status |
| --- | --- |
| `sharedHomeConcurrency.status` | **`passed`** (Mini live) |
| `forcedPoolSize` | **`4`** (Phase 3 absolute cap; shadow **preferred** stays **2**) |
| `fallbackToUserCodexHomeForbidden` | **`true`** |
| Global `featureFlags.headlessRuntime` | **`false`** (production unchanged) |
| Shadow test profile opt-in | See design doc Phase 1 operator note |

## Phase 2 status (durable recovery, shadow only)

| Item | Status |
| --- | --- |
| Durable lease acquire / renew / CAS / no-steal | **Shipped** (`execution-lease.mjs`) |
| Inter-process lease CAS lock (fail closed) | **Fixed** (`withProfileLock` + concurrent two-process test) |
| Cancel via owning slot handle (no second acquire) | **Fixed** (`getActiveHandle` / active delivery) |
| Turn timeout → interrupt + slot restart + quarantine | **Fixed** |
| Durable `replyEventId` required before reply_persisted/ack | **Fixed** (fail closed) |
| Execution epoch + stale-epoch ignore | **Shipped** |
| Restart completion reconciliation (ack-only) | **Shipped** (`completion-reconciler.mjs`) |
| Receipt-only (no model / no MESH reply) | **Shipped** |
| Crash-boundary + reconnect tests | **Shipped** (synthetic fake App Server) |
| Helper `conversationStoreEnabled` | **Still false** (production inactive) |
| Node durable store for shadow/CI | **Opt-in** via `createDurableConversationStore({ enabled: true })` — mirrors helper schema; no MESH secrets |

Phase 2 does **not** flip production defaults or enable desktop handoff. Keep
dedicated `TRIANGLE_CODEX_HOME`; never fall back to `~/.codex`.

## Phase 3 status (bounded pool, shadow / test only)

| Item | Status |
| --- | --- |
| Preferred pool size for enabled shadow | **`2`** (default) |
| Manifest / guard absolute cap | **`forcedPoolSize: 4`** (do **not** default preferred to 4) |
| Keep shadow at 1 slot | Set `codexPool.preferredSize: 1` (manifest cap may stay 4) |
| Sticky assignment | Prefer registry `lastWorkerSlotId` when healthy; else failover |
| FIFO / overload | `waitMs: 0` → `pool_overloaded` fail closed; bounded wait is FIFO |
| Circuit breaker | Per-slot exponential backoff + jitter; `pool_circuit_open` when all open |
| Cancel / timeout with multi-slot | Owning handle / `getActiveHandle({ slotId })`; restart owning slot only |
| Global `featureFlags.headlessRuntime` | **`false`** |
| Desktop handoff | **Still disabled in Phase 3** (see Phase 4) |

Phase 3 raises the pool **only** for shadow/test profiles behind the existing
opt-in. Production desktop / mcp-interactive paths must not flip to multi-slot.

### Operator: enable Phase 1–3 shadow test profile only

1. Create an **isolated** test profile (never production Bob / mcp-interactive):
   - `runtimeAdapter: "codex-app-server"`
   - `runtimeMode: "headless"`
   - `shadowTestProfile: true`
   - `profileId: "<your-test-profile-id>"`
   - optional: `codexPool: { preferredSize: 2, maxSize: 4 }` (defaults)
   - optional single-slot shadow: `codexPool: { preferredSize: 1, maxSize: 1 }`
2. Enable the shadow path without flipping the global flag:

   ```sh
   # all shadow-shaped profiles on this host
   export TRIANGLE_HEADLESS_SHADOW_ENABLE=1

   # or allowlist one profile id
   export TRIANGLE_HEADLESS_SHADOW_PROFILES=codex-shadow-test
   ```

3. Keep dedicated `TRIANGLE_CODEX_HOME` (never `~/.codex`). Leave desktop
   `appServerWake` / mcp-interactive profiles untouched.
4. Phase 3 does **not** enable desktop handoff or production multi-slot; see
   Phase 4 for the optional handoff opt-in.

## Phase 4 status (optional desktop handoff, shadow / test only)

| Item | Status |
| --- | --- |
| Idle-only CAS ownership transfer | **Shipped** (`execution-lease.mjs` transfer primitives) |
| Headless→desktop + desktop→headless | **Shipped** (`desktop-handoff.mjs`) |
| Pre-commit rollback / post-commit freeze | **Shipped** |
| `recover-desktop` / `rollback-headless` | **Shipped** (synthetic desktop; no live ChatGPT.app in CI) |
| Global `featureFlags.desktopHandoff` | **`false`** |
| Manifest `sharedHomeConcurrency.desktopHandoffEnabled` | **`false`** |
| Production Shared App Server / `appServerWake` | **Unchanged** (runbook retained) |

Phase 4 does **not** flip production defaults or make handoff automatic on wake.
Dedicated `TRIANGLE_CODEX_HOME` remains required; never fall back to `~/.codex`.

### Operator: enable Phase 4 handoff for shadow experiments only

1. Use an isolated shadow test profile (same shape as Phase 1–3).
2. Opt in explicitly:

   ```sh
   export TRIANGLE_HEADLESS_SHADOW_ENABLE=1
   export TRIANGLE_DESKTOP_HANDOFF_ENABLE=1
   ```

   Or in tests: `resolvePhase4DesktopHandoffConfig(profile, { enableHandoff: true })`.

3. Do **not** set `sharedHomeConcurrency.desktopHandoffEnabled` / 
   `featureFlags.desktopHandoff` true in the default immutable manifest until
   Phase 5 gates pass. Production desktop wake stays on Shared App Server —
   see `docs/triangle-client/shared-codex-app-server-runbook.md`.
4. Handoff is explicit API/operator only (`handoffToDesktop` /
   `handoffToHeadless` / `recoverDesktop` / `rollbackHeadless`); never on wake.

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

6. Shared-home concurrency probe must remain `passed` on Darwin for multi-slot.
   A failed probe must never fall back to `~/.codex`. After Phase 3, keep
   `forcedPoolSize` at the absolute cap (**4**) and leave shadow preferred at
   **2** unless an operator explicitly overrides.

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
is now `passed`. Phase 3 raises `forcedPoolSize` to **4** (absolute cap) while
shadow preferred size defaults to **2**. Phase 4 ships idle-only desktop handoff
behind an explicit shadow opt-in; default `desktopHandoffEnabled` /
`featureFlags.desktopHandoff` remain **false**.

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

- If `status === "passed"`: keep `runtime-manifest.json`
  `sharedHomeConcurrency.status` as `"passed"`,
  `fallbackToUserCodexHomeForbidden: true`, and Phase 3
  `forcedPoolSize: 4` (preferred shadow size remains 2).
- If seed turns fail (auth / network): leave status `unproved` / `failed`; fix
  dedicated-home login; do **not** point `CODEX_HOME` at `~/.codex`.
- If resume still fails after successful seeds: capture stderr (redacted) and
  home layout (`sessions/`, sqlite, locks) for a follow-up; still no user-home
  fallback.

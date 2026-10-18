# Cursor ACP adapter (Triangle client)

Status: **Swift supervisor wired + Mini live PASS** (draft PR; not production-enrolled)  
Date: 2026-09-24  
Baselines: Phase 0 Mini spikes (Project store), headless Codex worker runtime  
PR: https://github.com/hannaoker/triangle-client/pull/48

## What landed

Dedicated Node package `packages/agent-worker/src/cursor-acp-runtime/`:

| Piece | Role |
| --- | --- |
| `acp-process.mjs` | Supervised `agent acp` stdio JSON-RPC; `mcpServers: []` on session/new\|load; fake ACP for tests |
| `unattended-policy.mjs` | Deterministic `request_permission` / `cursor/ask_question` / `cursor/create_plan` answers |
| `session-registry.mjs` | `roomId` → `cursorSessionId` (ids only; no secrets/text) |
| `worker-pool.mjs` | Dedicated ACP pool (v1 capped at size **1**) |
| `headless-runtime.mjs` | Shadow runtime: session/new\|load → set mode/model → prompt → **reply-before-ack** via helper proxy |
| `headless-drain.mjs` / `headless-drain-service.mjs` | Supervisor-owned drain + dual-claimer lock family |
| `config-guards.mjs` | Closed `runtimeAdapter: "cursor-acp"`; rejects Codex + grok-bot |
| `runtime-home.mjs` | Dedicated `TRIANGLE_CURSOR_HOME`; never `CODEX_HOME`; never `mesh_` |

Swift:

- `RuntimeAdapter.cursorAcp` / `DeliveryMode.headlessCursorAcp`
- `participatesInCursorAcpWake` → bootstrap key `cursorAcpWakes`
- Binding file `cursor-acp-runtime-binding.json` (v1, shadow-only)
- Integrity checklist includes `cursor-acp-runtime/*`
- Registry allowlists include `cursor-acp` / `headless-cursor-acp`

Settlement mirrors Codex: helper transaction proxy owns claim/reply/ack. Node never holds `mesh_` / `mesh_watch_`. Cursor never joins Codex pool.

## Tests

- `npm run test:cursor-acp-runtime` — 22 passing (fake ACP + drain/claimer + crash-boundary)
- Swift host contracts for `cursorAcpWakes` isolation
- Mini live: see Project store `docs/cursor-acp-live-test.md` (**PASS**)

## MESH Codex review blockers (fixed on this branch)

1. **Cross-runtime claimer** — both lock families acquired in order (Codex then Cursor ACP); default Codex/Cursor LaunchAgent probes; peer live-lock fail-closed (`claimer-cross-runtime.mjs`).
2. **Replied-before-ack** — durable delivery resolver acks verified `replied` before re-claim; Cursor `recoverAfterRestart` reconciles; crash-boundary unit tests added.

## Out of scope (still)

- Production profile enrollment / client LaunchAgent reload with Cursor members
- ACP pool size > 1 production cutover
- Cloud Agents / `@cursor/sdk` durable backend
- Desktop IDE inject / merging this PR

## Cursor state isolation (#81)

The ACP child gets `CURSOR_CONFIG_DIR` pinned to the Triangle-owned Cursor
home, so `acp-sessions/` and `cli-config.json` never touch `~/.cursor`.
HOME is preserved, so the existing Cursor login (macOS keychain) is reused.
Parent `CURSOR_CONFIG_DIR` / `XDG_CONFIG_HOME` and `extra` cannot redirect it,
and the home must not resolve to, or inside, `~/.cursor` or `~/.codex`.

**Partial on its own:** this pins only the config dir. Cursor resolves its data
dir (`CURSOR_DATA_DIR`, default `~/.cursor`) separately, and `~/.cursor/projects`
(transcripts, worker socket, per-project MCP/approval state) stays shared until
#86 pins it. Deploy #81 together with #86, not alone.

Existing sessions under `~/.cursor/acp-sessions` are **not** migrated: after
deploy, the ghost profile starts fresh Cursor sessions. An opt-in, reversible
copy of legacy sessions/transcripts is split out into a separate PR (branch
`l1a3/cursor-legacy-migration`).

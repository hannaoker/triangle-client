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

- `npm run test:cursor-acp-runtime` — 18 passing (fake ACP + drain/claimer)
- Swift host contracts for `cursorAcpWakes` isolation
- Mini live: see Project store `docs/cursor-acp-live-test.md` (**PASS**)

## Out of scope (still)

- Production profile enrollment / client LaunchAgent reload with Cursor members
- ACP pool size > 1 production cutover
- Cloud Agents / `@cursor/sdk` durable backend
- Desktop IDE inject / merging this PR

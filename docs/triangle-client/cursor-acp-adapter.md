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
| `runtime-home.mjs` | Dedicated `TRIANGLE_CURSOR_HOME`; pins `CURSOR_CONFIG_DIR` + `CURSOR_DATA_DIR`; socket-path preflight; never `CODEX_HOME`; never `mesh_` |

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

## Cursor state isolation (CURSOR_CONFIG_DIR / CURSOR_DATA_DIR)

Verified against the installed cursor-agent `2026.09.10-fd3934a` bundle
(`index.js`, module `../cursor-config/dist/paths.js`):

- config root: `CURSOR_CONFIG_DIR` -> `$XDG_CONFIG_HOME/cursor` -> `~/.cursor`
  (ACP sessions `<config>/acp-sessions/<id>`, `cli-config.json`).
- data root: `CURSOR_DATA_DIR` -> `~/.cursor` (no XDG step). Holds
  `<data>/projects/<workspace-slug>/` (agent transcripts, worker log, terminals)
  and the local worker socket.
- worker socket: `<base>/<slug>/worker.sock`, base = `<data>/projects` if <= 84
  chars, else `<data>` if <= 84, else the shared `/tmp/.cursor`; joined dir
  > 92 chars is cut to 84 + `-<sha256:7>` (max socket path 104 bytes; the
  bundled Node binds 104, fails EINVAL at 105 on macOS).

The ACP child env pins both roots to Triangle-owned dirs. `CURSOR_DATA_DIR`
defaults to the Triangle Cursor home and can be moved with
`TRIANGLE_CURSOR_DATA_DIR`. A conflicting `CURSOR_DATA_DIR` override throws
`cursor_data_dir_conflict`; a data dir whose `projects/` exceeds 84 chars (or
whose worker socket would exceed the OS limit) throws
`cursor_socket_path_too_long` before spawn / session new|load.

**Operator note:** the default macOS home
`~/Library/Application Support/The Triangle/model-state/cursor-acp-runtime-home`
is ~93 chars for a typical user, so it fails the preflight. Set
`TRIANGLE_CURSOR_DATA_DIR` to a short Triangle-owned dir (<= 75 chars, not
under `~/.cursor`), e.g. `~/.triangle/cursor-data`, before deploying.

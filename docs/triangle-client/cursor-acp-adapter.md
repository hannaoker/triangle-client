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

## Legacy ACP session migration (opt-in, #81)

`plan/apply/revertLegacyCursorAcpSessionCopy` copy referenced sessions from
`~/.cursor/acp-sessions/<id>` into `<cursor home>/acp-sessions/<id>`. Nothing
runs automatically; run only while the Cursor ACP drain is stopped.

- Apply copies regular files one by one (exclusive create, never overwrites,
  never moves or deletes the source) and records each file's size, mtime and
  sha256 plus every directory it created (manifest schema 2).
- All target paths are checked physically (`owned-fs.mjs`): the Triangle home
  is re-resolved with realpath and every component below it is lstat'ed; any
  symlinked or non-directory ancestor is rejected before copying or removing.
  Legacy sources are checked the same way below `realpath(HOME)`: a symlinked
  `~/.cursor`, `~/.cursor/acp-sessions` or session directory is reported as
  `unsafe_source` and not copied (move the real tree into place first).
- A session whose copy fails midway is rolled back (only the files this apply
  copied, identity-checked, and the empty directories it created) and returned
  in `failed`; it is not recorded, so a later apply can retry it. If rollback
  cannot finish, the record is kept with `incomplete: true` for revert.
- **Undo after use:** revert is per session and all-or-nothing. A session is
  removed only if every recorded file still matches its snapshot and no other
  files exist in it; then exactly those files and the now-empty recorded
  directories are removed (never a recursive delete). If the session was used
  after migration (file changed, missing, added, replaced by another type, or a
  new directory created) or any path or manifest entry is unsafe, the
  whole session is left in place, returned in `kept` with the reason and file
  lists, and stays in the manifest. The manifest is deleted only when every
  entry has been undone.

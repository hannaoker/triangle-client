# Cursor ACP adapter (Triangle client)

> **Permissions v1 (F1).** This lane is not run under the seatbelt runner
> sandbox. Its children run as the same user and can read the `triangle`
> custody home (`<TRIANGLE_HOME>`, workload and owner keys) in v1. This is
> accepted under F1 (same-user local runtime is trusted); a custody-home read
> deny for this lane is a v1.1 follow-up.

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

The ACP child env pins both roots to Triangle-owned dirs:

- `CURSOR_CONFIG_DIR` = the Triangle Cursor home (unchanged from #81).
- `CURSOR_DATA_DIR` = **`~/.triangle/cursor-data`** by default (created 0700
  on first use; `/Users/<user>/.triangle/cursor-data/projects` is ~47 chars,
  well under Cursor's 84-char socket base). Override with
  `TRIANGLE_CURSOR_DATA_DIR` / `cursorDataDir`. The long
  `~/Library/Application Support/...` home is deliberately not the data dir.

A conflicting `CURSOR_DATA_DIR` override throws `cursor_data_dir_conflict`; a
data dir whose `projects/` exceeds 84 chars (or whose worker socket would
exceed the OS limit) throws `cursor_socket_path_too_long` before spawn /
session new|load. The chosen dirs are reported by the ACP process
`status()` (`cursorDataDir`, `cursorDataDirSource`), the worker-pool slot
status, the headless runtime `status().cursorDirs`, and the exported
`describeTriangleCursorDirs()` (for doctor/inventory).

### Data dir hardening

- The forbidden-root check (`~/.cursor`, `~/.codex`, `/tmp/.cursor`) projects
  a not-yet-existing data dir through the realpath of its deepest existing
  ancestor, so a path below a symlink into a forbidden tree is rejected
  before anything is created. Overrides with `.` or `..` segments are
  rejected (`cursor_data_dir_invalid`), and an absent override resolves only
  from the injected env (never the host `process.env`).
- Containment is checked by exact path component, so a `..`-prefixed child
  such as `~/.cursor/..triangle-data` counts as inside `~/.cursor`.
- An existing data dir must be private: a directory owned by the current
  user with no group/other permission bits. Otherwise it fails with
  `cursor_data_dir_not_private` (or `cursor_data_dir_invalid`), so a shared
  root such as `/tmp` is never used. A newly created dir is made 0700.
- Runtime `status().cursorDirs.socketPreflight` checks the configured working
  directory (else the Cursor home, the default session cwd) and lists it in
  `workspacePaths`.

### Existing `~/.cursor` state is not migrated

Sessions under `~/.cursor/acp-sessions` and transcripts under
`~/.cursor/projects/<slug>/agent-transcripts` are left untouched and are
**not** copied: after deploy the ghost profile starts fresh Cursor sessions
(no resume of pre-isolation sessions). An opt-in, reversible copy of legacy
sessions/transcripts is split out into a separate PR (branch
`l1a3/cursor-legacy-migration`).

### Deploy notes

1. No env var is required: the default data dir passes the socket preflight
   on a normal macOS HOME. Set `TRIANGLE_CURSOR_DATA_DIR` only to move it.
2. After deploy, the first Cursor ACP start creates `~/.triangle/cursor-data`
   (0700). New transcripts/worker sockets land there instead of
   `~/.cursor/projects`.
3. Existing ghost Cursor sessions are not resumed (see above); expect a
   fresh session per room on the first post-deploy delivery.
4. If a preflight error appears (`cursor_socket_path_too_long`), the message
   names the reason; unset or shorten `TRIANGLE_CURSOR_DATA_DIR` (<= 75 chars,
   not under `~/.cursor`).

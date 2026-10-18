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

### Opt-in legacy migration (never automatic)

Run only while the Cursor ACP drain is stopped. Both helpers copy, never move
or delete the `~/.cursor` source, and share `owned-fs.mjs`:

- **Physical containment:** the owned anchor (Triangle Cursor home for
  sessions, data dir for transcripts) is re-resolved with realpath and every
  path component below it is lstat'ed before any copy, create or remove; a
  symlinked or non-directory ancestor is rejected. Lexical `path.relative`
  checks are not relied on. (Node has no `openat`/`unlinkat`, so a hostile
  concurrent writer is out of scope; every destructive call re-validates
  immediately before acting.)
  Legacy sources are checked the same way below `realpath(HOME)`: a symlinked
  `~/.cursor`, `~/.cursor/acp-sessions`, `~/.cursor/projects`, slug,
  session or `agent-transcripts` directory is reported as `unsafe_source` and
  nothing is copied from it (move the real tree into place first).
- **Data dir creation:** the forbidden-root check (`~/.cursor`, `~/.codex`,
  `/tmp/.cursor`) projects a not-yet-existing data dir through the realpath
  of its deepest existing ancestor, so a path below a symlink into a
  forbidden tree is rejected before anything is created. Overrides with `.`
  or `..` segments are rejected (`cursor_data_dir_invalid`), and an absent
  override resolves only from the injected env (never the host
  `process.env`).
  Containment is checked by exact path component (`~/.cursor/..x` is
  inside `~/.cursor`). An existing data dir must be owned by the current
  user with no group/other bits (`cursor_data_dir_not_private`).
- **Snapshot identity:** apply records each copied file's size, mtime and
  sha256 plus every directory it created (manifest schema 2). Manifest
  entries are constrained on revert: session entries to
  `acp-sessions/<id>/...`, transcript entries to
  `projects/<slug>/agent-transcripts/...` (dirs: `projects/<slug>[/agent-transcripts/...]`);
  anything else is kept as `unsafe_path` and never removed.
- **Failed apply:** a copy that fails midway removes its own torn target file.
  A session copy that fails is rolled back (identity-checked) and returned in
  `failed` without being recorded, so a later apply can retry it (if rollback
  cannot finish the record is kept with `incomplete: true` for revert).
  Transcript copies are per file: files already copied stay recorded. The
  session rollback also runs if the manifest cannot be written after a copy
  (if that rollback also fails and the manifest stays unwritable, apply
  returns the leftover files in `failed[].untrackedFiles` and stops). A
  transcript whose manifest entry cannot be persisted is rolled back
  (identity-checked, with the empty dirs its copy created) and apply throws
  with `rolledBack` (plus `untrackedFiles` if neither step succeeded).
- **Socket preflight first:** transcript apply runs the
  `cursor_socket_path_too_long` preflight for the target data dir and the
  migrated workspaces before creating or copying anything (plan reports it
  as `socketPreflight`). Runtime `status().cursorDirs.socketPreflight`
  checks the configured working directory (else the Cursor home, the
  default session cwd) and lists it in `workspacePaths`.
- **Resumable undo:** session revert persists `revertInProgress`
  (write-ahead) before unlinking and records files already removed when an
  I/O error interrupts it, so a later revert finishes instead of treating
  them as post-migration use (directories the migration created count as
  expected even once emptied); malformed session records are kept verbatim
  (`manifest_record_invalid`) without aborting the others. Transcript
  revert is per file and reports I/O
  errors as `remove_failed` (kept in the manifest). If transcript apply
  created `projects/`, revert removes it (only when empty) once the manifest
  is gone.
- **Undo after use:** revert never deletes recursively and never deletes a
  file whose identity changed.
  - Sessions (`plan/apply/revertLegacyCursorAcpSessionCopy`,
    `~/.cursor/acp-sessions/<id>` -> `<cursor home>/acp-sessions/<id>`):
    all-or-nothing per session. Removed only if every recorded file is
    unchanged and no new file or directory exists (full preflight before any
    unlink); otherwise the whole session is kept and
    reported (`used_after_migration` / `unsafe_path` with file lists).
  - Transcripts (`plan/apply/revertLegacyCursorTranscriptCopy({ workspacePaths })`,
    `~/.cursor/projects/<slug>/agent-transcripts/**` ->
    `<data>/projects/<slug>/agent-transcripts/**`): per file. Unchanged copies
    are removed; appended/modified copies and copies whose path became unsafe
    are kept and reported in `keptFiles`; files created after migration are
    never touched; recorded directories are removed only when empty.
  - Kept entries stay in the manifest (with `lastRevert`), so a later revert
    can retry; the manifest is deleted only when nothing remains. Undo is
    therefore a partial rollback once the new location has been used: it
    removes only pristine copies and leaves all post-migration work in place.
- Transcript copy takes regular files only (existing targets win;
  symlinks/sockets skipped; worker socket/logs/terminals are not copied).
  Manifests: `<cursor home>/acp-sessions/.triangle-legacy-session-copy.json`,
  `<data>/projects/.triangle-legacy-transcript-copy.json`.

### Deploy notes

1. No env var is required: the default data dir passes the socket preflight
   on a normal macOS HOME. Set `TRIANGLE_CURSOR_DATA_DIR` only to move it.
2. After deploy, the first Cursor ACP start creates `~/.triangle/cursor-data`
   (0700). New transcripts/worker sockets land there instead of
   `~/.cursor/projects`.
3. Optional, to keep resume context for existing ghost sessions: with the
   drain stopped, run the session copy and the transcript copy for the ghost
   working directory, then start the drain. Undo (drain stopped) removes only
   pristine copies; anything used after migration is kept and reported.
4. If a preflight error appears (`cursor_socket_path_too_long`), the message
   names the reason; unset or shorten `TRIANGLE_CURSOR_DATA_DIR` (<= 75 chars,
   not under `~/.cursor`).

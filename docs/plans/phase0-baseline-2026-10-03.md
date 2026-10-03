# Phase 0 baseline — 2026-10-03

Recorded at start of Suggested PR 0 execution.

## Commits

| Repo | Branch | Commit | Notes |
| --- | --- | --- | --- |
| `the-triangle` | `codex/the-triangle` | `5eda2080bb59f5bf2ee2e404b4273c8a0c0f4d2f` | Matches plan tip. Working tree has ~389 unrelated deletions — **ignored**; use clean worktree. |
| `triangle-client` | `main` | `789ca888db6df4eb890d9fa0b69d431b687ffd3f` | Ahead of review tip `e181263` (includes #63, #64). |

## Runtimes (this Mac mini)

| Tool | Version |
| --- | --- |
| Node | v22.22.3 |
| npm | 10.9.8 |
| Swift | Apple Swift 6.4 (swiftlang-6.4.0.34.1) |

## Schema

MESH SQL migrations present through `mesh/drizzle/0014_mailbox_watch_grant_assembly.sql`. Drizzle meta/journal drift remains finding **M5** (not fixed in Phase 0).

## Lease flags (code defaults)

From `mesh/app/lib/realtime-mailbox-config.ts`:

- Writes/enforcement enable only when env is literally `"true"`.
- Defaults: `writesEnabled: false`, `enforcementEnabled: false`.
- **Production Vercel env not inspected** for this baseline.

Assumption unchanged: keep lease enforcement off until PR5–6 + migration gates.

## Client identity inventory (pointers)

Local Mini file-custody profiles (see prior Project Context notes; not re-enrolled here):

- Verified mailboxes observed: `bob`, `hermes-mini`, `codex-headless` (recovered 2026-10-03).
- Still quarantined: `codex-bob-test` (no workload file → agent-card fallback unavailable).
- Installation: `inst_EaA3qkuzOuQwTSFw`.
- Watch members: bob + codex-headless.

Legacy vs workload: Mini uses file custody (`credentials/local/ENABLED`). `/api/v1/agents/me` returns 401 for local `mesh_` bearers; status succeeds via agent-card + workload fallback when workload key exists.

## Phase 0 branch names

- `the-triangle`: `fix/phase0-test-baseline` (worktree from `5eda208`)
- `triangle-client`: `fix/phase0-test-baseline` (from `789ca88`)

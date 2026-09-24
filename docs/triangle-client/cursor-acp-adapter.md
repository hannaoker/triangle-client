# Cursor ACP adapter (Triangle client)

Status: **Shadow vertical in tree** (draft PR)  
Date: 2026-09-24  
Baselines: Phase 0 Mini spikes (`docs` in Project store), headless Codex worker runtime

## What landed

Dedicated Node package `packages/agent-worker/src/cursor-acp-runtime/`:

| Piece | Role |
| --- | --- |
| `acp-process.mjs` | Supervised `agent acp` stdio JSON-RPC child + fake ACP for tests |
| `unattended-policy.mjs` | Deterministic `request_permission` / `cursor/ask_question` / `cursor/create_plan` answers |
| `session-registry.mjs` | `roomId` → `cursorSessionId` (ids only; no secrets/text) |
| `worker-pool.mjs` | Dedicated ACP pool (v1 capped at size **1**) |
| `headless-runtime.mjs` | Shadow runtime: session/new\|load → set mode/model → prompt → **reply-before-ack** via helper proxy |
| `config-guards.mjs` | Closed `runtimeAdapter: "cursor-acp"`; rejects Codex + grok-bot |
| `runtime-home.mjs` | Dedicated `TRIANGLE_CURSOR_HOME`; never `CODEX_HOME`; never `mesh_` |

Settlement mirrors Codex: helper transaction proxy owns claim/reply/ack. Node never holds `mesh_` / `mesh_watch_`.

Mode is **workload policy** (`conversational`→`ask`, `tools`→`agent`, `planning`→`plan`), set via `session/set_config_option` when advertised.

Continuity uses `session/load` after slot restart (Phase 0: resume/close not advertised).

## Tests

`npm run test:cursor-acp-runtime` — fake ACP only; **no live Cursor required**.

## Out of scope (this PR)

- Mini live canary / production profile enrollment
- Swift `RuntimeAdapter` / supervisor `cursorAcpWakes` bootstrap wiring
- Client-supervisor LaunchAgent / Mini launchd changes
- Codex pool env / Bob / grok-bot changes
- ACP pool size > 1 production cutover
- Cloud Agents / `@cursor/sdk` durable backend
- Desktop IDE inject

## Follow-up canary (Mini)

When J has a clearly named **test** profile (not production Bob/Codex):

1. Operator enable `TRIANGLE_CURSOR_ACP_SHADOW_ENABLE=1` (or profile allowlist).
2. Dual-claimer fail-closed vs existing Codex headless claimer for that instance.
3. Exercise one conversational turn + one tool turn against live `agent acp`.
4. Do **not** enroll production profiles in this path until supervisor wiring + soak.

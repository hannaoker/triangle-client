# Codex chat attachment — 2026-10-25

Status: source and tests on `codex/discovery-usability` (on top of `cb733f3`), not installed. Owner request: todo 4, make arbitrary discovered Codex chats able to receive and be woken, as the bound conversation already can. Operator documentation: `docs/triangle-client/installed-local-messaging.md` ("Codex chat attachment").

## What Codex tells an MCP server (Codex 0.164.0, `exec`, metadata-only probe)

- The child's environment is `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TMPDIR`, `USER` and `__CF_USER_TEXT_ENCODING`: no `CODEX_*` variable, so no `CODEX_HOME` and no thread id.
- `initialize` carries no `_meta` (only `clientInfo` `codex-mcp-client` 0.164.0); `tools/list` carries only a `progressToken`.
- `tools/call` carries `_meta.threadId`, `_meta.sessionId` (equal here), `windowId` (`<thread>:0`), `callId`, `itemId` and `x-codex-turn-metadata` (`thread_id`, `session_id`, `turn_id`, `thread_source`, `turn_trigger`, …). This is the only place a chat identifies itself.
- The `instructions` an MCP server returns at `initialize` are not shown to the model (asked directly, it knew nothing of them), so a server cannot ask its chat to attach.
- `[mcp_servers.<name>.tools.<tool>] approval_mode = "approve"` pre-approves a tool.
- `codex exec` waits for extra stdin when stdin is left open; close it when scripting.

Consequence: a Codex chat can attach only at its first Triangle tool call, and the supervisor cannot be told its raw thread id earlier without a new, wider trust decision. The design therefore keeps the wake inside the chat's own MCP child.

## Design

- **Child** (`createCodexSessionMcpChild`, in `claude-session-mcp-child.mjs`, entry `triangle-local codex-session-mcp`): identity per call from `_meta` (rejected if absent, or if `sessionId` or the turn metadata name another thread, which is what a subagent's call looks like); one state per chat (address, lease, grant, child id), so one process can serve several chats; attach on the first call, renew every five seconds; a refused call after a lifecycle change is retried once after a fresh attach. Tools are the Claude child's, now one shared function (`runSessionTool`). The module is the existing one, so no manifest bump or helper rebuild.
- **Wake** (in the child): `reserve_wake_notification` (the supervisor decides whether anything is owed) → the existing `codex-wake-adapter` `notify` runs `codex queue --thread <the chat's own id>` with the `codexPath`/`codexHome` pinned under `wake` → `report_wake_result`; the chat acknowledges with `triangle_ack_notification`. Never retried. The journal's per-session wake state is reused unchanged (it was already keyed by the session address).
- **Broker** (`createWorkspaceSessionBroker`): `attach`/`detach` take `harness: 'codex'`; Codex addresses use the `codex:` namespace that lifecycle discovery already derives; each harness is on only if its discovery is opted in and (Codex) its messaging is enabled; `checkRecipient` uses the Codex sender list for Codex receivers; a sender named for Codex gets the reachable Codex chats in its credential's recipients; the directory shows `attachment`, hint and evidence-backed presence for Codex rows.
- **Policy**: optional `codex: {enabled, allowedSenders}` in the workspace policy, senders being exact 64-hex principals or `session-` addresses, no default. Strict schema; the Claude list is separate.
- **Setup/disable**: `setup-session-messaging --harness codex --sender …` writes the marked block into `<workspace>/.codex/config.toml` (refuses a foreign `triangle-session` table or a damaged block, preserves everything else and the file mode, idempotent); `disable-session-messaging` removes it.

## Evidence

- `test/local-session-codex.test.mjs`: 10 tests, all passing: attach on first call, receive/claim/reply and ack, wake with the right thread and pins and no repeat after ack, no raw thread id in the journal, detach on close; Claude-versus-Codex sender lists and a full Claude-to-Codex round trip; missing and ambiguous identity, unregistered and ended chats, two chats in one process, resume; wake failure/deferral not retried and pull-only without pins; setup/disable file handling and schema; the spawned `codex-session-mcp` entry over stdio. The wider family (`local-messaging-*`, `local-session-*`, `claude-session-*`, closure, wake adapter, runtime bundle and others): **328/328**.
- Real Codex on an isolated host (scratch root under `/private/tmp`; no `~/Library` or `~/.codex` configuration), 2026-10-25 07:05 UTC: a `codex exec` chat given only the `triangle-session` tools. Its lifecycle was registered (`origin: exec`, `not-attached`); 7 s later its first call attached it (`reachable`, `online`, `mcp-lease`); a message sent from the owner side was listed, claimed and answered (`CODEX-E2E HELLO`); all four calls completed under the `-c` approvals; it exited 0 and the directory returned to `not-attached`. The real `codex queue` through the wake adapter returned `accepted` with a receipt for that finished chat's thread. The test stood in for the lifecycle hook (it read the new thread's rollout file name and reported `SessionStart`), because the project hooks of an untrusted scratch workspace do not run.

## Not proven

- Codex Desktop starting a turn from the queued hint in an idle chat (needs the owner's chat), and how long that takes.
- That a Desktop chat's project `.codex/config.toml` entry loads without an app restart, and that MCP processes are per chat there (M0 observed per-chat processes; the child handles either).
- Hook-fired registration followed by attach for a Desktop chat end to end (only the pieces are shown).
- One side effect of the run: a queued Triangle hint now sits in the finished disposable `exec` chat `01a171e0…` and would run if someone opens that chat.

## Live acceptance, in the real workspace (owner-driven)

1. Install this revision (supervisor runtime only, as on 2026-10-24).
2. `triangle-local setup-session-messaging --harness codex --workspace "/Users/zhenyuhou/Projects/The Triangle" --sender <bound Codex id> [--sender <Claude session address>]`, restart the service, trust the project in Codex, restart Codex or start a new chat.
3. In a Codex Desktop chat in that workspace: "Call triangle_get_status and tell me the address."
4. From another session send that address a message, leave the chat idle, and watch for a turn started by the hint. Evidence: the journal's wake state (accepted, then acknowledged), the thread's rollout, and the directory (`attached`, `online`).
5. Repeat after a Codex restart and after closing and reopening the chat.

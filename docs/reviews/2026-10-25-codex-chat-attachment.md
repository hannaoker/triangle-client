# Codex chat attachment — 2026-10-25

Status: committed locally on `codex/discovery-usability` (`790e420`, `2ae8696`, `408cc91`; not pushed) and installed on the Mini on 2026-10-25 (supervisor bundle `502630cf…`), enabled in the real workspace for the bound Codex identity only. Codex Desktop waking an idle attached chat is not yet shown. Owner request: todo 4, make arbitrary discovered Codex chats able to receive and be woken, as the bound conversation already can. Operator documentation: `docs/triangle-client/installed-local-messaging.md` ("Codex chat attachment").

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

## Installation (2026-10-25, owner go-ahead: supervisor runtime only, bound Codex identity only)

Installed from `408cc91`, a local commit that is not on `origin`. Bundle `490374ac…` (`cb733f3`) became `502630cfb87128b9219c1d9e5d6e93331df5fa2985074cf69f6508ced3d5b4db`; manifest v12, 81 artifacts, same Node; the codex, hermes and antigravity manifests were not restaged.

What the live attempt found, in order:

1. The preflight (snapshot tests under `umask 077`) failed a setup test: `replaceTextFile` created its temporary file with the owner's mode but creation honors the umask, so a 0640 `config.toml` became 0600. Fixed with an explicit `fchmod` (`2ae8696`); my first "fix" was committed after a verification step whose pipeline hid the failing test, and was amended once the test truly passed under both umasks.
2. The first install of the item 4 revision (bundle `f4320780…`) succeeded, but enabling Codex attachment through the installed `triangle-local` failed with `local_command_failed`. The automatic revert restored the baseline (configuration, policy and hook files byte-identical to their pre-change copies; `.codex/config.toml` absent). A patched copy of the CLI printed the real error: a temporal dead zone, because the entry-point block sat in the middle of `local-messaging-cli.mjs` and ran before the Codex setup constants below it were initialized. The tests import the module, which finishes evaluating first, so none could see it. Fixed by running the entry point last (`408cc91`), with a test that runs setup, a rerun and disable as the program; that test fails against the previous file and passes now.
3. Preflight on `408cc91`: snapshot 329/329, the live bundle equals the `2ae8696` source, exactly one artifact (the CLI) changes, route quiet. Install, restart and verification passed: one supervisor from the new bundle, journal unchanged (36 completed, 2 held, 14 pending replies), Codex directory rows carry `attachment` fields.
4. Through the installed wrapper: setup (an idempotent rerun that keeps the capability secret), policy `codex` section exactly `{enabled: true, allowedSenders: [the bound identity]}` with the Claude receiver list empty (mode 0600), the managed block in `/Users/zhenyuhou/Projects/The Triangle/.codex/config.toml` (mode 0600), the MCP entry started as Codex starts it from the workspace (`initialize` and `tools/list`: 10 tools, exit 0, no stderr), and no broker warnings in the logs. The real workspace is already trusted in Codex (`trust_level = "trusted"`).

Records: pre-change copies in `~/Library/Application Support/The Triangle/archive/codex-attachment-20261025/` (checksums verified) and `releases/codex-attachment-install-verification.json`. Manual rollback: `triangle-local disable-session-messaging --workspace <workspace>`; restore `supervisor.manifest.cb733f3.json` from the archive to `worker-runtime/supervisor.manifest.json` (mode 0600, atomic) for the previous bundle; `scripts/triangle-client-service.sh start` with `TRIANGLE_READY_TIMEOUT_MS=60000` behind a quiet gate. The earlier policy file (a disabled one from the disposable-workspace tests) was replaced by the current policy; its pre-change copy is in the archive.

Still open: the Desktop proof in the section above, which needs a Codex chat started after the config change (a chat that was already loaded does not gain the server).

# Codex automatic lifecycle attachment — 2026-10-25

Status: candidate on `codex/automatic-session-attachment`; not installed or enabled in the real workspace. Existing production runtime remains PR #120. This removes the need for an agent/model to call `triangle_get_status` manually on startup or resume where Codex runs its lifecycle hooks; it does not reopen unloaded chats or claim that selecting a chat alone fires hooks.

## Motivation and shape

Installed attachment survives real compaction and a short physical sleep/wake, but new/resumed chats previously needed a first model-side Triangle call. Codex can invoke an MCP tool directly from a lifecycle hook on the session's existing MCP connection. Use that route, retaining the current authority, addresses, broker and wake path.

- `setup-session-messaging --harness codex ... --auto-attach` opts in; omitting the option preserves existing settings. `--no-auto-attach` removes only Triangle's managed attachment hooks.
- Two hooks, `SessionStart` and `UserPromptSubmit`, call `triangle-session.triangle_attach_session` with no arguments. The latter is a fallback if the MCP server or lifecycle registration is not ready at SessionStart. Existing discovery hooks remain metadata-only and unchanged.
- New Codex-only tool, `triangle_attach_session`, uses only the runtime `_meta.threadId`; missing or contradictory context fails closed. No caller-supplied identity is accepted. It shares the existing credential/attachment path, returns hook-compatible `{}`, and reads no inbox or peer body, sends no message and launches no reasoning turn.
- The bound fixed conversation is a successful no-op for this hook. Ordinary session tools still refuse its duplicate identity. Receiver grants and directional sender lists remain unchanged.
- Setup preflights hook files, refuses unsafe/symlink/foreign collisions, preserves unrelated hooks and file modes, and is idempotent. Disabling workspace messaging removes the managed hooks as well as the MCP entry and fences participation.
- No new runtime module or native helper change; the packaging closure stays at manifest v12.

## Official documentation and actual probe

Sources fetched 2026-10-25:

- https://learn.chatgpt.com/docs/hooks — `mcp_tool` handlers use an existing connection, run synchronously without requesting model-tool approval, do not start/reconnect servers, may encounter unavailable MCP at SessionStart, and require ordinary hook trust. Hook failures do not block the session.
- https://learn.chatgpt.com/docs/extend/mcp — MCP lifecycle and server configuration.

Probe: installed Codex CLI 0.164.0 in `/private/tmp/triangle-session-discovery-m0-20261023`, with a metadata-only MCP server. No production configuration, receiver policy or thread ownership changed. Probe logs only method/event names, times and hashed identity; no credentials, transcript text or messages.

Initial command-line inline-hook attempts produced MCP initialize/list but no tool calls; a harmless command control also did not run. These runs do not prove MCP hooks unsupported. Moving the prepared definitions into the disposable project hook file made the reason observable: Codex's read-only `hooks/list` reported the two definitions as `modified` and skipped them.

The owner explicitly approved these two disposable probe hooks. They were trusted through Codex's normal interactive hook review screen, not through a bypass flag or trust-file edits. `hooks/list` then reported `trusted`.

After approval, a separately owned disposable App Server session observed automatic `tools/call` from both SessionStart and UserPromptSubmit, and again on the next prompt. The calls supplied `_meta.threadId` matching the current thread's SHA-256 and omitted `_meta.sessionId`. The model was told not to call tools. The probe's hook runs completed with `{}`. The second model turn exceeded the harness's 100 s cap after its hook had already completed; this is not a two-model-turn completion claim. The complete Triangle attachment + Desktop wake path using the new hook remains a live release gate.

Scratch scripts/logs: `/private/tmp/triangle-auto-attach-spike-20261025/`. Original disposable hook/MCP files are backed up there; production was not changed.

## Acceptance and release gates

Affected messaging/discovery/Claude/Grok/inbox/wake/supervisor/closure suite: **318/318 passed after the startup-race regression fix**, zero failures or skips. `git diff --check` passed. Source regression coverage:

- Automatic hook context (threadId only) attaches without a model tool call; repeated calls are idempotent.
- Missing/ambiguous context and supplied identity arguments fail closed; revoked policy is enforced.
- Bound chat stays on its fixed identity/inbox and queues no duplicate wake.
- Default setup leaves hooks byte-identical; explicit opt-in/rerun/opt-out/disable preserves unrelated hooks and modes.
- Unsafe/foreign hooks fail before policy or MCP settings writes.
- Installed CLI entry parses opt-in/opt-out and rejects conflicting flags.

Required live gate before claiming Desktop usability:

1. Merge/install the candidate only with the owner's explicit release approval.
2. Enable the two real-workspace attachment hooks and obtain normal trust for those exact definitions; approval of the metadata-only disposable probes is not approval of production hook activation.
3. New Desktop chat: give a harmless prompt that does not request any Triangle call. Confirm lifecycle registration and automatic MCP attachment, no model-side Triangle call, and the same established directional grants.
4. Send one bounded authorized Triangle canary after it is idle; verify queued hint, exact correlated reply and ack.
5. Archive/reopen that chat and repeat after a normal user prompt, without asking it to call status. Verify same address and advanced lifecycle generation; verify the bound fixed chat has no second inbox.
6. Record actual startup races and fallback behavior. If neither hook can reach MCP, retain manual status attachment and show a truthful hint; do not scan private stores or start another owner.

Unloaded-chat auto-wake, cross-machine routing and universal agent parity remain outside this change.


## Desktop startup race found during approved acceptance

The owner approved candidate installation, two real-workspace hooks and merge conditional on passing Desktop tests. Candidate `c24f269` installed with unchanged receiver policy. The first Desktop no-tools turn did not attach. Restarting the app did not fix it. The bundled Desktop binary is `0.164.0-alpha.11.1`; an isolated probe with that exact binary also supported MCP hooks, disproving a simple version-incompatibility explanation.

Temporary metadata-only tracing of the candidate MCP child confirmed a real Desktop `triangle_attach_session` invocation with `_meta.threadId`, followed by explicit `session_offline`: the hook ran concurrently with the command that registers discovery. No message content or credentials were traced. Tracing is not part of the source change and must be removed before final acceptance.

The fix waits at most two seconds for explicit `session_offline` refusals inside the hook, bounded by the remaining RPC budget. Timeouts and other errors are not blindly retried. Each hook forces a fresh grant so same-child resume cannot return a cached old-generation credential; existing generation-fencing recovery still applies. Regression deliberately starts attachment before discovery, verifies success only after a real lifecycle report, checks resume at generation 2, and checks failure when no lifecycle ever arrives.

# One status verb on every surface

Candidate branch: `claude/messaging-consistency-plan`, based on main `451eb44` (#140).
Source and tests only: nothing is installed, no live state was touched.

## Problem

An audit of main `451eb44` found `status` meant different things by surface:

- `triangle-local status` without an ID: host status; with `--message-id`: message status.
- Attached Claude and Codex chats: `triangle_get_status` took an optional `messageId`;
  without one it returned the chat's own address and inbox counts.
- The bound Codex MCP adapter (`triangle-local mcp`): `messageId` was required, so there
  was no way to ask for the conversation's own view.
- `triangle-local grok status`: accepted `--message-id` and silently ignored it,
  returning the session view.

The obvious fix for the bound adapter, dropping `required` and calling `local_status`,
would have handed the model the host status (journal, dispatcher, wake, discovery,
router): the server gives the own view only to `interactive` senders, and the bound
conversation shares its credential with the owner CLI, so `local_status` cannot be
narrowed by sender.

## Change

- New `session_status` method (client `sessionStatus()`): the caller's own
  `{route, senderId, sessionId, generation, inbox}`, for attached chats and the bound
  conversation only (`unsupported` for any other sender). For the bound conversation it
  goes through the same inbox validation as `list_inbox`: `inbox_disabled` when the desktop
  inbox is off, `binding_changed` for a stale credential. `local_status` is unchanged and
  now shares one helper with it for the interactive view.
- Bound MCP adapter: `messageId` optional; no argument calls `session_status`. An older
  supervisor without the method makes the call fail visibly (`method_not_found`) instead
  of answering with its host status.
- Grok: `grok status --message-id ID` returns that message's status under the existing
  sender-or-recipient rule; no argument is unchanged.
- One `STATUS_TOOL_DESCRIPTION` in `local-messaging-protocol.mjs` for all three MCP
  surfaces (Codex appends its attach sentence). No new module, so the runtime file list
  is unchanged.
- `local-messaging-tool-parity.test.mjs` pins tool names, arguments and required fields
  across the bound adapter, Claude chats and Codex chats. Each intended difference is
  listed: bound-only `triangle_cancel_message`, Codex-only `triangle_attach_session`, and
  the bound adapter's required `claimId`, `replyId` and `generation`.

Preserved: message, request, claim and reply IDs, free-form bodies, route evidence,
ACLs and `foreign_access_denied`, error redaction. Changes are additive; no journal
migration and no new permission.

## Verification

- Tests were written first and failed for the expected reasons (missing `sessionStatus`,
  schema still requiring `messageId`, Grok returning the session view, missing export).
- Baseline on `451eb44`: 1198 worker tests, 1194 passed, 3 skipped, 1 failed. The failure
  (`Real baseline v12 journal module compatibility`) shells out to `git show` and only
  failed in the history-less copy the baseline ran in; its file passes 14/14 in the
  worktree.
- After the change: 1206 tests, 1203 passed, 3 skipped, 0 failed (+8 tests: adapter 2,
  server wire 1, bound conversation end to end 1, Grok 1, parity 3).
- Packaged installer and test-runner contract suites: 11/11. `node --check` on the six
  changed modules and `git diff --check` are clean.
- The bound-conversation test runs a real host: no-argument status tracks the inbox
  through send, claim and reply; the owner CLI keeps the host view; a disabled inbox
  fails with `inbox_disabled`; none of `journal`, `dispatcher`, `wake`, `router`,
  `discovery` or `replyIdentity` reaches the MCP tool.
- Not verified: an installed runtime, a live Desktop MCP model turn, a real Grok session.

## Remaining differences and why they stay

`local-messaging-tool-parity.test.mjs` pins each of these, so none is drift.

- The bound adapter requires `claimId`, `replyId` and `generation`, which attached chats generate or default. The bound conversation is the owner's own thread and its stable IDs are supplied by the model on purpose; relaxing them is a product decision, not a consistency fix.
- `triangle_cancel_message` exists only on the bound adapter and is documented as unsupported on the local route. `triangle_attach_session` exists only for Codex chats because attachment is a lifecycle hook.
- Tool descriptions still say "local recipient on this host". Rewording belongs with the router work, once non-local routes exist (unified messaging design, section 4.11).
- `triangle-local grok` has `sessions` but no `discover` or `ack-wake`: Grok is pull-only and has no wake to acknowledge.
- `triangle-local status` without an ID keeps the host view for the owner, while the MCP tools give the own view. The two share one credential, which is why the MCP tool asks `session_status`.

## Upgrade and rollback boundary

Install a matching supervisor and bound MCP runtime together. A new bound adapter against
an older supervisor fails no-argument status visibly; an older bound adapter keeps
requiring `messageId`. Loaded sessions keep their old tool schema until restarted.
Rollback is the previous bundle: nothing is persisted.

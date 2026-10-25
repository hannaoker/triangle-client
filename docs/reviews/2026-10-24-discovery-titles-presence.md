# Discovery titles, evidence-backed presence and reload guidance — 2026-10-24

Status: source and tests only, branch `codex/discovery-usability` off `66fdd70` (#118). Not committed, pushed, merged or installed; the Mini runs #118. Owner request: todo 3 (remove or clearly document the reload requirement) and todo 5 (actual conversation titles and evidence-backed presence). Operator documentation is in `docs/triangle-client/installed-local-messaging.md` ("Codex discovery", "Titles and presence", "What needs a reload", "Rollout and rollback").

## Decision on the reload requirement

It is a property of the harnesses, so it is documented and made visible rather than removed. Claude hooks need no reload; Codex hooks and Claude MCP servers do; Codex MCP attachment does not exist for arbitrary chats yet. The directory now says why a visible Claude chat is not reachable (`attachment`, `attachmentHint`) instead of showing it `offline`. One route to a lighter Claude attach is untested: ship the session MCP server as a Claude Code plugin.

## What changed

- Hooks read their own session's title (Claude registry record found through the ancestor `claude` process and matched on session id and exact start time; Codex `threads.name`, else `title`) and host process (pid, start time, scope), and report them as optional fields of the existing lifecycle event. Fields are bounded and covered by the event challenge. Titles are sanitized at hook, broker and view; `--no-titles` stops them being reported, stored or shown.
- The supervisor derives `presence` and `presenceEvidence` from an end event, a live attachment lease or a one-`ps`-per-refresh check of the recorded host process; pids are never returned. A failed check is `unknown`.
- Claude rows get `attachment` (`attached`, `not-attached`, `ended`) and a hint. A chat without a lease is no longer `offline`.
- Journal: four nullable columns, added with `PRAGMA table_info` plus `ALTER TABLE … ADD COLUMN`; handles and lifecycle unchanged. A hook newer than its supervisor retries with the bare event when refused with `invalid_discovery_event`. No new module, so the manifest and the helper are unchanged (`worker-bundle-closure` passes).

## Evidence

- Tests: 14 new in `local-session-discovery.test.mjs` and `local-session-attachments.test.mjs`; **297/297** pass across `local-messaging-*`, `local-session-*`, `claude-session-*`, `worker-bundle-closure`, `client-supervisor-local-messaging`, `codex-local-inbox`, `grok-local-session` and `keychain-launch-contract`, with no failures or skips. The full agent-worker suite was not run. They cover sanitization, bounds, tampering with title or host between challenge and report, the presence matrix with a fake probe, a real `sleep` process alive, reused (wrong start time) and killed, ps failure, additive migration of a pre-title journal, the real hook subprocess reading a registry fixture named after its parent pid (right session, other session, reused pid, secret `.key` file untouched), and Codex name/title/schema fallbacks.
- Real session check: the Claude reader run in this desktop session returned the true session title and the `claude` process (pid, start, scope `session`); the `ps` table took 42 ms and the lookup 0.5 ms, well inside the 5-second hook timeout.
- Bug found by a test: on macOS `ps -p a,b` prints nothing when any listed pid is gone, so a batched probe would have reported every live session as gone. The probe reads the whole table instead.

## Harness documentation consulted (2026-10-24)

- Claude Code hooks: settings-file edits are normally picked up by a file watcher; hook input has no title field (only `session_id`, `prompt_id`, `transcript_path`, `cwd`, …); `Stop` carries `last_assistant_message`; `SessionStart` can return a `sessionTitle`. https://code.claude.com/docs/en/hooks
- Claude Code MCP: project servers need approval in interactive sessions; `/mcp reconnect all` retries failed servers; enabling a plugin mid-session connects its servers; the page does not say whether a new `.mcp.json` entry loads into a running session. https://code.claude.com/docs/en/mcp
- Codex hooks: new or changed hooks are skipped until trusted (trust is per hook definition); common input has no title; the page does not say whether a running session re-reads `hooks.json`. https://learn.chatgpt.com/docs/hooks
- Codex MCP: project `.codex/config.toml` is read for trusted projects only; the desktop app's steps say to restart after configuring; `_meta` thread ids are not documented (our own 2026-10-23 probe measured them). https://learn.chatgpt.com/docs/extend/mcp?surface=cli

## Not proven

- Which process Codex Desktop hooks actually run under. The process layout suggests the shared `codex … app-server`, so such rows are expected to be `unknown` with `scope: shared`; the first live desktop registrations will confirm it.
- Codex title refresh in the desktop app (the generated title may appear only after the first turn, so the first prompt's hook can miss it).
- That reopening an already-loaded Codex chat, short of an app restart, loads new hooks.
- Whether a Claude plugin avoids the restart for the session MCP server.
- Any installed behavior: nothing here has run in the production supervisor.

## Ideas left out on purpose

A `Stop` hook would give busy/idle evidence for both harnesses, but a new hook definition needs fresh Codex trust, so it is a separate owner decision. Reading harness thread stores to list chats that never reported would be a scan the discovery decision excludes.

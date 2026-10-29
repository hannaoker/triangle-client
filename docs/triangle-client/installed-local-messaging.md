# Installed local messaging

Current additions: the local principal router and optional attached-chat reply
identity are implemented. Runtime v14 includes the latter's full import closure;
new pin creation remains disabled by default. Existing pins continue to be
verified when it is disabled. See the [R1 acceptance](../handoffs/2026-10-26-r1-installed-acceptance.md)
and [R2 acceptance and limits](../handoffs/2026-10-26-r2-installed-disabled.md).
Local socket traffic is journaled on this device, not on the MESH server.
Grok remains owner-paired and pull-only, with no automatic Grok wake.

The existing Triangle supervisor hosts the local control socket, production SQLite journal and recoverable dispatcher. It reuses registered profile runners and serializes their local and MESH turns through one shared reasoner gate. Same-host delivery does not use Iroh or MESH. Harness inference can still use its provider's network connection.

## Install and bind

Stage the supervisor runtime with `scripts/triangle-worker-install.py stage-runtime --agent supervisor` and install its wrapper with `install-local-wrapper --application-root ...`. The wrapper embeds a frozen copy of the installer and its shebang names the interpreter that ran the installer (`sys.executable`, required to be an absolute path without whitespace) instead of a hard-coded `/usr/bin/python3`, so run the installer with the Python you want pinned; on macOS `/usr/bin/python3` reports the Command Line Tools interpreter it resolves to. Manifest v9 packages the complete local messaging closure; exact v8 bundles remain valid. The Swift helper must also support v9 and forward the opted-in configuration path.

The installed entry is `~/Library/Application Support/The Triangle/bin/triangle-local`:

```text
triangle-local setup --thread-id CURRENT_THREAD --recipient gravity2
triangle-local status
triangle-local status --message-id STABLE_ID
triangle-local discover
triangle-local send --to gravity2 --text "Task" --message-id STABLE_ID --request-id STABLE_REQUEST
triangle-local replies --request-id STABLE_REQUEST
triangle-local consume --message-id REPLY_ID
triangle-local mcp
```

Setup binds the desktop sender to the thread named by `--thread-id`, but only in the owner-created integration file (`desktop-integration.json` in the local state directory). It reads the dedicated desktop-sender binding (`desktop-binding.json`, falling back to legacy `app-server-binding.json` if present) solely for the existing sender identity and never writes it. Local messaging keeps working when an older app-server host is retired or moves its own binding, because the thread is fixed by the integration file and the broker verifies that the desktop identity matches. Use `--rebind-thread` only as an explicit owner action to move an existing integration to another conversation; it rotates the capability secret, so old exchanges stop working. Setup preserves wake settings but disables automatic wake whenever the sender or thread changes (or the prior integration is missing); activate wake explicitly for the new binding. Setup does not enroll a replacement identity or touch the binding's inbound wake flag. Restart the existing client service after setup. A cold multi-profile start can exceed the service script's default ten-second readiness window; `TRIANGLE_READY_TIMEOUT_MS=60000` is available for the supervised activation check.

## Custody and authority

Setup writes private owner configuration and a capability binding to one sender, thread and recipient allowlist. The supervisor authenticates that binding and issues short-lived turn credentials. It rereads the integration capability on every exchange so rotation revokes old exchanges. The secret is verified before anything else; only verified exchanges are charged to the desktop bucket (120 per minute), while failed attempts have their own bucket (30 per minute), so an unauthenticated caller cannot lock the desktop out. The supervisor signing key stays in process. A developer running as the same OS user can read owner files; this interface does not isolate mutually hostile processes sharing that account.

Message, request and recipient identifiers must be bounded identifier strings (`[A-Za-z0-9._:-]`, 1 to 256 characters; UUIDs, `rep-<uuid>` reply IDs and 64-hex instance IDs all qualify), otherwise the call fails with `invalid_request`. The server decides with the sender in the signed credential, never the client's own `senderId` string. Because a caller may omit `inReplyTo` and so restart conversation depth, one sender/recipient pair (both directions together) is also capped server-side at 10 admitted messages per 10 minutes (`exchange_limit_exceeded`); exact retries and refused sends do not count.

Admission means the immutable envelope was durably stored, not that the agent succeeded. Requests are claimed once; exact retries retain their original IDs. Queued requests recover after restart, while uncertain executing requests become held and are not automatically replayed. Replies are correlated, non-consuming on retrieval, and persisted independently of the client connection. Agent assessments remain free-form and must be independently checked.

Shutdown waits only for executions that already started (bounded by the runner timeout) and never starts queued work; queued messages stay `queued_local` and run after the next start.

A listing always returns at least one pending reply. One response carries about 255 KB, so a reply larger than that is returned cut to fit with `truncated: true` and `originalTextBytes` (the full text stays in the journal, never silently dropped) and can still be consumed. Replies that merely overflow the page wait whole for the next listing, so consume what you have read.

Local coding execution defaults to 60 minutes, configurable from one second through 24 hours in `runnerTimeoutMs`. The host forwards this budget to the subprocess runner so an earlier profile deadline cannot cut local tasks short. MESH profile execution deadlines remain unchanged. Caller waits and authentication token lifetimes remain separate from execution time.

Timeout starts when the runner actually acquires the reasoner gate. A late success after timeout stays held with reason `runner_timeout` instead of becoming a normal reply. Its text is kept for the owner in the journal (`late_result_text`, an additive nullable column added automatically to existing journals), and per-message status exposes only `hasLateResult: true`, never the text. Shutdown retains journal ownership until underlying execution settles. Status exposes queue, executing, completed, held, pending-reply and dispatcher counts. MESH or provider authentication failures remain distinct from local route health.

Local route failures never stop the supervisor's MESH, headless or ACP lanes. A bad owner configuration, a missing recipient lane, a changed desktop identity, or a busy journal or socket disables only the local route. The supervisor logs the failure code, retries the host with exponential backoff (rebuilding it so repaired owner files are reread), and its `localStatus()` reports `state: "failed"` with that code, never secrets, until a start succeeds. An existing but unsafe or invalid `local-messaging.json` keeps its strict validation but is omitted from the helper bootstrap and recorded as a `local_messaging_invalid` omission instead of failing the whole bootstrap; the supervisor preflight does not count it as a MESH failure. The owner can still see the cause with `triangle-local status`, which rereads and validates the same file.

## Journal files and retention

The journal lives in the local state directory as `local-messaging.sqlite` (plus `local-messaging-owner.sqlite`, the exclusive owner lock). Services installed before this change used the peer drain's file names (`peer-drain.sqlite`, `peer-drain-owner.sqlite`). The first start moves them once, under the old owner lock and together with any `-journal` files, keeping their 0600 modes; it refuses with `journal_busy` while an old-version service still owns them, with `journal_migration_conflict` when both name sets exist, and never moves a database that is not a local journal. Nothing is copied or rewritten, so rolling back to a build that predates the move means moving the two files back to their old names.

The dispatcher compacts finished records at start and at most hourly, with the peer drain's eight-day rule: completed messages are removed only once all of their replies have been consumed and aged out, and consumed replies after eight days. `held`, `queued_local` and `executing` records and unconsumed replies are never compacted. An exact retry of a compacted message ID is admitted as new work, and a compacted message can no longer be named as `inReplyTo` (`parent_not_found`).

## Scope and limits

### Readable recipient directory (source candidate)

The source candidate adds `triangle-local sessions`, RPC `list_sessions`, and
MCP `triangle_list_sessions` to both Codex and Claude adapters. These require a
matching updated supervisor; an older server reports an unsupported-method error.
This section does not imply an installed runtime upgrade.

Each entry contains `id`, `label`, `kind` (`worker`, `conversation`, or `unknown`)
and `presence` (always `unknown` for these configured entries; discovered chats carry
evidence-backed presence, see "Titles and presence"). Worker profile names and fixed paired
conversation labels come from owner configuration, not transcript scans. Labels
are untrusted display text; use the exact `id` for routing. The directory lists
only the intersection of the existing owner ACL and credential recipient scope.
It neither grants access nor proves that a recipient is online or can wake.
Legacy `discover` and `triangle_list_recipients` keep their ID-only output.

This is a directory for existing registrations, not automatic discovery of all
open chats. Automatic registration, liveness evidence and conversation titles come
from lifecycle discovery (the sections below), not from this directory. This
directory needs no schema migration. Rolling
back removes the new read-only method without modifying messaging data or grants.

The CLI is an installed supported path. The MCP stdio entry uses the same socket API and passes subprocess protocol tests, but adding it to an already running Codex conversation may require a host reload. Do not claim native Triangle tools are available until that host actually exposes them.

Both entries make a retry safe. The MCP `triangle_send_message` tool generates `messageId` and `requestId` itself when the caller omits them and returns both in its result and in its error text (marked "outcome unknown" after a transport failure); the CLI prints the same IDs as `send_outcome_unknown`. A retry that reuses them is an idempotent duplicate and is never dispatched twice, while a retry without them is a new message.

This milestone proves desktop-to-registered-agent delegation and durable return delivery. Recipient turns do not yet receive a configured outbound Triangle tool for recursive delegation. End-to-end provider availability, repeated long coding tasks, interruption/resume and multi-machine transport require their own evidence; one successful coding task does not establish universal reliability.

## Opt-in desktop reply wake (v10 candidate)

The v10 source candidate adds Codex queue notifications to the existing host;
this does not mean the Mini has been upgraded or push enabled. Exact v8/v9
bundles remain supported. The v10 artifact set adds `codex-wake-adapter.mjs`
and `local-messaging-notifier.mjs`; update the verified helper and supervisor
bundle together before enabling this configuration.

An optional `wake` object in the private local configuration pins `enabled`,
the absolute `codexPath`, and the owner's absolute `codexHome`. Absence or
`enabled: false` preserves pull behavior. The target is the existing desktop
broker's identity and thread, never a peer-selected destination. Activation
still requires the live ownership, delivery and shared-submission gates in
the harness-wake plan. There is no fallback server or thread resume.

Hints contain only validated infrastructure identifiers, counts and held/late
presence, using a fixed automated/untrusted template. Agent reply text remains
free-form and must be independently verified. One durable outstanding hint
coalesces the backlog. A successful queue receipt means accepted for queueing,
not read or completed. Timeout, crash or ambiguous output holds the hint;
new replies, ordinary retrieval, consumption and time do not retry it.

After retrieving updates, the bound desktop can explicitly acknowledge the
exact wake ID and generation using `triangle-local ack-wake --wake-id ID
--generation N`, or MCP `triangle_ack_notification`. Acknowledgment does not
consume replies. An unchanged acknowledged snapshot does not generate another
turn; new updates can produce a later coalesced hint. Foreign/stale
acknowledgments must fail. Uncertain delivery requires exact acknowledgment or
future explicit operator reconciliation, rather than automatic retry.

### Claude Desktop session adapter (v11 source candidate)

The v11 candidate adds the interactive-session broker, version-pinned Claude
socket delivery module, and session-local MCP child to every bundle. Existing
v8/v9/v10 artifact sets remain supported. This source change does not upgrade
the Mini or grant a Claude session Triangle access.

The new `triangle-local claude-session-mcp --expected-version 2.1.307`
entry runs inside Claude's project-scoped MCP server process. It requires a
distinct owner-paired interactive integration whose session UUID matches the
child's inherited UUID. The supervisor owns the journal and identity authority;
the child holds only its own inherited Claude socket capability. Never copy the
Codex desktop integration to enroll Claude. Explicit pairing, bundle verification
and live bidirectional acceptance remain release gates.

### Recovering a wake held after rebinding

Rebinding while a notification is outstanding fences it into `stale_held`.
Normal acknowledgment cannot clear that state, even using the new generation.
The operator can reconcile it without modifying SQLite manually:

1. Read `triangle-local status` and note `wake.activeWakeId` and `wake.generation`.
2. Set `wake.enabled` explicitly to `false` in the private local configuration,
   then stop the Triangle Client service.
3. Run `triangle-local reconcile-wake --wake-id ID --generation N` with the exact
   held wake ID and current generation (add `--config` for a nondefault config).
4. Restart the service. Re-enable wake only when the new target is ready.

This offline command requires the current private desktop binding and exclusive
journal ownership; it refuses while the supervisor owns the journal. It only
clears `stale_held`, validates the current integration thread and binding, and
rejects a wrong wake ID or generation. It clears obsolete notification metadata
so unread backlog can generate a fresh wake on the new thread. It does not
acknowledge or consume replies, retry held tasks, or erase message data. There is
no recovery RPC or agent MCP tool. Disabling wake does not withdraw a hint
already queued in the old conversation; its old acknowledgment remains fenced.

### Automatic Claude discovery (new source candidate)

After upgrading to this candidate, the owner can opt one canonical workspace in:

```text
triangle-local setup-discovery --workspace /absolute/workspace
```

The command adds lifecycle hooks to `.claude/settings.local.json` and a private
workspace-scoped installation capability. Preserve the printed hook-approval
requirement and restart the existing Triangle service once to load the optional
configuration. Do not assume this command exists in a previously installed build.
Already-open Claude chats appear on their next hook-bearing turn; new chats and
forks appear when their backend starts. The live disposable Desktop check picked
up the hooks without an app restart; other surfaces/versions are not established.
The hook never scans other chats or collects prompt text or transcript contents.

Use `sessions` or `triangle_list_sessions` to inspect exact session handles,
workspace/session-hash-prefix labels, lifecycle and last-seen metadata. Discovered
entries explicitly report `visible: true`, `reachable: false`, `wakeCapable:
false`. They do not acquire a Triangle inbox or messaging permissions. Titles
and presence come from evidence the chat's own hook reports ("Titles and
presence" below); Codex chats are covered under "Codex discovery". A chat that
was already open when the hooks were installed may need a reload ("What needs a
reload").

To turn it off or prepare rollback, run `triangle-local disable-discovery` using
the candidate before restoring older runtime code. It disables the capability,
removes only its managed hooks, and removes the optional config key so the old
host can read the configuration. Additive SQLite metadata can remain. No existing
messages, bindings, claims or unrelated agent settings are reset. Metadata has a
128-session cap and eight-day cleanup on subsequent reports. One installation
supports one workspace; a different workspace requires a separate explicit scope.

If the discovery integration is missing/corrupt or its workspace has moved,
configured recipients still list normally while discovered entries are hidden.
`disable-discovery` still removes the optional host config key for rollback.
Check its `hooksCleanupRequired` result: if true, supply the actual moved workspace
with `disable-discovery --workspace /absolute/moved/workspace` to finish hook
cleanup. The command does not follow unsafe paths or pretend a valid capability
was disabled when its file cannot be updated. Base setup preserves existing
optional integrations. At the 128-row limit, discovery evicts the oldest ended
row and retains its end marker; it does not evict observed sessions. Local status
reports directory `used` and `capacity` so an all-observed full directory is visible.

### Codex discovery (visibility only)

```text
triangle-local setup-discovery --harness codex --workspace /absolute/workspace
```

The command adds the same three lifecycle hooks to `.codex/hooks.json`
(`SessionStart`, `UserPromptSubmit`, and `SessionEnd` with a three-second
timeout) and keeps unrelated hooks. The owner reviews and trusts the new hooks in
Codex's own hook review; trust is recorded per hook definition, so a changed hook
needs review again, and no trust bypass is used. One workspace capability serves
both harnesses: `--harness` defaults to `claude`, and setting up the second
harness keeps the first. `disable-discovery` removes the managed hooks of both.

Codex entries read `Codex · <title> · <workspace> · <hash>` and carry an optional
descriptive `origin` (`cli`, `vscode`, `exec`, app-server variants, `subagent` or
`unknown`). Origin says where the chat began, not who runs it now, and nothing is
excluded by it. Discovery alone carries no receive or wake capability
(`reachable: false`, `wakeCapable: false`): the one conversation bound with `setup`
(and `setup-inbox` for incoming requests) can receive and be woken, and any Codex
chat can be attached with the separate opt-in under "Codex chat attachment". "All sessions"
means chats whose hooks report from the opted-in workspace. There is no scan of
other chats, so a chat that has not run a hook since the hooks were installed is
not listed.

### Titles and presence

Each lifecycle hook reads metadata about its own session only and reports it with
the event. Nothing else is read.

**Title**

- Claude: the session name in Claude's own per-process registry,
  `<claude config>/sessions/<pid>.json` (`CLAUDE_CONFIG_DIR` is honored). The hook
  walks up its process ancestry and accepts a record only if its pid is an
  ancestor, its `sessionId` is this session's and its `procStart` equals that
  process's start time, so a leftover file of a reused pid is ignored. The secret
  `.key` files beside it are never opened. Claude's hook input carries no title.
- Codex: `threads.name` (the name the user gave the chat), else `threads.title`,
  in `state_5.sqlite`: the same read-only lookup of the hook's own row that
  supplies origin.
- Both are private, version-specific files (seen on Claude 2.1.308 and Codex
  0.164.0), not supported APIs. When their layout changes the title is simply
  absent. A title is refreshed whenever a hook can read it, so a rename shows
  after the chat's next prompt, and an ended chat keeps its last title.
- Titles are untrusted display text: one line of at most 80 characters, control
  and bidirectional characters removed, and key-like runs of 28 or more letters
  and digits masked. They appear in `label` and in a `title` field, and every
  configured directory reader sees them. Route by `id`, never by title.
- To keep titles out of the directory run `triangle-local setup-discovery
  --no-titles` and restart the service (`discovery.titles: false`; the choice
  survives rerunning setup for the other harness, and `--titles` turns them back
  on). Hooks then stop reporting them, and titles already stored are hidden and not
  stored again; they stay in the journal file only until the entry ages out.

**Presence**

`presence` is `online`, `offline` or `unknown`, and `presenceEvidence.kind` says
which evidence decided it:

| `presenceEvidence.kind` | Meaning | `presence` |
| --- | --- | --- |
| `end-event` | The chat's end hook reported. | `offline` |
| `mcp-lease` | An attached MCP child holds an unexpired lease (renewed every five seconds, valid 30). | `online` |
| `host-process` | The process hosting the chat, recorded by its hook with its start time, is alive now. With `scope: session` (one process per chat: Claude, `codex exec` or the Codex CLI) | `online` |
| `host-process` | The same, with `scope: shared` (Codex Desktop is expected to run chats in one shared app server, so alive means the app is up, not that this chat is open). | `unknown` |
| `host-process-gone` | That process no longer exists, or its pid now belongs to another process. | `offline` |
| `none` | No evidence, or the process check could not run. | `unknown` |

Presence is not reachability. `capabilities.reachable` stays false until a chat is
attached (Claude, with the workspace messaging opt-in), and an online chat can
still be busy. The supervisor checks the recorded processes with one `ps` listing
per refresh, cached for five seconds, and never returns a process id to a reader.
A check that cannot decide is `unknown`, never `offline`. The first live Codex
Desktop registrations will show which process their hooks actually run under; until
that is confirmed, treat a `shared` or missing host as "no per-chat evidence".

### What needs a reload

A harness loads hooks and MCP servers when it loads a chat. Triangle cannot change
that, so it reports what is missing (`attachment` and `attachmentHint` on a
discovered Claude chat) and this table records what has been measured.

| Added after the chat started | Claude (Desktop, CLI) | Codex (Desktop, CLI) |
| --- | --- | --- |
| Discovery hooks (`setup-discovery`) | **No reload.** Open chats registered on their next prompt (measured 2026-10-23, Claude Desktop). Claude Code's documentation says edits to settings-file hooks are normally picked up by a file watcher. | **Reload needed.** Chats that were already loaded kept their old hook set (measured 2026-10-24, Codex 0.164.0). Both desktop chats registered after the owner restarted the Codex app, 1.4 and 1.2 seconds after their MCP launch. Whether reopening a loaded chat without an app restart is enough was not measured. New chats, and finished chats resumed later, register on their own. The hooks must also be trusted. |
| Messaging MCP entry (`setup-session-messaging`, `.mcp.json`) | **Existing chats do not gain it.** An app restart was required in the 2026-10-23 test, and Claude Code's documentation does not say that a new project server loads into a running session. Approve the project server when Claude asks. | The project `.codex/config.toml` is read for trusted projects only, and the desktop app's MCP steps say to restart after configuring; not measured for this entry. The chat then attaches on its first Triangle tool call ("Codex chat attachment"). |

What an operator sees:

- A discovered Claude chat with no MCP child lists as `attachment: "not-attached"`
  with a hint to reload or restart it, and `presence` follows the other evidence
  (not `offline`). Once the child connects it lists as `attached`, `presence:
  "online"` with `mcp-lease`, and `capabilities.reachable: true`.
- A Codex chat that predates the hooks is not listed at all. Listing it would
  need a scan of other chats, which discovery does not do. Restart the Codex app
  or start a new chat.

Not adopted: forcing a reload, and reading the harness thread stores to list chats
that have not reported. Not yet tested: shipping the session MCP server as a Claude
Code plugin. Claude Code documents that enabling a plugin mid-session connects its
MCP servers, which may allow attachment without a restart.

### Rollout and rollback of titles and host evidence

No module file is added, so the supervisor manifest version and the native helper
are unchanged. The journal gains four nullable columns on first start (additive; an
older release ignores them). A hook newer than the running supervisor falls back to
the bare lifecycle event when the older supervisor refuses the optional fields, so
the order of staging and restarting does not lose registrations. Before restoring
an older runtime, run `triangle-local disable-discovery`: it removes the optional
`discovery` configuration key (including `titles`), which an older host rejects.

## Workspace Claude attachments (candidate)

After installing this feature, enable lifecycle discovery, then run
`triangle-local setup-session-messaging --workspace /absolute/workspace`.
Restart the existing supervisor and reconnect/create Claude MCP sessions as
required by the harness, honoring its approvals. Setup adds only its managed
`triangle-session` entry to `.mcp.json`, preserving other entries and refusing
to overwrite an existing different entry. Existing MCP children are not
retroactively attached: a visible chat that has none is listed as
`attachment: "not-attached"` with a hint (see "What needs a reload").

Participation is a separate capability from discovery. The initial receiver
policy permits only the bound Codex sender; attached sessions can initiate sends
only to configured workers. Replies follow the original sender and claim.
This does not add an incoming Codex inbox or Claude-to-Claude permission.

The policy file is a ceiling, not a mirror of the owner config. Effective
authority is the policy intersected with the owner config the supervisor loaded:
a worker removed from `recipients` stops being reachable from attached sessions
at the next supervisor restart, while a worker added later needs
`setup-session-messaging` to be run again. The policy names the Codex sender
that was bound when it was written. Re-running `setup` with a replacement sender
revokes participation (policy disabled, managed MCP entry removed, config key
dropped); run `setup-session-messaging` again to authorize the new sender. A
thread-only `--rebind-thread` keeps the same sender and keeps participation.

If the policy file is damaged or the opted-in workspace is missing or moved,
attached sessions disappear from listings and the supervisor logs
`Workspace session messaging unavailable (<code>)` once per failure, for example
`invalid_private_file` or `workspace_missing`, again after a recovery. Configured
workers stay available throughout.

MCP initializes before attachment: Claude may fire SessionStart only after MCP
initialization finishes. First tool call/heartbeat attaches only after matching
lifecycle registration. The child uses its own exported session/socket/token;
no supervisor scanning of session token files occurs. Lifecycle end fences
stale inherited identities after `/clear`.

Use exact `session-...` IDs. A child renews a durable 30-second lease every five
seconds. Clean close detaches; a crash becomes offline after expiry. Restart
preserves custody; competing children cannot replace an unexpired lease.
Wake state belongs to the session address and lifecycle generation, not to the
child process: a replacement child inherits an outstanding wake and can
acknowledge it, while a new lifecycle generation starts a fresh wake epoch.
The heartbeat attaches every five seconds; tool calls reuse the grant of the
latest attach for up to 15 seconds (the supervisor still checks lease, child and
generation on every request, and the policy is checked before every call) and
attach afresh once, transparently, when a reused grant is refused, for example
after a supervisor restart. Attach requests are budgeted per session, 240 a
minute, so a busy session cannot starve another's lease.
A session's custody lease, wake binding and wake history live exactly as long as
its directory entry: they are removed when the entry ages out (eight days) or is
evicted from a full directory, and by the periodic compaction.
Capability rotation/disable fences prior credentials. Presence means a recent
child heartbeat, not that the model is free. Wake remains unsupported and pinned
to Claude 2.1.307; write acceptance alone is not visible-delivery proof.

`disable-session-messaging` revokes participation and removes only the matching
managed MCP entry. Disabling discovery also disables participation. Disabling
always converges, even when the policy file is damaged (an unreadable policy
cannot admit anyone), and both commands report `mcpCleanupRequired` when the
managed entry could not be removed, for example after the workspace moved
(pass `--workspace`). Neither cancels claimed execution, deletes messages,
redirects work to another chat, or launches a replacement. Existing
claim/retention behavior is unchanged; this adds no new task expiry contract.
Same-account shell isolation is not claimed. Cross-machine transport and worker
launch remain deferred.

## Codex chat attachment (candidate)

Lets any Codex chat in an opted-in workspace receive Triangle messages, answer them
and be woken, without binding it. It shares the workspace messaging capability and
policy file with Claude attachment and adds a Codex section to the policy.

```text
triangle-local setup-session-messaging --harness codex --workspace /absolute/workspace \
  --sender <exact id> [--sender <exact id> ...]
```

Prerequisite: `setup-discovery --harness codex` for the same workspace. Each
`--sender` is an exact principal id (64 hex characters) or session address
(`session-` and 64 hex) that may message Codex chats. None is granted by default,
and the list is separate from the Claude receiver list. Restart the existing
supervisor afterwards. Codex reads a project's `.codex/config.toml` for trusted
projects only, so trust the workspace in Codex, then restart the Codex app or start
a new chat so the server loads.

Setup writes a marked block into `<workspace>/.codex/config.toml` and leaves the rest
of that file alone: the `triangle-session` server (`triangle-local codex-session-mcp
--config … --workspace-messaging …`) and a pre-approval for every tool except
`triangle_send_message`, so a woken chat can read and answer its inbox without
waiting for a person while a send, which reaches another agent, keeps asking.
Setup refuses an existing `triangle-session` table that it did not write, and
rerunning it changes nothing. `disable-session-messaging` removes the block (and the
file if nothing else was in it) and fences the capability for both harnesses.

**How a chat attaches.** Codex tells an MCP server which chat is calling only in the
call itself (`_meta.threadId` and `sessionId`, observed on Codex 0.164.0). It is not
in the environment, in `initialize`, in `tools/list` or in the MCP server
instructions, which Codex does not show the model. So a chat attaches on its first
Triangle tool call: ask it to call `triangle_get_status` (it returns the chat's own
`session-…` address), or put that instruction in the workspace `AGENTS.md`. Until
then it is listed `attachment: "not-attached"` with a hint, and nothing can be sent
to or wake it. The call must name exactly one chat (a subagent thread is refused),
and the chat must already be registered by its own lifecycle hook. One MCP process
can serve several chats; each has its own address, lease and inbox.

**Receiving.** The tools are the Claude chat's: `triangle_list_inbox`,
`triangle_claim_message`, `triangle_reply_message`, `triangle_ack_notification`,
`triangle_get_replies`, `triangle_consume_reply`, `triangle_list_sessions`,
`triangle_list_recipients`, `triangle_send_message` and `triangle_get_status`.
A message to an attached chat is never run by a worker; the chat reads it as
untrusted peer content and replies to the original sender. A Codex chat can send
only to the owner's configured recipients, not to other sessions. A Claude chat can
message a Codex chat only if its exact address is among the `--sender` values.

**Wake.** While a message or reply is waiting, the chat's MCP child runs
`codex queue --thread <the chat's own id> --message <fixed hint>` with the
`codexPath` and `codexHome` the owner pinned under `wake` in the local configuration,
so wake needs `wake.enabled`; without it chats are pull-only. The hint carries
counts and no peer text, is never retried, and is cleared by the chat's own
acknowledgment. The supervisor stores only hashes; the raw thread id exists only in
the child's memory. A chat that has never called a Triangle tool cannot be woken,
because neither the child nor the supervisor knows its thread before that call.

**Bound conversation.** The conversation bound with `setup` keeps its own identity
(64 hex) and inbox. If it also loads this server it appears a second time under a
session address; use one route for it.

**Evidence and limits.** Real Codex 0.164.0 `exec` on an isolated host: a chat
attached on its first call, was `online` through `mcp-lease`, claimed and answered a
message from the owner side, and detached when it exited; `codex queue` through the
wake adapter was accepted for that finished chat's thread. Not yet shown: Codex
Desktop starting a turn from the queued hint in an idle chat. Rollback: run
`disable-session-messaging`; older releases reject a policy file that has the
`codex` section, so disable first.

### Optional automatic Codex attachment (owner opt-in)

With a runtime containing `triangle_attach_session`, add `--auto-attach` to the existing
`triangle-local setup-session-messaging --harness codex --workspace <workspace> --sender <exact-owner-id>`
command. This installs two managed MCP hooks in the workspace `.codex/hooks.json`:
`SessionStart` and `UserPromptSubmit`. Review and trust those exact new definitions through
Codex's normal hook UI; setup does not trust them for you. Existing MCP configuration may
still require an app restart.

The hooks call the chat's own MCP child directly, using Codex-supplied identity metadata.
The model does not have to call status first. The first-prompt hook covers MCP readiness at SessionStart; the attachment tool also
waits up to two seconds for a concurrent discovery command, retrying only explicit offline
refusals. Timeouts and other errors keep their existing failure semantics. No additional reasoning turn is
queued merely to attach. The fixed bound chat remains on its existing identity and inbox.
This adds no sender, receiver grant, global session scan or alternate App Server.

Omitting the flag preserves prior opt-in. `--no-auto-attach` removes only the two managed
attachment hooks; manual first-tool-call attachment stays available. Full
`disable-session-messaging` removes the hooks and MCP entry and fences the policy.
Unrelated hooks and configuration, including their file permissions, are preserved.

This runs only when Codex actually emits lifecycle events with the MCP server connected;
it does not reopen an unloaded chat. CLI 0.164.0 and Desktop-bundled 0.164.0-alpha.11.1 hook metadata were measured.
Installed Desktop new/reopened chats attached without model-side tool calls and completed
automatic wake/reply acceptance; these checks do not establish unopened-chat wake.
See `docs/reviews/2026-10-25-codex-auto-attachment.md` for evidence and rollout checks.

## Bound Codex incoming requests (candidate)

The owner may enable the inbox for exact local sender IDs:
`triangle-local setup-inbox --sender <exact-id>` (repeat `--sender` as needed),
then restart the existing supervisor. This does not enable wake automatically;
it uses the already configured Codex wake owner. Without opt-in, inbound requests
are denied. Workspace participation is still required for attached Claude senders.

Use `triangle_list_inbox`, `triangle_claim_message`, and `triangle_reply_message`
from MCP, or `inbox`, `claim --message-id ... --claim-id ...`, and
`reply --message-id ... --claim-file /private/claim.json --reply-id ... --text ...`
from the installed CLI. Save claim output in an owner-private directory/file.
Use stable claim/reply IDs when retrying. Claiming removes queued inbox visibility
but retains the executing record; replies return to the original sender.

Incoming wakes carry counts only. Read/surface peer content by default, and act
only under this conversation's own authorization. `disable-inbox` revokes the
receiver role and requires a supervisor restart; retained work is not deleted,
released, redirected or rerun. Thread rebinding disables the inbox and automatic
wake until explicit reauthorization. No second App Server or reasoning launcher
owns the inbox. Existing claim leases/retention still apply; this adds no automatic
task-expiry, lease-extension or cancellation contract.

## Exact chat grants (candidate installed on Mini 2026-10-28)

A directional exact grant permits one authenticated sender address to initiate
requests to one attached chat address. It never authorizes execution of peer
content. Discovery visibility alone remains insufficient to deliver a message.
Replies use existing claim custody and need no reverse initiation grant.

After installing the updated supervisor, CLI and session MCP children, owners can
use `triangle-local grant-session --sender EXACT_SENDER --to session-EXACT_TARGET`,
`revoke-session` with the same arguments, and `list-session-grants`. The list shows
both exact pairs and existing workspace-wide sender lists. Revoking a pair does
not remove a separate workspace-wide grant. Grok's own directional pairing ACLs
still apply in addition to session policy.

To opt a harness into messaging without workspace-wide inbound senders, use
`setup-session-messaging --harness codex --workspace WORKSPACE --exact-only` (or
`--harness claude`). This explicitly clears only that harness's workspace-wide
sender list; existing exact pairs and the other harness's grants are preserved.
It retains the normal setup/trust/reload requirements. Do not apply it to a live
workspace without owner approval for the intended permission change.

Grant creation migrates the private session policy to version 2, preserving the
existing lists. Older readers reject version 2, so install the matching runtime
and reload existing MCP children before creating grants. Revoke does not downgrade
the policy. To roll back, restore a privately saved compatible policy together
with its matching runtime, or disable messaging; do not hand-remove the version
field or exact grants to make an old reader accept it.

Send-time policy is authoritative: revocation blocks a new request even when a
caller still holds an earlier credential. Adding access may need the next MCP
heartbeat/credential renewal (normally five seconds); a cached credential never
widens itself. The same session address keeps its grant across reattachment;
a new replacement chat does not inherit it. Grant lists are scoped by the
installation/workspace and the existing generation/child fencing still applies.
Accepted requests and their valid replies are not canceled by initiation revocation.

Owner policy edits serialize on a private adjacent `session-messaging.json.lock`
file. Concurrent writers fail with `policy_busy` and may retry after completion.
A crash can leave a lock: stop owner configuration commands, verify no such edit
process remains, then remove only that stale lock before retrying. Never steal an
active lock or remove the policy itself. Reads and message processing do not
acquire this owner-edit lock.

# Installed local messaging

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
and `presence` (currently always `unknown`). Worker profile names and fixed paired
conversation labels come from owner configuration, not transcript scans. Labels
are untrusted display text; use the exact `id` for routing. The directory lists
only the intersection of the existing owner ACL and credential recipient scope.
It neither grants access nor proves that a recipient is online or can wake.
Legacy `discover` and `triangle_list_recipients` keep their ID-only output.

This is a directory for existing registrations, not automatic discovery of all
open chats. Automatic registration, lifecycle handoff, liveness and readable
conversation titles remain separate work. No schema migration is needed. Rolling
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
false`. They do not acquire a Triangle inbox or messaging permissions. Presence
is unknown while observed and offline after an end event; missing crash/end
signals do not establish live status. Actual chat titles and automatic Codex
registration are not implemented.

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

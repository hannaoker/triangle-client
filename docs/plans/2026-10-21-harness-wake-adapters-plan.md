# Harness wake adapters implementation plan

> **For implementer:** Use risk-based TDD. Write failing tests before changing behavior. Review and verify installed artifacts before activation.

**Goal (desktop push approved under D7-R):** A reply or actionable failure wakes the correct Codex or Claude Code conversation without model-side polling; hosted Grok Bot has an explicitly gated webhook/routine path.

**Architecture:** Keep Triangle's existing supervisor, identities, durable journal and delivery modes. Use harness-native delivery mechanisms behind small adapters. Reason Network is the behavioral baseline and a source of selectively reusable code, not a second production message bus.

## October 22 execution addendum

**Codex slice status:** implemented in the source candidate, with automatic wake
disabled by default. Antigravity completed the reviewed correction and test
handoffs through installed Triangle; parent Codex independently verified 142
focused tests and the full worker suite (851 passed, three skipped, zero failed),
plus 11 Swift launcher tests and the v10 packaging checks. The initial full run
found one stale v9 test expectation, corrected before the final full run.
The macOS candidate package builds successfully. These checks do not close the
remaining visual/bound-thread/arbitration activation gates or imply the Mini's
installed v9 service has been upgraded. Claude and hosted Grok remain separate
milestones.

This addendum supersedes the generic event-stream proposal below for the first
Codex milestone. Derive notification obligations from canonical unread replies
and held messages, with one durable delivery-state row per binding. Generic
subscriptions are deferred; free-form agent results remain unchanged.

- One outstanding hint across submitting, accepted-awaiting-ack, uncertain and
  stale-held. New arrivals accumulate; ordinary pull, consumption and elapsed
  time never clear submission uncertainty. No automatic retries after expiry.
- Every hint has a fresh wake ID, binding generation and snapshot fingerprint
  including held/late-result state. Only authorized acknowledgment for that
  exact wake ID/generation completes it. Do not repeat an unchanged acknowledged
  snapshot. Explicit operator force-clear must warn of duplicate-turn risk.
- Fixed automated/untrusted hint template; validated infrastructure IDs and
  counts only. No peer-provided content is inserted into the queued user text.
- Request-pair admission is durable and atomic with unique request insertion;
  exact duplicate retries must still succeed at the cap. Terminal replies do
  not spend or fail this request budget. Keep separate wake-rate/no-progress
  controls and preserve counting evidence during journal compaction.
- Auto-wake stays disabled by default. Integration needs a new exact manifest
  version coordinated across the Python installer, Swift validator and tests;
  immutable old manifest sets remain unchanged.

Execution evidence: [October 22 canary record](../reviews/2026-10-22-desktop-queue-canary.md).
Live idle delivery passed. Busy delivery passed its own strict collector and
turn timestamps establish non-interruption, but delegated preceding-turn
correlation is INCONCLUSIVE in the collector. Remaining protocol/activation
gates are not waived. Both target and working chat are actually owned by the
ChatGPT-bundled app server, despite the desktop tool naming.

Independent prerequisite review found a P2 retry-at-full-pair-cap defect in
`local-messaging-server.mjs`. On October 22 the owner explicitly answered “Yes”
to releasing the shared files to parent Codex for this fix and wake integration.
This supersedes the older ownership-pending statements below. Antigravity owns
the runtime integration allowlist through Triangle, request
`wake-m1-integration-20261022`; parent Codex owns documentation, installer, Swift
manifest validation/fixtures and bundle-closure tests. The reviewer is read-only.
No parallel implementation PR or production activation is authorized by this
ownership transfer. Installation remains gated on verification.

Focused proof matrix: valid exact-target receipt; explicit owner CODEX_HOME;
invalid/disabled binding never spawns; no shell/peer interpolation; abort before
start; timeout/abort/nonzero/malformed receipt held uncertain; bounded output;
child termination before settlement; no implicit retry. Integration adds
restart recovery, exact scoped acknowledgment, coalescing, late-result changes,
duplicate-at-cap/concurrent admission, shared submission arbitration and bundle
closure before activation.

**Tech stack:** Existing Node supervisor, SQLite journal, CLI/MCP interface, Swift bootstrap, versioned package manifests; Codex CLI/App Server; version-pinned unsupported Claude in-session socket; hosted Grok routine webhook and MESH tools.

**Status:** Desktop reply push approved by the owner ("push is approved"), 2026-10-21. D7-R supersedes pivot §16.7 for opt-in desktop reply notifications through the existing thread owner. Implementation and activation remain gated below; this approval does not approve local-to-MESH content copying. PR #107 remains unfinished and its review-finding fixes are not installed. The fix branch's work through `ce67d23` is integrated and pushed on `origin/codex/installed-local-messaging` (`d47976e`), and the fix checkout and local branch no longer exist, but no explicit release of the files it owned is recorded: confirm with the fix owner before any adapter implementation touches them. No account sign-in, Reason installation, webhook registration or live conversation injection was performed during this quick verification.

**Current state (read-only observations, 2026-10-21 22:10 PDT; evidence under "Live observations"):**

- The shared host is retired and verified absent (no LaunchAgent plist, launchd job, production `app-server-binding.json` or host process). The writer lock for thread `01a14c05-6603-7921-b744-659195a490a5` has one holder, the ChatGPT-bundled `codex app-server` (PID 39686, parent ChatGPT.app PID 39266, started 21:29). PIDs change when the app relaunches; they are observations, not identities.
- Local messaging is repointed at `client/desktop-binding.json`. The service restarted at 21:27 on the unchanged installed bundle `cd5492bd…` (manifest v9, pre-fix code), and `triangle-local status` exits 0.
- Not yet proven: queue routing to the owner, idle/busy delivery, MESH/local arbitration, restart-safe loop protection. No canary has run, and automatic desktop push stays OFF.


## 0. Review gates and decision ledger

- **Owner decision D7-R — APPROVED:** on 2026-10-21 the owner said “push is approved.” This supersedes pivot §16.7's pull-only rule for opt-in desktop reply notifications through the existing real thread owner, under shared local/MESH arbitration. Pull remains a supported fallback, not the only permitted delivery mode. Activation still requires the fix and ownership gates.
- **Workspace rule:** legacy `event-driven`/`codex exec` remains forbidden. Root `_context.md` and the pivot decision ledger now record approved D7-R. This does not authorize dual thread ownership, an automatic App Server fallback, arbitrary thread injection, or disabled-route reactivation before verification.
- **Prerequisite / exclusive ownership:** fix checkout `/Users/zhenyuhou/Projects/The Triangle/worktrees/local-messaging-fixes`, branch `fix/local-messaging-review-findings`, owner handoff HEAD `c4182f5` (clean when checked), integrated into the existing #107 branch as `3f0b6c0` (20:24) without code conflicts. The branch later advanced to `ce67d23` (21:02, "Migrate to dedicated desktop-sender binding when app-server-binding is removed"; it edits `local-messaging-auth-broker.mjs` and `local-messaging-cli.mjs`), which was integrated and pushed as `d47976e` (21:57) on `origin/codex/installed-local-messaging`. At 22:10 PDT that checkout and the local fix branch no longer exist, and the branch was never pushed under its own name. Pin the release checklist to `ce67d23`/`d47976e`, not `c4182f5`. The fix owner alone owns journal, dispatcher, server, client, rate/loop tracker, CLI, host and supervisor changes until released; the removal and the integration commit suggest release, but none is recorded, so confirm it before M1 touches those files. No parallel wake implementation PR on those files. This documentation-only revision never modified that checkout. Rebase the wake implementation only after its fixes land in the agreed base; do not assume PR #107 complete or silently absorb another owner's work.
- **Critical predecessor findings:** #5 stable message/request IDs on retry and #12 causal/loop cap that currently ignores linking are release blockers for automatic wake. Require regression evidence against real supported CLI/MCP paths, unlinked/new-request-id reply loops, reconnect/retry and mixed MESH/local delivery. A failed fix must keep push OFF. Carry their exact IDs and the fix owner's final commit/PR into the release checklist; this review did not independently close them.
- **Single thread owner:** the production shared-host resume path was retired and verified absent on 2026-10-21 (see "Shared-host retirement verified"); still verify the ChatGPT app connection and the current writer-lock holder. A thread ID in a JSON file, successful queue command or disabled watch flag alone is insufficient. Enforce one owner and one submit arbiter for MESH and local notifications on that thread, including restart. No second app-server/thread-resume fallback.
- **Two separate approvals:** D7-R desktop push and local-to-MESH content bridging are distinct decisions. Approval of one does not approve the other.

## 1. Quick verification, October 21

Evidence levels: **source** means implementation inspected; **CLI** means the installed command accepts/documents the primitive; **live** requires a real bound-session canary and correlated reply. Do not collapse these levels.

Reason reference: `reason-machines/reason-network` HEAD `ec37609eaa2412163937886509173c6a335e8c20`, version 0.12.5. `git ls-remote` confirmed the inspected commit was current during this check. Later that evening upstream HEAD moved to `f447dd3b2aee58887e16f628bb40b6e0d8012271` (0.12.6; six commits, 02:17-02:49Z on 2026-10-22). Of the cited files, `src/agent.rs` (+5, ZCode client-name detection only) and `src/daemon/mail.rs` (+120/-5, offline-session notes: an offline session's unread mail is forgotten after 24 hours) changed. The `codex queue` arm of `deliver` is unchanged apart from a shift of about 21 lines. Every citation below stays pinned to `ec37609` and was not re-verified at the newer commit.

| Target | Reason mechanism verified | Local Triangle evidence | Remaining live gate |
| --- | --- | --- | --- |
| Codex | `src/daemon/mail.rs:292–293` chooses `codex queue --thread ID --message TEXT`; hooks add context at tool boundaries/stop. Queue subprocess has a 30-second delivery timeout, not a coding-task deadline. | Installed `codex-cli 0.163.0`: `codex queue --help` succeeds and documents existing-session queuing. The owner of the desktop thread is a different build, the ChatGPT-bundled server `0.163.0-alpha.11.1` (the Homebrew CLI and the Codex-managed daemon are `0.163.0`; see "Live observations"). Triangle already has App Server thread ownership, resume and turn submission code. | Prove the installed CLI reaches this exact desktop-owned thread while idle and busy; help output is not proof of that attachment. |
| Claude Code | `src/agent.rs:201–210` (`ClaudeSocket`; `claude_socket()` is at :209 and reads `CLAUDE_CODE_MESSAGING_TOKEN`) obtains a session messaging socket/token; `post_to_claude` writes optional auth plus a user frame. `src/mcp.rs:360` forwards daemon events and acknowledges after forwarding. Source also includes hook/channel alternatives. | Installed Claude Code 2.1.307; version/help succeed. A desktop-app Claude Code session on this Mac exports `CLAUDE_CODE_MESSAGING_SOCKET` (a live unix socket) and `CLAUDE_CODE_MESSAGING_TOKEN` to its tool subprocesses (presence and socket type only; nothing was written). No Triangle Claude adapter or bound Claude canary has been demonstrated. Anthropic documents channels for an open session, with preview/auth/organization constraints. | Bind a controlled real Claude session; prove socket availability/auth, idle wake, busy delivery and correlated reply. Do not infer these from CLI version alone. |
| Hosted Grok Bot | Reason's hosted setup explicitly documents remote MCP plus `wake_me(webhook URL,key)` registration for a routine that calls `check_inbox`. This hosted bridge is not the Grok CLI hook adapter. | Unauthenticated MCP initialize POST returned HTTP 401: endpoint is reachable and requires auth. It does not verify authenticated tools or wake. Triangle already contains `grok-bot-wake.mjs`, quota backoff and webhook tests. | Authenticated tool discovery, provider-supported routine, valid trigger, actual bot inbox retrieval/reply, repeat success after idle. Hosted bridge server implementation was not verified in the public engine repository. |

**Historical hazard, removed by the shared-host retirement (verified 2026-10-21; see "Shared-host retirement verified"):** before it, the desktop sender was bound to this conversation with inbound wake disabled, yet binding `enabled:false` did NOT prove another host would not resume the thread: `scripts/macos-shared-codex-app-server-host.mjs` resolves/resumes its preferred thread before writing its binding, and its LaunchAgent had `RunAtLoad` and `KeepAlive`. The LaunchAgent, launchd job and production binding are now absent; the script, LaunchAgent template and runbook remain in the repository. The desktop sender is now bound through `client/desktop-binding.json` plus the integration file. `setup --rebind-thread` still creates an ownership question, not evidence of the real owner; real-owner proof, queue routing and arbitration remain M0 work. No fresh headless thread can substitute for the desktop proof.

### Grok constraint we must preserve

`docs/triangle-client/2026-09-30-grok-webhook-wake-retired.md` records repeated `400 Automation … is disabled` from the prior routine webhook. The installation script requires an explicit retirement override. At this revision, the installed `client/instances/3356f7bfb8e902f4b519d8238e3555e4974217898af96bed249cf0cfb729c1eb.json` explicitly has profile `bob`, enabled true, deliveryMode `headless-app-server`, runtimeAdapter `codex`. This is a configuration snapshot, not proof of the active MESH claimer. The September retirement record still governs the old Grok webhook; workspace history describes Bob as Grok. M0/M4 must reconcile those records with the actual loaded process/claim ownership before relying on Bob. Existing Bob must not be used as the hosted canary by assumption. Do not switch Bob's identity/runtime as a shortcut. Use a distinct explicit hosted binding if a new test lane is needed.

### Checks actually run

- Public Reason source inspection, pinned commit, current remote HEAD check.
- Local Codex queue help and Claude version/help. No reasoning turns started.
- Unauthenticated hosted MCP initialize probe: HTTP 401. No credentials sent.
- Existing Triangle App Server and Grok wake tests: `node --test packages/agent-worker/test/app-server-host-support.test.mjs packages/agent-worker/test/grok-bot-wake.test.mjs` exited 0, 34/34 passed. These tests do not prove live harness wake.

## 2. Compare implementation choices

“Use the adapter as a baseline” here covers both selective reuse of Reason's harness delivery code and adopting its complete daemon.

| Dimension | Whole Reason daemon/hosted service as baseline | Port Reason adapter primitives into Triangle | Extend only Triangle's current adapters |
| --- | --- | --- | --- |
| First proof | Fast manual comparison once separately installed/authenticated; not yet measured | Small Codex queue prototype; Claude socket prototype | Codex App Server code already exists; Claude still new |
| Identity/custody | Parallel Reason roster, sessions and mailbox state; mapping/bridge needed for Triangle authority | Triangle remains authoritative; adapters receive bound notifications | Triangle remains authoritative |
| Processes/packaging | Second daemon, binary lifecycle and possibly hosted account dependency | Existing supervisor; added small modules and versioned closure | Existing supervisor and current helper integration |
| Harness coverage | Broad upstream coverage, subject to each harness's delivery tier | Start with Codex and Claude; follow upstream mechanisms selectively | Less upstream reuse; easy to repeat solved compatibility work |
| Grok Bot | Hosted MCP/routine integration is documented; cloud implementation and current account behavior need proof | Reuse the routine pattern; actual provider trigger remains gated | Existing webhook code and quota protection retained; retired provider route unresolved |
| Delivery semantics | Must reconcile Reason's read/delivered receipts with Triangle's own states | Preserve Triangle's explicit reply consumption and recovery guarantees | Preserve current guarantees |
| Maintenance/license | Upstream daemon/version/account compatibility; engine MIT/Apache-2.0; hosted setup/service is separate | Track pinned source/version; preserve applicable license and notices for copied code | Own all compatibility discovery; no copied adapter code |
| Fit for this pivot | Useful isolated benchmark, not recommended production dependency | **Recommended** | Reuse supporting components after ownership proof |

Proposed choice, pending approval: use Reason's mechanisms as a behavioral baseline. Pivot §16 decision 10 still says to build our own integrations and permits borrowing patterns. Copying upstream code, beyond that decision, requires an explicit owner decision and license handling. Do not adopt a second daemon or authority implicitly.

Codex queue is a candidate only after proving the single real thread owner. Remove the automatic App Server fallback: the existing route is collision-sensitive and not authorized as a substitute for this new desktop wake design.

Claude's practical prototype is the Reason-style session socket delivered by a Triangle MCP child running INSIDE that Claude session. This is a version-pinned, unsupported internal interface, not a supported public API. The supervisor must never discover/read other Claude sessions' token files. Custom Claude channels are not the default: preview allowlisting blocks ordinary Triangle use; a development flag requires separate explicit approval.

## 3. Target shape and contract

```
reply or held-task event
  -> same SQLite commit: reply/state + durable notification event
  -> supervisor-owned notifier with replay cursor and bounded retries
  -> adapter selected from an owner-bound session registry
       Codex: queue to exact single-owner thread; no automatic fallback
       Claude: in-session MCP child -> own authenticated socket (unsupported/version-pinned)
       Grok Bot: secret-free webhook hint -> hosted routine retrieves via MESH
  -> harness accepts notification
  -> agent reads durable reply/status and independently verifies work
```

No second supervisor or permanent sidecar watcher is needed. Local CLI clients may subscribe over the existing socket; hosted bots use authenticated remote tools, never a Unix socket exposed over the internet.

Adapter contract, proposed:

```js
probe(binding) // {kind, mode, available, reason, version, evidenceLevel}
notify(binding, event, {signal}) // {state: 'accepted'|'deferred'|'failed'|'uncertain', receipt?}
```

The supervisor owns retries, scheduling, auth, event persistence and custody. Adapters own harness-specific binding validation and submission. Use stable event IDs and bind to installation, principal, session/thread and policy. “accepted by harness” is not “read by model” or “task succeeded.”

Payloads remain free-form. Lifecycle/correlation metadata can be structured. Notification hints carry event/message IDs and retrieval instructions; do not embed private keys, mailbox grants, arbitrary execution directives or credential-bearing URLs in prompts/logs.

Use at-least-once event delivery with deduplication where supported. Do not promise exactly-once model turns: a crash after host acceptance but before local recording is ambiguous. Hold uncertain submissions or reconcile a host receipt before retrying. A successful CLI exit alone cannot eliminate that crash window.

<!-- REVIEW 2026-10-21 (design suggestion; not adopted)
(1) Uncertain submissions: holding is right for a coding execution, but for a wake hint it can leave a reply that nobody is told about after a crash in the acceptance window. Consider a digest hint ("N unread replies; run replies") that carries an event ID, is coalesced per thread and is retried after a bounded window, with an explicit uncertain state only after retries are exhausted. (2) Hints arrive as user-role text (a codex queue message, a Claude socket user frame). Consider requiring hints to be rendered from a fixed template with validated IDs only, with no peer-supplied strings (request IDs are caller-chosen), and testing that.
-->

## 4. Milestones and implementation tasks

### M0 — bind and prove harness primitives first

Create `docs/reviews/2026-10-21-harness-adapter-spike.md` with version, target session, method, receipt, observed turn/message and correlation IDs for each attempt. Use controlled sessions; do not inject into unrelated chats or change existing profile identities. Preserve current auth and user approval policies.

1. Codex: FIRST inventory the ChatGPT app-owned connection, shared-host process/service (retired and verified absent 2026-10-21; confirm it stays absent), binding readers and all MESH/local producers for the exact thread. Establish its single real owner and preserve evidence of the endpoint/owner. Do not start/resume it in a second app-server. Only after the ownership gate may a controlled queue canary run. Test idle/busy plus simultaneous MESH/local hints. If queue cannot reach that owner, stop and report unsupported; no fallback to any second app-server, and the retired production shared host is not to be restored.
2. Claude: use a controlled session with approved tool policy and session-scoped Triangle MCP child. Obtain only that process's exported messaging socket/token. If absent, degrade to pull; do not scrape session registry/token files. Use fake sockets first, then live canary. Record the unsupported/internal interface and tested Claude version.
3. Grok: perform authenticated remote tool discovery with the owner's existing authorized connection. Inspect the provider's current webhook/routine contract. A documented `wake_me` name is not proof that our account has it. Trigger a harmless test routine, retrieve an inbox item and reply. Repeat after idle and inspect quota/disabled states.

**Gate:** select each adapter from observed capability. If hosted Grok cannot pass, mark it blocked/degraded while Codex and Claude continue. Do not resurrect the retired webhook based on documentation alone.

<!-- REVIEW 2026-10-21 (design suggestion; not adopted)
M0 Codex routing. (a) Extend the step 1 inventory to the Codex-managed daemon and every app-server that shares the owner's CODEX_HOME (see "Live observations"). (b) Before any live canary, add a Stage A run in a throwaway CODEX_HOME with a throwaway thread to learn what `codex queue` does: does it insert into the shared queue for the owner to drain, or resume the thread inside the daemon, and does an idle owner start a turn from a queued item? Stage A can only falsify; the live canary stays the acceptance proof. (c) Pin the owner build (ChatGPT-bundled, currently 0.163.0-alpha.11.1), not only the CLI, and have the adapter pass the owner's CODEX_HOME explicitly instead of inheriting the supervisor's environment. (d) Treat `codex queue` as undocumented-semantics and version-pinned, like the Claude socket. (e) Add proof-matrix rows for ChatGPT closed, relaunched and thread-not-loaded, where queue must never make the daemon (or any other process) the owner of this thread. (f) Record the owner as writer-lock holder plus executable path, parent and server version at each run, not as PIDs. (g) thread/queue/list may allow reconciling uncertain submissions; test it in Stage A.
-->

<!-- REVIEW 2026-10-21 (design suggestion; not adopted)
Before the first live canary: snapshot runtime health (client.error.log shows recurring keychain_unavailable install-watch failures since 18:52) so a canary failure is not confused with existing noise, and put each canary's exact message text and abort criteria up for owner sign-off. "Push is approved" covers desktop push, not experiments injected into the live conversation. triangle-local status currently reports pendingReplies 1 and held 1; decide how those are treated before the first wake test.
-->

### M1 — durable reply notifications and local subscriptions (after fix-branch release)

Create `packages/agent-worker/src/local-messaging-notifier.mjs` and `test/local-messaging-notifier.test.mjs`. Modify `local-messaging-journal.mjs`, `local-messaging-dispatcher.mjs`, `local-messaging-server.mjs`, `local-messaging-client.mjs` and focused tests.

1. Write failing tests for a reply commit followed by process death before notification, reconnect from cursor, duplicate delivery and foreign subscriber access.
2. Run `node --test packages/agent-worker/test/local-messaging-notifier.test.mjs` and observe missing behavior.
3. Add an additive SQLite event/outbox migration. Commit reply/completed state/event atomically; failure/held transitions also create actionable events. Preserve old journal data.
4. Add authenticated `subscribe_events({afterCursor})` on the local socket, bounded subscriber buffers and explicit backpressure/replay. Notification acknowledgment does not consume a reply. Disconnect does not cancel accepted coding work.
5. Host notifier in existing supervisor lifecycle. Await persistence and active notification operations on stop. On restart, replay pending events; do not replay uncertain coding executions.
6. Re-run notifier and existing local messaging tests. Commit the coherent storage/protocol slice after green checks.


### Notification outbox lifecycle requirements

These depend on the fix branch's final late-result and shutdown contracts; reconcile schema/API there before implementation.

- Events carry monotonically ordered ID, authenticated subscriber principal + bound session, source message/request IDs, event kind, task phase, late-result flag, and a safe retrieval reference. Late-result fields are monotonic; timeout-side effects or late results must never be rendered as normal completion. No secrets or full reply bodies in wake hints.
- Cursor/replay queries are bound server-side to principal, subscriber identity, session binding generation and stream. Never accept another subscriber's cursor as authority or use a global unfiltered event sequence to disclose data. Test foreign, stale-generation and forged cursor use.
- Proposed retention policy: delivered/acknowledged events retain a seven-day replay window. Unacknowledged events are not deleted merely for age; pending/failed/uncertain records survive until resolved or explicit owner cancellation. Add configurable bounded storage pressure that pauses new notification scheduling and reports actionable health, never silently drops pending events. Prune in bounded batches. Reply retention/consumption is independent.
- Retain a durable cursor floor. An expired cursor yields `resync_required` and an authorized reconciliation snapshot; never silently skip to head. Disconnected subscribers may rebind only to the same authorized principal/session lineage.
- Shutdown order: stop accepting new sends/subscribers; allow already accepted RPC persistence; stop launching notification attempts; settle bounded in-flight submissions; mark ambiguous outcome uncertain; flush transactional state; close sockets; release journal ownership LAST. Leave unstarted notifications queued for restart rather than executing a backlog while stopping. Coding runner ownership remains governed by the prerequisite fix; cancellation alone is not termination.
- Test crash between reply/event commit, after host acceptance/before receipt persistence, during prune, during unsubscribe, and while shutdown races late completion. No acknowledged event or late-result indicator may be lost through replay/prune.

<!-- REVIEW 2026-10-21 (design suggestion; not adopted)
M1 shape. The journal already indexes local_replies(recipient, consumed), and status reports pendingReplies and held. Deriving wake obligations from that state plus one delivery-state row per binding would self-heal after crashes and rollbacks and could replace the retention window, cursor floor, resync and forged-cursor machinery above. Backfill is needed either way for replies that already exist (today: pendingReplies 1, held 1). All nine server RPCs are request and response, so subscribe_events would be the first server-push stream, and broker credentials last 5 minutes (issueCredential in local-messaging-auth-broker.mjs, ttlMs 300000); consider a cursor long-poll and moving subscriptions off the Codex critical path (only Claude and `triangle-local listen` need them). "Never delete unacknowledged events" plus "pause scheduling under storage pressure" lets one dead ephemeral binding stall all notifications; consider expiring notification state for ephemeral bindings (Reason 0.12.6 forgets an offline session's unread mail after 24 hours) while replies stay retrievable by pull.
-->

### M2 — Codex wake adapter and local-listen fallback

Create `src/codex-wake-adapter.mjs`, `test/codex-wake-adapter.test.mjs` under `packages/agent-worker`. Modify `client-supervisor.mjs`, `local-messaging-host.mjs`, `local-messaging-auth-broker.mjs`, `local-messaging-cli.mjs`, their tests and `app-server-host-support.mjs` only if the M0 result requires it.

1. Write failing tests for exact thread/identity mismatch, CLI failure, busy coalescing, ambiguous acceptance, expired binding and reply-loop suppression.
2. Run `node --test packages/agent-worker/test/codex-wake-adapter.test.mjs` and observe failure.
3. Implement only the ownership-proven queue method. Use argv without a shell and a short submission timeout; preserve hook trust and sandbox policies. A thread-level arbiter must serialize local reply notifications and MESH app-server wakes against the SAME real owner. If the existing MESH route cannot participate without resuming a second owner, leave new push disabled and stop at the ownership gate.
4. Separate the short notification submission timeout from the 60-minute coding budget. Busy thread defaults to queued delivery, not forced steering.
5. Store harness receipt/evidence where available. Hold uncertain submission unless reconciliation proves safe retry. Add `triangle-local listen` backed by subscription for unsupported hosts; report pull mode explicitly.
6. Run adapter, host, supervisor and App Server focused tests, then perform installed idle/busy canaries. Commit after green verification.

<!-- REVIEW 2026-10-21 (design suggestion; not adopted)
Arbiter and opt-in. No registered instance carries appServerWake, and per the repository docs the retired host was the durable process that ran the desktop MESH wake, so the MESH side of the step 3 arbiter may no longer exist; state whether MESH-to-desktop wake is retired or re-homed onto this adapter. Also specify where the D7-R opt-in lives (desktop-binding.json has no enabled flag), a per-binding wake budget with quiet hours, and a kill switch.
-->

### M3 — Claude Code bidirectional adapter

Create `src/claude-session-delivery.mjs` (in-session MCP child), `test/claude-session-delivery.test.mjs`, and a narrow setup entry under `scripts/` if needed. Modify the local credential broker/MCP integration, supervisor and package closure lists.

1. Write failing tests for foreign session/socket, no cross-session token access, absent exported socket, write accepted then disconnect, and concurrent busy-session delivery.
2. Run delivery in Triangle's MCP process spawned by that Claude session. Use only its inherited socket/token; validate the socket and session association. Keep token material inside that child, never in supervisor registry, logs or IPC. Label `claude-session-socket` unsupported and pin the tested version. Re-probe after upgrade; missing/changed capability means pull, not token-file discovery. No development-channel bypass by default.
3. Register session identity without copying the desktop Codex integration capability. Provide scoped Triangle send/retrieve/consume tools so Claude can initiate and answer messages.
4. Preserve unrelated Claude settings. Prefer session-scoped setup; any persistent settings change must merge only the owned entry and support rollback.
5. Run `node --test packages/agent-worker/test/claude-session-delivery.test.mjs`, then real Codex-to-Claude and Claude-to-Codex canaries. Confirm idle wake versus next-step-only mode accurately.
6. Preserve required upstream license notices for selectively ported code. Commit after checks.

<!-- REVIEW 2026-10-21 (design suggestion; not adopted)
Record the Claude transport choice and the in-scope Claude surfaces (CLI, desktop app, IDE) in the decision ledger. A desktop-app session exports the messaging socket and token (see "Live observations"), while the channels reference says the development flag is ignored in Agent SDK sessions, so channels likely cannot work in the desktop app; that, more than the allowlist, is the stronger reason for the socket route. Name the CLAUDE_CODE_MESSAGING_SOCKET and CLAUDE_CODE_MESSAGING_TOKEN variables in step 2 so tests can assert them.
-->

### M4 — hosted Grok Bot, independent gate

Reuse `grok-bot-wake.mjs`, `test/grok-bot-wake.test.mjs`, the existing MESH auth/tool path and installation binding logic. Add a separate Grok live verification note. Do not make local Grok CLI hooks part of this milestone.

1. Honor the workspace rule: do not invent a Grok Connect “MESH plugin” or reverse-engineer connector registration. Use only the documented authorized connection. Write failing tests for repeated provider-disabled responses, quota/Retry-After, duplicate hints, foreign principal, expired binding and failed webhook acceptance.
2. Introduce a notifier input independent of MESH watch acquisition, while preserving the current MESH adapter behavior. Hosted routines must retrieve from an authority they can actually access; local-only reply data is not automatically visible remotely.
3. OWNER DECISION REQUIRED: local-to-MESH bridging copies local reply content to server storage and crosses the accepted same-device-only boundary. Default deny. Define exact principals, content scope, server destination, retention and revoke behavior; obtain explicit approval before implementation or any content transfer. Without approval, hosted bot retrieval of local-only replies is unsupported. Existing centralized MESH tasks can be evaluated separately.
4. Use the validated M0 provider trigger. Keep webhook secrets in protected owner storage. Avoid arbitrary agent-selected destinations and redirects; redact secrets and enforce bounded backoff/circuit behavior.
5. Preserve the retired route's default prohibition. A replacement must have its own binding and successful repeated idle-wake evidence. A 2xx webhook response is not bot execution proof.
6. Run Grok tests and live wake -> authorized retrieval -> correlated reply. If provider instability persists, ship disabled with actionable diagnostics; Codex/Claude release remains independent.

### M5 — package, diagnostics and installed acceptance

Modify `scripts/triangle-worker-install.py`, Swift `WorkerLauncher.swift` and `ClientSupervisor.swift` as needed, exact closure fixtures and `worker-bundle-closure.test.mjs`. Add a new manifest schema version for new artifact sets; retain exact v8/v9 validation rather than silently changing their immutable allowlists.

1. Test complete import closure for every supported bundle and both supported old manifests.
2. Report adapter version, session binding, evidence level, delivery tier, pending notification count, last accepted/failed/uncertain event and circuit state without secrets.
3. Run focused local tests, supervisor/App Server/Grok tests, Swift host tests and clean artifact validation. Compare known baseline failures explicitly. Independent review covers identity, callback authentication, side effects and ownership before activation.
4. Back up binaries/configuration/bindings. Activate through the single installed supervisor; confirm termination before replacement and ready state after start. Preserve disabled defaults until that adapter's canary passes.
5. Record all live evidence and rollback instructions. User approvals for newly required hosted account/routine setup are specific to that setup; source planning does not constitute those approvals.

## 5. Release proof matrix

| Scenario | Required observation |
| --- | --- |
| Codex assigns Antigravity, then does other work | Reply notification appears in the same bound Codex conversation without `replies` polling; content retrieved and verified. |
| Codex idle | One correlated wake turn; no new identity, replacement thread or unrelated chat. |
| Codex busy | Notification queues safely; no competing turn or accidental steering. |
| Claude idle/busy | Correct bound session receives message and sends an authenticated Triangle reply; mode reported accurately. |
| Lost subscription and restart | Pending event replays from cursor; reply survives; no duplicate coding execution. |
| Crash after harness accepts notification | Receipt reconciliation or explicit uncertain state; no claim of exactly-once wake. |
| Grok hosted idle | Valid routine starts, retrieves from MESH and answers; not just webhook 2xx. |
| Grok disabled/quota exhausted | Bounded retries/circuit, visible reason, no error loop, no silent Codex substitution. |
| Timeout after file edits | Held state/event; artifacts preserved for inspection; no blind retry. |
| Foreign identity/session and stale credentials | Notification and retrieval refused; no credential leakage. |
| Packaging/revert | Complete installed closure, old manifests still valid, original settings recoverable. |

## 6. Scope and source references

No mandatory coding-result schema. No new daemon. No coupling of notification timeouts to model execution time. Antigravity outbound tools remain a separate explicit integration slice; adapters alone do not grant every harness messaging capabilities.

- Reason code: https://github.com/reason-machines/reason-network/tree/ec37609eaa2412163937886509173c6a335e8c20
- Reason delivery tiers: https://github.com/reason-machines/reason-network/blob/ec37609eaa2412163937886509173c6a335e8c20/DESIGN.md#getting-messages-into-agents
- Reason hosted Grok setup and wake_me: https://reasonmachines.com/network (hosted-assistant instructions, steps 1–5).
- Official Codex App Server protocol: https://learn.chatgpt.com/docs/app-server
- Official Claude channels: https://code.claude.com/docs/en/channels
- Official Claude hooks: https://code.claude.com/docs/en/hooks
- Triangle current installed evidence: docs/reviews/2026-10-21-installed-local-messaging-acceptance.md
- Triangle Grok retirement: docs/triangle-client/2026-09-30-grok-webhook-wake-retired.md

**Recommended first implementation:** D7-R approved -> fix-branch integration -> M0 ownership proof -> controlled Codex canary -> M1 notification outbox -> M2 Codex wake. Claude follows after its primitive is proven. Grok validation proceeds independently and must not delay the local usability win.

**Progress as of 2026-10-21 22:10 PDT:** D7-R approved; fix-branch work integrated through `ce67d23` (`d47976e`, not installed); shared-host retirement done; M0 ownership proof partial (one observed writer-lock holder; queue routing, idle/busy delivery and arbitration open); no canary run; M1 and later not started.

## 7. Review corrections and dated installed evidence

This revision addresses blocking review items 1–3 and should-fix items 4–8. Desktop push approval was recorded afterward under D7-R; fix completion and activation are not claimed. A second review pass on the evening of 2026-10-21 corrected stale status and pins and recorded read-only live observations at the end of this file. Its design suggestions are kept as `REVIEW` HTML comments in this file (invisible when rendered) and are not adopted until the owner decides.

- Mini configuration rechecked: `client/local-messaging.json` has `runnerTimeoutMs: 3600000`. Runtime source for that expansion is commit `7526d79`; the earlier acceptance table's approximately 300-second correction test is historical evidence BEFORE the expansion. It remains unchanged, not rewritten into an hour-long test.
- The existing service readiness marker identifies parent PID 44108, ready timestamp 1792634237529, and configuration digest `e6c341d9e0766c49cc0ff58cb9551164c8b7755dc039d6e38f0cea5e22d77158`. These values are an observation, not proof of unique desktop-thread ownership or an hour-long successful task. No one-hour live task was run. Superseded after the 21:27 restart: the marker identifies parent PID 38633 and ready timestamp 1792643251116 (21:27:31 PDT) with the same configuration digest, and the running supervisor is still on bundle `cd5492bd…`.
- Bob's current registered configuration was read without credential files. It differs from older workspace/Grok history; actual mailbox claim ownership remains a release check, not inferred from the profile name.
- Reason queue selection is at pinned source `mail.rs:292–293`; the enclosing function begins at 269.
- Claude custom-channel preview restriction confirmed at https://code.claude.com/docs/en/channels-reference : a custom channel needs `--dangerously-load-development-channels` for development, not ordinary `--channels`. The plan selects the version-pinned unsupported in-session socket prototype and does not enable that flag.

Installed bundle recheck: manifest v9, bundle `cd5492bd98cfe551318258694dc675bd6c5ce580d3f1181d1a29dddfa3cb5c3a`; its packaged local host forwards the configured per-turn budget with the 3600000 ms default. This confirms the saved Mini configuration and packaged path, not an hour-long execution proof.

## Prerequisite handoff — c4182f5

Owner handed off the committed fix branch. Clean checkout verified; focused
local messaging, supervisor-local integration and bundle closure tests passed
137/137. Source/tests/scripts in the integrated #107 branch match c4182f5
exactly; later approved decision notes remain intact. Findings #5/#12 have
implementation and regression coverage in this handoff, not yet an automatic
wake production proof. The pair exchange cap is process-local and time-windowed;
restart/durable anti-loop behavior still requires M0/M1 validation before wake.

This is integration into the review PR, not merge to main, installed activation,
thread ownership proof, or permission to overlap the fix owner on shared files.
No runtime or bindings were changed during this integration.

Update, 2026-10-21 22:10 PDT: the fix branch advanced to `ce67d23` (21:02) and
was integrated and pushed as `d47976e` (21:57) on
`origin/codex/installed-local-messaging`; the fix checkout and local branch are
gone. Over `127c086`, `d47976e` changes five files
(`local-messaging-auth-broker.mjs`, `local-messaging-cli.mjs`, their two tests
and `docs/triangle-client/installed-local-messaging.md`). The 137/137 count
above reproduces with
`node --test packages/agent-worker/test/local-messaging-*.test.mjs
packages/agent-worker/test/client-supervisor-local-messaging.test.mjs
packages/agent-worker/test/worker-bundle-closure.test.mjs` (16 files, run by
the reviewer with an isolated `HOME`). Neither `c4182f5` nor `ce67d23` is
installed; the installed bundle is `cd5492bd…`.

<!-- REVIEW 2026-10-21 (design suggestion; not adopted)
Durable loop protection has no M0/M1 task. The pair cap is an in-memory Map (createPairExchangeLimiter in local-messaging-rate-limiter.mjs: 10 messages per 10 minutes), so a supervisor restart resets it, and with automatic wake each exchange is a model turn in the live conversation. Consider computing the pair count from journal timestamps (local_messages and local_replies already record sender, recipient and created_at) and adding a restart test.
-->

## M0 live inspection result (historical; superseded in part below)

Single-thread proof did not pass. Current observed writer is the ChatGPT-owned
server, but the dormant shared-host startup can select the rebound production
thread, and the installed bundle still uses the old shared binding. Queue routing
to the actual owner, busy/idle canaries and shared MESH/local arbitration remain
unverified. See `../reviews/2026-10-21-harness-adapter-spike.md`. No wake probe,
new server, binding change or activation was performed during this verification.

Superseded since: the shared host is retired, and the installed local-messaging
configuration was repointed at `client/desktop-binding.json` (configuration
rewritten 21:18, binding written 21:27); see below.

## Shared-host retirement verified

The owner retired the separate shared host; its LaunchAgent and production
binding are absent and its job is unloaded. The ChatGPT-owned writer remains
the sole observed exact-thread lock holder. See the spike report follow-up.
Update, 2026-10-21 22:10 PDT: the earlier statement here (local messaging still
points at the removed binding and `triangle-local status` fails) is superseded.
`client/local-messaging.json` (rewritten 21:18) now points at
`client/desktop-binding.json` (mode 0600; keys `instanceId`, `threadId`,
`version`; written 21:27:12; its `threadId` equals the current lock-holder
thread). The service restarted at 21:27 on the unchanged installed bundle
`cd5492bd…`, and `triangle-local status` exits 0 (`running: true`, recipient
`gravity2`; journal completed 2, held 1, pendingReplies 1). The installed
(pre-fix) broker requires `binding.threadId === integration.threadId`, so that
file must carry `threadId` until the fixed bundle is installed; the fixed
broker in `ce67d23` checks the sender identity only and, when the binding is
absent, writes `{version, instanceId}`. How the migration was performed is not
recorded in this repository. The spike report's follow-up predates the repoint
and still describes the failing status call. Do not restore the retired
shared-host binding. Queue routing, idle/busy delivery and arbitration proof
remain open.

<!-- REVIEW 2026-10-21 (design suggestion; not adopted)
Make the retirement durable in the repository: the host script is still packaged (scripts/release/build-client-package.mjs, line 133), and its LaunchAgent template and runbook still describe installing it. Consider mirroring the Grok retirement override in the installer, adding a doctor check that the shared-host LaunchAgent is absent, and, with owner approval and a backup first, removing the dead leftovers listed under "Live observations" (including the shared host's WebSocket token file). Once the fixed bundle is installed, the extra threadId in desktop-binding.json is redundant; decide whether to drop it so the thread lives only in the integration file.
-->

## Live observations, 2026-10-21 evening (read-only second review pass)

No queue submission, daemon or server start, socket write, binding change or
activation was performed by this pass. Times are PDT. PIDs, paths and counts are
observations that change on relaunch or restart.

**Codex on this Mac**

- Exact-thread lock `~/.codex/thread-writer-locks/01a14c05-6603-7921-b744-659195a490a5.lock`: one holder, PID 39686, the `codex app-server` bundled in ChatGPT.app (parent ChatGPT PID 39266, started 21:29:19; it replaced the PIDs 54924/55297 recorded earlier). It has no listening socket and no named unix socket (anonymous pairs and outbound HTTPS only). The other lock file in that directory is held by the same process.
- Builds differ: the ChatGPT-bundled owner is `codex-cli 0.163.0-alpha.11.1`; the Homebrew CLI and the Codex-managed daemon are `0.163.0`.
- A Codex-managed app-server daemon runs outside the Triangle supervisor (PID 16779, `app-server --remote-control --listen unix:// --managed-daemon`, with an updater loop; up since about 09:00). Its control socket is under `~/.codex/app-server-control/`. It holds no thread writer locks. `codex agents --help` describes browsing sessions on this shared local daemon.
- `codex queue --help` exposes `--remote <ws|wss|unix>` and interactive-launcher flags (`--model`, `--sandbox`, `--approve-for-me`, `--dangerously-bypass-*`, `--cd`, `--worktree`, `--add-dir`, `-c`). The CLI reference (read to its `codex sandbox` section) documents `codex queue` only as queueing a text message for an existing session by UUID or exact name, with `--remote` transport flags. Neither it nor the cited App Server page documents which server `queue` reaches by default, idle versus busy behavior or writer-lock interaction, and the App Server page has no `thread/queue`, attachment or writer-lock content.
- Static inspection of the Codex binaries (behavior unverified): `thread/queue/{add,list,update,delete,reorder,start}` protocol methods and a `thread/queue/changed` notification; the error text "... does not support thread/queue/add; update or restart ..."; a shared `~/.codex/queue_1.sqlite` (present, WAL active) with `queued_items(id, thread_id, payload_json, queue_order, ...)` and a `queued_thread_revisions` table maintained by triggers. The ChatGPT-bundled build contains the same method name.
- The Triangle supervisor runs four `codex app-server` children of its own (PIDs 38814/38815/38823/38824, parent PID 38694) in a separate Codex home (`model-state/codex-runtime-home` under the application-support folder). They hold no handles on `~/.codex/queue_1.sqlite` or the writer locks.

**Triangle runtime**

- Registered instances: `bob` and `codex-headless` (`headless-app-server`/codex, enabled), `ghost` (`headless-cursor-acp`), `gravity2` (`worker`/antigravity). No instance file carries `appServerWake`; the activation and readiness markers carry no wake settings, and the supervisor's bootstrap configuration was not inspected. Per the repository docs, the retired host was the durable process that ran the desktop wake loop.
- Service `dev.thetriangle.client` (`triangle-mailbox run-supervisor`, PID 38633, restarted 21:27) runs installed bundle `cd5492bd98cfe551318258694dc675bd6c5ce580d3f1181d1a29dddfa3cb5c3a`; its readiness marker (21:27:31) keeps configuration digest `e6c341d9…`.
- `client.error.log`: 44 `instance cycle failed (keychain_unavailable) [install_watch_failed]` entries from 18:52 to 22:10 (still recurring), 46 earlier `invalid_grant` cycle failures, and one older `ERR_MODULE_NOT_FOUND` for `codex-runtime/headless-drain-service.mjs` from bundle `22b914ee…` (logged before 2026-10-19T03:33Z). No runtime health baseline was recorded before this pass.
- Leftovers of the retired host on the Mini: `client/app-server-ws.token`, `client/app-server-wake-cursor.json`, `shared-app-server/` (`hold.pids`, `ui`, `workspace`) and `client/app-server-binding.json.before-local-messaging` (the 18:19 backup of the old production binding). In the repository: `scripts/macos-shared-codex-app-server-host.mjs` (still packaged by `scripts/release/build-client-package.mjs`), `scripts/macos/dev.thetriangle.shared-app-server.plist`, `docs/triangle-client/shared-codex-app-server-runbook.md` and `docs/triangle-client/PROJECT-STATUS.md`.

**Claude**

- A desktop-app Claude Code session (entrypoint `claude-desktop`, Agent SDK 0.3.304, desktop app 3.1623.1) exports `CLAUDE_CODE_MESSAGING_SOCKET` (a live unix socket, mode `srw-------`) and `CLAUDE_CODE_MESSAGING_TOKEN` to its tool subprocesses. Names and socket type only were inspected; nothing was written.
- The channels reference says `--dangerously-load-development-channels` is ignored in non-interactive (`-p`) and Agent SDK sessions.

**Reason reference**

- At pinned `ec37609`: `src/daemon/mail.rs:292–293` (the `codex queue` arm; `deliver` begins at 269) and `src/mcp.rs:360` (`on_event`, acknowledges after posting) match; `src/agent.rs:201` is the doc comment for `ClaudeSocket` and `claude_socket()` is at :209 (corrected in section 1). Upstream moved to `f447dd3` (0.12.6) after the pinned check.

**Tests re-run by the reviewer**

- `node --test packages/agent-worker/test/app-server-host-support.test.mjs packages/agent-worker/test/grok-bot-wake.test.mjs`: 34 pass, 0 fail.
- The 16-file set named in the handoff update (isolated `HOME`): 137 pass, 0 fail.

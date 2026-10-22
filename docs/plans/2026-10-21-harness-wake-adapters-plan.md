# Harness wake adapters implementation plan

> **For implementer:** Use risk-based TDD. Write failing tests before changing behavior. Review and verify installed artifacts before activation.

**Goal:** A reply or actionable failure wakes the correct Codex or Claude Code conversation without model-side polling; hosted Grok Bot has an explicitly gated webhook/routine path.

**Architecture:** Keep Triangle's existing supervisor, identities, durable journal and delivery modes. Use harness-native delivery mechanisms behind small adapters. Reason Network is the behavioral baseline and a source of selectively reusable code, not a second production message bus.

**Tech stack:** Existing Node supervisor, SQLite journal, CLI/MCP interface, Swift bootstrap, versioned package manifests; Codex CLI/App Server; Claude session socket or supported channel; hosted Grok routine webhook and MESH tools.

**Status:** Proposed, not implemented or activated. PR #107 supplies the installed local substrate and 60-minute local execution budget. This plan does not require redoing that work. No account sign-in, Reason installation, webhook registration or live conversation injection was performed during this quick verification.

## 1. Quick verification, October 21

Evidence levels: **source** means implementation inspected; **CLI** means the installed command accepts/documents the primitive; **live** requires a real bound-session canary and correlated reply. Do not collapse these levels.

Reason reference: `reason-machines/reason-network` HEAD `ec37609eaa2412163937886509173c6a335e8c20`, version 0.12.5. `git ls-remote` confirmed the inspected commit was current during this check.

| Target | Reason mechanism verified | Local Triangle evidence | Remaining live gate |
| --- | --- | --- | --- |
| Codex | `src/daemon/mail.rs:269` chooses `codex queue --thread ID --message TEXT`; hooks add context at tool boundaries/stop. Queue subprocess has a 30-second delivery timeout, not a coding-task deadline. | Installed `codex-cli 0.163.0`: `codex queue --help` succeeds and documents existing-session queuing. Triangle already has App Server thread ownership, resume and turn submission code. | Prove the installed CLI reaches this exact desktop-owned thread while idle and busy; help output is not proof of that attachment. |
| Claude Code | `src/agent.rs:201` obtains a session messaging socket/token; `post_to_claude` writes optional auth plus a user frame. `src/mcp.rs:360` forwards daemon events and acknowledges after forwarding. Source also includes hook/channel alternatives. | Installed Claude Code 2.1.307; version/help succeed. No Triangle Claude adapter or bound Claude canary has been demonstrated. Anthropic documents channels for an open session, with preview/auth/organization constraints. | Bind a controlled real Claude session; prove socket availability/auth, idle wake, busy delivery and correlated reply. Do not infer these from CLI version alone. |
| Hosted Grok Bot | Reason's hosted setup explicitly documents remote MCP plus `wake_me(webhook URL,key)` registration for a routine that calls `check_inbox`. This hosted bridge is not the Grok CLI hook adapter. | Unauthenticated MCP initialize POST returned HTTP 401: endpoint is reachable and requires auth. It does not verify authenticated tools or wake. Triangle already contains `grok-bot-wake.mjs`, quota backoff and webhook tests. | Authenticated tool discovery, provider-supported routine, valid trigger, actual bot inbox retrieval/reply, repeat success after idle. Hosted bridge server implementation was not verified in the public engine repository. |

Current desktop sender remains bound to this conversation with inbound wake disabled. This plan does not authorize silently enabling an older binding, switching to codex-headless, or treating a fresh headless thread as the desktop proof.

### Grok constraint we must preserve

`docs/triangle-client/2026-09-30-grok-webhook-wake-retired.md` records repeated `400 Automation … is disabled` from the prior routine webhook. The installation script requires an explicit retirement override. Existing Bob is currently a headless Codex lane, not evidence that hosted Grok wake works. Do not switch Bob's identity/runtime as a shortcut. Use a distinct explicit hosted binding if a new test lane is needed.

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
| Fit for this pivot | Useful isolated benchmark, not recommended production dependency | **Recommended** | Reuse as supporting fallback where already proven |

Decision: use the same native harness primitives as Reason. Start with Codex queue because the installed CLI supports it; use Triangle's existing App Server adapter only when queue cannot attach and ownership can be proven. Compare both in M0. Prefer Claude's supported channel interface when available; otherwise prototype Reason's session socket with explicit version/capability checks. Never advertise a fallback as equivalent idle wake until demonstrated.

## 3. Target shape and contract

```
reply or held-task event
  -> same SQLite commit: reply/state + durable notification event
  -> supervisor-owned notifier with replay cursor and bounded retries
  -> adapter selected from an owner-bound session registry
       Codex: queue to exact thread; proven App Server fallback
       Claude: supported channel or authenticated session socket
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

## 4. Milestones and implementation tasks

### M0 — bind and prove harness primitives first

Create `docs/reviews/2026-10-21-harness-adapter-spike.md` with version, target session, method, receipt, observed turn/message and correlation IDs for each attempt. Use controlled sessions; do not inject into unrelated chats or change existing profile identities. Preserve current auth and user approval policies.

1. Codex: run a read-only canary through `codex queue` to a controlled existing thread. Verify one new turn when idle and one queued follow-up when busy. Repeat against the current desktop thread only with a valid owner binding. If queue cannot attach, verify the existing authenticated App Server path before selecting it.
2. Claude: start/bind a controlled session with approved tool policy and Triangle MCP capability. Verify supported channel capability or session-socket discovery, including authentication. Confirm the message reaches the model and returns a correlated response.
3. Grok: perform authenticated remote tool discovery with the owner's existing authorized connection. Inspect the provider's current webhook/routine contract. A documented `wake_me` name is not proof that our account has it. Trigger a harmless test routine, retrieve an inbox item and reply. Repeat after idle and inspect quota/disabled states.

**Gate:** select each adapter from observed capability. If hosted Grok cannot pass, mark it blocked/degraded while Codex and Claude continue. Do not resurrect the retired webhook based on documentation alone.

### M1 — durable reply notifications and local subscriptions

Create `packages/agent-worker/src/local-messaging-notifier.mjs` and `test/local-messaging-notifier.test.mjs`. Modify `local-messaging-journal.mjs`, `local-messaging-dispatcher.mjs`, `local-messaging-server.mjs`, `local-messaging-client.mjs` and focused tests.

1. Write failing tests for a reply commit followed by process death before notification, reconnect from cursor, duplicate delivery and foreign subscriber access.
2. Run `node --test packages/agent-worker/test/local-messaging-notifier.test.mjs` and observe missing behavior.
3. Add an additive SQLite event/outbox migration. Commit reply/completed state/event atomically; failure/held transitions also create actionable events. Preserve old journal data.
4. Add authenticated `subscribe_events({afterCursor})` on the local socket, bounded subscriber buffers and explicit backpressure/replay. Notification acknowledgment does not consume a reply. Disconnect does not cancel accepted coding work.
5. Host notifier in existing supervisor lifecycle. Await persistence and active notification operations on stop. On restart, replay pending events; do not replay uncertain coding executions.
6. Re-run notifier and existing local messaging tests. Commit the coherent storage/protocol slice after green checks.

### M2 — Codex wake adapter and installed CLI fallback

Create `src/codex-wake-adapter.mjs`, `test/codex-wake-adapter.test.mjs` under `packages/agent-worker`. Modify `client-supervisor.mjs`, `local-messaging-host.mjs`, `local-messaging-auth-broker.mjs`, `local-messaging-cli.mjs`, their tests and `app-server-host-support.mjs` only if the M0 result requires it.

1. Write failing tests for exact thread/identity mismatch, CLI failure, busy coalescing, ambiguous acceptance, expired binding and reply-loop suppression.
2. Run `node --test packages/agent-worker/test/codex-wake-adapter.test.mjs` and observe failure.
3. Implement the M0-selected method. For queue, use argv without a shell, private trusted executable resolution and bounded delivery subprocess timeout. Preserve hook trust and sandbox policies.
4. Separate the short notification submission timeout from the 60-minute coding budget. Busy thread defaults to queued delivery, not forced steering.
5. Store harness receipt/evidence where available. Hold uncertain submission unless reconciliation proves safe retry. Add `triangle-local listen` backed by subscription for unsupported hosts; report pull mode explicitly.
6. Run adapter, host, supervisor and App Server focused tests, then perform installed idle/busy canaries. Commit after green verification.

### M3 — Claude Code bidirectional adapter

Create `src/claude-wake-adapter.mjs`, `test/claude-wake-adapter.test.mjs`, and a narrow setup entry under `scripts/` if needed. Modify the local credential broker/MCP integration, supervisor and package closure lists.

1. Write failing tests for foreign session/socket, private token handling, absent socket/channel, write accepted then disconnect, and concurrent busy-session delivery.
2. Use M0's supported mechanism. Restrict socket paths to owner-approved canonical session paths and protect authentication material. If channel is preview-gated, expose that requirement; do not bypass the gate.
3. Register session identity without copying the desktop Codex integration capability. Provide scoped Triangle send/retrieve/consume tools so Claude can initiate and answer messages.
4. Preserve unrelated Claude settings. Prefer session-scoped setup; any persistent settings change must merge only the owned entry and support rollback.
5. Run `node --test packages/agent-worker/test/claude-wake-adapter.test.mjs`, then real Codex-to-Claude and Claude-to-Codex canaries. Confirm idle wake versus next-step-only mode accurately.
6. Preserve required upstream license notices for selectively ported code. Commit after checks.

### M4 — hosted Grok Bot, independent gate

Reuse `grok-bot-wake.mjs`, `test/grok-bot-wake.test.mjs`, the existing MESH auth/tool path and installation binding logic. Add a separate Grok live verification note. Do not make local Grok CLI hooks part of this milestone.

1. Write failing tests for repeated provider-disabled responses, quota/Retry-After, duplicate event hints, foreign principal, expired binding and failed webhook acceptance.
2. Introduce a notifier input independent of MESH watch acquisition, while preserving the current MESH adapter behavior. Hosted routines must retrieve from an authority they can actually access; local-only reply data is not automatically visible remotely.
3. Decide the explicit local-to-MESH bridge policy before forwarding local reply content. Keep MESH authorization/storage authoritative for the centralized mode. Do not introduce an ad hoc internet-exposed local socket.
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

**Recommended first implementation:** M0 Codex canary -> M1 notification outbox -> M2 Codex wake. Claude follows after its primitive is proven. Grok validation proceeds independently and must not delay the local usability win.

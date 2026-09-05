# Codex desktop wake-up: implementation handoff

Verified: 2026-09-05 UTC (2026-09-04 America/Los_Angeles).
Status: native desktop idle-chat wake-up proved; MESH integration not implemented.

## Decision and scope

The first interactive Codex target is an existing desktop conversation attached
to a shared App Server. A lightweight MESH listener submits a turn when that
conversation is idle. The user can continue working; no mailbox wait tool holds
the model turn open. Background network long polling is acceptable; blocking the
chat waiting for mail is not the selected UX.

Use `mesh` as the sole public CLI. Keep the SDK subprocess adapter for autonomous
agents, not for injecting work into a conversation owned by another server.
The user accepted the desktop proof as sufficient to proceed with integration.
This is not a claim that every remaining task is mechanical or release-safe.


## Product priority (2026-09-05)

- **Harness integration is crucial** (Codex shared App Server path first, then
  Hermes and other reviewed harnesses via coordinator-delivery / trusted proxy).
- **Autonomous Codex SDK subprocess is optional** and must not gate Phase 1/2
  completion or harness work.
- Closing design Phase 1/2 still requires the production wiring and verification
  bar in
  [phase 1/2 completion criteria](2026-09-05-realtime-mailbox-phase-1-2-completion-criteria.md).
  App Server proofs do not by themselves mark Phase 2 Complete.

## Proven evidence

See [prototype report](shared-codex-server-prototype.md) for the exact timestamps.
Installed desktop/backend: bundled Codex 0.153.0; Node 22.22.3. The PATH CLI was
0.146.0, so do not silently substitute it.

- Desktop successfully resumed `01a06f9f-2db1-7143-b8b9-08c634cc7999`.
- An independent listener connection submitted turn
  `01a06fbe-417c-7412-8b69-44cfc4d3f3e6` at 04:05:34.721 UTC.
- Desktop received that turn's start at 04:05:34.723 and completion at
  04:05:37.558. Both connections agreed on the turn ID.
- Read-only inspection of the actual desktop DOM showed a new synthetic prompt
  and assistant answer `DESKTOP_SHARED_WAKE_OK`, without user chat input.
- This was a real desktop renderer, not the earlier two-client UI surrogate.
  It was synthetic and did not involve Bob. These are single local samples,
  not MESH latency or a percentile distribution.

## Root cause and setup contract

The desktop WebSocket path bypasses the normal stdio launcher's desktop-MCP
configuration injection. Desktop `thread/resume` failed with error -32600:
`failed to load configuration: invalid transport in mcp_servers.codex_app`.
Supplying a valid command/args/cwd transport definition fixed subscription.
For this text-only proof, `codex_app` was disabled. Full desktop-tool support
is a separate acceptance gate, not something this workaround proves.

Test backend launch (launch-only overrides; no persistent config edit):

```sh
/Applications/ChatGPT.app/Contents/Resources/codex \
  -c 'mcp_servers.codex_app={command="/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/codex-app-tools/scripts/launch_codex_app_tools_mcp",args=["./server.mjs"],cwd="/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/codex-app-tools",enabled=false}' \
  app-server --listen ws://127.0.0.1:PORT
```

Desktop connects using `CODEX_APP_SERVER_WS_URL=ws://127.0.0.1:PORT/rpc`.
The test used both `CODEX_ELECTRON_USER_DATA_PATH=TEST_UI_DIR` and
`--user-data-dir=TEST_UI_DIR`, with desktop/backend using the same CODEX_HOME.
Do not copy credentials, print secrets, or change HOME to isolate a test.
Open the disposable conversation using `codex://threads/THREAD_ID`.
The real success condition is a successful thread/resume and rendered history,
not `active=true`, deep-link acceptance, or thread/list success.

Desktop startup issues configuration/plugin/remote-control requests to the
backend. Separate Electron UI data does NOT isolate those mutations. Snapshot
configuration before experiments; compare after. config.toml was byte-identical
before/after the successful run; that does not audit every backend state store.
Do not point an unattended test at normal user state without accounting for this.

The private desktop app-tools pipe rejected a separate external probe with
`untrusted-code-signing-identity`. Never bypass that check. Shared App Server
was a separate, legitimate connection path. No permanent launchctl override was
installed and the ordinary desktop was not migrated or restarted.

## Source ownership and starting points

Live checkouts on the test machine:

- `/Users/zhenyuhou/Projects/The Triangle/the-triangle`: MESH server only.
- `/Users/zhenyuhou/Projects/The Triangle/triangle-client`: all client integration.

Older vault routing paths are stale on this machine; resolve the live checkout
before running commands. Check AGENTS.md and git status; preserve existing edits.

Client source to inspect first:

- `packages/agent-worker/src/wake-client.mjs`: injected wake transport, coalescing,
  reconciliation; default cursor store is in-memory, not durable production state.
- `packages/agent-worker/src/profile-scheduler.mjs`: per-profile scheduling and
  shared gate; not an atomic lock against independent desktop submissions.
- `packages/agent-worker/src/concurrency-gate.mjs`, `client-supervisor.mjs`.
- `packages/agent-worker/runners/codex-runner.mjs`: existing runner, not proof of
  shared-desktop attachment.
- `packages/agent-worker/test/wake-scheduler.test.mjs` and
  `docs/triangle-client/2026-09-03-realtime-mailbox-phase-2.md`.
- `scripts/prototypes/shared-codex-server.mjs`: runnable two-client protocol proof;
  not the native-desktop test. Three real model turns, persisted test history.
- `scripts/prototypes/native-desktop-wake-experiment.mjs`: archived native test,
  parameterized and opt-in guarded; syntax checked but revised wrapper not rerun.
  Requires MESH_ALLOW_DESKTOP_EXPERIMENT=1, a fresh private temporary
  MESH_DESKTOP_TEST_ROOT, and a disposable MESH_DESKTOP_TEST_THREAD_ID. Uses fixed
  debug port 63999; verify it is free. It reads existing login/configuration and
  can trigger startup mutations; review before execution. It only logs evidence;
  manually verify successful resume and renderer output, not its exit code alone.
  The original driver left idle Node/crash-handler processes that were explicitly
  terminated. The archived wrapper closes its socket and exits after cleanup, but
  process-tree cleanup and signal handling still need hardening before reuse.

At handoff, scheduler, wake-client, wake-scheduler tests, and Swift supervisor
contract tests already had uncommitted changes. Do not revert or overwrite them.

## Implementation sequence and acceptance gates

### A. Package shared-server attachment (client)

Add an opt-in adapter under agent-worker; implement initialize, thread/resume,
thread/read, turn/start, completion/error notifications, reconnect, and shutdown.
Persist a validated binding: installation/profile instance ID, agent ID, room
scope, server identity/endpoint, thread ID, adapter version, enabled state.
Fail closed when the endpoint/server identity changes; never silently resume the
same thread through a newly spawned SDK process. Use a disposable thread first.
Keep protocol request deadlines and unknown outcomes distinct from explicit errors.

Acceptance: repeat native idle wake with a unique nonce; verify matching server
events AND visible desktop response; reconnect and recover the same history.
Test desktop MCP/tools and approvals separately. Shipping cannot require disabling
ordinary desktop tools. Pin versions and detect incompatible upgrades in doctor.
Authenticated/private transport and lifecycle ownership are mandatory before
leaving the server running; the unauthenticated loopback proof is not a daemon.

### B. Wire real MESH wake transport (server + client)

Reuse existing server wake authorization, cursor, long-poll, and lease work after
checking its live implementation/deployment. On the client, wire the signed
helper transport, durable cursor store, supervisor startup, and scheduler.
One installation-scoped connection should multiplex profiles, subject to grant
authorization. If that grant is still undecided, resolve it before wiring.
Network notifications are hints only: reconcile the durable mailbox on startup,
reconnect, cursor expiry/resync, and coalesced wakes. No message body in wake hints.
Do not add a second delivery owner beside mcp-interactive for the same profile.

Acceptance: empty mailbox causes zero model turns; unrelated room/sender does
not activate the bound chat; dropped/duplicate hints still reconcile correctly.
Credentials remain inside the signed helper; logs contain IDs/status, not secrets.

### C. Durable admission, transactions, and busy-chat behavior (client)

Persist delivery-to-thread/turn correlation before submission. Queue when busy;
after completion, reconcile and admit work. Do not steer or interrupt by default.
Coalesce hints, not distinct durable deliveries. Bound queue size, retries, model
invocations, per-profile concurrency, and installation concurrency.

Human and listener can race. A local scheduler lock alone cannot serialize direct
desktop turn/start calls. Prove server admission behavior with simultaneous
submissions; on explicit busy errors retain pending work. On lost responses,
reconcile history/correlation before retry. If ambiguity cannot be resolved, show
`submission_unknown` and stop automatic resubmission rather than promise exactly-once.
Do not assume turn/start has MESH-style idempotency.

Retain the trusted transaction proxy and room contract from the accepted design:
claim/read/reply/ack are durable operations; wake receipt and turn completion are
not acknowledgements. Slice 6 (trusted transaction proxy) is a **hard gate**
before production Hermes / coordinator-delivery claim/reply/ack paths; it is
out of Phase 1/2 Complete but required for harness production. Keep protocol
ownership in open.json (`self-serve-drain` versus `coordinator-delivery-v1`). Reply key reuse with different payload remains
a server conflict; map only the proxy's verified derived-key conflict to replied,
record it, then ack under the established contract. Never swallow generic conflicts.
After five consecutive failed turns on one transaction, surface transaction_stuck
and stop waking. Preserve operator abandonment/recovery and lease semantics.

Acceptance: competing human/message submissions, duplicate wakes, crash before/
after turn submission, reply commit/local-write loss, ack failure, permanent model
failure, reconnect during streaming, and two profiles cannot lose or duplicate work.

### D. Public lifecycle and operator visibility (client)

Keep `mesh enroll`, `mesh agent add bob --runtime hermes`, `mesh start`,
`mesh status`, `mesh inbox`, and `mesh doctor` as the public direction. Exact
desktop-binding flags/subcommands remain to be designed; do not document them as
implemented. Internal triangle-client/helper names may remain implementation details.
Status must distinguish connected, subscribed, pending, busy, running, reconnecting,
submission_unknown, transaction_stuck, and disabled. Show last successful wake,
bound thread, queue depth, retry count, and actionable errors. Stop must release
owned connections/processes without stopping the user's ordinary desktop.

### E. Real Bob canary, then release hardening

Use a verified profile and Bob's verified current agent ID. Send a unique nonce,
record outbound event/room, leave the desktop idle, and let the user operate Bob.
Pass only when Bob's correlated durable reply triggers the same desktop chat
without a new user message, manual poll, or impersonating Bob. Repeat while the
chat is busy and across listener restart. Record mesh commit, hint receipt,
admission, desktop start, completion, reply, and ack times separately.

Then test background/unsubscribed chats, approvals, cancellation, multiple rooms,
server restart, transport authentication, resource bounds, and a fake-harness soak.
Do not call one successful local turn a latency distribution or production soak.

## First next-agent task

Read this note and the prototype report; inspect dirty source changes. Implement
A with focused adapter tests, then B and the Bob canary behind opt-in flags.
Do not redeploy MESH merely for the desktop configuration fix; deploy only actual
required server changes after verifying what is already live. Do not commit,
push, permanently migrate desktop, or enable a production daemon without authority.

## Not proved / do not infer

Closed-app startup; background/unsubscribed task wake; attachment to the ordinary
desktop's private server; full desktop tools/approval compatibility; durable MESH
delivery; exactly-once turn submission; user/listener race safety. These remain
explicit tests, not reasons to repeat the already-passed basic feasibility study.

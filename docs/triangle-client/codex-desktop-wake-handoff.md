# Codex desktop wake-up: implementation handoff

Verified: 2026-09-05 UTC (2026-09-04 America/Los_Angeles).
Updated: 2026-09-12.

Status:
- Native desktop idle-chat wake-up proved (2026-09-05).
- Phase 2 durable wake/scheduling is **Complete** (2026-09-12 wall soak).
- Shared Codex App Server track: **authenticated WS transport + supervisor wiring landed**; native-desktop nonce repeat and Bob canary remain.

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


## Product priority (2026-09-12)

- **Harness integration is crucial** (Codex shared App Server path first, then
  Hermes and other reviewed harnesses via coordinator-delivery / trusted proxy).
- **Post–Phase 2 priority #1** is Shared Codex App Server integration (this
  track), before Slice 6 proxy, Bob canary, and optional SDK.
- **Autonomous Codex SDK subprocess is optional** and must not gate Phase 1/2
  completion or harness work.
- Phase 1/2 Complete means durable wake and scheduling only. App Server proofs
  do not reopen Phase 2. See
  [phase 1/2 completion criteria](2026-09-05-realtime-mailbox-phase-1-2-completion-criteria.md).

## App Server track status (2026-09-12)

| Gate | Status |
| --- | --- |
| A. Shared-server attachment scaffold | **Landed (authenticated WS + fake)** — `shared-codex-app-server.mjs` + `authenticated-app-server-transport.mjs`. Live Codex `initialize` may omit `serverInfo.name`; identity comes from authenticated `transport.connect()`. Native-desktop nonce repeat still open. |
| B. MESH wake → session without Node `mesh_` secrets | **Landed (wiring + docs)** — helper watch transport; `createAppServerWakeBridge`; supervisor/CLI opt-in `appServerWake` bootstrap |
| C. Admission / busy queue / correlation | **Partial** — in-memory queue + correlation; durable production persistence and race matrix still open |
| D. Lifecycle / doctor status surface | **Partial** — `session.status()` distinguishes doctor phases; public `mesh` flags not designed yet |
| E. Real Bob canary | **Not started** |
| Slice 6 trusted transaction proxy | **Landed on main (PR #7)** — use `createTrustedTransactionProxy` / helper CLI; Mac security review still required before production Hermes claim/reply/ack |
| Optional Codex SDK subprocess | **Out of scope** |

### What landed (scaffold → authenticated transport)

- Opt-in binding validation and fail-closed identity/endpoint checks
- Memory + atomic file binding stores
- Fake App Server JSON-RPC transport for Linux unit tests
- **Authenticated WebSocket transport** (`createAuthenticatedAppServerTransport`):
  Bearer capability-token auth on connect, `serverIdentity` from connect / scripted
  `triangle/authenticated` hello (not from missing initialize `serverInfo.name`)
- Session: connect / resume / read / turn/start / wait / admit / reconnect / shutdown
- Wake bridge: helper-shaped watch transport → `resolveDelivery` → admit (empty mailbox → zero turns)
- **Supervisor / CLI opt-in `appServerWake`** for bound-thread bootstrap (secret-free MESH watch; App Server WS token via absolute file or env *name*)
- Slice 6 helper proxy on main (not claimed as Mac-reviewed production)

```sh
cd packages/agent-worker && node --test \
  test/shared-codex-app-server.test.mjs \
  test/authenticated-app-server-transport.test.mjs
```

### How MESH wake reaches the App Server session (no Node secrets)

Production path (same custody model as Phase 2 wake):

1. Supervisor / operator ensures a Keychain watch grant via
   `triangle-mailbox watch-ensure --installation … --actor-profile …`.
2. Node builds `createHelperWatchTransport({ helperPath, installationId })`.
   The helper CLI runs `watch-poll`; **`mesh_watch_` never enters the Node
   process**.
3. `createWakeClient` coalesces secret-free `{ agent_id, high_watermark }` hints.
4. `createAppServerWakeBridge` calls injectable `resolveDelivery` to reconcile
   durable mailbox state (empty → skip; delivery → `{ deliveryId, text }`).
5. `session.admit` queues or starts `turn/start` on the bound shared App Server
   thread while the desktop remains attached to the same server.

Self-serve mailbox drain can feed `resolveDelivery` for Codex experiments.
Production Hermes / coordinator-delivery claim/reply/ack still requires
**Slice 6**. Do not treat wake receipt or turn completion as MESH ack.

### Explicit remaining gaps before production claim

1. **Native desktop nonce repeat** of the 2026-09-05 wake against this production-shaped
   authenticated WS adapter (Mac). Authenticated WS transport itself has landed.
2. **Durable correlation / crash recovery** and human-vs-listener race proofs.
3. **Slice 6 Mac security review** before Hermes production claim/reply/ack (implementation on main).
4. **Bob canary** (unique nonce, correlated durable reply → same desktop chat).
5. **Public lifecycle flags** under `mesh` (binding subcommands still undesigned).
6. **Optional SDK subprocess** remains optional and must not gate this track.

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

- `packages/agent-worker/src/shared-codex-app-server.mjs`: App Server adapter
  (binding, session, admission, wake bridge, Slice 6 proxy entry).
- `packages/agent-worker/src/authenticated-app-server-transport.mjs`: authenticated
  WebSocket JSON-RPC transport + scripted auth handshake for Linux tests.
- `packages/agent-worker/src/client-supervisor.mjs` / `client-supervisor-cli.mjs`:
  opt-in `appServerWake` bootstrap beside workers / eventWake.
- `packages/agent-worker/test/shared-codex-app-server.test.mjs` and
  `authenticated-app-server-transport.test.mjs`: focused unit tests.
- `packages/agent-worker/src/wake-client.mjs`: injected wake transport, coalescing,
  reconciliation; default cursor store is in-memory, not durable production state.
- `packages/agent-worker/src/helper-watch-transport.mjs`: secret-free helper poll.
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

**Increment status:** scaffold + authenticated WebSocket transport + fake-transport
tests landed. `serverIdentity` is supplied by authenticated `connect()` (capability
token auth metadata and/or scripted `triangle/authenticated` hello). Live Codex
`initialize` without `serverInfo.name` is accepted. **Native desktop nonce repeat
remains.**

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

**Increment status:** wake bridge reuses helper/fake watch transport patterns;
empty-mailbox → zero turns covered in unit tests. Supervisor/CLI opt-in
`appServerWake` bootstrap for a bound thread is wired (capability-token file or
env name; no Node `mesh_` / `mesh_watch_`). Live helper + desktop integration
and Bob canary remain.

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
out of Phase 1/2 Complete but required for harness production.

**Slice 6 increment (2026-09-12):** durable Swift store + policy + claim/reply/ack
orchestration, helper CLI, MCP rewriter, and Node helper wiring landed. See
[2026-09-12-slice6-trusted-transaction-proxy.md](2026-09-12-slice6-trusted-transaction-proxy.md).
Mac security review and Darwin host-suite evidence remain before production.
Keep protocol
ownership in open.json (`self-serve-drain` versus `coordinator-delivery-v1`). Reply key reuse with different payload remains
a server conflict; map only the proxy's verified derived-key conflict to replied,
record it, then ack under the established contract. Never swallow generic conflicts.
After five consecutive failed turns on one transaction, surface transaction_stuck
and stop waking. Preserve operator abandonment/recovery and lease semantics.

Acceptance: competing human/message submissions, duplicate wakes, crash before/
after turn submission, reply commit/local-write loss, ack failure, permanent model
failure, reconnect during streaming, and two profiles cannot lose or duplicate work.

**Increment status:** in-memory admission queue + correlation + submission_unknown
/ transaction_stuck phases landed. Slice 6 helper proxy landed on main (PR #7) —
Mac review still required before production Hermes claim/reply/ack.

### D. Public lifecycle and operator visibility (client)

Keep `mesh enroll`, `mesh agent add bob --runtime hermes`, `mesh start`,
`mesh status`, `mesh inbox`, and `mesh doctor` as the public direction. Exact
desktop-binding flags/subcommands remain to be designed; do not document them as
implemented. Internal triangle-client/helper names may remain implementation details.
Status must distinguish connected, subscribed, pending, busy, running, reconnecting,
submission_unknown, transaction_stuck, and disabled. Show last successful wake,
bound thread, queue depth, retry count, and actionable errors. Stop must release
owned connections/processes without stopping the user's ordinary desktop.

**Increment status:** doctor-facing `session.status()` fields landed; public CLI
binding flags not designed.

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

**Increment status:** not started.

## First next-agent task

Repeat the **native desktop nonce wake** against the authenticated WebSocket
adapter (`createAuthenticatedAppServerTransport` + bound session), then run the
**Bob canary**. Do not reopen Phase 2 Complete. Prefer leaving Mac-only desktop
experiment execution and Bob canary as follow-ups if this environment cannot run
them. Durable correlation / race matrix remains after that.

## Not proved / do not infer

Closed-app startup; background/unsubscribed task wake; attachment to the ordinary
desktop's private server; full desktop tools/approval compatibility; durable MESH
delivery; exactly-once turn submission; user/listener race safety; Bob canary;
Slice 6 production proxy. These remain explicit tests, not reasons to repeat the
already-passed basic feasibility study.

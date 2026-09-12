# Shared Codex App Server protocol prototype

Status: protocol proof and native desktop idle-chat wake-up passed; production-shaped
adapter scaffold started under `packages/agent-worker/src/shared-codex-app-server.mjs`
(fake-transport unit tests). Not yet a live WebSocket / Bob-integrated daemon.

Next agent: continue from [the concrete implementation handoff](codex-desktop-wake-handoff.md).
The guarded native experiment is preserved at
`scripts/prototypes/native-desktop-wake-experiment.mjs`; it is not a service launcher.

## Native desktop wake-up proved, 2026-09-05 04:05 UTC

The installed desktop (0.153.0) successfully resumed test thread
`01a06f9f-2db1-7143-b8b9-08c634cc7999` against the shared WebSocket server.
A separate listener connection submitted turn
`01a06fbe-417c-7412-8b69-44cfc4d3f3e6` while the chat was idle.

- External turn/start returned at 04:05:34.721 UTC.
- Desktop connection received matching turn/started at 04:05:34.723 UTC.
- Both connections observed completion at 04:05:37.558 UTC.
- Read-only inspection of the actual desktop renderer before and after showed
  a new synthetic prompt and assistant response DESKTOP_SHARED_WAKE_OK at 9:05 PM.
  Marker occurrences increased from four to six (one prompt and one answer).
- No user chat input or Bob participation triggered this turn. This was not a
  surrogate UI or merely a successful backend invocation.

The failed subscription was diagnosed explicitly: desktop thread/resume returned
`failed to load configuration: invalid transport in mcp_servers.codex_app`.
Supplying a valid bundled MCP command/args/cwd definition as a server launch
override removed the error. Desktop and backend used the same configuration home;
Electron UI data remained separate. The codex_app server was disabled for this
text-only test: full desktop-tool and approval compatibility remains unproved.
No private signed IPC boundary was bypassed. The initial configuration-home
mismatch and startup timing were confounders, not independently proven causes.

Scope: an open, subscribed, idle chat in an already-running desktop connected
to the shared server. This does not prove starting a closed app, attaching to the
ordinary desktop's existing private server, background/unsubscribed chat delivery,
human/listener races, or a real MESH-to-Bob round trip. The local timing is one
sample, not a latency distribution.

Diagnostic driver and transport evidence: /private/tmp/mesh-desktop-probe.v88XjH/
run.mjs and fixed.log. The driver still needs cleanup hardening before reuse.

## Native desktop experiment, 2026-09-05 UTC

The actual installed desktop connected to the shared server using
CODEX_APP_SERVER_WS_URL with /rpc. An isolated instance used both
CODEX_ELECTRON_USER_DATA_PATH and --user-data-dir, and separate desktop-local
CODEX_HOME. The server retained the existing login. The ordinary desktop stayed
running; no launchctl override was installed.

Verified: WebSocket initialize succeeded, the desktop reported Codex 0.153.0,
and it queried projects, threads, configuration, and account state. A deep link
briefly activated the disposable test conversation. An external connection
resumed that thread and completed a synthetic turn.

Unverified: visible external-turn streaming into the desktop chat. The thread
view became inactive; no desktop thread/resume was observed and the instrumented
connection showed no turn/started or turn/completed notifications. Backend
connectivity is proven, but renderer subscription remains a gate.

The isolated desktop, proxy, and server were stopped and PID exit was checked.
Startup issued config/batchWrite, experimental-feature enablement, and
marketplace/add requests against the shared backend. Isolated UI state does not
isolate backend configuration. Before permanent adoption, preserve and compare
backend settings and supply required desktop MCP/runtime overrides. Full tool,
approval, and configuration compatibility has not been established.

## Run

Node 22+ and an authenticated Codex installation are required.
This makes three short real model turns using your configured model and login.
It creates a disposable persisted thread, uses a temporary read-only workspace,
binds only loopback, and stops the App Server at the end. It does not touch MESH,
send to Bob, or connect to the desktop's private IPC bridge.

```sh
MESH_CODEX_BINARY=/Applications/ChatGPT.app/Contents/Resources/codex \
  node scripts/prototypes/shared-codex-server.mjs
```

Omit the environment override to use codex on PATH. Pin a tested binary:
the successful run used desktop Codex 0.153.0 and Node 22.22.3.

## What it proves

Two independent WebSocket clients in one test driver attach to one App Server.
The UI client starts a conversation and completes an initial turn. The listener
client resumes the saved thread, starts a turn while idle, and queues one
synthetic message in memory while that turn is active. It submits the queued
message after completion. Both clients observe identical turn IDs. A fresh
listener connection resumes and reads the same three responses.

The driver represents a UI; it is not the actual terminal or desktop renderer.
The queue is a single in-memory test item, not a durable MESH delivery queue.
The 20 ms event-check loop is test-driver bookkeeping, not a proposed mailbox
poll loop. Production should dispatch from notification callbacks.

## Observed evidence

Run: 2026-09-05 03:28:59–03:29:14 UTC.
Thread: 01a06f9c-c2ad-7750-8972-efea8f0fa4ab.

- Initial response: UI_READY.
- Listener started an idle turn; UI observed turn start in 30 ms.
- Second response: WAKE_RECEIVED.
- Busy event was queued, then started after the preceding turn completed.
- Third response: QUEUED_RECEIVED.
- Reconnected client found the same thread and exactly three completed turns.
- Server exited after the test.

30 ms is one local submission-to-notification sample, not MESH latency,
model completion latency, a percentile, or a scalability benchmark.

Earlier attempts to resume immediately after thread/start returned
no rollout found for thread id, including with ephemeral:false.
Completing the first turn before attaching worked. Do not conclude that every
ephemeral thread is unsupported; the first attempt also preceded the first turn.
Readiness for external attachment must be proven, not inferred from thread/start.

## Architecture recommendation

User terminal/client and MESH bridge connect to the same App Server.
The bridge reconciles durable mailbox state and records a delivery-to-thread
mapping. When idle it submits a turn; when busy it queues and reconciles after
turn completion. The existing conversation is free to work without a blocking
mailbox tool. Use turn/steer only under an explicit interruption policy.

The SDK subprocess adapter remains appropriate for autonomous agents.
It is not a bridge into an already-owned desktop conversation. The desktop
private app-tools pipe rejected the earlier external probe with
untrusted-code-signing-identity; do not depend on or bypass that interface.

## Remaining gates

- Attach the actual Codex terminal UI using --remote to this shared server and
  verify rendering, input, approvals, and external turns.
- Connect the real MESH wake listener and prove Bob reply → same-conversation
  activation with no intervening user message.
- Implement one authoritative queue/dispatcher for human-versus-listener races.
  This sequential test does not prove atomic admission under competing clients.
- Persist correlation and reconcile unknown submission outcomes before retry;
  never equate tool receipt with MESH acknowledgement.
- Test disconnect during submission, App Server restart, duplicate wakes,
  approvals, cancellation, and multiple rooms/profiles.
- Bound queue/resource usage and prevent peer content changing configuration.
- Configure authenticated transport before production; this disposable local
  probe exposes a loopback listener and must not be left running.
- Pin the experimental protocol and verify upgrades.

Temporary workspaces and saved synthetic conversation history are retained for
inspection. Desktop startup can issue backend configuration writes; do not infer
configuration isolation from a separate Electron user-data directory.

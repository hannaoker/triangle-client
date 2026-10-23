# Desktop queue canary — October 22, 2026

Scope: one dedicated scratch conversation created with owner authorization;
no production binding changes, queue database writes, second server, or installs.

Target: `01a16531-3a1d-7d41-85cf-f6ba0dccc2db` (Triangle wake canary).
The initial setup completed with `READY`. Although created using Codex desktop
tools, its actual writer is the ChatGPT-bundled server, PID 39686, parent
ChatGPT.app PID 39266. CLI is Homebrew `codex-cli 0.163.0`.

## Observations

All timestamps below are UTC on October 22 (subtract seven hours for PDT).

| Case | Submission | Observed result | Evidence boundary |
| --- | --- | --- | --- |
| Idle, `B1-IDLE-20261022` | 20:19:57.186; exit 0, receipt `01a16545-3821-77c3-82a7-cd93736d8f97` | Turn `01a16545-4577-7f63-be54-67d81dc489ba` started 20:20:01.023, completed 20:20:02.512; exact acknowledgment | Strict collector PASS: one queue-triggered turn, one acknowledgment, zero tools/unclassified records. Same sole lock holder in all 30 samples (~36 seconds). CLI exit time was not measured separately from observation. |
| Busy, `B1-BUSY-20261022` | 20:21:06.158–06.423; exit 0, receipt `01a16546-44f4-7391-91ab-07adf95d4e0b` | Busy turn completed 20:21:24.822; canary turn `01a16546-8cd7-7b42-88df-cf3f2ced3d79` started 11 ms later, completed 20:21:27.417; exact acknowledgment | Strict collector PASS for canary itself. `--after-token` is INCONCLUSIVE because the busy request arrived as a delegated tool input, not an ordinary user item. Separate JSON turn-ID/timestamp inspection establishes ordering; do not label full protocol PASS. |

Busy predecessor: `01a16545-cbb6-7680-9645-a43af0e06b71`, started
20:20:35.392. Its sole requested shell command was `sleep 45`, observed in
the rollout before queue submission. It returned `busy done.` (extra period
relative to requested output). The queued canary did not interrupt that turn.
Post-test lock holder remained PID 39686; target queue count was zero.

Transient evidence: `/private/tmp/triangle-wake-canary-20261022/idle.json`
and `busy.json`; original rollout is the exact target's October 22 session.
No unrelated conversation content was collected.

## Remaining gates

This establishes useful live idle/busy delivery evidence, not installed adapter
acceptance. Full protocol gates remain: visible/background observation, bound
working-thread canary, restart behavior, and local/MESH arbitration. Automatic
wake remains OFF. No MESH content bridge is authorized.

Independent prerequisite review found one remaining P2: exact retries are
rejected at a full pair cap because exchange reservation precedes durable
deduplication (`local-messaging-server.mjs:218`). No other P1/P2 was reported;
reviewer ran 41 relevant tests successfully. The owner subsequently explicitly
released shared-file ownership to parent Codex; fixing the retry regression
remains a prerequisite for activation.

Antigravity was assigned only the new standalone queue adapter and its test
file, through installed Triangle, request `wake-adapter-build-20261022`.
That first task excluded shared files, packaging, live configuration and
installation. Its correction passes produced an 11-test standalone adapter;
independent review still found a descendant-cleanup edge case and an unbounded
probe version, both assigned to the next integration task.

After ownership release, Antigravity received runtime integration request
`wake-m1-integration-20261022`. Parent Codex owns packaging and docs separately.
The focused v10 Python/Swift contract test and 11 Swift launcher tests passed;
independent packaging review found no P1/P2 and verified old v8/v9 exact sets
against the pre-change source. Full closure tests await the notifier module.
This is source verification, not installation or automatic-wake activation.

## Integration review checkpoint

The candidate passed 33 focused adapter/notifier/SQLite tests and all 21
combined bundle-closure/installation-contract tests. Those passes did not close
independent review findings: installed binding format incompatibility, notifier
shutdown race, configurable interval below the 15-second floor, startup before
socket readiness, and a parent-reproduced stale acknowledgment accepted after
thread rebind. The batched correction request is
`wake-m1-review-fixes-20261022`, under the same integration request ID.

The initial implementation request ended held with `runtime_error`, without a
final reply. Its stored diagnostic contains network-unavailable/503 indicators;
this is not a proven source-test failure or a completed handoff. Triangle
started the queued correction separately after the first execution ended.
Do not treat the partial source or passing tests as accepted implementation.

Computer-use observation of the desktop app was denied by the tool's app safety
restriction. No alternate screen-access method was used. A user-observed
visual/background check remains necessary before closing those activation gates.

## Final source verification

Both follow-ups completed through installed Triangle, with correlated replies
to `wake-m1-review-fixes-20261022` and `wake-m1-test-wiring-20261022`. Independent
re-review found no remaining P1/P2 source blocker in the correction batch.
Binding compatibility, stable restart identity, durable generation advance,
stale/foreign acknowledgment rejection, full evaluation shutdown custody,
production configuration bounds and socket-first startup have regression
coverage. Parent independently reproduced zero post-stop submissions and the
reviewer verified real SQLite/socket retry-at-cap behavior.

- Focused final run: 142 passed, zero failed/cancelled/skipped. All 167 worker
  source/test file hashes remained unchanged during the run.
- Full worker package: final run 851 passed, three skipped, zero failed or
  cancelled; source hashes remained unchanged. The prior run's sole failure
  was an old v9 assertion in the supervisor bundle test. It was updated to v10;
  that file's nine tests and then the final full suite passed.
- Packaging/installation contracts: 21 passed. Swift launcher tests: 11 passed.
  Canary collector self-tests: 19 passed. Earlier targeted results are subsets,
  not additional independent test counts.
- Release-candidate build: `0.1.0-wake-candidate`, macOS arm64, 131 manifest
  files. Archive SHA-256:
  `b58759a7f27e8a558b7280562321f024609b6c73370e11cd0844b539564b655b`.
- Export smoke: generated checksum-verifying installer installed the actual
  archive into a disposable private test home. Packaged CLI help succeeded;
  the exported source staged and validated a v10 supervisor containing both
  wake modules. The test service stayed staged/stopped; the real account's
  installation was not changed.

The package is local under `/private/tmp/triangle-wake-release-20261022`.
This remains a candidate with automatic wake off; live activation gates above
are still open. No MESH content bridge or second app-server was introduced.

## User-observed scratch wake

On October 22 (01:39 UTC October 23), the existing scratch conversation
`01a16531-3a1d-7d41-85cf-f6ba0dccc2db` received one queue submission labeled
`B1-VISIBLE-20261022-01`. Receipt:
`01a16669-3208-7322-8039-da16d8040635`. Its sole turn
`01a16669-536b-7bf1-b412-b8e303805612` completed in 3,135 ms with exactly
`canary ack B1-VISIBLE-20261022-01`; the rollout records no tool calls in that
turn. The queue was empty afterward and writer-lock inspection returned the
same sole PID, 39686.

The user explicitly confirmed: "Yes, exactly once and automatically" when
asked whether the notification and acknowledgment appeared without typing or
clicking to trigger it. This closes the user-observed foreground scratch-chat
queue wake check. It does not establish background-app behavior, installed
v10 notifier delivery/acknowledgment, or the bound working-thread and retired
MESH-route arbitration gates. Production remains v9 with automatic wake off.

## Installed v10 checkpoint

The subsequent supported developer-helper upgrade and service installation
completed. The public package installer first refused an existing helper whose
hash did not match its older receipt; that refusal was not bypassed. The
repository helper installer upgraded the helper; service preparation required
the trusted Node directory explicitly in PATH. Service installation refreshed
agent bundles but preserved the dedicated v9 supervisor manifest, so the
dedicated supervisor was explicitly staged at v10 and the local wrapper
refreshed through the installer before restarting the existing service.

Authenticated installed `triangle-local status` then confirmed running true,
the unchanged desktop sender/thread and gravity2 recipient, zero active tasks,
eight unread replies and two held tasks. Wake state was idle. The retired
shared host remained disabled, its live app-server binding was absent, and no
registered instance requested appServerWake. The working-thread lock still had
the same sole owner, PID 39686. This is absence of a competing configured route,
not proof of arbitration between two live wake producers.

Automatic approval review rejected the subsequent command to enable wake on
the real working thread because its existing backlog could immediately cause
a model turn. That command did not execute. Explicit owner approval for that
specific activation was requested; installed v10 remains running with wake off.

## Approved live working-thread test

The owner then explicitly approved: "Enable for the live test." Wake was
enabled on the existing integration without changing sender, thread or recipient.
The installed supervisor submitted one coalesced hint for eight unread replies
and two held tasks, with no late result. Wake ID:
`e4e1b96a-68a6-4795-8693-50df612e0fb3`, generation 1; queue receipt:
`01a16675-12bd-7fc0-be8f-9fcded38aacb`, targeting working thread
`01a14c05-6603-7921-b744-659195a490a5`.

A subsequent supported supervisor restart retained that exact wake ID,
generation, receipt and `accepted_awaiting_ack` state. The target queue contained
one item and the sole writer-lock owner remained PID 39686. No peer task was
executing. This proves durable submission retention across the observed restart;
delivery into a subsequent conversation turn and exact acknowledgment are still
pending at this checkpoint. Wake is enabled for the authorized test.

## Delivered wake, acknowledgment and restart recovery

The queued notification subsequently arrived in the actual working conversation
after the submitting turn ended, with the exact wake ID and generation above.
Codex used installed `triangle-local replies` to retrieve all eight updates,
then installed `ack-wake` returned `acknowledged: true` for generation 1.
Historical peer instructions were not executed; no replies were consumed or
deleted, and the two held tasks were not retried.

A second supported supervisor restart retained generation 1, the same
`last_acknowledged_wake_id`, and a non-null acknowledged fingerprint. Status
returned idle with no active wake; the Codex target queue contained zero items,
and the sole thread writer remained PID 39686. The unchanged backlog remained
eight replies/two held tasks without a duplicate submission. This closes the
observed installed-notifier delivery, exact acknowledgment, outstanding-wake
restart recovery and acknowledged-snapshot restart checks. It does not prove
delivery with the desktop app quit, sustained soak, new-reply latency, Iroh
transport, or arbitration between two live desktop wake producers.

The controlled test was then ended by switching wake enabled to false and
restarting the existing service. v10 remains installed; no second app-server,
identity change or local-to-MESH content bridge was introduced.

## Fresh Antigravity review completion wake

The owner requested Antigravity review PR #107. Installed `triangle-local send`
admitted `pr107-review-fresh-20261022` under the existing desktop sender, with
gravity2 as recipient. It was observed executing, then completed with correlated
reply `rep-033a4e2d-1c28-4ff1-bb18-57d94a6d7dba`. Durable admission-to-completion
elapsed time was 862,305 ms (14 min 22.305 s), including review and its reported
test work; this is not a transport latency measurement.

That fresh reply changed unread count from eight to nine and caused wake
`0ff87b58-ff5b-4e16-9aa0-ec96c610bb15`, generation 1, receipt
`01a1668a-2f9f-7011-8a9d-0c44972a4794`. It arrived as the next notification in
the bound working conversation. Codex retrieved the correlated review through
the installed CLI and acknowledged the exact wake successfully. This proves
the observed fresh-task send → execution → reply → automatic wake → retrieval
→ acknowledgment path, on the same device, without model-side reply polling.
Wake was then disabled and the healthy existing supervisor restarted.

Review validation: Codex reproduced one service-test failure, not Antigravity's
reported three: 26 passed/one failed in 27 tests; the failure is the stale v9
assertion at `tests/triangle-client-service.test.mjs:171` against v10. Source
inspection confirms rebind of an outstanding wake enters `stale_held` and no
supported recovery command exists. Holding and rejecting stale acknowledgments
is intentional safety behavior; the missing operator reconciliation is an
availability gap, not grounds to accept stale acknowledgments. Source also
confirms the 20 ms notification callback precedes dispatcher reply persistence;
the periodic timer supplies eventual notification, so the review's delayed
notification concern is plausible, not a reproduced loss. Its separate Swift
signal-test failure has not been independently reproduced. No source changes
were made by this read-only review and no merge was requested or performed.

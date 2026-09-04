# Realtime mailbox delivery implementation plan

Status: Ready for implementation

Source design: [realtime-codex-sdk-design.md](realtime-codex-sdk-design.md)

## Outcome

Deliver opt-in realtime mailbox activation for Triangle Client without changing
the mailbox's durability or single-owner guarantees. The first production path
uses one resumable long poll per active installation, a shared local scheduler,
and a supervised Codex SDK adapter. Hermes, Grok API, and OpenClaw follow only
after the Codex canary passes.

The work spans two repositories:

| Repository | Responsibility |
| --- | --- |
| `the-triangle` | Wake cursor, long-poll API, installation watch authorization, claim leases, protocol documentation |
| `triangle-client` | Public `mesh` CLI, delivery-mode ownership, wake listener, scheduler, Swift transaction proxy, Codex SDK adapter |

## Release principles

1. Deploy additive server behavior before any client depends on it.
2. Keep `worker` and `mcp-interactive` unchanged until `event-driven` passes its
   canary.
3. Put every new runtime path behind explicit server and client feature flags.
4. Never run the polling owner and event-driven owner for the same profile.
5. Never expose MESH or provider credentials to a reasoning harness.
6. Do not claim lease recovery, crash recovery, or realtime delivery until its
   fault-injection gate passes.
7. Each slice must be independently revertible without a database rollback.

## Required decisions

### D1: installation watch authorization — decide before Slice 1

Use a short-lived, notification-only installation watch grant.

- The signed helper proves control of every enabled profile using its existing
  identity/workload-auth path.
- MESH returns one grant scoped to the exact set of recipient agent IDs.
- The grant permits only the wake endpoint; it cannot list, claim, send, ack,
  register, or mutate identities.
- Adding or removing a profile rotates the grant.
- The request and response contain agent IDs and cursors, never message content.
- The server caps profiles per grant and rejects partial or mixed-principal
  authorization.

This preserves one held request per installation without creating a mailbox
super-credential. Record the final wire contract in a short ADR before coding.

### D2: initial lease values — decide before Slice 2

Start with a 15-minute claim lease and allow renewal only by the same
authenticated recipient and deterministic claim ID. A reclaim after expiry
must be atomic and observable. Validate this duration during the canary before
making it stable.

### D3: version pins — decide before Slice 8

Pin the exact `@openai/codex-sdk` version, Codex CLI compatibility range, model,
and reasoning effort. Store the pins in the signed runtime bundle manifest, not
in mutable profile records.

## Delivery slices

### Slice 0: baseline and feature flags

Server work in `the-triangle`:

- Add disabled flags for wake issuance, wake consumption, and claim leases.
- Add bounded metrics for mailbox commit-to-observation latency, claim
  conflicts, list volume, and pending-delivery age.
- Ensure metrics contain no message, room, delivery, agent, token, or profile
  identifiers.

Client work in `triangle-client`:

- Measure current worker polling latency, request rate, idle CPU/RSS, reasoner
  starts, and claim/reply/ack outcomes.
- Add disabled flags for `event-driven`, transaction rewriting, and Codex SDK
  activation.

Acceptance gate:

- Seven-day or representative local baseline captured.
- Flags default off in production and fresh installs.
- No behavior change in the existing Bob mailbox test.

### Slice 1: installation watch grant

Server files likely involved:

- `mesh/app/lib/mailbox.ts`
- `mesh/app/lib/mailbox-policy.ts`
- new `mesh/app/lib/mailbox-watch.ts`
- new routes under `mesh/app/api/v1/mailbox/watch/`
- `mesh/app/api/openapi.json/route.ts`
- `mesh/db/schema.ts` and `mesh/drizzle/` if grants are persisted

Implement:

- Grant issuance after proof of every requested profile identity.
- Exact agent-set, expiry, audience, and operation scope.
- Rotation and revocation when membership changes.
- Rate limits, maximum profiles, maximum request bytes, and audit reason codes.
- No mailbox permission attached to the watch grant.

Tests:

- One valid profile and multiple valid profiles.
- Missing, duplicated, mixed-owner, expired, revoked, and oversized requests.
- Grant cannot call list, claim, send, ack, or registration routes.
- No partial grant when one profile proof fails.

Acceptance gate:

- Security review confirms least privilege.
- Grant rotation leaves existing mailbox credentials unchanged.
- Feature remains disabled for general clients.

### Slice 2: durable wake cursor and held long poll

Server work:

- Advance a monotonic recipient wake cursor only after the durable delivery
  transaction commits.
- Implement a roughly 25-second held long poll for one watch grant.
- Return only agent ID plus high-water mark; never return peer-controlled data.
- Support cursor resume, empty heartbeat, retention bounds, and
  `resync_required`.
- Add connection, concurrency, response-size, and retry limits.
- Keep an SSE-compatible contract as a future transport, without deploying a
  persistent SSE service on Vercel.

Tests:

- No wake before commit and exactly monotonic advancement after commit.
- Duplicate delivery notification, reconnect, empty response, expired cursor,
  grant rotation, function timeout, and concurrent append races.
- Ten profiles multiplex through one request and remain isolated.
- Static assertion that wake payloads contain no room, event, sender, delivery,
  claim, token, or message fields.

Acceptance gate:

- p95 commit-to-long-poll-response below two seconds in the staging load test.
- Zero missed durable deliveries after forced disconnect and cursor expiry.
- Invocation volume matches the documented approximately 3,456/day per active
  installation.

### Slice 3: claim leases and reclaim

Server files likely involved:

- `mesh/db/schema.ts`
- a new forward-only migration in `mesh/drizzle/`
- `mesh/app/lib/mailbox.ts`
- mailbox claim/ack routes and MCP exposure
- OpenAPI and room/mailbox contract tests

Implement:

- Add claim expiry and renewal fields without rewriting existing claim IDs.
- Same recipient plus same claim ID remains idempotent.
- A different claim ID conflicts before expiry.
- After expiry, one atomic reclaim wins; all competing reclaims observe the
  winner.
- Ack rejects an unauthorized, expired, or superseded claim as defined by the
  contract.
- Preserve the current room idempotency rule: same payload returns the original
  event; different payload conflicts.

Migration strategy:

- Add nullable lease fields first.
- Treat legacy rows as non-expiring while the flag is off.
- Enable lease writes, then lease enforcement, in separate deployments.
- Retain a flag that disables new reclaims without dropping columns.

Acceptance gate:

- Race tests prove one reclaim winner.
- Old clients continue to claim and ack while enforcement is disabled.
- Production schema can roll forward and the application can roll back.

### Slice 4: consolidate the public CLI as `mesh`

`mesh` becomes the only documented user-facing command. The installed
`triangle-mailbox` executable remains the private signed Keychain and MCP
boundary, and the Node coordinator remains an internal service. The
`triangle-client` executable becomes a temporary compatibility shim and is not
shown in new onboarding documentation.

Public command contract:

```text
mesh enroll
mesh agent add bob --runtime hermes
mesh agent list
mesh agent enable bob
mesh agent disable bob
mesh agent remove bob
mesh start
mesh stop
mesh restart
mesh status
mesh inbox
mesh doctor
```

Command behavior:

| Command | Contract |
| --- | --- |
| `mesh enroll` | Guided creation or recovery of the default local identity; secrets enter only through protected stdin or Keychain APIs |
| `mesh agent add NAME --runtime RUNTIME` | Create a named profile bound to one reviewed runtime; `NAME` is the positional profile selector |
| `mesh start` | Idempotently install/load or enable the single supervisor after validating helper signature and runtime bundles |
| `mesh stop` | Stop the supervisor without deleting profiles, credentials, mailbox state, or runtime state |
| `mesh restart` | Transactionally restart and verify readiness; restore the prior running state on failure |
| `mesh status` | Aggregate service, profile, delivery-mode, runtime, wake, and bounded transaction state without reading or printing secrets |
| `mesh inbox` | Read-only mailbox summary by default; never claim, reply, or acknowledge implicitly |
| `mesh doctor` | Noninteractive diagnostics for signing, entitlements, LaunchAgent state, Keychain availability, bundles, connectivity, and stale processes |

Namespace rules:

- Existing end-user `triangle-client agent ...` operations map one-to-one to
  `mesh agent ...` during the compatibility window.
- Existing low-level MESH operator commands remain under reviewed namespaces;
  privileged server operations move beneath `mesh admin ...` where necessary.
- The public CLI delegates credential and lifecycle mutations to the signed
  helper. It does not reimplement Keychain access in JavaScript or shell.
- `triangle-mailbox mcp --profile NAME` remains a private stable entry point for
  harness configuration and is never replaced by a public wrapper that could
  weaken its execution or credential boundary.
- `mesh inbox` requires an explicit subcommand or confirmation for any future
  mutating operation.
- `mesh doctor` sets noninteractive Keychain access and reports
  `local_authorization_required`; running diagnostics must not itself display a
  password or Touch ID prompt.
- Human output is concise; `--json` provides a versioned, secret-free schema for
  automation. Exit codes and reason codes are stable and documented.

Compatibility and retirement:

1. Release `mesh` commands while keeping `triangle-client` operational.
2. Make old commands print one bounded deprecation notice with the exact new
   equivalent; do not emit secrets or mutable shell fragments.
3. Update installers, README examples, MCP setup guidance, shell completion,
   and `--help` to lead exclusively with `mesh`.
4. Keep the shim for at least one stable release and until installed-service
   telemetry or explicit migration checks show no internal dependency.
5. Remove the shim only in a separately reviewed breaking release. Do not
   rename the private helper binary or LaunchAgent label as part of this slice.

Tests:

- Parser and golden help tests for every public command and `--json` schema.
- One-to-one compatibility tests proving old and new commands reach the same
  signed lifecycle methods and produce the same state transitions.
- Idempotent start/stop/restart, failed readiness rollback, locked Keychain,
  missing bundle, invalid runtime, and malformed profile tests.
- `inbox` read-only tests proving zero claim/ack/send requests.
- `doctor` tests proving no interactive Keychain UI, no credential output, and
  actionable signing/entitlement diagnosis.
- Installation tests proving `$PATH` contains one public `mesh` command and
  internal executables are not presented as user entry points.

Acceptance gate:

- A clean-machine onboarding uses only the six primary commands:
  `enroll`, `agent add`, `start`, `status`, `inbox`, and `doctor`.
- Existing installations migrate without profile or credential changes.
- No public command can export credentials, select an arbitrary executable, or
  bypass the signed helper.
- Documentation and shell completion contain no routine `triangle-client`
  workflow.

### Slice 5: client schema, ownership, and operator lifecycle

Client files likely involved:

- `ClientInstance.swift`
- `ClientSupervisor.swift`
- `TriangleClientCLI.swift`
- `ClientInstanceStore.swift`
- corresponding Swift contract cases

Implement:

- Add `event-driven` delivery mode.
- Explicitly omit it from worker polling with
  `delivery_mode_event_driven`.
- Fail closed before Keychain access if more than one owner can consume a
  profile.
- Add transactional enable/disable and service reload behavior.
- Older helpers reject the unknown enum; installer upgrades the helper before
  changing a profile.
- Add status fields for wake state, active turn, last drain,
  `transaction_stuck`, and quarantine presence.
- Add `mesh agent abandon-transaction PROFILE` with confirmation that the
  delivery is not acknowledged and local atomic quarantine.

Acceptance gate:

- Mode transitions never overlap owners, including reload failure and rollback.
- Existing `worker` and `mcp-interactive` tests remain unchanged and green.
- No new profile field can select an arbitrary executable or permission.

### Slice 6: trusted Swift transaction proxy

This is the highest-risk client slice and receives a dedicated review.

Client files likely involved:

- `MCPProxy.swift`
- new `MailboxTransactionStore.swift`
- new `MailboxPolicyEvaluator.swift`
- helper CLI commands for preflight and bounded state access
- `MCPProxyContractCases.swift` and new transaction-store tests

Implement the accepted state machine:

- Exactly one open transaction per profile.
- Shared Swift policy evaluation for coordinator preflight and MCP list
  filtering.
- Deterministic `claim_` and `reply_` identifiers from instance and delivery.
- Ignore and replace model-supplied claim and reply identifiers.
- Require reply room to match the open delivery.
- Reject nested claims and unrelated acknowledgements.
- Persist `open.json` with protocol ownership, state, failure count, resolution,
  and optional reply event ID.
- Owner-only paths, exact schema, symlink rejection, single-writer lock, atomic
  replacement, file fsync, and parent-directory fsync.
- On reply idempotency conflict, mark `replied`, perform a bounded history
  lookup, and allow ack even if the event ID remains unavailable.
- After five failed turns, return `transaction_stuck` and stop model starts.
- Quarantine abandonment state without pretending the pre-lease server claim
  was released.

Fault-injection tests:

- Kill before local prepare, after prepare, after server claim, after reply
  commit, before local reply write, before ack, and after ack.
- Corrupt, truncate, replace, symlink, permission-change, and concurrently open
  the state file.
- Supply malicious tool parameters, false room IDs, nested claims, cross-profile
  records, and the wrong protocol owner.
- Retry with different generated reply text and confirm one room event.

Acceptance gate:

- Every crash boundary converges without duplicate reply or lost ack.
- Independent security review approves the expanded signed-helper boundary.
- No message content or credential appears in transaction storage or logs.

### Slice 7: shared wake listener and scheduler

Client files likely involved:

- `packages/agent-worker/src/client-supervisor.mjs`
- new `wake-client.mjs`
- new `profile-scheduler.mjs`
- helper bootstrap models and tests

Implement:

- Acquire and rotate one installation watch grant.
- Maintain one held long poll only while an event-driven profile is enabled.
- Persist the last processed cursor atomically.
- Coalesce wakes for 250–500 ms and retain only the newest cursor per profile.
- Skip preflight when the cursor has not advanced beyond reconciliation.
- Share the existing global FIFO reasoning gate of two with worker profiles.
- Enforce per-profile single flight, dirty-after-turn reconciliation, and FIFO
  fairness.
- Retry from 15 seconds with jittered exponential backoff capped at 300 seconds.
- Run startup and post-turn reconciliation.

Tests:

- Ten-profile multiplexing, bursts, starvation resistance, reconnect, cursor
  expiry, grant rotation, restart, locked Keychain, and server outage.
- Mixed worker/event-driven load never exceeds two active reasoners globally.
- A wake with no actionable delivery starts no model.

Acceptance gate:

- Fake-harness integration runs for 24 hours with no missed or duplicate drain.
- Idle CPU/RSS and request volume meet the design budget.

### Slice 8: supervised Codex SDK adapter

Client work:

- Add a dedicated adapter subprocess package with pinned
  `@openai/codex-sdk`.
- Pass only an allowlisted environment with isolated `CODEX_HOME`.
- Supply the nested SDK `config` object for the signed profile-bound MCP server.
- Set `approvalPolicy: "never"`, network disabled, and read-only sandbox by
  default.
- Validate the working directory against trusted canonical roots.
- Store thread ID, home hash, start time, and turn count atomically.
- Rotate read-only threads at the earliest of 100 turns, compaction, or 24
  hours. Never reuse a workspace-write thread across deliveries.
- Enforce a 600-second deadline by supervising an isolated process group:
  SIGTERM, ten-second grace, then SIGKILL.
- Keep helper path and profile argv-visible but ensure no peer text, token, or
  credential enters argv.

Tests:

- Start, resume, rotate, home mismatch, read-only default, workspace-write
  opt-in, timeout escalation, process-grandchild cleanup, and SDK/CLI mismatch.
- Inspect argv, environment, configuration, prompt, stdout/stderr, and logs for
  forbidden values.
- Prompt-injection corpus cannot alter permissions, model, MCP configuration,
  working directory, or acknowledgement rules.

Acceptance gate:

- Disposable identity completes controlled Bob exchanges end to end.
- Killing the adapter never kills or wedges the coordinator.
- No approval waits indefinitely in headless execution.

### Slice 9: production canary

Run at least 100 Bob round trips with a disposable identity, including:

- normal requests and replies;
- bursts and multiple profiles;
- long-poll reconnect and cursor expiry;
- server, coordinator, helper, MCP, and Codex restarts;
- every claim/reply/ack crash boundary;
- reply conflict with different regenerated text;
- five consecutive failures and operator quarantine/recovery;
- claim expiry and competing reclaim; and
- read-only resume versus workspace-write fresh thread.

Promotion gates:

- Zero lost deliveries.
- Zero duplicate replies.
- Zero concurrent owners for a profile.
- p95 commit-to-first-list below five seconds.
- Resource and invocation budgets met.
- No secret or peer text leakage in forbidden surfaces.
- Manual rollback to `mcp-interactive` and `worker` demonstrated.

### Slice 10: optional harness adapters

Implement only after Slice 9 passes:

1. Hermes via `coordinator-delivery-v1` and the existing stdin runner.
2. Grok API via a reviewed provider adapter and separate Keychain credential.
3. OpenClaw via a fixed agent/session with `--deliver` disabled. Do not ship
   automatic peer text in argv until stdin or protected-file input exists or a
   separate privacy review accepts the exposure.

Every adapter must pass the common ownership, timeout, retry, idempotency,
injection, secret-confinement, and process-cleanup conformance suite.

## Pull-request sequence

Keep changes reviewable and deployable in this order:

1. Server ADR, flags, and baseline metrics.
2. Server watch grant.
3. Server cursor and long-poll endpoint.
4. Server lease schema and disabled implementation.
5. Server lease enforcement and reclaim.
6. Public `mesh` CLI facade and `triangle-client` compatibility shim.
7. Client delivery-mode schema and lifecycle.
8. Client transaction store and policy evaluator.
9. Client MCP rewriting state machine.
10. Client wake listener and shared scheduler.
11. Client Codex SDK subprocess adapter.
12. Cross-repository E2E and canary tooling.
13. Hermes, then Grok API, then OpenClaw adapters.

Do not combine server schema, proxy state machine, and SDK adapter into one pull
request. Each changes a different trust or recovery boundary.

## Verification commands

Use the repository-native suites after focused tests:

```text
# the-triangle
npm test

# triangle-client
npm --prefix packages/agent-worker test
swift test --package-path packages/macos-mailbox-helper
```

Also run the signed-helper installation smoke test and the controlled Bob E2E
from a clean installed artifact, not only from source checkouts.

## Deployment order

1. Deploy server schema and disabled flags.
2. Deploy watch grant and long poll, still allowlisted to test installations.
3. Deploy lease writes, then lease enforcement after observing compatibility.
4. Release and reinstall the signed Triangle Client helper/runtime bundle and
   public `mesh` CLI.
5. Enable one disposable event-driven profile.
6. Complete the canary and observe it for at least one full idle/reconnect cycle.
7. Expand by explicit installation allowlist, then opt-in user flag.

## Rollback

- Disable new server grants or wake responses without deleting durable mailbox
  state.
- Disable lease reclaim while retaining added columns.
- Disable Codex activation before changing a profile's delivery owner.
- Prove the wake listener absent, then transactionally restore
  `mcp-interactive` or `worker`.
- Preserve open/quarantined transaction records for diagnosis; never delete
  them as part of automatic rollback.
- Roll back client and server independently because every server change is
  additive and old clients remain supported.

## Definition of done

The feature is done only when:

- the accepted design's verification matrix is automated;
- the clean-install Bob canary passes all required fault boundaries;
- production metrics meet latency and resource budgets;
- the security review signs off on watch grants and the stateful Swift proxy;
- operational documentation covers enable, status, stuck transactions,
  quarantine, retry, rollback, and the consolidated `mesh` command surface;
- clean-machine onboarding and routine operation require no direct invocation
  of `triangle-client` or `triangle-mailbox`; and
- the server and client commits, installed artifact versions, and production
  deployment IDs are recorded together in the release note.

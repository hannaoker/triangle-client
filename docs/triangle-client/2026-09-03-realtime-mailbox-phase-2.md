# Realtime mailbox Phase 2 - listener and scheduler

Status: Complete

Updated: 2026-09-12

Source design Phase 2 / implementation Slice 5 (ownership) + Slice 7 (listener).

## Product priority

- Agent harness integration (Codex, Hermes, ...) is crucial.
- Interactive Codex uses the shared App Server track
  ([handoff](codex-desktop-wake-handoff.md)); that track is **separate** from
  Phase 2 completion.
- Autonomous Codex SDK subprocess (design Phase 3 / Slice 8) is **optional**
  and is not required to close Phase 2.
- Trusted transaction proxy (Slice 6) is **not** part of Phase 2 Complete, but
  remains a hard gate before production harness claim/reply/ack paths.


See the shared completion bar:
[2026-09-05-realtime-mailbox-phase-1-2-completion-criteria.md](2026-09-05-realtime-mailbox-phase-1-2-completion-criteria.md).

## Delivered

- `event-driven` delivery mode in Swift `DeliveryMode`
- Event-driven profiles stay out of worker `instances` (wake ownership is separate)
- Registry allowlist accepts `event-driven`
- Node `wake-client.mjs`: cursor store, coalesce, resync handling, startup reconcile
- Node `profile-scheduler.mjs`: single-flight, dirty-after-turn, shared gate, fake harness
  (still injectable for soak) and **real mailbox harness** (`createMailboxHarness`)
- Real mailbox harness wires scheduler preflight/drain to `mailbox-client.mjs`
  `listUnread` / `completeAndAcknowledge` (claim → reason → ack/reconcile), using
  ungated runners while the scheduler holds the shared `maxConcurrentReasoners` gate
- Bootstrap `eventWake.drains`: per-profile mailbox + runner credentials for self-serve
  drain; wake `profiles` remain secret-free `{ instanceId, agentId }` membership
- Atomic on-disk wake cursor store (`createAtomicFileCursorStore`) with restart recovery tests
- Signed MESH watch-grant transport through the macOS credential helper:
  - Swift `MeshWatchClient` + `WatchGrantService` for create / join / finalize /
    revoke / held poll against MESH Phase 1 routes
  - Keychain store `dev.thetriangle.mesh.mailbox-watch` (installation-scoped;
    fails closed when Keychain is unavailable)
  - Secret-free `watch-status` / ensure / revoke operator JSON; credentials never
    printed
  - Helper CLI boundary: `triangle-mailbox watch-poll --installation … --cursor …`
  - Node `helper-watch-transport.mjs` adapter for the injected wake-client transport
- Supervisor event-driven wake launch (prototype):
  - Swift `ClientSupervisor` enumerates `participatesInEventDrivenWake` profiles
  - Durable installation id under Application Support (`client/installation.json`)
  - Bootstrap `eventWake` section: installation id, helper path, atomic cursor path,
    actor profile, ensure-before-watch, secret-free `{ instanceId, agentId }` profiles,
    plus matching `drains` for mailbox claim/ack
  - Node coordinator launches one multiplexed wake runtime beside worker loops
  - Shared reasoning gate with worker loops; helper `watch-ensure` preflight before
    held poll (fail closed if helper / Keychain / grant missing)
  - `mcp-interactive` remains omitted from worker instances and eventWake membership
- Focused Swift ClientSupervisor contract cases and Node supervisor / helper-transport /
  mailbox-harness tests
- Richer grant lifecycle operator UX: secret-free `watch-status` now includes
  `memberCount`, `listenerReady`, and bounded `operatorAction` next step
  (ensure / replace / unlock Keychain); contracts cover finalized + missing
- Linux verification suite `packages/agent-worker/test/phase2-verification.test.mjs`:
  helper ensure + durable cursor restart resume; reconnect-storm admission limit;
  crash after claim before ack; crash after generation before ack (same-claim
  reclaim, no regenerate when reply is durable); short fake-harness soak slice
- Accelerated soak harness `scripts/soak-fake-wake.mjs` (`--cycles` / `--hours 24`)
  plus `npm run soak:fake-wake` in `packages/agent-worker`

### Verification evidence recorded (2026-09-11, Linux Node v22.14.0)

Previously promoted to **Release Candidate** after implementation, focused
recovery checks, full Node suite, bounded-memory stress, and Darwin helper
suite. Wall-clock 24-hour soak was later reported green (2026-09-12); status
is now **Complete**.

```sh
cd packages/agent-worker && npm test
# 153 tests, 145 pass, 8 skip (Darwin-only), 0 fail

cd packages/agent-worker && npm run test:triangle-client
# 139 tests, 131 pass, 8 skip, 0 fail

node --test packages/agent-worker/test/phase2-verification.test.mjs
# 5/5 pass

node scripts/soak-fake-wake.mjs --cycles 2000
# submitted 2000, drainCount 240, peakConcurrentReasoners 1,
# maxConcurrentReasoners 2, duplicateDrains 0
```



### Wall-clock soak evidence (2026-09-12, America/Los_Angeles)

Operator-reported wall-clock 24-hour fake-harness soak completed with **no
issues found** (no lost wakes, duplicate drains, or shared-gate violations
reported). Command used for the wall soak:

```sh
node scripts/soak-fake-wake.mjs --hours 24
```

Phase 2 is therefore **Complete** for durable wake and scheduling only.
Trusted transaction proxy (Slice 6), interactive App Server harness wiring,
Bob canary, and optional autonomous Codex SDK remain out of this claim.

Swift helper WatchGrant / ClientSupervisor contracts still require macOS:

```sh
cd packages/macos-mailbox-helper && bash scripts/test-host.sh
```

## Remaining exclusions (not blockers for Complete)

- Grok/Cursor interactive profiles remain excluded (enforced; keep excluded)

Wall-clock 24-hour soak evidence is recorded below under Verification evidence.

## Explicitly out of Phase 2 Complete

- Trusted Swift transaction proxy (hard gate before production Hermes /
  coordinator-delivery claim/reply/ack)
- Optional autonomous Codex SDK adapter
- Wakeable Grok/Cursor UI sessions
- Claiming interactive App Server / Bob canary work as Phase 2 evidence

## Completion statement (2026-09-12)

> Phase 2 is complete: event-driven ownership, signed watch-grant transport,
> durable wake cursor recovery, supervisor wake launch, real mailbox harness
> with shared reasoning gate, reconnect/crash gates, and wall-clock 24-hour
> fake-harness soak evidence are recorded. "Complete" means durable wake and
> scheduling only. Interactive Codex App Server harness wiring, Hermes / other
> harness adapters, trusted transaction-proxy work, Bob canary, and optional
> autonomous Codex SDK remain out of scope for this claim.

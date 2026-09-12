# Realtime mailbox Phase 1 / Phase 2 completion criteria

Updated: 2026-09-12 (America/Los_Angeles)

This note records the agreed bar for renaming Phase 1 and Phase 2 from
prototype / implementation-in-progress to **Complete**. Phase 1 and Phase 2
now meet that bar for durable wake and scheduling only. Post–Phase 2 priority
#1 is Shared Codex App Server integration
([handoff](codex-desktop-wake-handoff.md)).

## Product priority (binding)

- **Agent harness integration is crucial** (Codex, Hermes, and other reviewed
  harnesses). Interactive Codex uses the shared App Server + MESH listener
  track documented in `codex-desktop-wake-handoff.md`.
- **Autonomous Codex SDK subprocess (design Phase 3 / Slice 8) is optional.**
  It is not a gate for Phase 1/2 completion and is not required before harness
  integration work.
- **Trusted Swift transaction proxy (Slice 6)** is out of Phase 1/2 scope, but
  it remains a hard gate before production Hermes / coordinator-delivery harness
  paths - do not bury it under optional Phase 3 SDK language.
- Keep Grok / Cursor interactive UI sessions excluded unless an official
  wakeable automation API exists.

## Current status (do not overclaim)

| Phase | Current status | Why |
| --- | --- | --- |
| Phase 1 (MESH watch grants, held poll, claim leases) | **Complete** | Adversarial regressions landed; focused five-file suite 86/86 and full mesh suite 1094/1094 recorded on tip `ecdf619` (PR #4 merge), Node v22.22.3 on Zhenyus-Mini |
| Phase 2 (listener + scheduler + production wiring) | **Complete** | Implementation + operator-reported wall 24h soak green (2026-09-12); App Server / Slice 6 / Bob / SDK remain separate |

### Phase 1 evidence (2026-09-05)

Recorded on **Zhenyus-Mini**, **Node v22.22.3**, tip **`ecdf619`** on
`codex/the-triangle` (PR #4 merge). Adversarial coverage lives in
`mesh/tests/mailbox-watch.test.mjs` and
`mesh/tests/mailbox-d1.test.mjs`.

Focused five-file mailbox bundle (from `mesh/`):

```bash
node --test tests/mailbox-watch.test.mjs tests/mailbox-d1.test.mjs \
  tests/mailbox-api.test.mjs tests/mailbox-mcp.test.mjs tests/mailbox-e2e.test.mjs
```

Result: **86/86 pass** (fail 0 / todo 0).

Full mesh suite (build + `tests/*.test.*`):

```bash
npm test
```

Result: **1094/1094 pass**, exit 0, ~22s wall.

External deployment, production migration, and canary activation remain
separately authorized and are **not** implied by Phase 1 Complete.

## Close Phase 1 verification gaps

**Done** (recorded in Phase 1 evidence above):

1. Concurrent `globalLimit` + N held-poll admission test.
2. Mixed-validity batch acknowledgement test proving zero partial updates.
3. Acknowledgement-versus-reclaim race test.
4. Run the full MESH mailbox / API / MCP / end-to-end suites green.

Also keep the existing Phase 1 proof matrix in
`2026-09-03-realtime-mailbox-phase-1.md` satisfied.

## Finish Phase 2 production wiring

**Done** for Phase 2 Complete (durable wake/scheduling):

1. Signed MESH watch-grant transport through the macOS credential helper.
2. Atomic on-disk wake cursor with restart recovery tests.
3. `event-driven` profiles in the private supervisor bootstrap.
4. Wake listener launched alongside worker loops.
5. Scheduler preflight/drain connected to the real mailbox client and shared
   reasoning gate.
6. Grant creation, renewal/replacement, revocation, and operator-visible
   status (`watch-status` / ensure / revoke).
7. Grok/Cursor interactive profiles kept excluded.

## Clear verification gates

Recorded for Phase 2 Complete:

1. Helper suite on Darwin (Apple's Testing module) — required on Mac hosts.
2. Node suite green on Linux for triangle-client focused paths.
3. Reconnect-storm / crash-boundary coverage on the Phase 2 Complete gates
   branch (PR #5) where applicable.
4. Operator-reported wall-clock 24-hour fake-harness soak green (2026-09-12).

Post–Phase 2 App Server scaffold and Bob canary work are **separate** from
Phase 2 Complete. Do not use App Server unit tests as Phase 2 evidence, and do
not reopen Phase 2 when App Server gaps remain.

## Status after evidence

Phase 1 and Phase 2 statuses are **Complete** for durable wake and scheduling.
Combined "complete" does **not** cover the trusted transaction proxy (Slice 6),
optional autonomous Codex SDK adapter, wakeable Grok/Cursor UI sessions, or
Bob canary / full App Server production attachment.

App Server first increment: see `codex-desktop-wake-handoff.md`.

## Defensible completion statements

### Phase 1 only (in force)

> Phase 1 is complete: installation-scoped watch grants, resumable held
> polling, claim leases with atomic reclaim and claim-bound acknowledgement,
> and adversarial admission / batch-ack / ack-vs-reclaim regressions have
> passed the focused five-file suite (86/86) and full mesh `npm test`
> (1094/1094) on tip `ecdf619` (Node v22.22.3, Zhenyus-Mini). "Complete"
> means MESH server contracts and verification evidence only. External
> deploy/canary, Interactive Codex App Server harness wiring, Hermes / other
> harness adapters, trusted transaction-proxy work, and optional autonomous
> Codex SDK subprocess work remain out of scope for this claim.

### Phase 1 + Phase 2 (in force as of 2026-09-12)

> Phase 1 and Phase 2 are complete: claim leases, resumable held polling,
> atomic admission and acknowledgement, persisted cursor recovery, production
> watch transport, supervisor integration, event-driven profile scheduling,
> and wall-clock 24-hour fake-harness soak evidence. "Complete" means durable
> wake and scheduling only. Interactive Codex App Server harness wiring and
> Hermes / other harness adapters are tracked separately. Trusted
> transaction-proxy work remains a harness production gate. Autonomous Codex
> SDK subprocess work is optional and out of scope for this claim.

## Related docs

- `/Users/zhenyuhou/Projects/The Triangle/the-triangle/docs/plans/2026-09-03-realtime-mailbox-phase-1.md` (MESH server)
- `2026-09-03-realtime-mailbox-phase-2.md`
- `codex-desktop-wake-handoff.md`
- Drive: Realtime Mailbox Delivery Design.md / Implementation Plan.md

# Realtime mailbox Phase 1 / Phase 2 completion criteria

Updated: 2026-09-05 (America/Los_Angeles)

This note records the agreed bar for renaming Phase 1 and Phase 2 from
prototype / implementation-in-progress to **Complete**. Do not flip those
status lines until the evidence below exists.

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
| Phase 1 (MESH watch grants, held poll, claim leases) | Implementation may be largely present in source | Missing adversarial regression tests and a recorded full-suite pass |
| Phase 2 (listener + scheduler + production wiring) | Implemented in source (**prototype**) | Runtime is not production-wired through the signed helper / supervisor |

## Close Phase 1 verification gaps

Before marking Phase 1 complete:

1. Concurrent `globalLimit` + N held-poll admission test.
2. Mixed-validity batch acknowledgement test proving zero partial updates.
3. Acknowledgement-versus-reclaim race test.
4. Run the full MESH mailbox / API / MCP / end-to-end suites green.

Also keep the existing Phase 1 proof matrix in
`2026-09-03-realtime-mailbox-phase-1.md` satisfied.

## Finish Phase 2 production wiring

Before marking Phase 2 complete:

1. Implement the signed MESH watch-grant transport through the macOS credential
   helper.
2. Persist the wake cursor atomically on disk and verify restart recovery.
3. Include `event-driven` profiles in the private supervisor bootstrap.
4. Launch the wake listener alongside worker loops.
5. Connect scheduler preflight/drain operations to the real mailbox client and
   shared reasoning gate.
6. Implement grant creation, renewal/replacement, revocation, and
   operator-visible status.
7. Keep Grok/Cursor interactive profiles excluded.

## Clear verification gates

1. Install/use a Swift toolchain containing Apple's Testing module and pass the
   helper suite.
2. Fix any unrelated README / contract failures so the Node suite is fully green.
3. Run reconnect-storm tests at the configured global connection limit.
4. Run crash/restart tests at these boundaries:
   - before cursor persistence,
   - after cursor persistence but before drain,
   - after claim but before acknowledgement,
   - after generation but before acknowledgement.
5. Complete the planned 24-hour fake-harness soak with no lost wakes, duplicate
   reasoning turns, or cap violations.

Opt-in App Server / Bob canary experiments may continue while labeled as
**not Phase 2 complete**; do not block those experiments on soak, and do not
use them as evidence that Phase 2 is complete.

## Update status only after evidence exists

When the gates pass:

1. Change Phase 2 `Status: Implemented in source (prototype)` to
   `Status: Complete` (and the matching Phase 1 status line).
2. Move every applicable "Not yet" item into "Delivered."
3. Record exact passing commands, test counts, soak duration, tested
   configuration, and remaining exclusions.
4. State explicitly that "complete" covers **durable wake and scheduling** -
   not the trusted transaction proxy, optional autonomous Codex SDK adapter, or
   wakeable Grok/Cursor UI sessions.

## Defensible completion statement (use only after evidence)

> Phase 1 and Phase 2 are complete: claim leases, resumable held polling,
> atomic admission and acknowledgement, persisted cursor recovery, production
> watch transport, supervisor integration, and event-driven profile scheduling
> have passed focused, integration, crash-recovery, reconnect-storm, and
> 24-hour soak tests. "Complete" means durable wake and scheduling only.
> Interactive Codex App Server harness wiring and Hermes / other harness
> adapters are tracked separately. Trusted transaction-proxy work remains a
> harness production gate. Autonomous Codex SDK subprocess work is optional and
> out of scope for this claim.

## Related docs

- `/Users/zhenyuhou/Projects/The Triangle/the-triangle/docs/plans/2026-09-03-realtime-mailbox-phase-1.md` (MESH server)
- `2026-09-03-realtime-mailbox-phase-2.md`
- `codex-desktop-wake-handoff.md`
- Drive: Realtime Mailbox Delivery Design.md / Implementation Plan.md

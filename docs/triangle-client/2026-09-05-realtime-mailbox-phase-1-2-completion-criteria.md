# Realtime mailbox Phase 1 / Phase 2 completion criteria

Updated: 2026-09-11 (America/Los_Angeles)

This note records the agreed bar for renaming Phase 1 and Phase 2 from
prototype / implementation-in-progress to **Complete**. Phase 1 now meets that
bar with recorded suite evidence below. Do not flip Phase 2 to Complete until
its production-wiring and verification gates pass.

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
| Phase 2 (listener + scheduler + production wiring) | Implemented in source (**prototype**) | Linux Node gates + accelerated soak recorded; wall 24h soak and Darwin helper suite still required before Complete |

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
   helper suite. (**Still open** on Darwin host.)
2. Fix any unrelated README / contract failures so the Node suite is fully green.
   (**Done** on tip of this PR: `packages/agent-worker` `npm test` 153/145 pass /
   8 Darwin skips / 0 fail, Node v22.14.0.)
3. Run reconnect-storm tests at the configured global connection limit.
   (**Done** in `phase2-verification.test.mjs`.)
4. Run crash/restart tests at these boundaries:
   - before cursor persistence,
   - after cursor persistence but before drain,
   - after claim but before acknowledgement,
   - after generation but before acknowledgement.
   (**Done** across `wake-scheduler.test.mjs` + `phase2-verification.test.mjs`;
   claim/generation reclaim is same-process durable-claim ownership.)
5. Complete the planned 24-hour fake-harness soak with no lost wakes, duplicate
   reasoning turns, or cap violations.
   (**Harness ready:** `scripts/soak-fake-wake.mjs`; accelerated `--cycles 2000`
   recorded green. **Wall `--hours 24` still required** before Complete.)

Opt-in App Server / Bob canary experiments may continue while labeled as
**not Phase 2 complete**; do not block those experiments on soak, and do not
use them as evidence that Phase 2 is complete.

## Update status only after evidence exists

Phase 1 status is already **Complete** with the recorded suite evidence above.

When Phase 2 gates pass:

1. Change Phase 2 `Status: Implemented in source (prototype)` to
   `Status: Complete`.
2. Move every applicable "Not yet" item into "Delivered."
3. Record exact passing commands, test counts, soak duration, tested
   configuration, and remaining exclusions.
4. State explicitly that combined "complete" covers **durable wake and
   scheduling** - not the trusted transaction proxy, optional autonomous Codex
   SDK adapter, or wakeable Grok/Cursor UI sessions.

## Defensible completion statements

### Phase 1 only (in force)

> Phase 1 is complete: installation-scoped watch grants, resumable held
> polling, claim leases with atomic reclaim and claim-bound acknowledgement,
> and adversarial admission / batch-ack / ack-vs-reclaim regressions have
> passed the focused five-file suite (86/86) and full mesh `npm test`
> (1094/1094) on tip `ecdf619` (Node v22.22.3, Zhenyus-Mini). "Complete"
> means MESH server contracts and verification evidence only. External
> deploy/canary, Phase 2 production wiring, Interactive Codex App Server
> harness wiring, Hermes / other harness adapters, trusted transaction-proxy
> work, and optional autonomous Codex SDK subprocess work remain out of scope
> for this claim.

### Phase 1 + Phase 2 (use only after Phase 2 evidence)

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

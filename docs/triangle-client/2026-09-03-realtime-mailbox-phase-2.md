# Realtime mailbox Phase 2 - listener and scheduler

Status: Implemented in source (prototype)

Updated: 2026-09-05

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

## Delivered (prototype)

- `event-driven` delivery mode in Swift `DeliveryMode`
- Omitted from worker coordinator bootstrap with `delivery_mode_event_driven`
- Registry allowlist accepts `event-driven`
- Node `wake-client.mjs`: cursor store, coalesce, resync handling, startup reconcile
- Node `profile-scheduler.mjs`: single-flight, dirty-after-turn, shared gate, fake harness
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
- Focused Swift watch-grant contract cases and Node `helper-watch-transport.test.mjs`

## Not yet (blocks Status: Complete)

Production wiring:

- Wire atomic wake cursor into supervisor/production launch (store landed; end-to-end
  restart recovery with helper grant still open)
- `event-driven` profiles in the private supervisor bootstrap
- Wake listener launched alongside worker loops (helper transport exists; supervisor
  does not start it yet)
- Scheduler preflight/drain connected to the real mailbox client and shared
  reasoning gate
- Operator UX for grant lifecycle beyond the thin CLI hooks (ensure / status /
  revoke / poll)
- Grok/Cursor interactive profiles remain excluded

Verification gates:

- Swift toolchain with Apple's Testing module; helper suite green
- Node suite fully green (including unrelated README/contract fixes)
- Reconnect-storm tests at the configured global connection limit
- Crash/restart tests: before cursor persistence; after persistence before
  drain; after claim before ack; after generation before ack
- 24-hour fake-harness soak with no lost wakes, duplicate reasoning turns, or
  cap violations

## Explicitly out of Phase 2 Complete

- Trusted Swift transaction proxy
- Optional autonomous Codex SDK adapter
- Wakeable Grok/Cursor UI sessions
- Claiming interactive App Server / Bob canary work as Phase 2 evidence

## When Complete

Only after the completion-criteria evidence is recorded, change this file's
status to `Status: Complete`, move applicable "Not yet" items into Delivered,
and use the defensible completion statement from the criteria note.

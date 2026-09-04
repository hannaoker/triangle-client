# Realtime mailbox Phase 2 — listener and scheduler

Status: Implemented in source (prototype)

Source design Phase 2 / implementation Slice 5 (ownership) + Slice 7 (listener).

## Delivered

- `event-driven` delivery mode in Swift `DeliveryMode`
- Omitted from worker coordinator bootstrap with `delivery_mode_event_driven`
- Registry allowlist accepts `event-driven`
- Node `wake-client.mjs`: cursor store, coalesce, resync handling, startup reconcile
- Node `profile-scheduler.mjs`: single-flight, dirty-after-turn, shared gate, fake harness
- Focused `wake-scheduler.test.mjs` coverage

## Not yet

- Production MESH watch-grant transport wired through signed helper DPoP
- Bootstrap documents that launch wake runtime beside worker loops
- Slice 6 trusted transaction proxy
- Slice 8 Codex SDK adapter
- 24-hour fake-harness soak

Activation remains behind operator mode selection and later transport wiring.

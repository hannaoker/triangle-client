# Triangle Client

This is the canonical source repository for the agent side of The Triangle:
local mailbox runtimes, macOS Keychain identity custody, runtime adapters, the
`mesh` operator CLI, the A2A gateway SDK, and reference agent gateways.

The MESH core server and protocol source live separately in
[`hannaoker/the-triangle`](https://github.com/hannaoker/the-triangle).

See the [Triangle Client guide](docs/triangle-client/README.md) for supported
modes, installation, enrollment, lifecycle, and security boundaries.

## Realtime mailbox

Event-driven wake (Phase 2 **Complete** for durable wake/scheduling) and
interactive Codex desktop App Server handoff docs:

- [Phase 2 plan](docs/triangle-client/2026-09-03-realtime-mailbox-phase-2.md)
- [Phase 1/2 completion criteria](docs/triangle-client/2026-09-05-realtime-mailbox-phase-1-2-completion-criteria.md)
- [Codex desktop wake handoff](docs/triangle-client/codex-desktop-wake-handoff.md) (App Server track)
- [Shared Codex server prototype](docs/triangle-client/shared-codex-server-prototype.md)

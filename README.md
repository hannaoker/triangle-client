# Triangle Client

This is the canonical source repository for the agent side of The Triangle:
local mailbox runtimes, macOS Keychain identity custody, runtime adapters, the
`mesh` operator CLI, the A2A gateway SDK, and reference agent gateways.

The MESH core server and protocol source live separately in
[`hannaoker/the-triangle`](https://github.com/hannaoker/the-triangle).

See the [Triangle Client guide](docs/triangle-client/README.md) for supported
modes, installation, enrollment, lifecycle, and security boundaries.

The **macOS mailbox credential helper** (`triangle-mailbox`) is the Keychain
custodian for durable mailbox identity and installation-scoped watch grants.

## Realtime mailbox

Event-driven wake and interactive Codex desktop handoff docs:

- [Phase 2 plan](docs/triangle-client/2026-09-03-realtime-mailbox-phase-2.md)
- [Phase 1/2 completion criteria](docs/triangle-client/2026-09-05-realtime-mailbox-phase-1-2-completion-criteria.md)
- [Codex desktop wake handoff](docs/triangle-client/codex-desktop-wake-handoff.md)
- [Shared Codex server prototype](docs/triangle-client/shared-codex-server-prototype.md)

### Model-free agent workers

Install the helper, enroll a profile, and prepare a worker runtime without
putting mailbox tokens in shell history or env files:

```sh
./scripts/install-macos-mailbox-helper.sh
# enroll once: triangle-mailbox enroll --profile PROFILE --origin ORIGIN < admission.json
triangle-mailbox status --profile PROFILE
triangle-mailbox mcp --profile PROFILE
triangle-worker-service.sh prepare-runtime codex
export TRIANGLE_MAILBOX_PROFILE=PROFILE
triangle-worker-service.sh install codex
```

`VerifiedCredentialGate` refuses to launch unless Keychain verification
succeeds. Workers receive `CODEX_AGENT_ID` / `HERMES_AGENT_ID` from the helper
injection path, not from ambient env files.

#### Explicit legacy rollback only

For emergency recovery only, use the documented explicit legacy rollback to a
mode-`0600` credential file. Normal operation has **no silent fallback** to
file credentials.

Workers currently follow Mac availability.

### Watch grants (event-driven)

```sh
triangle-mailbox watch-ensure --installation inst_… --actor-profile PROFILE
triangle-mailbox watch-status --installation inst_…
triangle-mailbox watch-revoke --installation inst_…
```

`watch-status` is secret-free and includes an `operatorAction` next step
(ensure / replace / revoke / unlock Keychain).

## Deployment

Keychain is the authoritative credential store on Mac hosts. LaunchAgents invoke
only the signed helper; the helper internally injects verified workload material
through `VerifiedCredentialGate`. Do not place `mesh_` tokens in LaunchAgent
plists or operator env files.

## Security model

Fail closed when Keychain, helper signature, or watch-grant membership is
unavailable. Never log watch credentials or mailbox tokens. Interactive
`mcp-interactive` profiles stay out of event-driven wake membership.

## Testing and builds

```sh
cd packages/agent-worker
npm run test:triangle-client
```

Swift helper contracts require macOS with Apple's Testing module:

```sh
cd packages/macos-mailbox-helper
bash scripts/test-host.sh
```

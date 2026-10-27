# Triangle Client

This is the canonical source repository for the agent side of The Triangle:
local mailbox runtimes, the `triangle` owner CLI (permissions v1), runtime
adapters, the `mesh` operator CLI, the A2A gateway SDK, and reference agent gateways.

The MESH core server and protocol source live separately in
[`hannaoker/the-triangle`](https://github.com/hannaoker/the-triangle).

See the [Triangle Client guide](docs/triangle-client/README.md) for supported
modes, installation, profile binding, lifecycle, and security boundaries.

**Start here:** [packaged installation and guided setup](docs/triangle-client/quickstart.md).
The macOS package includes the CLI, Node, and background service; `triangle setup`
handles invitation enrollment and harness binding. MESH credentials use private
files, with no Apple Keychain dependency. [Linux CLI packages](docs/triangle-client/linux-install.md) support invitation enrollment and owner controls. Managed Linux releases also include a durable Codex/systemd runtime; they do not provide the macOS multi-profile supervisor or desktop chat adapters.

**Release install on another Mac:** [release bundle](docs/triangle-client/release-bundle.md)
(signing, layout, upgrade/uninstall), the
[E2E operator runbook](docs/triangle-client/e2e-operator-runbook.md)
(install → bind → runtime → event-driven watch), and
[multi-Mac MESH deploy](docs/triangle-client/multi-mac-mesh-deploy.md)
(second-Mac readiness; do not clone Mini). Preflight:
`./scripts/release/check-release-readiness.sh --mode docs`.

The **macOS mailbox credential helper** (`triangle-mailbox`) is the local
runtime host for agent identities created by the `triangle` CLI: a helper
profile points at the agent's `0600` workload key file, and the helper proves
the identity with short-lived DPoP workload tokens. It also custodies
installation-scoped watch grants.

## Same-device messaging

[Installed local messaging](docs/triangle-client/installed-local-messaging.md) connects configured workers and owner-enabled chats through the supervisor's local socket and journal. This path bypasses the MESH server and uses local identities; discovery alone grants no messaging permissions. Grok is owner-paired and pull-only. Optional attached-chat provenance and reply pinning require runtime v14 and remain disabled by default.

## Realtime mailbox

Event-driven wake (Phase 2 **Complete** for durable wake/scheduling) and
historical interactive Codex Shared App Server handoff docs. For current desktop chat messaging, use the same-device guide above; do not resume a desktop-owned chat in a second App Server:

- [Phase 2 plan](docs/triangle-client/2026-09-03-realtime-mailbox-phase-2.md)
- [Phase 1/2 completion criteria](docs/triangle-client/2026-09-05-realtime-mailbox-phase-1-2-completion-criteria.md)
- [Codex desktop wake handoff](docs/triangle-client/codex-desktop-wake-handoff.md) (App Server track)
- [Shared Codex server prototype](docs/triangle-client/shared-codex-server-prototype.md)

### Model-free agent workers

For source-build development, install the helper, bind a profile, and prepare a worker
runtime without putting key material in shell history or env files:

```sh
./scripts/install-macos-mailbox-helper.sh
triangle agent add --handle HANDLE        # owner CLI; writes agents/<agent_id>/workload-key.json
triangle-mailbox bind --profile PROFILE --key-file "$TRIANGLE_HOME/agents/<agent_id>/workload-key.json"
triangle-mailbox status --profile PROFILE   # verified identity + current permissions
triangle-mailbox mcp --profile PROFILE
triangle-worker-service.sh prepare-runtime codex
export TRIANGLE_MAILBOX_PROFILE=PROFILE
triangle-worker-service.sh install codex
```

`VerifiedCredentialGate` refuses to launch unless the agent verifies live
against `/api/v1/agents/me` (paused or refused agents fail closed). Workers
receive `CODEX_AGENT_ID` / `HERMES_AGENT_ID` and `TRIANGLE_WORKLOAD_KEY_FILE`
from the helper injection path, not from ambient env files.

#### Explicit legacy rollback only

Permissions v1 has no backward compatibility: there is no `mesh_` bearer and
no explicit legacy rollback to a mode-`0600` credential file. Roll back by
reinstalling a previously reviewed release as a whole. If the reply-identity policy exists, runtime v14 is the minimum even with new pin creation disabled. Do not remove that floor or send pinned work through an older reader to force a rollback.

Workers currently follow Mac availability.

### Watch grants (event-driven)

```sh
triangle-mailbox watch-ensure --installation inst_… --actor-profile PROFILE
triangle-mailbox watch-status --installation inst_…
triangle-mailbox watch-revoke --installation inst_…
```

`watch-status` is secret-free and includes an `operatorAction` next step
(ensure / replace / revoke / unlock watch-grant storage). Failed `watch-ensure` emits
secret-free stderr JSON with `code`, `gate`, and `operatorAction`. Re-run
`./scripts/install-macos-mailbox-helper.sh` from current main if
`watch-ensure --help` returns `local_validation_failed` (Sep-2-era binary).
`mcp-interactive` profiles cannot join watch membership.

## Deployment

`triangle` custody (`<TRIANGLE_HOME>/agents/<agent_id>/workload-key.json`,
`0600`) is the authoritative identity store on Mac hosts. LaunchAgents invoke
only the signed helper; the helper internally injects verified workload material
through `VerifiedCredentialGate`. Do not place keys or tokens in LaunchAgent
plists or operator env files.

## Security model

Fail closed when the agent key, live identity verification, helper signature,
or watch-grant membership is unavailable. Never log watch credentials or mailbox tokens. Interactive
`mcp-interactive` profiles stay out of event-driven wake membership.

## Local operator console

Scaffolded read-only status UI (CLI/JSON) for helper, profiles, instances, and
watch grants — without dumping Application Support credential material:

```sh
node packages/client-console/src/cli.mjs status --human
npm run test:console
```

See [packages/client-console/README.md](packages/client-console/README.md) and
the [Triangle Client guide](docs/triangle-client/README.md#local-operator-console-scaffold).

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

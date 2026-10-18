# Hermes mailbox worker

This client consumes inbound work from the Hermes identity's durable MESH
mailbox. The public A2A gateway remains a compatibility adapter for outbound
A2A and allowlisted MESH actions. The gateway does not call an LLM or contain
provider credentials.

Permissions v1: the agent is created by its owner with `triangle agent add`
(or at `triangle join`), and its workload key lives in triangle custody at
`agents/<agent_id>/workload-key.json` (0600) beside `agent.json`. There is no
permanent `mesh_` token, and v1 no longer stores agent credentials in the
macOS Keychain: the key lives only in that v1 key file. The macOS `triangle-mailbox` helper reads only that
agent's workload credential, never the owner key. The LaunchAgent
invokes `triangle-mailbox run-worker --profile hermes-mailbox-live --worker hermes`;
only that trusted controller receives the credential environment. The tracked
`.env.example` is legacy documentation, not the normal custody path.
At worker launch, the controller injects `MESH_ORIGIN`, `TRIANGLE_WORKLOAD_KEY_FILE`
(the path of that key file), and `HERMES_AGENT_ID`; operators do not persist
those values in a worker environment file. The injected identity is the
canonical MESH form, for example `agent_00000000000000000000000000000000`.

Install the signed helper and Hermes service transactionally:

```sh
./scripts/install-macos-mailbox-helper.sh --install-worker hermes --profile hermes-mailbox-live
```

Public installation requires the Developer ID configuration documented in
[`packages/macos-mailbox-helper/README.md`](../../../packages/macos-mailbox-helper/README.md).
The explicit `--local-ad-hoc` mode is development-only and non-public.

The reasoning process may read the project but cannot modify source, `.git`, or
project `.env*` files. It may write only its dedicated model-state root and the
fixed `~/Library/Caches/The Triangle/agent-worker/hermes` temporary root; ambient
`TMPDIR` is not trusted. It may use provider network access. This deliberately
trusts Hermes with the provider credentials inside its minimal model root—nothing
else belongs there.

macOS `sandbox-exec` uses directory read-data permission for path traversal, so
the reasoning process can observe entry names in exact ancestor directories of
approved roots. This accepted boundary does not grant sibling file contents;
credential contents, unrelated operator files, and project `.env*` contents
remain denied.

Inspect the service and sanitized profile status:

```sh
./scripts/triangle-worker-service.sh status hermes
"$HOME/Library/Application Support/The Triangle/bin/triangle-mailbox" status --profile hermes-mailbox-live
```

The package script deliberately does not load a project `.env` file.
For an explicit outbound compatibility request, put `AGENT_ORIGIN` and
`GATEWAY_INTERNAL_TOKEN` in `worker/.env.local`, then pipe one bounded JSON
operation to `npm run agent-send`. This command does not read the mailbox worker
configuration or accept `MESH_ORIGIN` or `TRIANGLE_WORKLOAD_KEY_FILE` as gateway selectors.

`HERMES_HOME` is Hermes' supported writable configuration/state home and must
be within a model root strictly below `TRIANGLE_MODEL_STATE_BASE`. The runtime
roots above keep the installed wrapper, venv, interpreter distribution, and
editable-package source mapping read-only; the venv must never be included in
`TRIANGLE_MODEL_ROOTS`. The service renderer derives and validates this installed
chain automatically with isolated Python discovery, ignores ambient
`PYTHONPATH`, and makes no provider call while doing so. The model-state base is
fixed to the application-owned path shown above; arbitrary home/config/runtime
roots and symlink aliases are rejected.

The LaunchAgent `dev.thetriangle.hermes.worker` polls its MESH mailbox every 15
seconds while idle and invokes Hermes only after unread work exists. It persists
a reply before acknowledgement and retries only its own durable claim after an
ambiguous failure. The old Hermes cron job `f591d4626cbc` is paused and must not
be resumed while the LaunchAgent is the active consumer.

Only the controller reads the agent's workload key; it exchanges it for
short-lived DPoP-bound access tokens (`agent.read`/`agent.write`), and every
MESH call is subject to the agent's permissions (a refused call reports
`permission_denied` with the permission key, or `agent_paused`). The Hermes
reasoning subprocess receives an explicit minimal environment and never
inherits MESH, database, gateway, or other ambient credentials.

The verified helper commits before the opt-in service transaction begins. If
service install or bootstrap fails, its runtime and LaunchAgent changes roll
back while the safe helper remains installed. For an emergency rollback, stop
the LaunchAgent and restore the prior helper/runtime/plist release. Legacy
mode-`0600` credential files require a separate explicit rollback and are never
selected automatically.

# Triangle mailbox helper and Triangle Client host for macOS

`triangle-mailbox` is the local runtime host for a MESH agent identity
(permissions v1). The identity itself is created and owned by the `triangle`
CLI (`triangle join` / `triangle agent add`), which writes the agent's Ed25519 workload key to
`<TRIANGLE_HOME>/agents/<agent_id>/workload-key.json` (mode `0600`, beside a
secret-free `agent.json`). A helper **profile** is only a `0600` pointer from a
local profile name to that key file
(`~/Library/Application Support/The Triangle/profiles-v1/profile-<hex>.json`); the
helper never registers agents, never stores a static `mesh_` bearer, and has no
Keychain identity path. Every use re-proves the identity with short-lived DPoP
workload tokens against `/api/v1/agents/me`. Chatbot transcripts, project
files, LaunchAgent plists, and reasoning subprocesses are not credential
stores.

## Install

Developer ID signing and notarization are out of scope. Public installs are
ad-hoc signed (`codesign --force --sign -`, identifier `dev.thetriangle.mailbox`,
no entitlements) and use portable file credential custody, because ad-hoc
signatures cannot carry Keychain access-group entitlements:

```sh
./scripts/install-macos-mailbox-helper.sh
```

The public build sets `TRIANGLE_FILE_CUSTODY_REQUIRED`, writes the
`credentials/local/ENABLED` marker, and records `signingMode: public_ad_hoc`
and `credentialCustody: file`. `TRIANGLE_CREDENTIAL_CUSTODY=keychain` is
refused (installer exit 64; helper exit 78), and a public install over an
existing Keychain-custody install is refused (exit 78) unless
`TRIANGLE_ACK_CUSTODY_SWITCH=1` acknowledges the switch. (This custody mode now
governs only installation watch grants; agent identities are always the
`triangle` key files above.) A source tree that
carries `com.apple.quarantine` (browser download) is refused with remediation;
see `scripts/release/check-quarantine.sh`.

The installer release-builds the helper and installs it at the canonical,
application-owned path:

```text
~/Library/Application Support/The Triangle/bin/triangle-mailbox
```

It rejects symlinks, unexpected file types, wrong ownership or permissions,
and signatures that fail strict verification, are not ad-hoc, have the wrong
identifier, carry a certificate authority or team, or embed Keychain
entitlements.
Replacement uses same-filesystem staging, fsync, atomic rename, and rollback.
An existing helper and its manifests are restored byte-for-byte if a later gate
fails.

For development only, an explicit ad-hoc mode is available:

```sh
./scripts/install-macos-mailbox-helper.sh --local-ad-hoc
```

`--local-ad-hoc` is non-public, local testing only. It keeps Keychain storage
for installation watch grants and does not provide a stable application
identity for a distributed Keychain credential.
`TRIANGLE_CREDENTIAL_CUSTODY=file` opts it into file custody.

## Bind a profile to a `triangle` agent

Create the agent with the `triangle` CLI (owner-signed; see
`packages/triangle-cli/README.md`), then point a helper profile at its key
file. Nothing secret crosses argv, stdin, or the environment; the helper opens
the `0600` key file itself:

```sh
triangle agent add --handle codex-mailbox-live --name "Codex Mailbox Live"
HELPER="$HOME/Library/Application Support/The Triangle/bin/triangle-mailbox"
"$HELPER" bind --profile codex-mailbox-live \
  --key-file "$HOME/Library/Application Support/The Triangle/v1/agents/agent_…/workload-key.json"
```

`bind` prints the same fields as `status` (with `status` for the outcome) and
exits non-zero unless the identity verified; nothing is written then. It checks
the key file custody (no-follow regular file owned by you, no
group/other bits, inside `<TRIANGLE_HOME>/agents/<agent_id>/`, matching
`agent.json`), proves the identity with a DPoP workload token against
`/api/v1/agents/me`, and only then writes the pointer. It refuses to replace a
binding that points at a different agent (`identity_mismatch`); run
`"$HELPER" unbind --profile NAME` first. The origin defaults to the agent's
authority (or the `via` deployment in `<TRIANGLE_HOME>/authority.json`);
`--origin https://…` overrides it. There is no show or export operation and no
command that returns key material or a token.

`status` re-verifies and reports the agent's current permissions and revision.
Paused agents fail closed with `agent_paused` (`operatorAction: resume_agent`;
run `triangle agent resume`). A key the server no longer accepts reports
`credential_refused` (`run_triangle_doctor`). Rotate or revoke keys with the
`triangle` CLI; the binding follows the key file path.

## Resume from a new chatbot session

The durable selector is the non-secret profile name:

```sh
"$HOME/Library/Application Support/The Triangle/bin/triangle-mailbox" status --profile codex-mailbox-live
"$HOME/Library/Application Support/The Triangle/bin/triangle-mailbox" mcp --profile codex-mailbox-live
```

## Installation-scoped watch grants (event-driven wake)

Phase 2 wake transport keeps the opaque `mesh_watch_` credential inside the
signed helper Keychain (`dev.thetriangle.mesh.mailbox-watch`). Operator and Node
surfaces never receive the secret.

### Upgrade an existing install

Sep-2-era helpers reject `watch-ensure` as an unknown command
(`local_validation_failed`). Re-run the installer from current `main` so the
Application Support binary includes the Phase 2 watch surface:

```sh
# Public ad-hoc release (file custody):
./scripts/install-macos-mailbox-helper.sh

# Local development / existing Keychain-custody hosts:
./scripts/install-macos-mailbox-helper.sh --local-ad-hoc
```

Confirm the installed helper knows the watch verbs (exit 0, JSON with
`"supported":true` — not `local_validation_failed`):

```sh
HELPER="$HOME/Library/Application Support/The Triangle/bin/triangle-mailbox"
"$HELPER" watch-ensure --help
"$HELPER" watch-poll --help
"$HELPER" watch-status --help
"$HELPER" watch-revoke --help
```

The installer refuses to commit if any of those probes fail. Install metadata at
`~/Library/Application Support/The Triangle/install-manifest/triangle-mailbox-install.json`
includes `cliSurface: ["watch-ensure","watch-poll","watch-status","watch-revoke"]`.

Ad-hoc custody: neither mode can embed Keychain access-group entitlements
(Developer ID is out of scope). Use the public install's file custody for
LaunchAgent custody and durable watch-grant items.

### Operator commands

```sh
HELPER="$HOME/Library/Application Support/The Triangle/bin/triangle-mailbox"
INSTALLATION='inst_YOUR_INSTALLATION_ID'

# Create/join/finalize for event-driven profiles, store the watch credential.
"$HELPER" watch-ensure --installation "$INSTALLATION" --actor-profile codex-mailbox-live

# Secret-free status JSON (grant id, agent ids, state, memberCount,
# listenerReady, and operatorAction next step). Never prints mesh_watch_ secrets.
"$HELPER" watch-status --installation "$INSTALLATION"

# Held poll for the Node wake client (secret-free stdout JSON).
"$HELPER" watch-poll --installation "$INSTALLATION" --cursor 0

# Revoke remotely and delete the local Keychain item.
"$HELPER" watch-revoke --installation "$INSTALLATION"
```

#### Grant expiry and proactive renewal

MESH fixes a watch grant's `expires_at` when it is created (TTL capped at
3600 s; finalize does not extend it). `watch-ensure` and `watch-status` include
`"expiresAt"` (ISO 8601 UTC) when the helper knows it. The helper keeps it in a
secret-free sidecar,
`~/Library/Application Support/The Triangle/client/watch-grant-expiry/<installation>.json`
(0600), keyed by grant id. It is not part of the stored credential record, so an
older helper can still read the credential after a rollback. Grants stored by
older helpers have no sidecar, so `expiresAt` is omitted until the next
`watch-ensure`. The supervisor renews once per installation at about 85 % of the
grant lifetime. When `expiresAt` is missing it falls back to renewing after
MESH rejects the credential (`watch_credential_invalid`).

`mcp-interactive` profiles may join watch membership as **notify-only** members
when an App Server binding matches their instance (so `appServerWake` receives
hints). `grok-bot` profiles may likewise join watch membership as notify members
(and may act as grant actor) when a Grok Bot binding matches. Actors must not be
`mcp-interactive`. Set delivery mode appropriately before `watch-ensure`. If
Keychain is unavailable, watch commands fail closed.

### Interpreting watch-ensure failures

Failed `watch-ensure` writes secret-free JSON to **stderr** (exit 1), not the
opaque legacy `operation_failed` blob. Fields:

| Field | Meaning |
| --- | --- |
| `code` | Machine-readable failure (`workload_key_missing`, `interactive_delivery_excluded`, …) |
| `gate` | Which gate failed: `validation`, `membership`, `workload_auth`, `keychain`, `network`, or `profile` |
| `operatorAction` | Next step (`unlock_login_keychain`, `use_event_driven_profile`, `repair_workload_auth`, …) |
| `operatorNotes` | Short secret-free hints (ad-hoc Keychain limits / file custody, mcp-interactive exclusion, …) |
| `safeToRetry` / `mustNotReregister` | Retry / re-registration policy |

Never expect `mesh_` or `mesh_watch_` material in this JSON. Common Mac checks
after a failure (operator-run on the Mac; not claimed from Linux CI):

1. `"$HELPER" watch-ensure --help` — must be supported (upgrade if not).
2. `"$HELPER" status --profile PROFILE` — profile must verify.
3. Delivery mode: `mcp-interactive` cannot be the watch grant **actor**; it may
   be a notify member with a matching App Server binding. `grok-bot` may notify
   (and may act) with a matching Grok Bot binding. `event-driven` remains the
   preferred actor when available.
4. The profile binding (`profiles-v1/profile-<hex>.json`) must point at an existing
   `0600` `workload-key.json`; the watch grant (`credentials/local/watch/` or the
   `dev.thetriangle.mesh.mailbox-watch` Keychain item) appears only after a
   successful ensure.
5. If `gate` is `keychain` on an ad-hoc helper, move the host to file custody
   (public install); Developer ID is out of scope.
6. If `code` is `agent_paused`, resume the agent with `triangle agent resume`;
   if it is `credential_refused` or `credential_invalid`, run `triangle doctor`
   and rebind. Do **not** remint or move aside watch JSON for these.
7. If `rejectedCode` is `replacement_unauthorized` or `watch_credential_invalid`,
   current helpers retry create without a replacement header and keep the local
   binding until the new grant is stored (so concurrent `watch-poll` is not
   stranded as `credential_missing`). If an older helper still fails, move aside
   `~/Library/Application Support/The Triangle/credentials/local/watch/<installation>.json`
   (file-custody Mini) or delete the mailbox-watch Keychain item, then re-run
   `watch-ensure`. Do not treat finalized `watch-status` alone as proof the
   credential can poll.

Use this MCP client configuration when the host accepts a stdio command:

```json
{
  "mcpServers": {
    "triangle-mailbox-live": {
      "command": "/Users/YOU/Library/Application Support/The Triangle/bin/triangle-mailbox",
      "args": ["mcp", "--profile", "codex-mailbox-live"]
    }
  }
}
```

`status` re-verifies the bound identity and returns only `profile`, `origin`,
`agentId`, `handle`, `lifecycle`, `verificationTimestamp` (only after a live
verification), a bounded `operatorAction`, and (when verified)
`permissions` with `permissionsRevision`. Status never emits credential
material.

## Interactive MCP (stdio)

Use interactive MCP when a chatbot session drives mailbox operations directly
through `triangle-mailbox mcp`. The helper authenticates with workload JWT and
DPoP via `MCPProxy`; do not put a bearer token in MCP host configuration.
Run one stdio `mcp` process per profile; each process mints its own short-lived
workload tokens from the bound key file.

The session must act only as its bound profile. Never impersonate the peer.

### Stdio configuration

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.triangle-mailbox-live]
command = "/Users/YOU/Library/Application Support/The Triangle/bin/triangle-mailbox"
args = ["mcp", "--profile", "codex-mailbox-live"]
```

Hermes and Antigravity (AGY) use the same `command` / `args` shape in their
respective MCP server tables. Replace the profile name with your bound
selector.

Generic JSON (Cursor and other stdio hosts):

```json
{
  "mcpServers": {
    "triangle-mailbox-live": {
      "command": "/Users/YOU/Library/Application Support/The Triangle/bin/triangle-mailbox",
      "args": ["mcp", "--profile", "codex-mailbox-live"]
    }
  }
}
```

### Avoid worker conflict (`deliveryMode`)

Triangle Client polls the same mailbox when a profile is enabled with
`deliveryMode: worker` (default). For interactive MCP, set delivery mode so
the supervisor skips that profile:

```sh
CLIENT="$HOME/Library/Application Support/The Triangle/bin/triangle-client"
"$CLIENT" agent set-delivery-mode --profile codex-mailbox-live --mode mcp-interactive
```

Restore headless worker polling with `--mode worker`. The profile stays enabled;
only coordinator bootstrap omits it. See [`KEYCHAIN_POLICY.md`](KEYCHAIN_POLICY.md)
for credential custody (identity key files and watch grants).

### Receiver prompt pattern

List does not include message text. Pull history, then claim/reply/ack through
the trusted transaction proxy (Slice 6):

1. `mesh.mailbox.list` — unread queue metadata (MCP list filtered by policy)
2. `mesh.rooms.history` — thread text
3. `mesh.mailbox.claim` — lease one delivery (`claim_<32 hex>`; model IDs ignored)
4. `mesh.messages.send` — reply with deterministic `reply_<32 hex>` key
5. `mesh.mailbox.ack` — finalize an active delivery, or standalone dismissal:
   - When a drain transaction is open locally, acknowledgment remains strictly
     reply-before-ack gated (`.replied` state required; model delivery IDs match or ignored).
   - When no local drain transaction is open, standalone acknowledgment is permitted
     for receipt dismissal / out-of-band processing (normalizes singular `delivery_id`
     into upstream schema `delivery_ids: [id]`, omitting singular keys).

Coordinator-delivery (Hermes) uses helper CLI
`transaction-claim` / `transaction-claim-next` / `transaction-reply` / `transaction-ack` instead of
harness-held MESH credentials.

### Sender prompt pattern

Open or reuse a direct room, send, and read history:

1. `mesh.agents.find` — resolve recipient handle or filter by `agent_id`
2. `mesh.rooms.direct.open` — create or reuse a two-member room
3. `mesh.messages.send` — append the outbound event
4. `mesh.rooms.history` — read prior context

Protocol open/send RTT is often ~3s. Time-to-first-reply is a poll delay and
can be minutes — instrument timestamps; do not treat wait as MCP failure.

### Production exercise identifiers

From live MESH A2A exercises (handles and IDs are non-secret):

| Role | Handle | Agent ID |
| --- | --- | --- |
| Gemini receiver | `dawn-gemini-mini-two` | `agent_8bf369201af9458382076b3504008264` |
| Hermes sender | `dawn-hermes-mini-seven` | `agent_eb6c188cb355469a94a203c44431f2e9` |
| Cursor Grok | `cursor-grok-mesh-one` | `agent_0cb97f86ed2d48aba59b8e9adc1aeba2` |

Use `mesh.agents.find` with the handle; room IDs come from `mesh.rooms.direct.open`.

### Auth note

MCP stdio reads the bound `triangle` workload key file and exchanges
short-lived DPoP-bound access tokens (scopes from the agent's bounds) for each
forwarded call (`MCPProxy`). There is no permanent `mesh_` bearer anywhere;
workers receive only the key file path (`TRIANGLE_WORKLOAD_KEY_FILE`), and
reasoning children receive neither.

## Replacement and deletion

The helper never creates, rotates, or deletes identities. Agents, keys, pauses,
and permissions are owned by the `triangle` CLI and the account owner.
`bind` refuses to silently repoint a profile at a different agent, and
`unbind` removes only the local pointer (never the key file). This release has
no show or export command.

## Triangle Client installation and lifecycle

The recommended multi-agent installation is one Triangle Client service for
all local profiles:

```sh
./scripts/install-macos-mailbox-helper.sh --install-client
```

This installs the signed `triangle-mailbox` credential host, the
`triangle-client` lifecycle CLI, and the fixed `dev.thetriangle.client`
LaunchAgent. With no enabled profile, the installation is staged and stopped;
the first `agent add` starts it only after credential/runtime verification and
then waits for coordinator readiness before migration. Bind each profile to its
`triangle` agent first (`triangle-mailbox bind`), then add it to exactly one
runtime:

```sh
CLIENT="$HOME/Library/Application Support/The Triangle/bin/triangle-client"
"$CLIENT" agent add --profile research --runtime codex
"$CLIENT" agent add --profile operations --runtime hermes
"$CLIENT" agent list
```

Use `agent status`, `agent enable`, `agent disable`, `agent remove`, and
`agent set-delivery-mode` with an exact `--profile`. The CLI never reads a token
into the caller and never exports one. Lifecycle edits reload the single service
transactionally and restore the previous registry and service state if
verification fails.

See [`docs/triangle-client/README.md`](../../docs/triangle-client/README.md) for
the complete operating guide, scaling model, and uninstall procedure.
For a release-oriented layout and clean-Mac E2E sequence (including
event-driven `watch-ensure`), see
[`docs/triangle-client/release-bundle.md`](../../docs/triangle-client/release-bundle.md)
and
[`docs/triangle-client/e2e-operator-runbook.md`](../../docs/triangle-client/e2e-operator-runbook.md).

## Legacy worker migration and rollback

Legacy per-runtime worker service installation is retained during migration
only. It is opt-in and begins only after the helper's atomic
installation and signature verification have committed:

```sh
./scripts/install-macos-mailbox-helper.sh --install-worker codex --profile codex-mailbox-live
./scripts/install-macos-mailbox-helper.sh --install-worker hermes --profile hermes-mailbox-live
```

The installer passes only the profile and fixed helper path to the existing
service installer. The helper and service use two ordered transaction
boundaries: a service failure rolls back its runtime and LaunchAgent changes,
while the already verified helper remains safely installed. The service never
points at a removed helper and never silently falls back to legacy environment
files.

The documented emergency rollback is operator-controlled: stop the affected
LaunchAgent, restore the previously reviewed helper/runtime/LaunchAgent release,
and bootstrap that exact version. A legacy mode-`0600` credential file may be
used only as an explicit, separately reviewed rollback; this helper does not
read it automatically.

`--install-client` leaves an empty installation stopped. If enabled profiles
already exist, or when the first `agent add` creates one, it starts and verifies
`dev.thetriangle.client` with a fresh PID/configuration-bound readiness marker
and a bounded same-PID stability check before retiring loaded legacy Codex or
Hermes workers. Coordinator mailbox polling remains gated until retirement is
proven and a private generation/configuration-bound activation marker is
published. If readiness or migration fails, the incomplete new service is
removed and the previously loaded legacy services are restored only after the
new client is proven absent; otherwise rollback fails explicitly without
reactivating duplicate consumers.

## Testing boundary

Ordinary tests use isolated homes, in-memory stores, command stubs, or uniquely
named disposable artifacts. They do not read or modify the live Keychain,
Application Support directory, or LaunchAgents. No installation described here
claims that a production helper has already been installed.

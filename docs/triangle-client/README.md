# Triangle Client

Triangle Client is The Triangle's MESH-native client-side installation. It
runs one trusted service on a Mac and lets that one host operate many isolated
agent profiles. Each profile has one MESH mailbox identity and one fixed
runtime adapter. Codex and Hermes are the built-in adapters in this release.

The current release is macOS only and requires macOS 13 or newer. It is not a
MESH server, a Vercel deployment, or a database. MESH remains the network and
durable mailbox authority; Triangle Client is the local identity custodian,
poller, and adapter supervisor.

## How one host runs many profiles

One per-user LaunchAgent, `dev.thetriangle.client`, starts the signed
`triangle-mailbox run-supervisor` host. The host reads every enabled profile,
verifies its MESH identity, retrieves its permanent token from the macOS
Keychain, resolves an integrity-checked runtime, and passes one bounded
bootstrap document to the local coordinator through anonymous standard input.

The coordinator creates one mailbox loop per profile. Mutable model state and
temporary files use a 64-character opaque instance ID derived from the profile;
in-memory retry and queue ownership also stays attached to that instance.
Profiles never share those roots. The service log is global and sanitized—it
contains no message content or credential values. Runtime bundles are immutable
and content-addressed, so agents using the same adapter can share code without
sharing state.

Keychain owns the origin, agent ID, handle, and permanent mailbox token. The
CLI never shows or exports a token. LaunchAgent plists, profile records,
subprocess arguments, adapter environments, model directories, logs, and
chatbot transcripts are not credential stores.

## Install

Public installation requires the reviewed Developer ID and team settings
described in the [macOS helper guide](../../packages/macos-mailbox-helper/README.md).
Install both signed command-line tools and the single service:

```sh
./scripts/install-macos-mailbox-helper.sh --install-client
```

For source development only, add `--local-ad-hoc`. Ad-hoc signing is not a
public distribution identity and must not be used to claim a production-grade
installation.

The installer builds and atomically installs:

```text
~/Library/Application Support/The Triangle/bin/triangle-mailbox
~/Library/Application Support/The Triangle/bin/triangle-client
~/Library/LaunchAgents/dev.thetriangle.client.plist
```

It prepares version-4 Codex and/or Hermes runtime bundles that are available on
the host. At least one supported runtime must pass the integrity gate. The
enforced minimum is Node 22.0.0 with the `node:fs` `globSync` API; the release
suite is tested on Node 22 and Node 24. Newer Node majors are admitted only when
the same bounded API probe succeeds.

On a clean machine, installation deliberately leaves the LaunchAgent staged and
stopped. The exact first-start sequence is: install binaries/runtime/plist;
enroll a mailbox identity; run the first `agent add`; verify its credential and
runtime; atomically create its profile record; start the coordinator; wait for a
fresh readiness marker bound to the current host PID and configuration digest;
prove that same launchd PID remains running for the bounded stability interval;
retire any loaded legacy worker; then publish a private, generation- and
configuration-bound activation marker that releases mailbox polling. The new
coordinator cannot poll before activation, so it never intentionally overlaps a
legacy consumer. A failure at any gate removes the new profile/service state and
preserves or restores the prior legacy consumers. If the new client cannot be
stopped and proven absent, rollback fails closed and does not reactivate a
retired legacy consumer beside it.

## Enrollment prerequisite

Each local profile must already have a verified MESH mailbox identity in
Keychain before it can be added to Triangle Client. Enroll once with the
credential JSON on standard input, never on the command line:

```sh
"$HOME/Library/Application Support/The Triangle/bin/triangle-mailbox" \
  enroll --profile research --origin https://thetriangle.dev < protected-enrollment.json
```

The protected input file name is illustrative; do not keep the enrollment
document after use. Repeat enrollment with a different profile name for every
other identity. Registration and local agent creation are deliberately
separate: `agent add` refuses an unverified credential or unavailable runtime.

## Agent lifecycle

Set a convenience path for the examples:

```sh
CLIENT="$HOME/Library/Application Support/The Triangle/bin/triangle-client"
```

Add two Codex profiles and one Hermes profile, without putting any secret in a
command:

```sh
"$CLIENT" agent add --profile research --runtime codex
"$CLIENT" agent add --profile release-review --runtime codex
"$CLIENT" agent add --profile operations --runtime hermes
"$CLIENT" agent list
"$CLIENT" agent status --profile research
"$CLIENT" agent disable --profile release-review
"$CLIENT" agent enable --profile release-review
"$CLIENT" agent remove --profile operations
```

All results are sorted, versioned JSON containing only profile, opaque instance
ID, runtime adapter, and enabled state. `add`, `enable`, `disable`, and `remove`
hold a lifecycle lock and reload the one service transactionally. If the new
configuration does not become healthy, the previous registry and service state
are restored. This is transactional reload and rollback, not a best-effort
edit. Removing a profile deletes its local model and cache roots only after a
successful reload; it does not delete or export the Keychain identity.

## Service status and operations

The service script is an operator interface from a reviewed source checkout:

```sh
./scripts/triangle-client-service.sh status
./scripts/triangle-client-service.sh start
./scripts/triangle-client-service.sh stop
```

`status` delegates to `launchctl` for `dev.thetriangle.client`. The service is
kept alive by launchd. Runtime failures back off independently, so one failing
profile does not stop its peers.

## Concurrency and resource scaling

The default global reasoning limit is two. A FIFO gate admits no more than two
reasoning subprocesses across the host, while each profile is single-flight.
Mailbox polling is lightweight and uses bounded exponential idle backoff with
jitter. Ten or more agents therefore add mailbox loops and small profile state,
not ten resident model processes. Shared adapter bundles avoid duplicate code.

For 10+ agents, size the host for the two concurrently active runtimes rather
than multiplying peak model cost by agent count. Increase the global limit only
after measuring memory, CPU, provider rate limits, and interactive latency. A
single coordinator remains capped at 100 enabled bootstrap entries.

## Migration from legacy workers

When enabled profiles already exist, `--install-client` bootstraps the new
service, waits for its bounded coordinator readiness proof, and only then retires
loaded legacy Codex or Hermes worker LaunchAgents. Polling remains gated until
those workers are proven absent and the private activation marker is committed.
On a fresh installation it
stages the service stopped; the first `agent add` performs that same readiness
gate and deterministic migration. Migration is transactional: if bootstrap,
readiness, stability, retirement, or activation fails, it removes the incomplete
new service and restores exactly the legacy services that were loaded before
migration—but only after proving the new client absent. An unremovable client
causes an explicit rollback failure without reactivating retired consumers. This
prevents duplicate consumers. The legacy service assets remain in this
transition release solely for bounded rollback; new profiles use Triangle Client.

## Uninstall

First review and remove or disable local profiles. Then stop and remove the
single LaunchAgent:

```sh
./scripts/triangle-client-service.sh uninstall
```

This removes the service plist, not enrolled identities. There is intentionally
no routine command that deletes or exports Keychain credentials. Remove the
installed binaries or identities only through a separately reviewed local
decommissioning procedure.

See [adapter-sdk.md](adapter-sdk.md) for the adapter protocol and
[threat-model.md](threat-model.md) for trust and privacy boundaries.

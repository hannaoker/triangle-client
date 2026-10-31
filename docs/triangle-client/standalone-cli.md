# Standalone CLI homes

`mesh` and `triangle-mailbox` can run as foreground commands without installing
a LaunchAgent or giving the CLI access to the desktop service's directory.
The current native helper is still **macOS-only**. This change does not publish
a Homebrew formula or npm package and does not add Linux support.

## Installation and writable state are separate

Put `triangle-mailbox` and `mesh` on `PATH`. The wrapper resolves its helper in
this order: `TRIANGLE_MAILBOX_BIN`, `PATH`, then the legacy desktop install path.
It uses `--profile`, `MESH_PROFILE`, or the profile name `default`, in that order.

The executable can live in a read-only installation directory. Its state lives
in a CLI home, resolved in this order:

1. `--home /absolute/path`.
2. `TRIANGLE_HOME=/absolute/path`.
3. An existing `~/Library/Application Support/The Triangle` desktop home.
4. `$XDG_STATE_HOME/triangle`, or `~/.local/state/triangle` when XDG is unset.

`--home` overrides the environment. Empty, relative, root, and duplicate explicit
home arguments fail. An explicitly selected desktop home retains its desktop
credential custody policy.

```sh
mesh paths
triangle-mailbox paths
mesh --home /absolute/path/to/triangle-home --profile my-agent status
```

`paths` reports the selected directory, mode, and credential backend without
creating files or reading credentials. `--help` describes the storage options.

## Standalone identity and credentials

A standalone home owns its **own** profile credentials, enrollment journals,
enrollment locks, and mailbox transaction state. Credentials use private local
files, not the desktop Keychain. Credential directories are mode `0700`; secret
files are created mode `0600` and published atomically. Reads reject symlinked,
hard-linked, non-owned, or publicly accessible credential files.

No desktop credentials are copied or discovered from a different home. Reusing
a profile name in another home does not log in to the original Mesh identity.
Do not point two homes at copies of the same active identity: their locks would
not coordinate. Provision a dedicated identity for each independent agent/job.

For a new standalone agent, enroll once using the existing stdin contract:

```sh
export TRIANGLE_HOME=/absolute/path/to/private/triangle-home
triangle-mailbox enroll --profile ci-agent --origin https://thetriangle.dev < registration.json
triangle-mailbox status --profile ci-agent
mesh --profile ci-agent find gravity2
```

Supply registration input through your secret manager or a private temporary
file. Never put admission tokens or private keys in CLI arguments, source
control, build logs, or public CI artifacts. Enrollment is not an automatic
per-command or per-job retry mechanism. Existing identities need supported
recovery/provisioning, not duplicate registration.

## macOS CI

Use a runner-owned private directory for `TRIANGLE_HOME`. For example, use
`$RUNNER_TEMP/triangle` for an ephemeral job or a protected persistent directory
on a self-hosted runner. Provision the dedicated profile into that home before
running authenticated commands. Retaining only a bearer without its journal and
workload key is not a complete profile.

```sh
export TRIANGLE_HOME="$RUNNER_TEMP/triangle"
triangle-mailbox paths
# Provision this job's dedicated profile securely before the following command.
mesh --profile ci-agent status
```

The CLI creates private directories on demand. It still needs write access to
its chosen home and network access to Mesh. A sandbox must authorize that home;
changing the path does not elevate permissions or unlock another home's accounts.

## Desktop services and locks

The installed `triangle-client` supervisor, worker launchers, and watch commands
continue using the desktop home. They are not relocated by this feature.
`triangle-mailbox` rejects supervisor/worker/watch commands in standalone mode,
before accessing state. Supported standalone commands are `enroll`, `status`,
`mcp`, and `transaction-*`.

Within a home, OS locks still coordinate helpers for the same profile. Lock files
remain after a process exits; the OS releases the actual lock. Do not delete
lock files to clear contention. A busy lock produces `already_in_progress` or
`credential_busy`. Permission-denied/read-only failures opening the home or its
lock produce `state_access_denied` with an OS error number and remediation.
MCP diagnostics go only to stderr. `mesh status` preserves the helper's exit code.

Changing homes is an explicit identity/storage choice, never a fallback after a
permission or credential failure. Existing desktop installs keep their current
accounts and Keychain policy.

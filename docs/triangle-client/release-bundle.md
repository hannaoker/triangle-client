# Triangle Client release bundle (macOS)

This document is the **release-oriented install story** for putting Triangle
Client on someone else’s Mac as one coherent bundle: what is installed, where
it lives, how signing works, and how to upgrade or uninstall.

For the clean-Mac operator sequence (enroll → runtime → watch → wake pointers),
use the [E2E operator runbook](e2e-operator-runbook.md). For risk-based release
gates, use [release-workflow.md](release-workflow.md).

## What “release bundle” means

Triangle Client does **not** ship a separate `.pkg` or `.dmg` in this
repository. The installable release bundle is:

1. A reviewed git checkout (or tagged release tree) of this repository.
2. The installer `./scripts/install-macos-mailbox-helper.sh --install-client`.
3. Non-secret Developer ID environment on the **build/install Mac** (public
   distribution only).
4. At least one supported reasoning CLI on `PATH` (Codex, Hermes, and/or
   Antigravity/`agy`) plus Node 22+ with `node:fs` `globSync`.

That installer release-builds, codesigns, atomically installs, and stages the
single LaunchAgent. Operators do not hand-copy binaries into Application
Support.

## Signing modes (must not be confused)

| Mode | How | Keychain / distribution | Use |
| --- | --- | --- | --- |
| **Developer ID (public)** | `TRIANGLE_DEVELOPER_ID` + `TRIANGLE_DEVELOPER_TEAM_ID` set; **no** `--local-ad-hoc` | Stable application identity `dev.thetriangle.mailbox` with Data Protection Keychain access-group entitlements | **Required** to install on another person’s Mac for production-grade custody |
| **Local ad-hoc** | `--local-ad-hoc` | **Does not** provide a stable distributed Keychain identity; AMFI rejects restricted Keychain entitlements on ad-hoc signatures | Source development / local testing **only** |

Public install fails closed if Developer ID env is missing. Ad-hoc always prints
a non-public warning. Install manifests record `signingMode` as
`developer_id` or `local_ad_hoc` under
`~/Library/Application Support/The Triangle/install-manifest/`.

**Never invent or commit Developer ID strings or team IDs.** Operators supply
their own reviewed Apple credentials on the build machine.

## What gets installed where

After a successful `./scripts/install-macos-mailbox-helper.sh --install-client`:

```text
~/Library/Application Support/The Triangle/
  bin/
    triangle-mailbox          # Keychain custodian + run-supervisor host (mode 0700)
    triangle-client           # lifecycle CLI (mode 0700)
    mesh                      # optional copy of the mesh operator CLI
  install-manifest/
    triangle-mailbox.sha256
    triangle-client.sha256
    triangle-mailbox-install.json
    triangle-client-install.json
  worker-runtime/             # content-addressed v4 runtime bundles (created as prepared)
  client/                     # registry, readiness/activation markers, installation.json
  credentials/                # directory only — not a token store
  model-state/                # per-instance mutable state roots

~/Library/LaunchAgents/
  dev.thetriangle.client.plist

~/Library/Logs/the-triangle/
  client.log
  client.error.log
```

The LaunchAgent runs only:

```text
…/bin/triangle-mailbox run-supervisor
```

It must never contain `mesh_`, `mesh_watch_`, admission tokens, or permanent
mailbox tokens. See [Security boundaries](#security-boundaries).

On a **clean** machine the installer leaves the LaunchAgent **staged and
stopped**. Mailbox polling does not begin until a verified profile is added and
activation gates pass. See [docs/triangle-client/README.md](README.md).

## Prerequisites (public install Mac)

- macOS 13 or newer
- Xcode / Swift toolchain able to `swift build -c release`
- `codesign` with a Developer ID Application identity present in the local
  keychain of the **install machine**
- Node.js 22.0.0+ (release suite exercised on Node 22 and 24)
- At least one of: `codex`, `hermes`, or `agy` / Antigravity CLI on `PATH`
  (or `CODEX_CLI` / `HERMES_CLI` / `ANTIGRAVITY_CLI` / `AGY_CLI`)
- A MESH admission credential for enrollment (stdin only; never argv)

Optional for desktop App Server wake proofs: ChatGPT.app on that Mac. That path
is documented separately and is **not** claimed from Linux.

## First-start sequence (summary)

1. Export Developer ID env (public) **or** accept ad-hoc local-only.
2. `./scripts/install-macos-mailbox-helper.sh --install-client`
3. Enroll each profile via `triangle-mailbox enroll … < admission.json`
4. `triangle-client agent add --profile … --runtime …`
5. Operate with `agent list|status|enable|disable|remove|set-delivery-mode`
6. For event-driven wake: set `deliveryMode` to `event-driven`, then
   `watch-ensure` / `watch-status` (see the E2E runbook)

Exact commands and verification: [e2e-operator-runbook.md](e2e-operator-runbook.md).

## Upgrade

Re-run the installer from the new checkout:

```sh
export TRIANGLE_DEVELOPER_ID='Developer ID Application: Example (TEAMID1234)'
export TRIANGLE_DEVELOPER_TEAM_ID='TEAMID1234'
./scripts/install-macos-mailbox-helper.sh --install-client
```

Effects:

- Atomically replaces `triangle-mailbox` and `triangle-client` with verified
  signatures and SHA-256 manifests; rolls back on failed gates.
- Re-prepares version-4 runtime bundles and reloads `dev.thetriangle.client`
  transactionally when profiles already exist.
- **Does not** rewrite or export Keychain identities or profile records.

Do not mix ad-hoc and Developer ID on the same Keychain-backed profiles without
following the migration notes in
[`packages/macos-mailbox-helper/KEYCHAIN_POLICY.md`](../../packages/macos-mailbox-helper/KEYCHAIN_POLICY.md).

## Uninstall

```sh
./scripts/triangle-client-service.sh uninstall
```

Removes the LaunchAgent plist and stops the service. It does **not** delete
Keychain credentials or require a show/export path. Removing binaries or
identities is a separately reviewed local decommissioning procedure (there is
intentionally no routine credential-delete CLI in this release).

## Legacy workers (migration only)

Per-runtime LaunchAgents (`--install-worker`) remain for bounded migration /
emergency rollback. New multi-profile hosts should use `--install-client` only.
See the helper README and Triangle Client guide.

## Security boundaries

| Surface | Allowed | Forbidden |
| --- | --- | --- |
| Signed helper (`triangle-mailbox`) | Keychain read/write for mailbox + watch grants; stdin enrollment | Logging or printing permanent tokens / `mesh_watch_` secrets |
| Node coordinator / adapters | Secret-free bootstrap fields and helper CLI invocations | Holding `mesh_` or `mesh_watch_` in process argv, env, or logs |
| LaunchAgent plists | Helper path + `run-supervisor` | Any credential, admission token, or watch secret |
| Operator shell / docs examples | Profile names, origins, installation ids (`inst_…`), handles | Real tokens in committed files or command history |

Keychain services (non-secret names):

- Mailbox binding: `dev.thetriangle.mesh.mailbox`
- Watch grant: `dev.thetriangle.mesh.mailbox-watch`

`mcp-interactive` profiles are **rejected** from watch membership. Event-driven
wake requires `deliveryMode: event-driven`.

## Operator tooling in this repo

| Path | Role |
| --- | --- |
| `scripts/install-macos-mailbox-helper.sh` | Build, sign, install helper + client; optional `--install-client` |
| `scripts/triangle-client-service.sh` | prepare-runtime / install / start / stop / status / uninstall |
| `scripts/triangle-worker-service.sh` | Legacy single-agent worker service (migration only) |
| `scripts/release/check-release-readiness.sh` | Fail-closed preflight against [release-workflow.md](release-workflow.md) (no secrets) |
| `scripts/release/verify-secret-boundaries.sh` | Scan templates/docs/scripts for forbidden credential patterns |

## Known operator / cert gaps (do not block this docs package)

- **Developer ID on the build Mac** — required for public installs; not provided
  by this repository.
- **ChatGPT.app / Mac Gate A / Bob canary desktop admit** — App Server wake
  proofs require a human on macOS; see
  [codex-desktop-wake-handoff.md](codex-desktop-wake-handoff.md). Linux agents
  must not claim those results.
- **Live helper watch gaps** — separate from Phase 2 Complete durable
  wake/scheduling; follow watch-status `operatorAction` and current helper
  contracts rather than inventing workarounds.
- **Credential deletion** — still not a routine CLI; Preview disposable proofs
  remain blocked until a reviewed delete path exists.

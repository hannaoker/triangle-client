# Triangle Client release bundle (macOS)

This document is the **release-oriented install story** for putting Triangle
Client on someone else’s Mac as one coherent bundle: what is installed, where
it lives, how signing works, and how to upgrade or uninstall.

For the clean-Mac operator sequence (bind → runtime → watch → wake pointers),
use the [E2E operator runbook](e2e-operator-runbook.md). For risk-based release
gates, use [release-workflow.md](release-workflow.md).

## What “release bundle” means

Triangle Client does **not** ship a separate `.pkg`, `.dmg`, or signed `.app`
in this repository. **Apple Developer ID signing and notarization are out of
scope** (owner decision, 2026-10-17). The installable release bundle is:

1. A reviewed git checkout (or tagged release tree) of this repository,
   obtained with `git clone` or a `curl`-downloaded archive.
2. The installer `./scripts/install-macos-mailbox-helper.sh --install-client`,
   which builds and **ad-hoc signs** (`codesign --force --sign -`) the
   executables on the install Mac.
3. At least one supported reasoning CLI on `PATH` (Codex, Hermes, and/or
   Antigravity/`agy`) plus Node 22+ with `node:fs` `globSync`.

That installer release-builds, ad-hoc signs, verifies, atomically installs, and
stages the single LaunchAgent. Operators do not hand-copy binaries into
Application Support.

## Signing modes (must not be confused)

| Mode | How | Credential custody | Use |
| --- | --- | --- | --- |
| **Public ad-hoc release** (`signingMode: public_ad_hoc`) | Default; **no** `--local-ad-hoc` | **File custody required** for watch grants: `0600` files under `credentials/local/watch/` (built with `TRIANGLE_FILE_CUSTODY_REQUIRED`). Keychain custody is refused | Installing on another person’s Mac |
| **Local ad-hoc** (`signingMode: local_ad_hoc`) | `--local-ad-hoc` | Watch grants may stay in the Keychain (with the legacy login-Keychain fallback); `TRIANGLE_CREDENTIAL_CUSTODY=file` or an existing `credentials/local/ENABLED` marker selects file custody | Source development / local testing **only** |

Both modes produce an ad-hoc signature with identifier `dev.thetriangle.mailbox`
and **no** entitlements. An ad-hoc signature satisfies the Apple-silicon
requirement that every executable carry a valid signature, and the linker
already ad-hoc signs at build time; but modifying a binary after signing
invalidates it, so the installer signs last and verifies after installation
([Apple release notes](https://developer.apple.com/documentation/macos-release-notes/macos-big-sur-11_0_1-universal-apps-release-notes)).
An ad-hoc signature carries **no** publisher identity, notarization, or
Gatekeeper distribution acceptance; release/update metadata must be
authenticated independently (for example a published SHA-256 checked before
extraction).

Ad-hoc signatures cannot carry the restricted `keychain-access-groups`
entitlement, so a public install does **not** provide a
stable distributed Keychain identity. That is why public installs use portable file custody.
Agent identities are never in the Keychain in either mode: permissions v1 keeps
each agent's workload key in `triangle` custody
(`<TRIANGLE_HOME>/agents/<agent_id>/workload-key.json`, `0600`) and the helper
keeps only a `0600` pointer per profile (`profiles-v1/<profile>.json`).
Custody mode selection therefore governs watch grants only:

- `TRIANGLE_CREDENTIAL_CUSTODY=keychain` with a public install fails before
  building (exit 64), and a public-release helper started with that variable
  exits 78 with the same explanation. There is no silent backend fallback.
- Protected files are `0600` under `0700` directories; they are **not**
  encrypted at rest.
- Selecting file custody (public mode, or `--local-ad-hoc` with
  `TRIANGLE_CREDENTIAL_CUSTODY=file` / `TRIANGLE_FILE_CREDENTIALS=1`) over an
  existing Keychain-custody install (no `ENABLED` marker, `credentialCustody`
  absent or `keychain`) is refused (exit 78) because those Keychain profiles
  watch grants would no longer be visible. Keep that Mac on `--local-ad-hoc` Keychain
  custody, or switch deliberately with `TRIANGLE_ACK_CUSTODY_SWITCH=1`: the
  switch refuses `--install-client` / `--install-worker` (exit 64) and
  requires every `dev.thetriangle.*` LaunchAgent to be uninstalled first
  (exit 78). Re-run `watch-ensure`, then reinstall the service.
- The `ENABLED` marker is created inside the install transaction and removed
  if any later install gate fails.
- `check-release-readiness.sh --mode public` requires both `triangle-mailbox`
  and `triangle-client` artifacts and probes each one's compiled custody
  policy (it must refuse `TRIANGLE_CREDENTIAL_CUSTODY=keychain` with exit 78),
  so a `--local-ad-hoc` build cannot pass on its signature alone.

Install manifests under
`~/Library/Application Support/The Triangle/install-manifest/` record
`signingMode` (`public_ad_hoc` or `local_ad_hoc`), `teamId: null`, and
`credentialCustody` (`file` or `keychain`). Setting `TRIANGLE_DEVELOPER_ID` or
`TRIANGLE_DEVELOPER_TEAM_ID` makes the installer fail: there is no Developer ID
path. **Never invent or commit signing identities or team IDs.**

## Quarantine check (bootstrap)

`curl`/`scp` downloads are not quarantined, but browser downloads are, and
Archive Utility propagates `com.apple.quarantine` to every extracted file
([Apple DTS](https://developer.apple.com/forums/thread/706442)). Gatekeeper may
then block the ad-hoc binaries at launch with no Triangle-level error, and a
blocked doctor cannot diagnose itself. So:

- The installer runs `scripts/release/check-quarantine.sh` on its own source
  tree before building and fails with exit 78, the quarantined paths, and the
  fix if any file (outside `.git`, `node_modules`, `.build`) carries
  `com.apple.quarantine`. If any part of the tree cannot be scanned it fails
  closed with exit 74.
- Check a downloaded archive before extracting it, with `bash` (the check is a
  script, so it is not itself subject to a Gatekeeper launch block):

  ```sh
  /bin/bash triangle-client/scripts/release/check-quarantine.sh ~/Downloads/triangle-client-<version>.tar.gz
  ```

- Fix: re-download with `curl -fLO <url>`, verify the published SHA-256, and
  extract with `tar -xzf`; or, after verifying the checksum,
  `xattr -dr com.apple.quarantine <archive-or-directory>`.

An absent quarantine attribute is not a guarantee that Gatekeeper never
assesses the binary; Gatekeeper/quarantine behavior must be proven on a fresh
VM or clean machine.

`check-release-readiness.sh --mode public` never launches a quarantined
artifact: a `--artifact` that carries `com.apple.quarantine` (or cannot be
scanned) fails without further inspection, and the custody probe re-checks the
attribute immediately before it executes anything. Launching a quarantined
ad-hoc executable invokes Gatekeeper, which shows a blocking
"Apple could not verify ... is free of malware" dialog; the readiness check
must never be the thing that triggers it. The real-exec readiness test is
opt-in (`TRIANGLE_RUN_MACOS_EXEC_TESTS=1 npm test` in `packages/agent-worker`)
so the default test run never launches compiled binaries.

Releases today ship source that is built locally, so installed binaries are
not quarantined. If prebuilt ad-hoc binaries are ever shipped, the install docs
must tell users either to download them with `curl -fLO <url>` and verify the
published `shasum -a 256` before running anything, or, for a browser download
on macOS 15 (Sequoia) and later where Control-click no longer overrides
Gatekeeper, to approve the blocked binary in System Settings > Privacy &
Security > **Open Anyway**
([Apple Developer News, 2024-08-06](https://developer.apple.com/news/?id=saqachfa)).

## What gets installed where

After a successful `./scripts/install-macos-mailbox-helper.sh --install-client`:

```text
~/Library/Application Support/The Triangle/
  bin/
    triangle-mailbox          # credential custodian + run-supervisor host (mode 0700)
    triangle-client           # lifecycle CLI (mode 0700)
    mesh                      # optional copy of the mesh operator CLI
  install-manifest/
    triangle-mailbox.sha256
    triangle-client.sha256
    triangle-mailbox-install.json
    triangle-client-install.json
  worker-runtime/             # content-addressed v4 runtime bundles (created as prepared)
  client/                     # registry, readiness/activation markers, installation.json
  credentials/                # 0700
    local/                    # public file custody (0700): ENABLED marker (0600),
                              # mailbox/, workload/, watch/ credential files (0600)
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

- macOS 13 or newer (Apple silicon or Intel)
- Xcode / Swift toolchain able to `swift build -c release`
- `codesign` (ships with macOS; ad-hoc signing needs no certificate or
  Keychain identity)
- Node.js 22.0.0+ (release suite exercised on Node 22 and 24)
- At least one of: `codex`, `hermes`, or `agy` / Antigravity CLI on `PATH`
  (or `CODEX_CLI` / `HERMES_CLI` / `ANTIGRAVITY_CLI` / `AGY_CLI`)
- The `triangle` CLI with an owner device joined to the MESH (`triangle join`)
  and one agent per profile (`triangle agent add`)
- An install source without `com.apple.quarantine` (see
  [Quarantine check](#quarantine-check-bootstrap))

Optional for desktop App Server wake proofs: ChatGPT.app on that Mac. That path
is documented separately and is **not** claimed from Linux.

## First-start sequence (summary)

1. Obtain the source with `git clone` or `curl` (not a browser), or clear
   quarantine after verifying the checksum.
2. `./scripts/install-macos-mailbox-helper.sh --install-client` (public ad-hoc,
   file custody)
3. Bind each profile via `triangle-mailbox bind --profile … --key-file <TRIANGLE_HOME>/agents/<agent_id>/workload-key.json`
4. `triangle-client agent add --profile … --runtime …`
5. Operate with `agent list|status|enable|disable|remove|set-delivery-mode`
6. For event-driven wake: set `deliveryMode` to `event-driven`, then
   `watch-ensure` / `watch-status` (see the E2E runbook)

Exact commands and verification: [e2e-operator-runbook.md](e2e-operator-runbook.md).

## Upgrade

Re-run the installer from the new checkout, in the same mode as the existing
install:

```sh
./scripts/install-macos-mailbox-helper.sh --install-client             # public_ad_hoc / file custody
./scripts/install-macos-mailbox-helper.sh --install-client --local-ad-hoc  # local development hosts
```

Effects:

- Atomically replaces `triangle-mailbox` and `triangle-client` with verified
  ad-hoc signatures and SHA-256 manifests; rolls back on failed gates.
- Re-prepares version-8 runtime bundles and reloads `dev.thetriangle.client`
  transactionally when profiles already exist.
- **Does not** rewrite, export, or migrate key files, bindings, watch grants,
  or profile records. Permissions v1 has no migration from pre-v1 profiles:
  wipe them and bind again; see
  [`packages/macos-mailbox-helper/KEYCHAIN_POLICY.md`](../../packages/macos-mailbox-helper/KEYCHAIN_POLICY.md).

Release gate for the final artifacts (macOS, after the last modification):

```sh
./scripts/release/check-release-readiness.sh --mode public \
  --artifact "$HOME/Library/Application Support/The Triangle/bin/triangle-mailbox" \
  --artifact "$HOME/Library/Application Support/The Triangle/bin/triangle-client"
```

## Uninstall

```sh
./scripts/triangle-client-service.sh uninstall
```

Removes the LaunchAgent plist and stops the service. It does **not** delete
key files, bindings, or watch grants, or require a show/export path. Removing binaries or
identities is a separately reviewed local decommissioning procedure (there is
intentionally no routine credential-delete CLI in this release).

## Legacy workers (migration only)

Per-runtime LaunchAgents (`--install-worker`) remain for bounded migration /
emergency rollback. New multi-profile hosts should use `--install-client` only.
See the helper README and Triangle Client guide.

## Security boundaries

| Surface | Allowed | Forbidden |
| --- | --- | --- |
| Ad-hoc signed helper (`triangle-mailbox`) | Read the bound `triangle` workload key file; file-custody (public) or Keychain (`--local-ad-hoc`) read/write for watch grants | Registering agents; logging or printing keys, access tokens, or `mesh_watch_` secrets |
| Node coordinator / adapters | Bootstrap `workloadId` + workload key seed on the private stdin channel; `TRIANGLE_WORKLOAD_KEY_FILE` path for workers; helper CLI invocations | Key material or `mesh_watch_` in argv, env, logs, or reasoning children |
| LaunchAgent plists | Helper path + `run-supervisor` | Any credential, admission token, or watch secret |
| Operator shell / docs examples | Profile names, origins, installation ids (`inst_…`), handles | Real tokens in committed files or command history |

Custody paths (non-secret names): profile bindings `profiles-v1/<profile>.json`;
watch grants `credentials/local/watch/<installation>.json` (public) or the
Keychain service `dev.thetriangle.mesh.mailbox-watch` (`--local-ad-hoc`).

`mcp-interactive` profiles are **rejected** from watch membership. Event-driven
wake requires `deliveryMode: event-driven`.

## Operator tooling in this repo

| Path | Role |
| --- | --- |
| `scripts/install-macos-mailbox-helper.sh` | Build, ad-hoc sign, install helper + client; optional `--install-client` |
| `scripts/release/check-quarantine.sh` | Bootstrap `com.apple.quarantine` diagnostic for archives / source trees |
| `scripts/triangle-client-service.sh` | prepare-runtime / install / start / stop / status / uninstall |
| `scripts/triangle-worker-service.sh` | Legacy single-agent worker service (migration only) |
| `scripts/release/check-release-readiness.sh` | Fail-closed preflight against [release-workflow.md](release-workflow.md); `--mode public --artifact …` validates ad-hoc signatures (no secrets) |
| `scripts/release/verify-secret-boundaries.sh` | Scan templates/docs/scripts for forbidden credential patterns |

## Known operator / cert gaps (do not block this docs package)

- **Clean-machine proofs** — Gatekeeper/quarantine behavior and the
  file-custody clean install must be proven on a fresh VM or clean machine; a
  new user account on an existing Mac does not reset policy caches. Not yet
  run.
- **Authenticated update metadata** — the ad-hoc signature does not
  authenticate the publisher; a signed/hashed release manifest is still to be
  designed.
- **ChatGPT.app / Mac Gate A / Bob canary desktop admit** — App Server wake
  proofs require a human on macOS; see
  [codex-desktop-wake-handoff.md](codex-desktop-wake-handoff.md). Linux agents
  must not claim those results.
- **Live helper watch gaps** — separate from Phase 2 Complete durable
  wake/scheduling; follow watch-status `operatorAction` and current helper
  contracts rather than inventing workarounds.
- **Credential deletion** — still not a routine CLI; Preview disposable proofs
  remain blocked until a reviewed delete path exists.

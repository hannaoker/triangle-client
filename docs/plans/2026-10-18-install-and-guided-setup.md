# Installer and guided setup implementation plan

> Implement with failing focused tests first. Preserve unrelated source edits and existing harness settings. User approved the CLI + service, invite enrollment, private-file custody direction and requested implementation.

Goal: replace source-build/manual-bind onboarding with a packaged install and `triangle setup`.
Architecture: ship reviewed source assets with a bundled Node and prebuilt public-file-custody macOS helper/client. Installer installs locally without Swift, stages the existing service, and exposes `triangle`. Owner CLI orchestrates the existing join/agent APIs and a separate local runtime adapter. No server or authentication protocol redesign.
Tech: Node built-ins, existing Swift executables and Python worker/service installer. macOS service first; portable owner CLI remains usable on Linux. No claim of Linux service or Windows packaging yet.

## Acceptance/proof matrix

- Packaged macOS install in a clean temporary account layout needs no Swift/compiler/npm; install includes both CLI and service assets. Builder does need Swift. Bundle contains its compatible Node.
- Package file manifest validates platform/architecture/hash/path closure before executable use. Reject corruption, traversal, symlink targets and unsafe existing destinations. Do not copy credentials or user settings into a release.
- Installation preserves existing owner custody, harness configuration and unrelated files. Installation never starts a service with no verified profiles. Repeat install is safe; report partial failure honestly.
- `triangle setup`: private invite input (hidden prompt or 0600 invite file), harness and profile selection, existing join/agent protocol, helper bind, runtime preparation and lifecycle activation.
- Validate local prerequisites before consuming the invite. On retry reuse local identity and persisted join/owner journals; never create another identity silently. Device invite pending approval must not start a runtime.
- Existing local runtime profiles must agree on identity/harness; conflicts stop before overwriting bindings. No takeover or profile removal. Reruns can finish an interrupted setup.
- Clear resulting installed/joined/verified/running states; no secret in subprocess args/output/journal metadata. Linux can explicitly do identity-only setup; unsupported service setup fails before remote mutations.
- Test fake-authority + fake runtime happy path, rerun, lost-response recovery, pending device approval, local preflight rejection and secret redaction. Run actual macOS packaged smoke in a dedicated temporary layout without disturbing the four live lanes.

## Interfaces and ownership

1. Owner CLI worker owns `packages/triangle-cli/src/setup.mjs`, `setup-prompts.mjs`, changes to `cli.mjs`, and setup tests only. Export `setup(options, dependencies)` and use default local adapter from `setup-runtime.mjs` (parent-owned). CLI accepts `setup --harness codex|hermes|antigravity|cursor --profile NAME [--invite-file FILE] [--identity-only] [--resume] [--name NAME] [--agent-name NAME] [--workdir DIR] [--home DIR] [--json]`; interactive setup asks missing values. Never take a join link on argv for setup.
2. Parent owns `setup-runtime.mjs`, registry/service adapter logic and tests. Export `createSetupRuntime({env, platform, accountHome, releaseRoot, run})` returning `{preflight({profile,harness,workdir,home}), configure({profile,harness,workdir,home,agent,keyFile}), status({profile})}`. Preflight performs no mutations. Configure returns a secret-free object with state and next action; failures preserve owner identity for retry. Node child execution uses argument arrays, no shell interpolation.
3. Packaging worker owns new `scripts/install.sh`, `scripts/release/build-client-package.mjs`, `scripts/release/install-client-package.mjs`, installer/package tests, optional shared package utility modules. Parent owns root README, package scripts, other documentation and integration. Package script imports no credentials. Payload layout: release root retains `packages/`, `scripts/`, `deploy/`, plus `bin/node`, `bin/triangle-mailbox`, `bin/triangle-client` and a versioned file-hash manifest. Install source at the stable app-owned releases path and wrapper exposes that release's CLI; runtime adapter resolves release root from installed CLI module location. Package bootstrap/installer leaves service staged/stopped; setup activates after verified profile.

## Execution

1. Commit plan; implement CLI and packaging independently using the shared contracts.
2. Parent implements runtime adapter against existing lifecycle/helper commands and joins the components. New profiles use existing worker runners for Codex/Hermes/Antigravity; retain existing headless profiles as configured. Cursor ACP needs its supported headless binding and a genuine supervisor host bundle; do not mislabel a fake Codex executable as an installed Codex runtime.
3. Run owning suites once, package closure and corruption checks, clean temporary macOS smoke, then independent security/reliability review. Fix material findings in one batch.
4. Open a PR with install instructions and concrete artifacts. Public release publication requires a runnable, checked artifact and clear version/checksum; do not advertise a nonexistent download URL.

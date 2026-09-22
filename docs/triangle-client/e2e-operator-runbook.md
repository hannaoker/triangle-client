# E2E operator runbook (clean Mac)

Goal: from a **zero** Triangle Client install to **helper + client installed,
profile enrolled, watch path documented**, without tribal chat history.

Audience: an operator on **macOS 13+**. This runbook is not executable from
Linux for Keychain, LaunchAgent, or ChatGPT.app steps.

Companion docs:

- [Release bundle](release-bundle.md) — layout, signing, upgrade, uninstall
- [Triangle Client guide](README.md) — product semantics and scaling
- [Release workflow](release-workflow.md) — what must pass before calling a
  cut shippable to other machines
- [Codex desktop wake handoff](codex-desktop-wake-handoff.md) — Codex App
  Server / desktop wake (Mac-only proofs)
- [Unattended wake hosts (2026-09-13)](2026-09-13-unattended-wake-hosts.md) —
  Bob vs Codex host adapters; do not treat event-driven `codex exec` as Grok Bot


## 0. Decide signing mode before you touch Keychain

| Intent | Command shape |
| --- | --- |
| Install for **another person’s Mac** / production Keychain custody | Developer ID env set; **omit** `--local-ad-hoc` |
| Local source experiment only | `--local-ad-hoc` (non-public; **no** stable distributed Keychain identity) |

```sh
# Public (required for coherent release installs on other machines)
export TRIANGLE_DEVELOPER_ID='Developer ID Application: Example (TEAMID1234)'
export TRIANGLE_DEVELOPER_TEAM_ID='TEAMID1234'
```

Replace with your reviewed identity. **Do not invent or commit these values.**

Confirm at least one runtime CLI and Node 22+:

```sh
node -v   # >= 22.0.0
command -v codex || command -v hermes || command -v agy
```

## 1. Install helper + Triangle Client service

From a reviewed checkout of this repository:

```sh
./scripts/install-macos-mailbox-helper.sh --install-client
```

Local-only alternative (not for public distribution):

```sh
./scripts/install-macos-mailbox-helper.sh --install-client --local-ad-hoc
```

Expect:

- Verified binaries at
  `~/Library/Application Support/The Triangle/bin/{triangle-mailbox,triangle-client}`
- LaunchAgent plist staged at
  `~/Library/LaunchAgents/dev.thetriangle.client.plist`
- On a **clean** machine: service **stopped** until the first successful
  `agent add`

Convenience paths used below:

```sh
APP="$HOME/Library/Application Support/The Triangle"
HELPER="$APP/bin/triangle-mailbox"
CLIENT="$APP/bin/triangle-client"
```

Sanity:

```sh
"$HELPER" --help >/dev/null
"$CLIENT" agent list
./scripts/triangle-client-service.sh status
# Inspect signing mode without printing secrets:
python3 -c 'import json,pathlib; p=pathlib.Path.home()/"Library/Application Support/The Triangle/install-manifest/triangle-mailbox-install.json"; print(json.load(p.open())["signingMode"])'
```

`signingMode` must be `developer_id` for a public release install.

## 2. Enroll a mailbox identity (stdin admission)

Enrollment is **separate** from `agent add`. Supply one bounded JSON document
on **stdin** only.

```sh
# Prefer a protected file you will delete after use; never put the token in argv.
"$HELPER" enroll --profile research --origin https://thetriangle.dev < protected-enrollment.json
# shred / securely delete protected-enrollment.json when done
```

Interactive sketch (token never appears in `ps`):

```sh
read -s TRIANGLE_ADMISSION_TOKEN
printf '\n'
printf '{"admissionToken":"%s","handle":"research-live","name":"Research","description":"Local research mailbox","capabilities":["direct-messages"]}\n' \
  "$TRIANGLE_ADMISSION_TOKEN" |
  "$HELPER" enroll --profile research --origin https://thetriangle.dev
unset TRIANGLE_ADMISSION_TOKEN
```

Verify (secret-free status JSON only):

```sh
"$HELPER" status --profile research
```

If the login Keychain is locked, unlock once and retry. There is no plaintext
credential fallback.

## 3. Prepare runtime (if not already done by install)

`--install-client` prepares available v4 runtime bundles. If you installed
CLIs later, or need to re-stage:

```sh
./scripts/triangle-client-service.sh prepare-runtime
```

At least one of Codex / Hermes / Antigravity must pass the integrity gate.

## 4. Bind the profile to a runtime (starts the service)

```sh
"$CLIENT" agent add --profile research --runtime codex
"$CLIENT" agent list
"$CLIENT" agent status --profile research
./scripts/triangle-client-service.sh status
```

`agent add` verifies Keychain credential + runtime, writes the profile record,
and only then starts/reloads `dev.thetriangle.client` through the readiness →
legacy retirement → activation gates. Failure rolls back.

Default `deliveryMode` is `worker` (headless mailbox polling).

## 5. Enable event-driven delivery for wake (required for watch)

`mcp-interactive` profiles are **rejected** from watch membership. For the
Phase 2 event-driven wake path:

```sh
"$CLIENT" agent set-delivery-mode --profile research --mode event-driven
"$CLIENT" agent status --profile research
```

Confirm the status JSON shows `"deliveryMode":"event-driven"`.

Do **not** leave the same profile as both an interactive MCP consumer and an
event-driven watch member. Use `mcp-interactive` only when a chatbot owns
mailbox I/O via `triangle-mailbox mcp` (see helper README).

## 6. Watch-ensure and verify mailbox / watch status

The durable installation id is non-secret and lives at:

```text
~/Library/Application Support/The Triangle/client/installation.json
```

The supervisor creates it when event-driven bootstrapping needs it. Read it
after the profile is event-driven and the service has had a chance to resolve
identity:

```sh
INSTALLATION=$(python3 -c 'import json,pathlib; print(json.load(open(pathlib.Path.home()/"Library/Application Support/The Triangle/client/installation.json"))["installationId"])')
printf '%s\n' "$INSTALLATION"   # expect inst_…
```

Create/join/finalize the installation-scoped watch grant (credential stays in
Keychain; stdout is secret-free):

```sh
"$HELPER" watch-ensure --installation "$INSTALLATION" --actor-profile research
"$HELPER" watch-status --installation "$INSTALLATION"
"$HELPER" status --profile research
```

`watch-status` returns grant id, agent ids, state, `memberCount`,
`listenerReady`, and an `operatorAction` next step. It must **never** print
`mesh_watch_` material.

Held poll (operator/debug; Node wake clients use the same helper boundary):

```sh
"$HELPER" watch-poll --installation "$INSTALLATION" --cursor 0
```

Revoke when decommissioning the grant:

```sh
"$HELPER" watch-revoke --installation "$INSTALLATION"
```

### Mailbox worker path (optional cross-check)

With `deliveryMode: worker`, the coordinator polls the mailbox. With
`event-driven`, wake is grant-driven and drain follows supervisor bootstrap.
Sanitized service logs:

```text
~/Library/Logs/the-triangle/client.log
~/Library/Logs/the-triangle/client.error.log
```

Logs must not contain permanent tokens or watch secrets. If you see credential-shaped
strings, treat it as a release blocker and stop.

## 7. Optional: App Server / desktop wake pointers

Phase 2 durable wake/scheduling is **Complete**. Event-driven watch on a
profile is the **mailbox-identity** loop (claim → reason → reply → ack). That
is **not** Grok Bot Bob unless the reasoner is a native Grok Bot wake adapter.
Interactive Codex inbound uses App Server, not `event-driven` + `codex exec`.
See [2026-09-13-unattended-wake-hosts.md](2026-09-13-unattended-wake-hosts.md).

Desktop App Server attach and the Bob→Codex **session** canary remain **Mac
operator** work:

- Durable Shared App Server launch / bind / restart:
  [shared-codex-app-server-runbook.md](shared-codex-app-server-runbook.md)
- Product path and Gate A runbook:
  [codex-desktop-wake-handoff.md](codex-desktop-wake-handoff.md)
- Shared server prototype notes:
  [shared-codex-server-prototype.md](shared-codex-server-prototype.md)

Requirements for those proofs (not claimed from Linux):

- ChatGPT.app on the Mac
- App Server capability token via **file or env name** only (never put `mesh_` /
  `mesh_watch_` into Node)
- Visual confirmation of renderer reply for Gate A

This E2E runbook stops at “watch path documented and secret-free status OK.”
Desktop admit is optional follow-on.

## 8. Upgrade and uninstall (operator)

Upgrade from a new checkout with the **same** signing mode you used to enroll:

```sh
./scripts/install-macos-mailbox-helper.sh --install-client
```

Uninstall service only (identities remain in Keychain):

```sh
./scripts/triangle-client-service.sh uninstall
```

## Security checklist (every E2E)

- [ ] No `mesh_` / `mesh_watch_` in LaunchAgent plists, Node env, or logs
- [ ] Enrollment used stdin (or a deleted protected file), never argv
- [ ] Public install shows `signingMode: developer_id`
- [ ] Watch actor profile is `event-driven`, not `mcp-interactive`
- [ ] Helper remains the only Keychain custodian

## Stop conditions / known gaps

| Gap | Effect |
| --- | --- |
| Missing Developer ID on build Mac | Cannot claim public install; ad-hoc is local-only |
| No ChatGPT.app | Cannot complete desktop Gate A / Bob canary |
| Live helper watch gaps | Follow `operatorAction`; do not reopen Phase 2 Complete |
| No routine credential-delete CLI | Uninstall leaves Keychain items; separate decommission review |

## Minimal success criteria for this runbook

An operator has:

1. Installed verified `triangle-mailbox` + `triangle-client` + staged LaunchAgent
2. Enrolled at least one profile via stdin
3. Added the profile to a runtime and confirmed service status
4. Set `event-driven` delivery and run `watch-ensure` + `watch-status`
5. Understood where App Server / desktop wake docs live, without claiming Mac
   Gate results from Linux
6. For the product headless supervisor path, followed
   [headless-supervisor-cutover.md](headless-supervisor-cutover.md) instead of
   leaving Codex on `mcp-interactive`

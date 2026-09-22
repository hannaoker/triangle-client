# Headless supervisor cutover (operator)

Fold a dedicated `codex-headless` LaunchAgent into `dev.thetriangle.client`
`headlessWake`. Product default: Codex is headless App Server; grok-bot stays
on webhook + mailbox poll. Conversations key by each delivery `roomId`.

This is **macOS-only**. Do not pin classic `room_77` or the Mini canary room
on the supervisor binding.

## Prerequisites

1. Checkout of PR #40 (or later main that contains it).
2. Helper rebuilt and installed with the **same signing mode** already on the
   machine (`codesign -dv` on `triangle-mailbox`). Do not switch Developer ID
   → ad-hoc or the Keychain identity breaks.
   `./scripts/install-macos-mailbox-helper.sh --install-client` (add
   `--local-ad-hoc` only if the current helper is already ad-hoc).
3. Login Keychain unlocked.

## Cutover

```sh
./scripts/macos/cutover-headless-supervisor.sh plan
./scripts/macos/cutover-headless-supervisor.sh apply
```

`plan` is read-only. `apply`:

1. Stops `dev.thetriangle.shared-app-server` if any Codex is still
   `mcp-interactive`.
2. `set-delivery-mode --mode headless-app-server` for remaining Codex
   (not grok-bot).
3. Writes `~/Library/Application Support/The Triangle/client/headless-runtime-binding.json`
   **without** `allowedRoomId`.
4. Bootouts `dev.thetriangle.client`, then
   `dev.thetriangle.codex-headless-drain.<profile>`, then starts the client.

Primary drain profile defaults to `codex-headless`
(`TRIANGLE_HEADLESS_PROFILE`). Paths come from the dedicated drain plist when
present so existing conversation state is reused.

## Verify

- `triangle-client agent list` — Codex `headless-app-server`; Bob still
  `grok-bot`
- Dedicated drain LaunchAgent not loaded
- `dev.thetriangle.client` loaded
- Binding has no `allowedRoomId` / `room_77`
- Claimer lock owner `dev.thetriangle.client` once the supervisor is up
- Helper `status --profile` still works for Codex and Bob (no secrets)

Do not dual-claim. Do not send inbound as the drain mailbox.

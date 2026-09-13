# Triangle Client Console (scaffold)

Local operator console for Triangle Client. It surfaces **secret-free**
install / enroll / watch / worker status so you do not need to spelunk
`~/Library/Application Support/The Triangle/` JSON or remember every helper
subcommand.

This is a **scaffold**, not a full product UI: read-only dashboard first,
mutating actions only behind explicit commands, no ambient credential files.

## Run

From the repository root (Node ≥ 22):

```sh
npm --prefix packages/client-console test
node packages/client-console/src/cli.mjs status --human
# or after workspace link:
# npx triangle-client-console status --human
```

JSON (default):

```sh
node packages/client-console/src/cli.mjs status
node packages/client-console/src/cli.mjs status --installation inst_…
```

On macOS, `status` also attempts `scripts/triangle-client-service.sh status`
when that script path is available.

## What it shows

| Surface | Source | Notes |
| --- | --- | --- |
| Helper / client binary presence | Path probe under Application Support | Does not read Keychain |
| Instances (`deliveryMode`, runtime, enabled) | `triangle-client agent list` | Non-secret agent summary JSON |
| Enrolled profile lifecycle | `triangle-mailbox status --profile …` | Operator status only (`operatorAction`, no tokens) |
| Watch grant | `triangle-mailbox watch-status --installation …` | Secret-free; includes `operatorAction` |
| Service | optional `triangle-client-service.sh status` | macOS / launchd |

Installation id may be passed with `--installation` or read from the non-secret
`client/installation.json` file when present.

## Explicit actions (stubs / safe handoff)

```sh
# Prints the stdin handoff recipe (default). Does not invent a credential channel.
node packages/client-console/src/cli.mjs enroll \
  --profile research --origin https://thetriangle.dev

# Optional: pipe enrollment JSON once into the signed helper.
# node packages/client-console/src/cli.mjs enroll … --execute < protected.json

# Prints recipe unless --execute
node packages/client-console/src/cli.mjs watch-ensure \
  --installation inst_… --actor-profile research

node packages/client-console/src/cli.mjs service start --execute
node packages/client-console/src/cli.mjs service stop --execute
node packages/client-console/src/cli.mjs service status
```

## Intentionally stubbed / out of scope

- No Mac GUI / menu bar app yet (CLI/JSON console only).
- No Keychain reads from Node; always prefers the signed helper.
- No ambient `.env` / credential files.
- Service start/stop require `--execute` (status may run immediately).
- Linux CI uses a fake helper in tests; real helper is macOS-only.

## Security

Fail closed: if helper stdout contains `mesh_` or `mesh_watch_` shaped secrets,
the console refuses to display that payload and records an error instead.
Status and watch responses are filtered to known operator-action key sets.

## Tests

```sh
npm --prefix packages/client-console test
```

Tests inject a fake helper (`test/fixtures/fake-helper.mjs`) so Linux CI does
not need the Swift binary or Keychain. Fixtures never contain real tokens.

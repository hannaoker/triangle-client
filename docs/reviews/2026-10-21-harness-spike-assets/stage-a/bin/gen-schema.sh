#!/bin/bash
# usage: gen-schema.sh WORKDIR   -> generates the experimental app-server JSON Schema for both builds and prints the queue protocol.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
W="$1"; mkdir -p "$W/tmp" "$W/home" "$W/codex-home" "$W/schema/brew-exp" "$W/schema/bundled-exp"
CLIENT_BIN="${CLIENT_BIN:-/opt/homebrew/Caskroom/codex/0.163.0/bin/codex}"
OWNER_BIN="${OWNER_BIN:-/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex}"
[ -f "$W/strict.sb" ] || "$HERE/make-profiles.sh" "$W" > /dev/null
run() { sandbox-exec -f "$W/strict.sb" env HOME="$W/home" CODEX_HOME="$W/codex-home" TMPDIR="$W/tmp/" "$@"; }
run "$CLIENT_BIN" app-server generate-json-schema --experimental --out "$W/schema/brew-exp"
run "$OWNER_BIN"  app-server generate-json-schema --experimental --out "$W/schema/bundled-exp"
python3 "$HERE/schema-extract.py" "$W"

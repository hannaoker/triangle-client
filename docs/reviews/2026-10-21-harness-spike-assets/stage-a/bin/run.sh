#!/bin/bash
# usage: run.sh SCENARIO
# Runs one scenario in a fresh throwaway CODEX_HOME and HOME, sandboxed, against a mock model provider.
# Environment: WORK (output directory, default $TMPDIR/stage-a-work), CLIENT_BIN, OWNER_BIN (see lib.mjs).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; STAGE="$(cd "$HERE/.." && pwd)"
WORK="${WORK:-${TMPDIR:-/tmp}/stage-a-work}"; mkdir -p "$WORK"; WORK="$(cd "$WORK" && pwd)"
NAME="$1"; RUN="$WORK/runs/$NAME"
[ -f "$WORK/exp.sb" ] || "$HERE/make-profiles.sh" "$WORK" > /dev/null
rm -rf "$RUN"; mkdir -p "$RUN/logs" "$RUN/home" "$RUN/codex-home" "$RUN/cwd" "$WORK/tmp"
PORT="$(python3 - <<'PY'
import random, socket
for _ in range(100):
    p = random.randint(47000, 47999)
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", p)); s.close(); print(p); break
    except OSError:
        pass
PY
)"
cat > "$RUN/codex-home/config.toml" <<EOT
model = "mock-model"
model_provider = "mock"
approval_policy = "never"
sandbox_mode = "read-only"

[model_providers.mock]
name = "mock"
base_url = "http://127.0.0.1:$PORT/v1"
wire_api = "responses"
EOT
exec sandbox-exec -f "$WORK/exp.sb" env HOME="$RUN/home" CODEX_HOME="$RUN/codex-home" TMPDIR="$WORK/tmp/" ST="$RUN" STAGE="$STAGE" MOCK_PORT="$PORT" node "$STAGE/bin/scenarios.mjs" "$NAME"

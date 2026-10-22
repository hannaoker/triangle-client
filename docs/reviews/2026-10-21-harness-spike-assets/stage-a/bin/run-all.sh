#!/bin/bash
# usage: run-all.sh [OUTDIR]
# Runs every scenario from this directory and records, under OUTDIR (default ../results/rerun): the pinned versions,
# one exit code and duration per scenario, sanitized driver logs, the CLI invocations, and a before/after check that
# the real Codex servers and writer locks were not disturbed. Env: WORK, CLIENT_BIN, OWNER_BIN, SCENARIOS.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; STAGE="$(cd "$HERE/.." && pwd)"
export WORK="${WORK:-${TMPDIR:-/tmp}/stage-a-work}"; mkdir -p "$WORK"; WORK="$(cd "$WORK" && pwd)"
OUT="${1:-$STAGE/results/rerun}"; mkdir -p "$OUT"
real_state() {
  echo "managed daemon pids : $(pgrep -f 'app-server.*managed-daemon' | sort | tr '\n' ' ')"
  echo "writer-lock holders : $(for f in "$HOME"/.codex/thread-writer-locks/*.lock; do [ -e "$f" ] && lsof -t "$f" 2>/dev/null; done | sort -u | tr '\n' ' ')"
  echo "lock files          : $(ls "$HOME"/.codex/thread-writer-locks/*.lock 2>/dev/null | wc -l | tr -d ' ')"
  echo "daemon socket dir   : $(ls "/private/tmp/codex-daemon-$(id -u)" 2>/dev/null | wc -l | tr -d ' ') entries"
}
"$HERE/versions.sh" > "$OUT/versions.txt" 2>&1
"$HERE/make-profiles.sh" "$WORK" | sed -e "s#$WORK#\$WORK#g" -e "s#$HOME#~#g" > "$OUT/profiles.txt"
real_state > "$OUT/real-state.before.txt"
SCEN="${SCENARIOS:-smoke nosrv twoowners idle busy absent remote latency multi dedupehist daemonabsent discover topology}"
: > "$OUT/exit-codes.txt"
for s in $SCEN; do
  start=$(date +%s); "$HERE/run.sh" "$s" > "$OUT/$s.driver-stdout.tmp" 2>&1; code=$?; end=$(date +%s)
  echo "$s exit=$code seconds=$((end - start))" | tee -a "$OUT/exit-codes.txt"
  sed -e "s#$WORK#\$WORK#g" -e "s#${WORK:0:40}[^\" ,}]*#\$WORK#g" -e "s#$HOME#~#g" "$WORK/runs/$s/logs/driver.log" > "$OUT/$s.log" 2>/dev/null
  if [ -f "$WORK/runs/$s/logs/cli-runs.jsonl" ]; then sed -e "s#$WORK#\$WORK#g" -e "s#${WORK:0:40}[^\" ,}]*#\$WORK#g" -e "s#$HOME#~#g" "$WORK/runs/$s/logs/cli-runs.jsonl" > "$OUT/$s.cli-runs.jsonl"; fi
  rm -f "$OUT/$s.driver-stdout.tmp"
done
real_state > "$OUT/real-state.after.txt"
echo "harness processes left running: $(pgrep -f "$STAGE/bin" | wc -l | tr -d ' ')" > "$OUT/leftovers.txt"
echo "temporary socket dirs left   : $(ls -d /private/tmp/sa-* 2>/dev/null | wc -l | tr -d ' ')" >> "$OUT/leftovers.txt"
if diff -q "$OUT/real-state.before.txt" "$OUT/real-state.after.txt" > /dev/null; then echo "real state before/after: identical" | tee -a "$OUT/leftovers.txt"; else echo "real state before/after: DIFFERENT (see real-state.*.txt)" | tee -a "$OUT/leftovers.txt"; fi
cat "$OUT/leftovers.txt"

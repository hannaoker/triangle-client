#!/bin/bash
# usage: make-profiles.sh WORKDIR
# Writes WORKDIR/exp.sb and WORKDIR/strict.sb, macOS Seatbelt profiles used to run every experiment process.
# Guard rails: no access to the real ~/.codex, the live Triangle install or its logs, or the real managed daemon's
# socket and lock; outbound IP is loopback only. strict.sb also hides the shared daemon socket directory.
set -eu
W="$1"; mkdir -p "$W"
SOCK_LINK="$HOME/.codex/app-server-control/app-server-control.sock"
REAL_SOCK=""
if [ -L "$SOCK_LINK" ] || [ -e "$SOCK_LINK" ]; then
  REAL_SOCK="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$SOCK_LINK" 2>/dev/null || true)"
fi
DAEMON_DIR="/private/tmp/codex-daemon-$(id -u)"
base() {
  cat <<EOP
(version 1)
(allow default)
;; Stage A guard rails. The user's real Codex state, the live Triangle install and the real managed daemon are off limits.
(deny file* (subpath "$HOME/.codex"))
(deny file* (subpath "$HOME/Library/Application Support/The Triangle"))
(deny file* (subpath "$HOME/Library/Logs/the-triangle"))
EOP
  if [ -n "$REAL_SOCK" ]; then
    printf '(deny file* (literal "%s"))\n(deny file* (literal "%s.lock"))\n' "$REAL_SOCK" "$REAL_SOCK"
  fi
  cat <<'EOP'
;; No internet: outbound IP is loopback only; unix sockets are open except the real daemon's.
(deny network-outbound)
(allow network-outbound (remote ip "localhost:*"))
(allow network-outbound (remote unix-socket))
EOP
  if [ -n "$REAL_SOCK" ]; then
    printf '(deny network-outbound (remote unix-socket (path-literal "%s")))\n' "$REAL_SOCK"
  fi
}
base > "$W/exp.sb"
{ base; printf '(deny file* (subpath "%s"))\n' "$DAEMON_DIR"; } > "$W/strict.sb"
if [ -n "$REAL_SOCK" ]; then G=yes; else G="no daemon socket found"; fi
echo "profiles written to $W (real daemon socket guarded: $G)"

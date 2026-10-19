#!/bin/bash
set -euo pipefail
archive=""; checksum=""; test_root=""
while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 ]] || { echo 'Usage: install.sh --archive FILE --sha256 HEX [--test-root TEMP_ROOT]' >&2; exit 64; }
  case "$1" in --archive) archive=$2;; --sha256) checksum=$2;; --test-root) test_root=$2;; *) echo 'Unknown install option' >&2; exit 64;; esac
  shift 2
done
[[ -n "$archive" && -n "$checksum" ]] || { echo '--archive and --sha256 are required; obtain the checksum through a trusted channel.' >&2; exit 64; }
script_root=$(cd "$(dirname "$0")" && pwd -P)
stage=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/triangle-package-verify.XXXXXX")
trap '/bin/rm -rf "$stage"' EXIT
/bin/chmod 700 "$stage"
/usr/bin/perl "$script_root/release/verify-client-package.pl" "$archive" "$checksum" "$stage" "$test_root"
args=(--verified-stage "$stage")
if [[ -n "$test_root" ]]; then args+=(--test-root "$test_root"); fi
"$stage/bin/node" "$stage/scripts/release/install-client-package.mjs" "${args[@]}"

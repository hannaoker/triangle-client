#!/bin/bash

set -euo pipefail

if [[ "${TRIANGLE_RUN_DISPOSABLE_KEYCHAIN_TEST:-}" != "1" ]]; then
  echo "Refusing live Keychain test without TRIANGLE_RUN_DISPOSABLE_KEYCHAIN_TEST=1." >&2
  exit 64
fi

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
package_dir="$(CDPATH= cd -- "$script_dir/.." && pwd)"
test_root="${TMPDIR%/}/triangle-mailbox-keychain-integration"
module_cache="$test_root/module-cache"
scratch_path="$test_root/build"

mkdir -p "$module_cache" "$scratch_path"

sdk_15_4="/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk"
if [[ -z "${SDKROOT:-}" && -d "$sdk_15_4" ]]; then
  export SDKROOT="$sdk_15_4"
fi
export CLANG_MODULE_CACHE_PATH="$module_cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$module_cache"

exec swift run \
  --disable-sandbox \
  --package-path "$package_dir" \
  --scratch-path "$scratch_path" \
  -j 1 \
  TriangleMailboxDisposableKeychainTest

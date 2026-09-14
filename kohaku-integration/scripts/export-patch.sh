#!/usr/bin/env bash
# Regenerate patches/ from the working tree in vendor/kohaku (after editing the SDK there).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$HERE/vendor/kohaku"
git -C "$VENDOR" add -A packages/plugins/src packages/tornado-cash/src
git -C "$VENDOR" diff --cached --binary -- packages/plugins/src packages/tornado-cash/src \
  > "$HERE/patches/0001-tornado-cash-relayer-signed-paymaster.patch"
git -C "$VENDOR" reset -q
echo "wrote $HERE/patches/0001-tornado-cash-relayer-signed-paymaster.patch"

#!/usr/bin/env bash
# Fetch the Kohaku SDK at the pinned commit, apply the thin-relayer patch and
# build the packages this integration links against (vendor/ is git-ignored).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$HERE/vendor/kohaku"
KOHAKU_REPO="${KOHAKU_REPO:-https://github.com/ethereum/kohaku.git}"
KOHAKU_COMMIT="$(cat "$HERE/patches/KOHAKU_COMMIT")"

if [ ! -d "$VENDOR/.git" ]; then
  echo ">> cloning $KOHAKU_REPO @ $KOHAKU_COMMIT"
  git clone --filter=blob:none "$KOHAKU_REPO" "$VENDOR"
fi
git -C "$VENDOR" fetch --depth 1 origin "$KOHAKU_COMMIT" 2>/dev/null || true
git -C "$VENDOR" checkout -q --force "$KOHAKU_COMMIT"
git -C "$VENDOR" clean -fdq -e node_modules -e dist

echo ">> applying patches"
for p in "$HERE"/patches/*.patch; do
  git -C "$VENDOR" apply --index "$p"
  echo "   applied $(basename "$p")"
done

echo ">> installing + building @kohaku-eth/{provider,plugins,mimc-tree,tornado-cash}"
(cd "$VENDOR" && pnpm install --ignore-scripts)
(cd "$VENDOR" && pnpm --filter @kohaku-eth/provider --filter @kohaku-eth/plugins --filter @kohaku-eth/mimc-tree build)
(cd "$VENDOR" && pnpm --filter @kohaku-eth/tornado-cash build)

echo ">> linking into this package"
(cd "$HERE/.." && pnpm install)
echo "done"

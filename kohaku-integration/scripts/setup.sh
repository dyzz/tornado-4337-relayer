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

echo ">> applying the SDK patch"
git -C "$VENDOR" apply --index "$HERE/patches/0001-tornado-cash-relayer-signed-paymaster.patch"
echo "   applied 0001-tornado-cash-relayer-signed-paymaster.patch"

echo ">> installing + building @kohaku-eth/{provider,plugins,mimc-tree,tornado-cash}"
(cd "$VENDOR" && pnpm install --ignore-scripts)
(cd "$VENDOR" && pnpm --filter @kohaku-eth/provider --filter @kohaku-eth/plugins --filter @kohaku-eth/mimc-tree build)
(cd "$VENDOR" && pnpm --filter @kohaku-eth/tornado-cash build)

echo ">> linking into this package"
(cd "$HERE/.." && pnpm install)
echo "done"

# --- Kohaku CLI (dmarzzz/kohaku-cli) with the relayer-paymaster patch, linked to the patched SDK ---
CLI="$HERE/vendor/kohaku-cli"
CLI_COMMIT="$(cat "$HERE/patches/KOHAKU_CLI_COMMIT")"
if [ ! -d "$CLI/.git" ]; then
  git clone --filter=blob:none https://github.com/dmarzzz/kohaku-cli.git "$CLI"
fi
git -C "$CLI" fetch --depth 1 origin "$CLI_COMMIT" 2>/dev/null || true
git -C "$CLI" checkout -q --force "$CLI_COMMIT"
git -C "$CLI" apply "$HERE/patches/0002-kohaku-cli-relayer-paymaster.patch"
(cd "$CLI" && npm install --no-audit --no-fund)
rm -rf "$CLI/node_modules/@kohaku-eth/tornado-cash" "$CLI/node_modules/@kohaku-eth/plugins"
ln -s ../../../kohaku/packages/tornado-cash "$CLI/node_modules/@kohaku-eth/tornado-cash"
ln -s ../../../kohaku/packages/plugins "$CLI/node_modules/@kohaku-eth/plugins"
(cd "$CLI" && npm run -s typecheck)
echo "kohaku-cli ready: (cd $CLI && npm run dev:prod -- --help)"

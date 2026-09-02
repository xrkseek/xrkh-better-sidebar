#!/usr/bin/env bash
# One-shot install for XRK-Harness.
# Usage: bash scripts/install-xrkh.sh [version]
set -euo pipefail
VERSION="${1:-latest}"
PKG="xrk-better-sidebar@${VERSION}"

if command -v xrkh >/dev/null 2>&1; then
  xrkh plugin add "$PKG"
  xrkh restart
else
  npx -y @xrkseek/harness-cli plugin add "$PKG"
  npx -y @xrkseek/harness-cli restart
fi

echo "Done. Hard-refresh the browser."

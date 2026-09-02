#!/usr/bin/env bash
set -euo pipefail
VERSION="${1:-latest}"
PKG="xrkh-better-sidebar@${VERSION}"
if command -v xrkh >/dev/null 2>&1; then
  xrkh plugin add "$PKG"
  xrkh restart
else
  npx -y @xrkseek/harness-cli plugin add "$PKG"
  npx -y @xrkseek/harness-cli restart
fi
echo "Done. Hard-refresh the browser."

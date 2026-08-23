#!/usr/bin/env bash
# Build web if stale, then start (or reuse) the server.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f web/dist/index.html ] || [ -n "$(find web/src web/index.html web/vite.config.ts -newer web/dist/index.html 2>/dev/null | head -1)" ]; then
  (cd web && npm run build)
fi
exec node server/index.ts

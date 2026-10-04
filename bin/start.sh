#!/usr/bin/env bash
# Build web if stale, then start (or reuse) the server.
set -euo pipefail
cd "$(dirname "$0")/.."

# Reuse: if a simon-dash server is already up (a hand-started one, or a
# previous launchd instance), exit 0 instead of starting a second one that
# would die on EADDRINUSE. Under launchd's KeepAlive { SuccessfulExit: false }
# a clean exit is not respawned, so this ends the 30s rebuild-and-fail loop.
# Same detection the CLI/MCP use (server/transport.ts): data/server.pid names
# a live pid AND a simon-dash API answers on the port recorded there. Both,
# so a stale pid file whose pid was reused by an unrelated process does not
# keep the real server from ever starting.
if node --input-type=module -e "
  import { readFileSync } from 'node:fs';
  import { serverAppearsRunning, probeServer } from './server/transport.ts';
  let port;
  try { port = JSON.parse(readFileSync('data/server.pid', 'utf8')).port; } catch { process.exit(1); }
  const pid = serverAppearsRunning('data/state.json');
  process.exit(pid && port && await probeServer(port) ? 0 : 1);
" 2>/dev/null; then
  echo "simon-dash: server already running (data/server.pid); not starting another"
  exit 0
fi

if [ ! -f web/dist/index.html ] || [ -n "$(find web/src web/index.html web/vite.config.ts -newer web/dist/index.html 2>/dev/null | head -1)" ]; then
  (cd web && npm run build)
fi
exec node server/index.ts

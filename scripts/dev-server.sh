#!/usr/bin/env bash
# Local dev helper: start API against a local Postgres.
set -euo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:5432/autopilot?schema=public}"
export PORT="${PORT:-8099}"
nohup npx tsx src/server.ts > /tmp/autopilot-api.log 2>&1 &
echo $! > /tmp/autopilot-api.pid
echo "started pid $(cat /tmp/autopilot-api.pid) on port $PORT"

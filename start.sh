#!/usr/bin/env bash
# Starts the database, the copy engine and the dashboard for a local run (after ./setup.sh).
# Press Ctrl+C to stop both. The database container keeps running; stop it with: docker stop gtc-db
# Usage: ./start.sh        (on Windows, run it from Git Bash)
set -euo pipefail
cd "$(dirname "$0")"
. scripts/local-common.sh

need_node
find_pnpm
need_docker
load_env
start_db

say "Applying any new database migrations"
$PNPM db:migrate

say "Starting the copy engine and the dashboard (Ctrl+C to stop)"
$PNPM dev:engine &
ENGINE_PID=$!
$PNPM dev:web &
WEB_PID=$!

stop() {
  trap - INT TERM EXIT
  # Signal the whole process group: pnpm does not always pass signals on to tsx and next.
  kill -TERM 0 2>/dev/null || true
}
trap stop INT TERM EXIT

printf '\n\033[1;32mDashboard: http://localhost:3000\033[0m (it can take a few seconds to compile)\n\n'

# If either process exits, stop the other too.
while kill -0 "$ENGINE_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null; do sleep 1; done
warn "The engine or the dashboard stopped; shutting down the other. See the output above."

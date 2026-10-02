#!/usr/bin/env bash
# One-time local setup for a SIMULATION run: installs dependencies, creates .env with fresh
# secrets, starts PostgreSQL in Docker, applies migrations, creates the owner login and seeds
# simulated accounts. Safe to run again; finished steps are skipped.
# Usage: ./setup.sh        (on Windows, run it from Git Bash)
set -euo pipefail
cd "$(dirname "$0")"
. scripts/local-common.sh

say "Checking tools"
need_node
find_pnpm
need_docker

say "Installing dependencies"
$PNPM install --frozen-lockfile

if [ ! -f .env ] && docker container inspect "$DB_CONTAINER" >/dev/null 2>&1; then
  die "A database container '$DB_CONTAINER' exists but .env is missing, so its password is unknown. Remove it with 'docker rm -f $DB_CONTAINER' (this deletes its data) and run ./setup.sh again."
fi

if [ ! -f .env ] || grep -q '^OWNER_EMAIL=owner@example.com' .env; then
  OWNER_EMAIL=""
  while ! printf '%s' "$OWNER_EMAIL" | grep -Eq '^[^@ ]+@[^@ ]+\.[^@ ]+$'; do
    read -r -p "Email for your dashboard login: " OWNER_EMAIL || die "No email entered."
  done
  export OWNER_EMAIL
fi

say "Writing .env"
node scripts/local-env.mjs

load_env
start_db

say "Applying database migrations"
$PNPM db:migrate

if [ "$(db_query 'select count(*) from "user"')" = "0" ]; then
  say "Creating your dashboard login ($OWNER_EMAIL)"
  while :; do
    read -r -s -p "Choose a password (at least 12 characters): " pw || die "No password entered."; echo
    if [ "${#pw}" -lt 12 ]; then warn "Too short, try again."; continue; fi
    read -r -s -p "Repeat the password: " pw2 || die "No password entered."; echo
    [ "$pw" = "$pw2" ] && break
    warn "Passwords do not match, try again."
  done
  # Sent on stdin so it never appears in the process list or shell history.
  printf '%s\n' "$pw" | GTC_OWNER_PASSWORD_STDIN=1 $PNPM owner:create
  unset pw pw2
else
  say "Dashboard login already exists, skipping"
fi

say "Adding simulated accounts"
$PNPM sim:seed

cat <<EOF

$(printf '\033[1;32m')Setup complete.$(printf '\033[0m')
Start the copier and dashboard with:   ./start.sh
Then open http://localhost:3000 and sign in as $OWNER_EMAIL.
Everything runs in SIMULATION mode: no broker is contacted and live trading is off.
EOF

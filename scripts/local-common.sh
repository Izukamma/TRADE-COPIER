# Shared helpers for setup.sh and start.sh (local SIMULATION runs). Sourced, not executed.
# Works with bash 3.2+ (macOS), Linux and Git Bash on Windows.

DB_CONTAINER="${GTC_DB_CONTAINER:-gtc-db}"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

need_node() {
  command -v node >/dev/null 2>&1 || die "Node.js is not installed. Install Node 22 or newer from https://nodejs.org and run this again."
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 22 ] || die "Node $major found; Node 22 or newer is required (https://nodejs.org)."
}

# Sets PNPM to a working pnpm command, falling back to Corepack (ships with Node).
find_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    PNPM="pnpm"
  elif command -v corepack >/dev/null 2>&1; then
    PNPM="corepack pnpm"
  else
    die "pnpm is not available. Run: npm install -g pnpm"
  fi
}

need_docker() {
  command -v docker >/dev/null 2>&1 || die "Docker is not installed. Install Docker Desktop from https://www.docker.com/products/docker-desktop"
  docker info >/dev/null 2>&1 || die "Docker is installed but not running. Start Docker Desktop and run this again."
}

load_env() {
  [ -f .env ] || die ".env not found. Run ./setup.sh first."
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
  [ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is missing from .env"
  # Split DATABASE_URL so the container is created with matching credentials.
  eval "$(node -e '
    const u = new URL(process.env.DATABASE_URL);
    const q = (s) => "\x27" + s.replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
    console.log(`DB_USER=${q(decodeURIComponent(u.username))}`);
    console.log(`DB_PASS=${q(decodeURIComponent(u.password))}`);
    console.log(`DB_NAME=${q(u.pathname.slice(1))}`);
    console.log(`DB_PORT=${q(u.port || "5432")}`);
  ')"
}

# Creates (first run) or starts the PostgreSQL 16 container, then waits until it accepts connections.
start_db() {
  if docker container inspect "$DB_CONTAINER" >/dev/null 2>&1; then
    if [ "$(docker container inspect -f '{{.State.Running}}' "$DB_CONTAINER")" != "true" ]; then
      say "Starting database container '$DB_CONTAINER'"
      docker start "$DB_CONTAINER" >/dev/null
    fi
  else
    say "Creating database container '$DB_CONTAINER' (PostgreSQL 16, port $DB_PORT)"
    docker run -d --name "$DB_CONTAINER" \
      -e POSTGRES_USER="$DB_USER" -e POSTGRES_PASSWORD="$DB_PASS" -e POSTGRES_DB="$DB_NAME" \
      -p "127.0.0.1:$DB_PORT:5432" \
      postgres:16 >/dev/null \
      || die "Could not start the database (see the message above). If port $DB_PORT is already in use, delete .env and run: GTC_DB_PORT=5433 ./setup.sh"
  fi
  local i=0
  # -h 127.0.0.1: the image's temporary init server only listens on the Unix socket.
  until docker exec "$DB_CONTAINER" pg_isready -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -le 60 ] || die "The database did not become ready. Check: docker logs $DB_CONTAINER"
    sleep 1
  done
}

db_query() {
  docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "$1"
}

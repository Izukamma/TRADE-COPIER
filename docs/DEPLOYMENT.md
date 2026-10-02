# Deployment and local development

## Components

| Service | What it does | Port |
|---|---|---|
| `db` | PostgreSQL 16: configuration, durable events, execution queue, links, audit | internal 5432 |
| `engine` | Long-running copier (Node 22): adapters, watcher, router, executor, reconciliation, risk, MT bridge endpoint. Runs migrations at start. Single instance enforced by a PostgreSQL advisory lock. | internal 8787 (`/bridge/*`) |
| `web` | Next.js dashboard (owner-only). Never talks to brokers; writes intent to `control_commands`. | internal 3000 |
| `caddy` | TLS (Let's Encrypt) and routing: `/bridge/*` → engine, everything else → web | 80/443 |

Copying runs entirely in `engine`; closing the browser or stopping `web` does not stop it.

## Production (single Linux server, Docker Compose)

```bash
git clone <repo> gtc && cd gtc
cp .env.example .env
pnpm keys:generate            # or: docker run --rm node:22 node -e "..." — prints secrets; paste into .env
$EDITOR .env                  # GTC_DOMAIN, BETTER_AUTH_URL, PUBLIC_BRIDGE_URL, OWNER_EMAIL, secrets
chmod 600 .env
docker compose up -d --build
docker compose ps             # all services healthy
# Create the single owner (password is prompted, not echoed):
docker compose exec -w /app/apps/web engine /app/node_modules/.bin/tsx scripts/create-owner.ts
```

Then open `https://<GTC_DOMAIN>`, sign in, and enable TOTP under **Settings**.

DNS: an A/AAAA record for `GTC_DOMAIN` pointing at the server; ports 80/443 open for Caddy.
Behind a TLS-intercepting proxy, build with `--secret id=extra_ca,src=/path/ca.pem`.

### Secrets

- `GTC_ENCRYPTION_KEYS` / `GTC_ENCRYPTION_ACTIVE_KEY_ID`: AES-256-GCM key ring for stored
  credentials, session tokens and device-token secrets. It lives only in the environment (or a
  secret manager); the database alone cannot decrypt anything. Back it up separately from the
  database — losing it means re-entering credentials and re-issuing device tokens.
- Key rotation: add a new key (`k2:<base64>,k1:<base64>`), set `GTC_ENCRYPTION_ACTIVE_KEY_ID=k2`,
  restart; new writes use `k2`, old values still decrypt. Re-save credentials to migrate, then
  drop `k1`.
- `BETTER_AUTH_SECRET`: session signing; rotating it signs everyone out.
- Never put real values in `.env.example`, screenshots, logs or tickets.

### Live execution

Defaults to **disabled**. Real-money follower orders require *both*:
1. `LIVE_TRADING_ENABLED=true` in the engine environment (restart), and
2. arming each LIVE follower account in the dashboard with a typed confirmation.
Masters on LIVE accounts are read-only and do not need arming.

### Backups and upgrades

```bash
docker compose exec db pg_dump -U gtc gtc | gzip > backup-$(date +%F).sql.gz
git pull && docker compose up -d --build     # engine applies new migrations at start
```
Stop the engine before restoring a backup. Upgrades restart the engine: in-flight submissions
are reconciled on the next start (see ARCHITECTURE.md › Recovery).

## Local development

Requirements: Node 22+, pnpm 10, PostgreSQL 16 (or `docker compose up -d db` with a published port).

```bash
pnpm install
cp .env.example .env && pnpm keys:generate     # paste values; set DATABASE_URL, BETTER_AUTH_URL=http://localhost:3000
export $(grep -v '^#' .env | xargs)             # or use direnv
pnpm db:migrate
pnpm owner:create                               # prompts for password
pnpm sim:seed                                   # optional: two SIMULATION accounts + group
pnpm dev:engine                                 # terminal 1
pnpm dev:web                                    # terminal 2 → http://localhost:3000
```

Useful commands:

| Command | Purpose |
|---|---|
| `pnpm typecheck` | TypeScript across all packages |
| `pnpm test` | all tests (integration tests need `DATABASE_URL_TEST`, default `postgres://postgres@127.0.0.1:5432/gtc_test`) |
| `pnpm test:unit` / `pnpm test:integration` | one project |
| `pnpm db:generate` | new migration from `packages/db/src/schema.ts` |
| `pnpm evidence -- --route <id> --since <iso>` | redacted evidence bundle for demo validation |
| `pnpm e2e:ui` | browser flow in SIMULATION (needs `playwright`, running web + engine) |

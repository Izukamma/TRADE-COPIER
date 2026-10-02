# Interfaces

The system has three interfaces. None of them is a public API.

## 1. Bridge endpoint (engine, for MT4/MT5 EAs)

`POST /bridge/v1/sync` — see [BRIDGE_PROTOCOL.md](BRIDGE_PROTOCOL.md).
`GET /healthz` — engine liveness for container health checks (blocked at Caddy).

## 2. Dashboard → engine control channel (`control_commands` table)

The dashboard never calls brokers. Owner actions that need the engine insert a row; the engine
claims it (`PENDING → RUNNING → DONE|FAILED`), stores a result JSON, and writes an audit record.
Results are visible under Diagnostics → Engine requests.

| kind | payload | effect |
|---|---|---|
| `RELOAD` | `{}` | reload accounts/routes/mappings now (otherwise every 3 s) |
| `TEST_CONNECTION` | `{accountId}` | force reconnect, wait ≤ 20 s, return status, balance, latency, capabilities |
| `SYNC_INSTRUMENTS` | `{accountId, symbols?}` | fetch symbol list and specs (API platforms: only listed/mapped symbols) |
| `CLOSE_COPIER_POSITIONS` | `{scope: GLOBAL\|GROUP\|ROUTE\|ACCOUNT, id?}` | pause entries in scope, then close/cancel only copier-linked follower trades |
| `COPY_EXISTING` | `{routeId}` | explicit copy of master positions already open (bypasses entry age) |
| `RESOLVE_JOB` | `{jobId, note}` | mark a `NEEDS_ATTENTION` job resolved after manual verification |
| `DETACH_LINK` | `{linkId}` | stop managing one follower position |
| `SIM_ACTION` | `{accountId, action: OPEN\|PENDING\|MODIFY\|CLOSE\|CANCEL\|SET_PRICE\|DEPOSIT, …}` | SIMULATION accounts only |
| `SIM_FAULTS` | `{accountId, faults}` | simulator fault injection (reject / lost response / not sent / latency) |

The engine itself issues `CLOSE_COPIER_POSITIONS` when a daily-loss limit is configured with
"pause entries and close copier positions".

## 3. Dashboard HTTP

| Route | Auth | Notes |
|---|---|---|
| `/login` | public | email + password, then TOTP if enabled |
| `/api/auth/*` | Better Auth | sign-up disabled; sign-in rate limited (5 / 5 min / IP) |
| `/api/history/export` | owner session | CSV of copied trades (no secrets), audited |
| all pages | owner session | server-side check in the `(app)` layout and every server action |

Server actions (`apps/web/src/actions/*`) are wrapped by `ownerAction()`: owner check, Zod
validation, redacted error messages, audit log entry. Next.js additionally rejects cross-origin
server-action POSTs.

## Database (selected tables)

`trading_accounts`, `device_tokens`, `bridge_nonces`, `instruments`, `copier_groups`, `routes`,
`symbol_mappings`, `master_snapshots`, `master_events`, `execution_jobs`, `job_transitions`,
`copy_links`, `bridge_commands`, `app_settings`, `daily_baselines`, `alerts`,
`control_commands`, `engine_heartbeats`, `connection_events`, `engine_logs`, `audit_log`, plus
Better Auth's `user`, `session`, `account`, `verification`, `two_factor`.
Schema: `packages/db/src/schema.ts`; migrations: `packages/db/migrations/`.

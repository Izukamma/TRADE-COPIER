# CHECKPOINT

_Last updated: 2026-10-02 · branch `claude/youthful-cerf-6308rh`_

## Stage status

| Stage | Status |
|---|---|
| 1. Repository, database, authentication, dashboard, engine foundation, simulator | **Done** — tested (unit + integration + browser E2E in SIMULATION) |
| 2. Real read-only auth + account/instrument sync for TradeLocker and Match-Trader | **Implemented, not verified** — blocked on demo credentials |
| 3. One complete API-platform demo-to-demo route (TradeLocker → TradeLocker) | **Code complete, not validated** — blocked on two TradeLocker demo accounts |
| 4. Remaining TradeLocker / Match-Trader routes | TradeLocker implemented; Match-Trader partial (documented endpoints only) — blocked on documentation/account access |
| 5. MT4 and MT5 bridges | **EA source + engine side done**; engine side tested with fake EA; EAs not compiled — blocked on a Windows/MetaTrader environment |
| 6. Cross-platform validation, recovery testing, deployment hardening | Recovery tested in simulation; Docker images build and run; single-instance lock; cross-platform on real platforms pending |

## Completed

- pnpm TypeScript monorepo: `apps/engine`, `apps/web`, `packages/{shared,db,adapters}`, `bridges/{mql4,mql5}`.
- PostgreSQL schema + migrations (`0000_init`, `0001_two_factor_lockout`); durable job queue with per-trade ordering, leases and `SKIP LOCKED`.
- Engine: master snapshot diff with deduplicated durable events, baseline (no copying of existing positions unless explicitly requested), loop/duplicate prevention, router, deterministic planner, execution state machine (DETECTED/QUEUED/SUBMITTED/ACCEPTED/FILLED/REJECTED/UNKNOWN/RECONCILED + SKIPPED/NEEDS_ATTENTION), reconciliation before retry, bounded retries with backoff, restart recovery, link monitor (divergence never re-opened), risk (pauses per follower/group/global with exits continuing, daily loss with explicit timezone/basis/floating/baseline/action, exposure, max positions, margin, stale data/quotes), close-copier-positions action, heartbeat, redacted logs, retention, single-instance advisory lock.
- Adapters: simulator (fault injection), TradeLocker (official SDK paths), Match-Trader (documented endpoints; unknown paths configurable, unverified bodies gated), MT bridge (signed device tokens, durable command outbox, idempotent EA delivery).
- Sizing: fixed, normalised multiplier, equity-proportional, risk-% with contract/currency conversion; step rounding never up past caps; symbol suggestions (US30/NAS100/SPX500 aliases), validation of contract/tick/currency/price basis; SL/TP absolute or distance policies validated against stop distances.
- Dashboard: all requested pages, owner-only Better Auth (sign-up disabled, TOTP, rate-limited sign-in), server-side authorization on every page/action/route, encrypted write-only credentials, device tokens, sizing preview gating activation, SIMULATION/DEMO/LIVE badges, status from live engine data only.
- MQL5 and MQL4 EAs (HMAC-signed requests, signed responses, tag + command-id dedup, magic-number guard, MT4 remainder tickets).
- Docker Compose (db, engine, web, Caddy TLS), `.env.example` with placeholders.
- Docs: architecture, deployment, Windows VPS, bridge protocol, interfaces, security, platform notes with sources, compatibility matrix, known limitations, test results, demo validation procedure.
- Tests: 109 automated (14 files), two consecutive green runs; browser E2E in SIMULATION; Docker images built and stack started.

## Blockers (concrete)

1. **No platform credentials/terminals** were available, so nothing has been validated on a real
   demo account. Required: two TradeLocker demo accounts (email, password, server, account id)
   entered **in the dashboard** (never in chat).
2. **Vendor documentation hosts blocked** from the development network
   (`public-api.tradelocker.com`, `docs.match-trade.com`, `app.theneo.io`). TradeLocker was
   implemented from the official SDK source; Match-Trader only from documentation excerpts.
   Missing Match-Trader details: symbols, quotes, partial-close and pending-order paths, edit/close
   bodies, rate limits.
3. **No Windows/MetaTrader environment**: the EAs are uncompiled.
4. Docker Hub rate-limited the `caddy` image pull in the sandbox; Caddy/TLS not started here.

## Next exact action

Deploy (or run locally), create two **TradeLocker demo** accounts in the dashboard with
platform TradeLocker / mode DEMO / base URL `https://demo.tradelocker.com`, store their
credentials on each account page, press **Test connection**, then **Sync instruments** with the
symbol you will map (e.g. `US30`). Check the instrument specification gaps shown on the account
page and correct `parseTradeLockerInstrument` field names in
`packages/adapters/src/tradelocker/adapter.ts` if needed; then follow
[docs/DEMO_VALIDATION.md](docs/DEMO_VALIDATION.md) and export evidence with `pnpm evidence`.

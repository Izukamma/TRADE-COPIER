# Test results

Generated from `pnpm test` (Vitest 3.2.7) on 2026-10-02 in the development container
(Node 22.22, PostgreSQL 16.10 local). Two consecutive full runs: **14 files, 109 tests, all passed**
(≈51 s each). TypeScript `pnpm typecheck` passed for all packages; `next build` passed.

## What kind of evidence each suite is

| Suite | Kind | Touches a broker? |
|---|---|---|
| `packages/shared/test/*` | Pure unit tests (sizing, rounding, mapping, crypto, risk, routing, state machine) | No |
| `packages/adapters/test/tradelocker.test.ts` | **Mocked HTTP** server implementing the paths of the official TradeLocker SDK | No — mock |
| `packages/adapters/test/matchtrader-sim.test.ts` | **Mocked HTTP** Match-Trader responses + simulator broker | No — mock |
| `apps/engine/test/unit/*` | Snapshot diff and deterministic planner | No |
| `apps/engine/test/integration/copying.test.ts` | Real engine + **real PostgreSQL** + **simulated brokers** | No — SIMULATION |
| `apps/engine/test/integration/restart.test.ts` | Engine stop/start, crash mid-submission, queue ordering (PostgreSQL) | No — SIMULATION |
| `apps/engine/test/integration/bridge.test.ts` | Real bridge HTTP server + **fake EA written in TypeScript** | No — the MQL EAs were not run |
| `apps/web/test/unit/*` | Authorization wrapper and status display with mocked session | No |
| `apps/web/test/integration/auth.test.ts` | **Real Better Auth** + PostgreSQL through its HTTP handler | No |

None of these results is evidence that copying works against a real TradeLocker, Match-Trader,
MT4 or MT5 account. See [DEMO_VALIDATION.md](DEMO_VALIDATION.md) for the procedure that produces
that evidence once demo credentials / terminals are available.

## Additional manual checks performed

- Engine + dashboard run locally against PostgreSQL; browser end-to-end flow
  (`scripts/e2e/ui-simulation-flow.mjs`, Playwright/Chromium) passed: create two SIMULATION
  accounts → group → follower → activation refused before preview → mapping US30→DJ30.cash
  confirmed → sizing preview 0.3 lots → activate → master trade → follower copy OPEN.
- Unauthenticated requests: `/` redirects to `/login`; `/api/history/export` → 401; forged
  session cookie → redirect/401; `POST /api/auth/sign-up/email` → 400 (sign-up disabled).
- Second engine instance refuses to start (PostgreSQL advisory lock).
- `docker build --target engine` and `--target web` succeeded; `docker compose up db engine web`
  reached healthy state; owner created inside the container; sign-in returned a
  `__Secure-gtc.session_token` cookie. (Caddy image pull was rate-limited by Docker Hub in the
  sandbox, so the TLS proxy itself was not started.)
- Screenshots of the running dashboard are in [`docs/screenshots/`](screenshots/).

## Bugs found by the tests and fixed

1. Partial close with `KEEP_MIN`: a remainder that rounded to zero closed the whole follower
   position although the master still held part of it (planner unit test).
2. Route activation race: the master baseline snapshot could be taken up to one follower refresh
   interval late, so a trade opened right after activation was treated as pre-existing
   (browser E2E). Accounts becoming masters now snapshot immediately.
3. Better Auth two-factor table was missing columns required by the current library version
   (detected at owner creation); migration `0001` adds them.

## Full verbose listing (last run)

```
 ✓ |unit| packages/shared/test/misc.test.ts > secret encryption > round-trips and binds to the record (AAD) 3ms
 ✓ |unit| packages/shared/test/misc.test.ts > secret encryption > rejects bad key configuration 4ms
 ✓ |unit| packages/shared/test/misc.test.ts > device tokens and signatures > generates parseable tokens and verifies HMAC signatures in constant time 2ms
 ✓ |unit| packages/shared/test/misc.test.ts > redaction > removes secrets from objects and strings 1ms
 ✓ |unit| packages/shared/test/misc.test.ts > copier tags > is deterministic and recognisable 1ms
 ✓ |unit| packages/shared/test/misc.test.ts > route graph > blocks self-copy, duplicates, chains and loops 1ms
 ✓ |unit| packages/shared/test/misc.test.ts > execution state machine > distinguishes acceptance from fills and forces reconciliation of UNKNOWN 0ms
 ✓ |unit| packages/shared/test/misc.test.ts > daily loss > computes trading-day keys in the reset timezone 16ms
 ✓ |unit| packages/shared/test/misc.test.ts > daily loss > evaluates balance vs equity basis and floating P&L treatment 2ms
 ✓ |unit| apps/engine/test/unit/planner.test.ts > planner: entries > plans a normalised market entry with mapped SL/TP 8ms
 ✓ |unit| apps/engine/test/unit/planner.test.ts > planner: entries > rejects stale entries (no replay after reconnect) 1ms
 ✓ |unit| apps/engine/test/unit/planner.test.ts > planner: entries > explicit existing-position copies bypass the age check 0ms
 ✓ |unit| apps/engine/test/unit/planner.test.ts > planner: entries > skips entries while paused at any level 1ms
 ✓ |unit| apps/engine/test/unit/planner.test.ts > planner: entries > enforces the LIVE gate 1ms
 ✓ |unit| apps/engine/test/unit/planner.test.ts > planner: entries > applies mandatory SL, direction, symbol and EA filters 1ms
 ✓ |unit| apps/engine/test/unit/planner.test.ts > planner: entries > rejects price deviation beyond the limit and unconfirmed mappings 0ms
 ✓ |unit| apps/engine/test/unit/planner.test.ts > planner: entries > rejects invalid stop distances rather than dropping the SL 0ms
 ✓ |unit| apps/engine/test/unit/planner.test.ts > planner: entries > blocks netting followers unless symbols are exclusive and free of unrelated positions 1ms
 ✓ |unit| apps/engine/test/unit/planner.test.ts > planner: entries > enforces exposure caps without rounding past them and max positions 1ms
 ✓ |unit| apps/engine/test/unit/planner.test.ts > planner: entries > refuses stale follower account data 0ms
 ✓ |unit| apps/engine/test/unit/planner.test.ts > planner: entries > suppresses duplicate entries when a link exists 0ms
 ✓ |unit| apps/engine/test/unit/planner.test.ts > planner: entries > does not substitute order types the follower lacks 0ms
 ✓ |unit| apps/engine/test/unit/planner.test.ts > planner: management continues while entries are paused > copies closes, partial closes and SL/TP changes while paused 1ms
 ✓ |unit| apps/engine/test/unit/planner.test.ts > planner: management continues while entries are paused > never re-opens a diverged (manually closed) follower position 0ms
 ✓ |unit| apps/engine/test/unit/planner.test.ts > planner: management continues while entries are paused > cancels the follower pending order when the master cancels 0ms
 ✓ |unit| apps/engine/test/unit/planner.test.ts > planner: management continues while entries are paused > owner close-all applies even when close copying is disabled 0ms
 ✓ |unit| apps/engine/test/unit/planner.test.ts > partial close quantities > keeps remaining exposure proportional or below, respecting the step 0ms
 ✓ |unit| packages/adapters/test/matchtrader-sim.test.ts > Match-Trader adapter (mocked HTTP, not a real account) > logs in, sends Auth-trading-api header and parses balance/positions 1010ms
 ✓ |unit| apps/web/test/unit/authz.test.ts > owner-only authorization > matches the owner email case-insensitively and requires a user id 1ms
 ✓ |unit| apps/web/test/unit/authz.test.ts > owner-only authorization > server actions refuse requests without an owner session and never run the handler 3ms
 ✓ |unit| apps/web/test/unit/authz.test.ts > owner-only authorization > runs for the owner and writes an audit record with the client IP 3ms
 ✓ |unit| apps/web/test/unit/authz.test.ts > owner-only authorization > does not leak secrets from thrown errors 0ms
 ✓ |unit| apps/web/test/unit/authz.test.ts > owner-only authorization > requireOwner throws and requireOwnerPage redirects for non-owners 2ms
 ✓ |unit| apps/engine/test/unit/diff.test.ts > master snapshot diff > detects open, modify, partial close and close with deterministic keys 4ms
 ✓ |unit| apps/engine/test/unit/diff.test.ts > master snapshot diff > ignores copier-tagged trades and linked follower positions (loop prevention) 1ms
 ✓ |unit| apps/engine/test/unit/diff.test.ts > master snapshot diff > links a filled pending order to its position and keeps the order id as master key 1ms
 ✓ |unit| apps/engine/test/unit/diff.test.ts > master snapshot diff > reports cancelled pending orders and modifications 0ms
 ✓ |unit| apps/engine/test/unit/diff.test.ts > master snapshot diff > splits a netting reversal into close + new open with a distinct key 0ms
 ✓ |unit| apps/engine/test/unit/diff.test.ts > master snapshot diff > detects scale-ins separately 0ms
 ✓ |unit| apps/engine/test/unit/diff.test.ts > MT4 partial close (remainder gets a new ticket) > is a partial close of the original trade, not close + new open 0ms
 ✓ |unit| apps/engine/test/unit/diff.test.ts > MT4 partial close (remainder gets a new ticket) > excludes copier magic numbers even when the comment was rewritten 0ms
 ✓ |unit| packages/shared/test/sizing.test.ts > sizing across contract specifications and currencies > value per point converts tick value into the account currency 2ms
 ✓ |unit| packages/shared/test/sizing.test.ts > sizing across contract specifications and currencies > fixed lots are respected and rounded down to the follower step 1ms
 ✓ |unit| packages/shared/test/sizing.test.ts > sizing across contract specifications and currencies > normalised multiplier converts exposure, not lots (equal lots != equal exposure) 0ms
 ✓ |unit| packages/shared/test/sizing.test.ts > sizing across contract specifications and currencies > raw lot multiplier is refused when specs differ 0ms
 ✓ |unit| packages/shared/test/sizing.test.ts > sizing across contract specifications and currencies > equity-proportional sizing converts master equity into follower currency 0ms
 ✓ |unit| packages/shared/test/sizing.test.ts > sizing across contract specifications and currencies > risk sizing uses SL distance, tick value and currency, rounding down 1ms
 ✓ |unit| packages/shared/test/sizing.test.ts > sizing across contract specifications and currencies > risk sizing rejects entries without a stop loss 0ms
 ✓ |unit| packages/shared/test/sizing.test.ts > sizing across contract specifications and currencies > risk sizing rejects when the minimum lot would exceed the risk budget 0ms
 ✓ |unit| packages/shared/test/sizing.test.ts > sizing across contract specifications and currencies > refuses sizing when FX conversion is unavailable 0ms
 ✓ |unit| packages/shared/test/sizing.test.ts > sizing across contract specifications and currencies > refuses non-fixed sizing when tick value data is unverified 0ms
 ✓ |unit| packages/shared/test/sizing.test.ts > sizing across contract specifications and currencies > applies the max order cap 0ms
 ✓ |unit| packages/shared/test/sizing.test.ts > sizing across contract specifications and currencies > EURUSD in a GBP account: contract-size path when tick data is missing 0ms
 ✓ |unit| packages/shared/test/symbols.test.ts > symbol mapping > canonicalises broker suffixes 2ms
 ✓ |unit| packages/shared/test/symbols.test.ts > symbol mapping > suggests index mappings across naming conventions without auto-confirming 2ms
 ✓ |unit| packages/shared/test/symbols.test.ts > symbol mapping > flags differing contract specs between Dow CFDs and a price-basis mismatch 1ms
 ✓ |unit| packages/shared/test/symbols.test.ts > symbol mapping > errors when FX conversion is required but missing 0ms
 ✓ |unit| packages/shared/test/symbols.test.ts > symbol mapping > maps SL/TP by absolute price or by distance from entry 0ms
 ✓ |unit| packages/shared/test/symbols.test.ts > symbol mapping > validates stop distances and direction 0ms
 ✓ |unit| packages/adapters/test/tradelocker.test.ts > TradeLocker adapter (mocked HTTP, not a real account) > authenticates, resolves accNum, loads config and maps column arrays 2016ms
 ✓ |unit| packages/adapters/test/matchtrader-sim.test.ts > Match-Trader adapter (mocked HTTP, not a real account) > opens with the documented body and refuses unverified operations by default 1006ms
 ✓ |unit| packages/shared/test/volume.test.ts > volume rounding > rounds down to the step without float artefacts 2ms
 ✓ |unit| packages/shared/test/volume.test.ts > volume rounding > never rounds up below the minimum 0ms
 ✓ |unit| packages/shared/test/volume.test.ts > volume rounding > rejects instead of rounding up when the minimum exceeds a hard cap (risk) 0ms
 ✓ |unit| packages/shared/test/volume.test.ts > volume rounding > caps at max volume and order cap 0ms
 ✓ |unit| packages/shared/test/volume.test.ts > volume rounding > handles coarse steps (indices with 0.1 / 1 lot steps) 0ms
 ✓ |unit| packages/shared/test/volume.test.ts > volume rounding > nearest mode never exceeds the cap 0ms
 ✓ |unit| packages/shared/test/volume.test.ts > volume rounding > floors partial-close quantities and handles tiny steps 0ms
 ✓ |unit| packages/shared/test/volume.test.ts > volume rounding > rounds prices onto the tick grid 0ms
 ✓ |unit| apps/web/test/unit/status.test.ts > dashboard status display > never shows CONNECTED from a saved record alone 1ms
 ✓ |unit| apps/web/test/unit/status.test.ts > dashboard status display > labels modes distinctly 0ms
 ✓ |unit| apps/web/test/unit/status.test.ts > dashboard status display > treats a missing or old heartbeat as engine offline 0ms
 ✓ |unit| packages/adapters/test/tradelocker.test.ts > TradeLocker adapter (mocked HTTP, not a real account) > places market orders with the SDK body shape and strategyId tag; acceptance is not a fill 1006ms
 ✓ |unit| packages/adapters/test/tradelocker.test.ts > TradeLocker adapter (mocked HTTP, not a real account) > classifies 5xx and timeouts on order placement as UNKNOWN (reconcile before retry) 2008ms
 ✓ |unit| packages/adapters/test/matchtrader-sim.test.ts > Match-Trader adapter (mocked HTTP, not a real account) > reconciles tag-less opens only when exactly one new position matches 3007ms
 ✓ |unit| packages/adapters/test/matchtrader-sim.test.ts > simulator broker > enforces volume steps and stop distances and supports netting 2ms
 ✓ |unit| packages/adapters/test/matchtrader-sim.test.ts > simulator broker > reconciles lost responses by tag 1ms
 ✓ |unit| packages/adapters/test/tradelocker.test.ts > TradeLocker adapter (mocked HTTP, not a real account) > classifies 429 and refused connections as retryable rejections, 400 as final 3010ms
 ✓ |unit| packages/adapters/test/tradelocker.test.ts > TradeLocker adapter (mocked HTTP, not a real account) > reconciles an ambiguous submission through order history by tag 2004ms
 ✓ |unit| packages/adapters/test/tradelocker.test.ts > TradeLocker adapter (mocked HTTP, not a real account) > refreshes tokens that are close to expiry 2005ms
 ✓ |unit| packages/adapters/test/tradelocker.test.ts > TradeLocker adapter (mocked HTTP, not a real account) > closes positions with qty and partial qty 1003ms
 ✓ |unit| packages/adapters/test/tradelocker.test.ts > TradeLocker adapter (mocked HTTP, not a real account) > parses instrument details defensively and marks unverified fields 1ms
 ✓ |unit| packages/adapters/test/tradelocker.test.ts > TradeLocker adapter (mocked HTTP, not a real account) > refuses non-https base URLs 1ms
 ✓ |unit| packages/adapters/test/tradelocker.test.ts > HTTP classification and rate limiting > treats a GET timeout as not-sent and a mutation timeout as ambiguous 1ms
 ✓ |unit| packages/adapters/test/tradelocker.test.ts > HTTP classification and rate limiting > sliding window waits for a slot and gives up past the allowed wait 202ms
 ✓ |integration| apps/engine/test/integration/copying.test.ts > copying pipeline (simulation) > copies entry, SL/TP modification, partial close and full close 2164ms
 ✓ |integration| apps/engine/test/integration/copying.test.ts > copying pipeline (simulation) > does not copy pre-existing master positions on first connection, and never replays them 1527ms
 ✓ |integration| apps/engine/test/integration/copying.test.ts > copying pipeline (simulation) > deduplicates events and routes each (event, route) once 1406ms
 ✓ |integration| apps/engine/test/integration/copying.test.ts > copying pipeline (simulation) > processes a rapid open/modify/close sequence in order 1806ms
 ✓ |integration| apps/engine/test/integration/copying.test.ts > copying pipeline (simulation) > copies pending orders and their cancellation 1718ms
 ✓ |integration| apps/engine/test/integration/copying.test.ts > copying pipeline (simulation) > ambiguous submission timeout: reconciles instead of resubmitting (no duplicate) 2323ms
 ✓ |integration| apps/engine/test/integration/copying.test.ts > copying pipeline (simulation) > rejected orders are recorded and not retried; not-sent failures are retried with a bound 2434ms
 ✓ |integration| apps/engine/test/integration/copying.test.ts > copying pipeline (simulation) > pausing entries skips new trades while exits and SL changes continue 2225ms
 ✓ |integration| apps/engine/test/integration/copying.test.ts > copying pipeline (simulation) > rejects stale entries (master trade older than max entry age) 900ms
 ✓ |integration| apps/engine/test/integration/copying.test.ts > copying pipeline (simulation) > follower disconnect: exits wait and complete after reconnection 6381ms
 ✓ |integration| apps/engine/test/integration/copying.test.ts > copying pipeline (simulation) > detects divergence and never re-opens a manually closed follower position 2359ms
 ✓ |integration| apps/engine/test/integration/copying.test.ts > copying pipeline (simulation) > refuses netting followers unless exclusive symbols are acknowledged 940ms
 ✓ |integration| apps/engine/test/integration/copying.test.ts > copying pipeline (simulation) > daily loss limit pauses new entries while exits continue 1165ms
 ✓ |integration| apps/engine/test/integration/copying.test.ts > copying pipeline (simulation) > close copier positions closes only copier-managed trades and pauses entries 1251ms
 ✓ |integration| apps/engine/test/integration/restart.test.ts > engine restart recovery (simulation + PostgreSQL) > continues managing copier positions opened before a restart 1732ms
 ✓ |integration| apps/engine/test/integration/restart.test.ts > engine restart recovery (simulation + PostgreSQL) > events that happened while the engine was down: closes are applied, stale entries are not replayed 1148ms
 ✓ |integration| apps/engine/test/integration/restart.test.ts > engine restart recovery (simulation + PostgreSQL) > a job left SUBMITTED by a crash is reconciled (not resubmitted) 4000ms
 ✓ |integration| apps/engine/test/integration/restart.test.ts > engine restart recovery (simulation + PostgreSQL) > queue claims respect per-trade ordering and leases 135ms
 ✓ |integration| apps/engine/test/integration/bridge.test.ts > MetaTrader bridge protocol (fake EA) > authenticates signed requests and rejects bad signatures, replays, skew, revoked tokens and wrong logins 289ms
 ✓ |integration| apps/engine/test/integration/bridge.test.ts > MetaTrader bridge protocol (fake EA) > delivers commands to the EA and applies its results (MT5 follower of a simulated master) 3017ms
 ✓ |integration| apps/web/test/integration/auth.test.ts > authentication (Better Auth, real database) > public sign-up is disabled 19ms
 ✓ |integration| apps/web/test/integration/auth.test.ts > authentication (Better Auth, real database) > owner signs in and receives an httpOnly session cookie; the session resolves to the owner 119ms
 ✓ |integration| apps/web/test/integration/auth.test.ts > authentication (Better Auth, real database) > forged session cookies do not authenticate 1ms
 ✓ |integration| apps/web/test/integration/auth.test.ts > authentication (Better Auth, real database) > wrong passwords fail and repeated attempts are rate limited 523ms
 Test Files  14 passed (14)
      Tests  109 passed (109)
   Duration  55.17s (transform 980ms, setup 0ms, collect 3.19s, tests 58.14s, environment 4ms, prepare 783ms)
```

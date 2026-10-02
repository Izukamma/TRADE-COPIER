# TradeLocker connector

**Status: IMPLEMENTED, NOT VERIFIED against a real account.** Exercised only with a mocked HTTP
server in automated tests. No TradeLocker credentials were available, and the vendor hosts
(`*.tradelocker.com`) were blocked from the development environment's network.

## Sources consulted

| Source | What was taken from it |
|---|---|
| Official Python SDK `tradelocker` **0.56.2** on PyPI (source read in full), repository <https://github.com/TradeLocker/tradelocker-python> | Every endpoint path, the `accNum` header, auth/refresh bodies, order body fields, column-config mechanism, rate-limit config, IOC/GTC rules, `strategyId` (≤ 32 chars) |
| Public reference <https://public-api.tradelocker.com/> (search snippets only; site blocked here) | Base URLs `https://demo.tradelocker.com/backend-api` / `https://live.tradelocker.com/backend-api`; `accNum` required on `/trade/*` |
| Streams API docs <https://api.tradelocker.com/streams-api/socket/docs/> (search snippets) | Socket.IO stream requires a `developer-api-key`; initial state followed by `SyncEnd` |

## Endpoints used

| Purpose | Method + path (relative to `/backend-api`) | Verified how |
|---|---|---|
| Login | `POST /auth/jwt/token` `{email,password,server}` → `accessToken`, `refreshToken` | SDK source |
| Refresh | `POST /auth/jwt/refresh` `{refreshToken}` (refreshed when < 30 min left, as the SDK does) | SDK source |
| Accounts | `GET /auth/jwt/all-accounts` → `accounts[{id, accNum, currency,…}]` | SDK source |
| Config / columns / rate limits | `GET /trade/config` → `d.positionsConfig.columns`, `d.rateLimits[{rateLimitType, measure, intervalNum, limit}]` | SDK source |
| Account state | `GET /trade/accounts/{id}/state` → `d.accountDetailsData` (columns: `balance`, `projectedBalance`, `availableFunds`, …) | SDK source |
| Positions | `GET /trade/accounts/{id}/positions` (columns incl. `stopLossId`, `takeProfitId`, `strategyId`) | SDK source |
| Active orders / history | `GET /trade/accounts/{id}/orders`, `GET /trade/accounts/{id}/ordersHistory` | SDK source |
| Instruments | `GET /trade/accounts/{id}/instruments` (routes INFO/TRADE) | SDK source |
| Instrument details | `GET /trade/instruments/{tradableInstrumentId}?routeId=<INFO>` | path from SDK; **field names not in SDK** |
| Quotes | `GET /trade/quotes?tradableInstrumentId&routeId=<INFO>` → `d.ap`, `d.bp` | SDK source |
| Place order | `POST /trade/accounts/{id}/orders` `{qty (string), routeId (TRADE), side, validity IOC/GTC, tradableInstrumentId, type market/limit/stop, price, stopPrice, stopLoss, stopLossType:"absolute", takeProfit, takeProfitType:"absolute", strategyId}` → `d.orderId` | SDK source |
| Modify position | `PATCH /trade/positions/{positionId}` | path from SDK; **body keys assumed** `stopLoss`/`takeProfit` |
| Close / partial close | `DELETE /trade/positions/{positionId}` `{qty}` (`"0"` = full) | SDK source |
| Modify / cancel order | `PATCH` / `DELETE /trade/orders/{orderId}` | path from SDK; PATCH body keys assumed |

## Behaviour

- **Detection:** REST polling of positions/orders every `TRADELOCKER_POLL_MS` (default 1000 ms).
  Expected detection delay ≈ poll interval + request latency (both shown in Diagnostics).
  The Streams API is not used because it requires a developer API key.
- **Acceptance vs fill:** `POST /orders` returns only an order id → job state `ACCEPTED`. The fill
  (position id, average price, filled quantity) is confirmed from `ordersHistory` by `strategyId`.
- **Ambiguity:** 5xx and timeouts on order placement are `UNKNOWN`; the engine reconciles by
  `strategyId` in `ordersHistory` and active orders before any retry.
- **Rate limits:** per-route sliding windows at 90 % of the limits returned by `/trade/config`;
  HTTP 429 is honoured with `Retry-After`.
- **Copier tag:** `strategyId = gtc1:<12-char id>`.
- **Instrument details:** parsed defensively. Missing or ambiguous fields (`tickValueCurrency` is
  always flagged because the SDK does not document the currency of `tickCost`) are listed as gaps;
  non-FIXED sizing is refused until a manual specification is confirmed in Symbol Mapping.
- Positions are treated as individually tracked (hedging-style).

## To verify on a demo account (first actions when credentials exist)

1. Instrument-details field names (`lotSize`, `lotStep`, `minOrderSize`, `maxOrderSize`,
   `tickSize`, `tickCost`, currency fields) — adjust `parseTradeLockerInstrument`.
2. `PATCH /trade/positions/{id}` body for SL/TP changes and removing a level.
3. Whether SL/TP orders appear in `/orders` with `stopPrice`/`price` (used to read position SL/TP).
4. Then run the demo validation procedure in [../DEMO_VALIDATION.md](../DEMO_VALIDATION.md).

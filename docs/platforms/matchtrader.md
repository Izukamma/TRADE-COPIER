# Match-Trader connector (Platform API)

**Status: PARTIALLY IMPLEMENTED, AWAITING PLATFORM ACCESS.** Only the endpoints that appeared in
the documentation excerpts we could read are enabled. Nothing has been run against a real
Match-Trader account. The documentation hosts (`docs.match-trade.com`, `app.theneo.io`) were
blocked from the development environment; details below come from search-engine excerpts of the
official documents.

## Sources

- Match-Trader Platform API (PDF): <https://docs.match-trade.com/wp-content/uploads/2024/05/MTR-Match-TraderPlatformAPI.pdf>
- Interactive reference: <https://app.theneo.io/match-trade/platform-api>
- Product page: <https://match-trader.com/platform-api/>

## Endpoints

| Purpose | Endpoint | State |
|---|---|---|
| Login | `POST {platform}/manager/co-login` `{email, password, brokerId}` → `token`, `accounts[{tradingAccountId, tradingApiToken, …}]` | Documented; implemented |
| Auth headers | `Auth-trading-api: <tradingApiToken>` and the co-auth token (sent as cookie `co-auth`) | Header documented; cookie form **assumed** |
| Balance | `GET {platform}/mtr-api/{SYSTEM_UUID}/balance` | Documented path; response field names parsed defensively |
| Open positions | `GET …/open-positions` | Documented path; field names parsed defensively |
| Open position | `POST …/position/open` `{instrument, orderSide, volume, slPrice, tpPrice, isMobile}` | Documented body; implemented |
| Edit position | `POST …/position/edit` | Path documented, **body not verified** → disabled unless `MATCHTRADER_ENABLE_UNVERIFIED_BODIES=true` (never on LIVE) |
| Close positions | `POST …/positions/close` | Path documented, **body not verified** → same gate |
| Partial close | exists per docs; **path not available to us** | `MATCHTRADER_PATH_PARTIAL_CLOSE` |
| Symbols | "Get Symbols" exists; **path not available** | `MATCHTRADER_PATH_SYMBOLS`; otherwise enter specs manually |
| Quotes | **path not available** | `MATCHTRADER_PATH_QUOTES`; without it set *max entry deviation* empty |
| Pending orders | "Create/Edit pending order", "active orders" exist; **paths not available** | rejected with a clear reason |
| Rate limits | not found | conservative client budget `MATCHTRADER_REQUESTS_PER_SECOND` (default 2) |

No endpoint was invented: unknown paths are configuration values left empty until copied from
the official reference.

## Behaviour

- **Detection:** polling `open-positions` every `MATCHTRADER_POLL_MS` (default 1500 ms).
- **No order tags:** Match-Trader exposes no comment/strategy field in what we could read. Copier
  trades are recognised through stored position links. Reconciliation of an ambiguous open
  compares positions before/after submission and is conclusive only when exactly one new
  matching position exists; otherwise the job is flagged `NEEDS_ATTENTION` (never resubmitted).
- **Account identity:** `server` field = `SYSTEM_UUID`; account identifier = `tradingAccountId`;
  credentials = email, password and broker id (encrypted).

## Next actions when access is available

1. Confirm co-auth header/cookie form, balance and position response fields.
2. Copy symbols, quotes, partial-close and pending-order paths and bodies from the official
   reference into the environment, and verify edit/close bodies; then set the capability flags.
3. Run [../DEMO_VALIDATION.md](../DEMO_VALIDATION.md).

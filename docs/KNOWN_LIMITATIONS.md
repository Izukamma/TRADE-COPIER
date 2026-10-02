# Known limitations

## Not yet validated on real platforms
- **No real copying has been demonstrated.** All evidence is from mocks, the simulator and a fake
  EA. Demo validation (entry, SL/TP modify, partial close, full close, restart recovery) is
  pending credentials/terminals — see [DEMO_VALIDATION.md](DEMO_VALIDATION.md).
- The MQL4/MQL5 EAs have **not been compiled**. Expect possible compile errors to fix in
  MetaEditor on first build.
- TradeLocker instrument-detail fields and modification body keys are assumptions (see
  `docs/platforms/tradelocker.md`); non-FIXED sizing is refused until specs are confirmed.
- Match-Trader: only login, balance, open positions and market open are based on documented
  shapes; symbols/quotes/partial close/pending endpoints are not configured, edit/close bodies
  are unverified and gated, there is no order tag, and rate limits are unknown.

## Behavioural limits (by design or v1 scope)
- Polling platforms can miss a trade that opens and closes between two polls; both appear as
  nothing. Pending orders that fill and close between polls appear as a cancellation.
- Master **scale-ins** (adding volume to an existing position, e.g. netting) are not copied; an
  alert is raised.
- Pending-order prices are copied as absolute prices (no price-basis offset). Use pending copying
  only between instruments with the same price basis.
- When the master pending order fills, the follower relies on its own pending order filling;
  if the follower's order does not fill, no market order is substituted.
- Partial closes reduce follower exposure proportionally, rounding the *remaining* volume down
  (closing slightly more than proportional) — never leaving more exposure than the master ratio.
- Netting followers require an explicit acknowledgement that mapped symbols are copier-only and
  are refused while a non-copier position exists on the symbol.
- Chained copying (A → B → C) is refused; copier trades are never re-copied.
- Exposure caps are in lots (per route and per account), not in notional currency.
- Margin checks use the platform's margin-per-lot only where reported (MT bridges, simulator);
  elsewhere only positive free margin is checked.
- Daily-loss tracking is computed by the copier from its own baseline; it can differ from a prop
  firm's calculation (timing, baseline, commissions). It is not a compliance guarantee.
- Detection/execution delays are measured and displayed; no execution speed is promised.
- Entry deviation is measured between the master fill and the follower quote in follower ticks;
  instruments with an inherent price offset need a larger limit or the check disabled.
- One engine instance (advisory lock); horizontal scaling is not supported.
- Sign-in rate limiting is in-memory per web process (single web instance assumed).
- TradeLocker Streams API (push) is not used; it requires a developer API key.
- The simulator's two accounts use independent random walks, so their prices drift apart over
  time (entries may then be rejected for deviation — which is the guard working).

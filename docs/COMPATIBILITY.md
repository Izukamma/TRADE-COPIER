# Platform compatibility matrix

Legend — **Impl**: implemented in code · **Tested**: automated test against mocks/simulator/fake
EA · **Verified**: confirmed against a real demo account. **No row is "Verified" yet**: no
platform credentials or MetaTrader terminals were available during development.

| Capability | TradeLocker | Match-Trader | MT4 bridge | MT5 bridge | Simulator |
|---|---|---|---|---|---|
| Authentication | Impl · Tested (mock) | Impl · Tested (mock) | Impl (device token) · Tested (fake EA) | same as MT4 | n/a |
| Token refresh / reconnect | Impl · Tested (mock) | re-login on 401 · Impl | n/a (stateless HMAC) | n/a | n/a |
| Account balance/equity/margin | Impl · Tested (mock) | Impl (field names assumed) | Impl (EA) | Impl (EA) | Impl · Tested |
| Instrument specs | Impl, **field names unverified** | Only with configured symbols path or manual specs | Impl (EA) | Impl (EA) | Impl · Tested |
| Quotes | Impl · Tested (mock) | Only with configured quotes path | Impl (EA) | Impl (EA) | Impl · Tested |
| Master detection | Poll 1 s | Poll 1.5 s | EA push ~0.3 s | EA push ~0.3 s | Poll 0.5 s |
| Master: market positions | Impl | Impl | Impl | Impl | Tested |
| Master: pending orders | Impl | only with active-orders path | Impl | Impl | Tested |
| Master: partial close | Impl | Impl | Impl (`from #` remainder) · Tested (diff) | Impl | Tested |
| Follower: market order | Impl · Tested (mock) | Impl (documented body) · Tested (mock) | Impl · Tested (fake EA) | Impl · Tested (fake EA) | Tested |
| Follower: limit/stop orders | Impl | **Not available** (paths unknown) | Impl | Impl | Tested |
| Follower: modify SL/TP | Impl (**body assumed**) | Gated (body unverified) | Impl | Impl | Tested |
| Follower: modify pending | Impl (**body assumed**) | Not available | Impl | Impl | Tested |
| Follower: partial close | Impl · Tested (mock) | Needs configured path + gate | Impl (new ticket followed) | Impl | Tested |
| Follower: full close | Impl · Tested (mock) | Gated (body unverified) | Impl | Impl | Tested |
| Follower: cancel pending | Impl | Not available | Impl | Impl | Tested |
| Order tagging (loop prevention, reconciliation) | `strategyId` | **none** (links only) | comment + magic | comment + magic | tag |
| Ambiguous-timeout reconciliation | by tag in history · Tested (mock) | before/after diff, often inconclusive | command result / tag · Tested (fake EA) | same | Tested |
| Hedging / netting | hedging-style | hedging-style | hedging | both (netting needs acknowledgement) | both · Tested |
| Rate limits | from `/trade/config` · Tested | client budget (undocumented) | n/a | n/a | n/a |
| Integration status shown in dashboard | IMPLEMENTED_UNVERIFIED | AWAITING_ACCESS | IMPLEMENTED_UNVERIFIED | IMPLEMENTED_UNVERIFIED | SIMULATED |

Cross-platform routes (any master → any follower) are supported by design: the planner works on
normalised instrument specs and the same adapter interface. In tests, SIMULATION accounts use
the simulator regardless of their platform label, so this does **not** test platform-specific
behaviour. The only platform-specific end-to-end path tested is SIMULATION master → MT5 follower
through the bridge protocol with a fake EA. No route has been run between two real platforms.

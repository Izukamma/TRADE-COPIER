# MT4 / MT5 bridge connectors

**Status: EA SOURCE PROVIDED, NOT COMPILED OR RUN.** The engine side of the protocol is tested with
a fake EA written in TypeScript (`apps/engine/test/integration/bridge.test.ts`). The MQL files
have not been compiled in MetaEditor or attached to a terminal, because no Windows/MetaTrader
environment was available.

- `bridges/mql5/GabrielCopierBridge.mq5` — MetaTrader 5 (hedging and netting accounts)
- `bridges/mql4/GabrielCopierBridge.mq4` — MetaTrader 4 (build 1090+)

## Why an EA bridge

MetaTrader has no official remote trading API for retail terminals. The EA runs inside an
authenticated terminal, so **the MT login password never leaves the terminal**. The EA talks to
the engine over HTTPS with a scoped, revocable device token.

## MQL references used

- `WebRequest` (POST with headers): <https://www.mql5.com/en/docs/network/webrequest> and <https://docs.mql4.com/common/webrequest>
- `CryptEncode(CRYPT_HASH_SHA256)`: <https://www.mql5.com/en/docs/common/cryptencode>
- MT5 `OrderSend`/`MqlTradeRequest` actions (`TRADE_ACTION_DEAL`, `_PENDING`, `_SLTP`, `_MODIFY`, `_REMOVE`): <https://www.mql5.com/en/docs/constants/tradingconstants/enum_trade_request_actions>
- MT5 margin modes (hedging vs netting): <https://www.mql5.com/en/docs/constants/environment_state/accountinformation>
- MT4 `OrderSend`/`OrderModify`/`OrderClose`/`OrderDelete`: <https://docs.mql4.com/trading>

## Capabilities (as implemented)

| | MT4 | MT5 |
|---|---|---|
| Master / follower | yes / yes | yes / yes |
| Market, limit, stop orders | yes | yes |
| Modify SL/TP, modify pending, cancel | yes | yes |
| Partial close | yes (remainder gets a new ticket, reported as `fromTicket`) | yes |
| Tagging | comment `gtc1:<id>` + magic 7710001 | comment + magic |
| Accounting | hedging | hedging or netting (netting requires explicit acknowledgement) |
| Detection | EA push every 300 ms (configurable) | same |
| Margin per lot | `MODE_MARGINREQUIRED` | `OrderCalcMargin` |

## Safety rules in the EA

- Executes only commands received in signed responses from the engine; never trades on its own.
- Refuses to modify, close or cancel any ticket that lacks the copier magic number.
- Deduplicates by command id (persisted in `MQL5/Files/GTC_<login>_done.txt`) and by tag
  (open positions, pending orders and recent history), so redelivery cannot open twice.
- The engine refuses tokens used from a different terminal login than the one they were issued for.

See [../BRIDGE_PROTOCOL.md](../BRIDGE_PROTOCOL.md) and [../WINDOWS_VPS.md](../WINDOWS_VPS.md).

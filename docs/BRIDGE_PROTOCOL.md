# MetaTrader bridge protocol (v1)

One endpoint, polled by the EA every ~300 ms. Each request pushes the terminal state and the
results of previously delivered commands; each response returns new commands.

```
POST {PUBLIC_BRIDGE_URL}/bridge/v1/sync
Content-Type: application/json
X-GTC-Key:   <tokenId>               16 hex chars (public part of the device token)
X-GTC-Ts:    <unix epoch ms>         must be within ±30 s of engine time (BRIDGE_MAX_SKEW_MS)
X-GTC-Nonce: <16–64 hex>             single use per token (replay protection)
X-GTC-Sig:   hex(HMAC-SHA256(secret, ts + "\n" + nonce + "\nPOST\n/bridge/v1/sync\n" + hex(SHA256(body))))
```

Device token shown once in the dashboard: `gtcd_<tokenId>_<secret>` (secret = 43 chars
base64url, 256 bits). The engine stores the secret AES-256-GCM-encrypted with the server key ring
(it must recompute HMACs); it is never returned by any API. Tokens are revocable per terminal.

Response headers: `X-GTC-Sig: hex(HMAC-SHA256(secret, ts + "\n" + nonce + "\n" + hex(SHA256(responseBody))))`
— the EA ignores any response whose signature does not verify.

Rejections: `401` (malformed headers, skew, unknown/revoked token, bad signature, replayed
nonce), `403` (account disabled, platform mismatch, **terminal login differs from the token's
account**), `400` (invalid JSON/payload), `413` (> 2 MB).

## Request body

```jsonc
{
  "protocol": 1,
  "platform": "MT5",                 // or "MT4"
  "login": "5550001",                // must equal the account identifier in the dashboard
  "server": "Broker-Demo",
  "eaVersion": "mt5-0.10",
  "terminalConnected": true,
  "tradeAllowed": true,
  "accounting": "HEDGING",           // or "NETTING" (MT5)
  "account": { "balance": 10000, "equity": 10012.5, "currency": "USD", "freeMargin": 9500, "margin": 512.5 },
  "serverTime": 1790000000000,
  "positions": [{
    "ticket": "880001", "symbol": "US30.cash", "side": "BUY", "volume": 0.1,
    "openPrice": 42002.1, "openTime": 1790000000000,      // UTC ms (EA converts from server time)
    "sl": null, "tp": 42500, "comment": "gtc1:abcdefghjkmn", "magic": 7710001,
    "profit": 1.2, "orderTicket": "880001",
    "fromTicket": "879990"                                 // MT4 only, after a partial close
  }],
  "orders": [{ "ticket": "880010", "symbol": "XAUUSD", "side": "SELL", "kind": "LIMIT", "volume": 0.2,
               "price": 2410.5, "sl": null, "tp": null, "createdTime": 1790000000000, "comment": "", "magic": 0 }],
  "quotes": [{ "symbol": "US30.cash", "bid": 42001.5, "ask": 42002.5, "time": 1790000000000 }],
  "symbols": [{                                             // only when the last response had sendSymbols=true
    "symbol": "US30.cash", "digits": 2, "tickSize": 0.01, "tickValue": 0.01, "contractSize": 1,
    "profitCurrency": "USD", "volumeMin": 0.01, "volumeMax": 100, "volumeStep": 0.01,
    "stopsLevelPoints": 0, "freezeLevelPoints": 0, "tradeAllowed": true, "marginPerLot": 420.0,
    "bid": 42001.5, "ask": 42002.5
  }],
  "results": [{
    "commandId": "uuid", "ok": true, "retcode": 10009, "message": "done",
    "orderTicket": "880001", "positionTicket": "880001",   // MT4 partial close: remainder ticket
    "fillPrice": 42002.1, "filledVolume": 0.1, "executedAt": 1790000000100
  }]
}
```

`tickValue` is in the account currency (MetaTrader convention); the engine records it that way.

## Response body

```jsonc
{
  "ok": true,
  "serverTime": 1790000000150,
  "pollMs": 300,
  "watchSymbols": ["US30.cash", "EURUSD"],   // symbols to quote/spec (mapped symbols)
  "sendSymbols": false,                      // include "symbols" in the next request
  "commands": [{
    "id": "uuid", "clientId": "abcdefghjkmn",
    "kind": "OPEN_MARKET",                   // PLACE_PENDING | MODIFY_POSITION | MODIFY_PENDING | CLOSE_POSITION | CANCEL_PENDING
    "symbol": "US30.cash", "side": "BUY", "volume": 0.1, "price": 0,
    "sl": 0, "tp": 42500,                    // 0 = none
    "positionTicket": "", "orderTicket": "", "pendingKind": "",
    "tag": "gtc1:abcdefghjkmn", "magic": 7710001
  }]
}
```

## Delivery and idempotency

- Commands live in `bridge_commands` (durable). States: `PENDING → DELIVERED → DONE | FAILED`, or
  `EXPIRED` if not collected within the TTL (default 10 s) — expired commands are never delivered.
- A delivered command without a result is redelivered after 15 s (max 3 deliveries). The EA
  skips command ids it already executed and, for opens, any position/order/deal that already
  carries the tag — so redelivery cannot duplicate an order.
- If the engine's wait times out while a command is `PENDING`, it atomically withdraws it
  (`EXPIRED`) and treats the order as **not executed**. If it was `DELIVERED`, the job becomes
  `UNKNOWN` and is reconciled from the reported result or the tag in the terminal state.
- Results are re-sent until a sync succeeds; the engine applies each result once.

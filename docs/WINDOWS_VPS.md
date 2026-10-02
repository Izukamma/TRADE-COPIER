# Windows PC / VPS: MetaTrader terminals and bridges

The copier engine and dashboard run on a Linux server (Docker). MetaTrader terminals run on
Windows (a VPS close to the brokers' servers is recommended) and connect **out** to the engine
over HTTPS. No inbound ports are needed on the Windows machine.

## 1. Prepare the machine

1. Windows Server 2019+/Windows 10+ with automatic updates scheduled outside market hours.
2. **Clock:** enable Windows time sync (`w32tm /resync`). Bridge requests are rejected when the
   PC clock is more than 30 s off.
3. Disable sleep/hibernation; set the VPS to restart terminals after reboots (see step 5).
4. One terminal installation folder **per account** (portable mode recommended:
   `terminal64.exe /portable`), so each terminal keeps its own `MQL5/Files` and settings.

## 2. Install the EA

1. In the dashboard: Accounts → add account (platform MT4/MT5, mode DEMO or LIVE, account
   identifier = terminal login). Open the account → **Issue new token**. Copy the token
   (`gtcd_…`) — it is shown once. Do not paste it into chat, tickets or screenshots.
2. Copy `bridges/mql5/GabrielCopierBridge.mq5` to `<terminal data folder>/MQL5/Experts/`
   (MT4: `bridges/mql4/GabrielCopierBridge.mq4` to `MQL4/Experts/`). *File → Open Data Folder*
   shows the location.
3. Open MetaEditor (F4), open the file, **Compile** (F7). Fix nothing silently: if compilation
   fails, record the errors (the EA has not been compiled before delivery).
4. Terminal → *Tools → Options → Expert Advisors*:
   - tick **Allow algorithmic trading**;
   - tick **Allow WebRequest for listed URL** and add your `PUBLIC_BRIDGE_URL`
     (e.g. `https://copier.example.com`).
5. Open one chart (any symbol), drag the EA onto it, and set inputs:
   - `InpBridgeUrl` = `https://copier.example.com`
   - `InpDeviceToken` = the token from step 1
   - `InpMagic` = `7710001` (leave unless you changed it in the engine)
   - `InpPollMs` = `300`, `InpDeviationPts` = slippage limit in points.
   Enable *Allow live trading* in the EA's Common tab. The chart's smiley/hat icon must be active.
6. In the dashboard the account moves from **AWAITING BRIDGE** to **CONNECTED** once signed
   syncs arrive. The Experts tab in the terminal prints `GTC bridge … started`.

## 3. Operating rules

- Keep the terminal logged in to the account and running 24/5. Copying stops for that account
  if the terminal closes; the dashboard shows it as disconnected after ~10 s.
- One EA instance per terminal/account. Do not attach it to several charts.
- Manual trades on a **follower** terminal are left alone (the EA only touches tickets with the
  copier magic). On a **master** terminal, manual trades and the EA magic numbers you select are
  copied.
- To revoke a terminal: dashboard → account → **Revoke** token. The next request is refused.
- Auto-start after reboot: create a scheduled task "At startup" running
  `"C:\MT5-Account1\terminal64.exe" /portable` for each terminal (charts and EAs are restored
  from the last session).

## 4. Troubleshooting

| Symptom (Experts tab) | Cause |
|---|---|
| `WebRequest blocked` / error 4014 (MT5) or 4060 (MT4) | URL not in the allow list (step 4) |
| `engine responded HTTP 401` | wrong/revoked token, or PC clock skew > 30 s |
| `engine responded HTTP 403` | terminal logged in to a different account than the token's |
| `response signature invalid` | something between terminal and engine altered the response — check proxy/TLS |
| `refused: position was not opened by the copier` | the engine asked to manage a ticket without the copier magic (should not happen; report it) |

# Trading Empire — OESM Command Deck

A single-page command deck for running a prop-firm trading career.

## Features
- **Hub** — 3D view of every account you run (Three.js)
- **Fleet** — prop firm accounts with profit target, drawdown and trading-day progress bars
- **Goals** — $2M total allocation, $100K personal capital, $100K/month payouts, plus payout history
- **Medals** — achievements that unlock as the career grows
- **Captain's Log** — trading journal
- **Jarvis** — AI copilot that knows the OESM strategy and your account data

## Running it
Open `index.html` in a browser. Saving data and Jarvis rely on the Claude Artifact runtime
(`window.claude`), so outside Claude the page runs in **preview mode**: it displays but doesn't save anything.
The live version is hosted as a Claude Artifact.

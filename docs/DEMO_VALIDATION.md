# Demo-account validation procedure

Automated tests prove logic against mocks and the simulator. This procedure produces the
evidence that a **real** route works. Use DEMO accounts only; keep `LIVE_TRADING_ENABLED=false`.

## Preconditions
- Two demo accounts on the platforms under test (start with TradeLocker → TradeLocker, the first
  route targeted by stage 3), engine and dashboard deployed, owner signed in.
- Accounts show **CONNECTED** after *Test connection*; instruments synced for the mapped symbols.
- Mapping (e.g. US30 → the follower's Dow CFD) validated and confirmed; any manual specification
  copied from the broker's contract-specification page.
- Route settings: FIXED minimum lot, mandatory SL off, copy SL/TP ABSOLUTE, modifications and
  partial/full closes on. Preview sizing, then activate.

## Steps (record time of each action)
1. **Entry** — on the master platform open the minimum size with SL and TP.
   Expect: Live Activity shows `POSITION_OPENED` → follower job `SUBMITTED → ACCEPTED → FILLED`
   (TradeLocker shows `ACCEPTED` first, then `FILLED` after history confirmation); follower
   position carries `strategyId`/comment `gtc1:…`.
2. **SL/TP modification** — move SL and TP on the master. Expect `POSITION_MODIFIED` → `RECONCILED`
   and the follower's levels updated.
3. **Partial close** — close part of the master. Expect `POSITION_PARTIALLY_CLOSED` → `FILLED`
   with the volume shown in the calculation notes.
4. **Restart recovery** — stop the engine (`docker compose stop engine`), wait 30 s, start it.
   Expect: no duplicate orders; status returns to CONNECTED; the open copy is still managed.
   Optionally modify SL while stopped — the change is applied after restart.
5. **Full close** — close the master. Expect `POSITION_CLOSED` → `FILLED`, link `CLOSED`.
6. **Pause check** — pause entries globally, open a master trade: expect `SKIPPED (entries paused)`;
   close it: nothing to copy. Resume.

## Recording evidence
```bash
pnpm evidence -- --route <routeId> --since <ISO time before step 1> --out evidence/<date>-<route>.json
```
Also save: screenshots of Live Activity and Trade History (no credentials visible), broker-side
trade history exports for both accounts, and the engine log excerpt for the time window
(`docker compose logs engine --since …`). Store under `evidence/private/` (git-ignored) or
another private location. Then update `docs/COMPATIBILITY.md` (Verified column) and
`CHECKPOINT.md`.

## Pass criteria
Every step produces exactly one follower action with the expected state, the measured delays are
recorded, no follower order exists without a matching job, and the broker histories match the
copier's links.

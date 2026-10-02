# Architecture

```
                       ┌──────────────────────── engine (Node, long-running) ────────────────────────┐
 TradeLocker REST ◄────┤ ConnectionManager ── adapters: TradeLocker · Match-Trader · MT bridge · Sim  │
 Match-Trader API ◄────┤        │ snapshots (poll / bridge push)                                       │
                       │        ▼                                                                      │
 MT4/MT5 EA ──HTTPS──► │ Bridge server ─► BridgeHub     MasterWatcher ─diff─► master_events (dedup)    │
 (signed device token) │                                         │                                     │
                       │                                   Router ─► execution_jobs (durable queue)    │
                       │                                         │                                     │
                       │   RiskService ◄── Executor (claim → plan → submit → reconcile) ─► copy_links  │
                       │   LinkMonitor (divergence) · ControlProcessor · Heartbeat · Retention          │
                       └───────────────────────────────────┬──────────────────────────────────────────┘
                                                           │ PostgreSQL
                       ┌───────────── web (Next.js) ───────┴──────────┐
 Owner browser ──────► │ Better Auth · owner-only server actions      │  writes config + control_commands,
                       │ reads status/heartbeat/events/jobs/links      │  never calls brokers
                       └───────────────────────────────────────────────┘
```

## Packages

| Path | Role |
|---|---|
| `packages/shared` | Domain types, Zod schemas, sizing, volume rounding, symbol mapping & validation, SL/TP mapping, daily-loss math, route-graph checks, state machine, copier tags, AES-GCM secrets, device-token HMAC, redaction. Pure and unit-tested. |
| `packages/db` | Drizzle schema, SQL migrations, durable queue (`claimJobs`, `transitionJob`). |
| `packages/adapters` | `PlatformAdapter` interface; TradeLocker, Match-Trader, simulator; HTTP failure classification; rate limiter. |
| `apps/engine` | The copier process. |
| `apps/web` | The dashboard. |
| `bridges/mql4`, `bridges/mql5` | Expert Advisor bridges. |

## Adapter interface

`connect · disconnect · health · getSnapshot · getInstruments · listSymbols · getQuote · submit · reconcile`
(`packages/adapters/src/types.ts`). Rules every adapter follows:
- read methods never place orders;
- `submit` never retries internally and returns `ACCEPTED`, `REJECTED{retryable}` or `UNKNOWN`
  (request may have reached the platform — timeouts, resets, 5xx on mutations);
- `reconcile` answers *did this command take effect?* using the copier tag/client id and
  platform history, and says whether the answer is **conclusive**.

## Data flow

1. **Detection.** The ConnectionManager refreshes each master at its platform's cadence
   (TradeLocker 1 s, Match-Trader 1.5 s, bridges ~0.3 s push, simulator 0.5 s). The
   MasterWatcher diffs the new snapshot against the stored one (`apps/engine/src/diff.ts`) and,
   **in one transaction**, inserts master events and the new snapshot/version. Event keys are
   deterministic (`open:<id>`, `partial:<id>:v<n>` …) with a unique index on
   `(account, event_key)`, so a crash or double detection cannot create duplicates.
   - First observation of a master = **baseline**; existing positions are not copied.
   - Positions tagged `gtc1:`, carrying the copier magic, or linked as follower positions on that
     account are excluded — copier trades are never re-copied (loop prevention).
   - Pending fills, MT4 remainder tickets and netting reversals are handled explicitly.
2. **Routing.** Each event fans out to one job per active route of the master's groups:
   `ordering_key = route + master trade key`, unique `(event, route)`.
3. **Execution.** `claimJobs` (`FOR UPDATE SKIP LOCKED`) only returns a job when no earlier job
   with the same ordering key is still non-terminal: per-trade ordering, independent followers.
   The **planner** (`apps/engine/src/planner.ts`) is a pure function returning exactly one of
   `SUBMIT | SKIP | REJECT | LINK_ONLY` with a reason. No AI model is involved anywhere.
4. **Links.** Entries create a `copy_links` row (unique per route + master trade) *before*
   submission, so a crash after submission still leaves a record keyed by the client id.
5. **Monitoring.** LinkMonitor compares links with follower state: late fills, pending fills,
   follower positions closed outside the copier (→ `DIVERGED`/`DETACHED`, never re-opened),
   volume reduced outside the copier.

## Execution state machine

```
DETECTED → QUEUED → SUBMITTED → ACCEPTED → FILLED
                │         │          │  └──► RECONCILED (pending/modify/cancel verified)
                │         │          └──► REJECTED (accepted but not filled)
                │         ├──► REJECTED ──(retryable & attempts left)──► QUEUED
                │         └──► UNKNOWN ──reconcile──► RECONCILED | UNKNOWN (retry check)
                │                              └──► QUEUED (conclusively not executed, once, new tag)
                │                              └──► NEEDS_ATTENTION (cannot prove either way)
                └──► SKIPPED (filters, pauses, stale entry, duplicate)
```

`ACCEPTED` (order accepted) is distinct from `FILLED` (deal/position exists). Every transition is
validated (`packages/shared/src/state-machine.ts`) and written to `job_transitions`.

**Ambiguous submissions.** `UNKNOWN` jobs are reconciled before anything else. Only a
*conclusive* "not found" after several checks permits one retry, and only on platforms with order
tags, only while the entry is still within its maximum age, and with a new tag so the two attempts
can be told apart. Otherwise the job becomes `NEEDS_ATTENTION` with a critical alert.

## Recovery after restart

- Jobs left `SUBMITTED` with an expired lease are moved to `UNKNOWN` and reconciled — never
  blindly resubmitted.
- The stored master snapshot + version survive restarts; events that happened while the engine
  was down are detected on the first diff. Closes/modifications are applied; entries older than
  `maxEntryAgeSeconds` are skipped as stale (no replay).
- Links persist follower position ids, so positions opened before a restart keep being managed.
- MT bridge commands are durable (`bridge_commands`) with TTL, single delivery + bounded redelivery
  and EA-side dedup.

## Sizing (deterministic)

`packages/shared/src/sizing.ts`. Money per 1.0 price move per lot = `tickValue / tickSize`
converted into the follower currency (or `contractSize` in the profit currency when tick data is
absent). Modes: FIXED; MULTIPLIER (normalised by both contract specs by default — equal lots are
not equal exposure; raw multiplier only when specs are identical); EQUITY_PROPORTIONAL (equity
ratio in a common currency); RISK_PERCENT (requires SL; risk / (SL distance × value per point)).
Results are rounded **down** to the volume step and never rounded up past the order cap or risk
budget; below the minimum volume the order is rejected.

## Risk

Entry pauses at global / group / route / account level stop **entries only**. Exits, partial
closes, SL/TP and pending-order management always continue. Daily loss uses an explicit timezone,
reset time, basis, floating-P&L treatment and baseline; a baseline taken after the reset time
(engine was down) is flagged as *late*. Stale account data and quotes block entries.

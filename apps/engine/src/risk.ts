import { and, eq, inArray, isNull } from "drizzle-orm";
import { alerts, appSettings, copyLinks, dailyBaselines, type Db } from "@gtc/db";
import { accountRiskSchema, baselineFrom, evaluateDailyLoss, tradingDayKey, type DailyLossStatus } from "@gtc/shared";
import type { ConnectionManager } from "./accounts";
import type { Log } from "./logger";

export interface GlobalPause {
  paused: boolean;
  reason?: string;
  at?: string;
}

/** UTC instant of local `HH:MM` on `dayKey` in `tz`. */
export function resetInstant(dayKey: string, resetTime: string, tz: string): number {
  const [y, m, d] = dayKey.split("-").map(Number) as [number, number, number];
  const [hh, mm] = resetTime.split(":").map(Number) as [number, number];
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 2; i++) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
        .formatToParts(new Date(guess))
        .map((p) => [p.type, p.value]),
    );
    const asIfUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    guess += Date.UTC(y, m - 1, d, hh, mm) - asIfUtc;
  }
  return guess;
}

export async function raiseAlert(
  db: Db,
  a: { severity: "INFO" | "WARNING" | "CRITICAL"; code: string; message: string; accountId?: string | null; routeId?: string | null; jobId?: string | null; dedupKey?: string },
) {
  await db
    .insert(alerts)
    .values({ ...a, message: a.message.slice(0, 1000), dedupKey: a.dedupKey ?? null })
    .onConflictDoNothing()
    .catch(() => {});
}

/** Pause state, daily loss, exposure. Exits are never blocked by anything in here. */
export class RiskService {
  globalPause: GlobalPause = { paused: false };
  dailyStatus = new Map<string, DailyLossStatus & { late: boolean }>();
  /** Accounts whose daily limit triggered a close-all that has already been requested today. */
  private closeRequested = new Set<string>();
  onCloseRequest?: (accountId: string, reason: string) => Promise<void>;

  constructor(
    private db: Db,
    private conn: ConnectionManager,
    private log: Log,
  ) {}

  async loadGlobal() {
    const row = await this.db.query.appSettings.findFirst({ where: eq(appSettings.key, "pause.global") });
    this.globalPause = (row?.value as GlobalPause | undefined) ?? { paused: false };
  }

  dailyLossBreached(accountId: string): boolean {
    return this.dailyStatus.get(accountId)?.breached ?? false;
  }

  /** Evaluates daily loss for every connected account with a fresh snapshot. */
  async evaluate(now = Date.now()) {
    for (const rt of this.conn.runtimes.values()) {
      const snap = rt.snapshot;
      if (!snap || !rt.snapshotAt) continue;
      const risk = accountRiskSchema.parse(rt.row.riskConfig ?? {});
      const cfg = risk.dailyLoss;
      if (!cfg.enabled) {
        this.dailyStatus.delete(rt.row.id);
        continue;
      }
      if (now - rt.snapshotAt > risk.staleAccountSeconds * 1000) continue;
      const dayKey = tradingDayKey(now, cfg.resetTimezone, cfg.resetTime);
      let base = await this.db.query.dailyBaselines.findFirst({ where: and(eq(dailyBaselines.accountId, rt.row.id), eq(dailyBaselines.dayKey, dayKey)) });
      if (!base) {
        const late = now - resetInstant(dayKey, cfg.resetTime, cfg.resetTimezone) > 5 * 60_000;
        const value = baselineFrom(cfg, snap.account.balance, snap.account.equity);
        await this.db
          .insert(dailyBaselines)
          .values({ accountId: rt.row.id, dayKey, baseline: value, balance: snap.account.balance, equity: snap.account.equity, late })
          .onConflictDoNothing();
        base = await this.db.query.dailyBaselines.findFirst({ where: and(eq(dailyBaselines.accountId, rt.row.id), eq(dailyBaselines.dayKey, dayKey)) });
        if (late)
          await raiseAlert(this.db, {
            severity: "WARNING",
            code: "DAILY_BASELINE_LATE",
            message: `${rt.row.nickname}: daily-loss baseline for ${dayKey} taken after the reset time (engine was not running); it may differ from the prop firm's figure`,
            accountId: rt.row.id,
            dedupKey: `baseline-late:${rt.row.id}:${dayKey}`,
          });
        this.closeRequested.delete(rt.row.id);
      }
      if (!base) continue;
      const st = evaluateDailyLoss(cfg, dayKey, base.baseline, snap.account.balance, snap.account.equity);
      this.dailyStatus.set(rt.row.id, { ...st, late: base.late });
      if (st.breached && !base.breachedAt) {
        await this.db.update(dailyBaselines).set({ breachedAt: new Date() }).where(and(eq(dailyBaselines.accountId, rt.row.id), eq(dailyBaselines.dayKey, dayKey)));
        await raiseAlert(this.db, {
          severity: "CRITICAL",
          code: "DAILY_LOSS_LIMIT",
          message: `${rt.row.nickname}: daily loss ${st.loss.toFixed(2)} reached limit ${st.limit.toFixed(2)} (baseline ${st.baseline.toFixed(2)}); new entries paused`,
          accountId: rt.row.id,
          dedupKey: `daily-loss:${rt.row.id}:${dayKey}`,
        });
        this.log.warn("risk", "daily loss limit reached", { accountId: rt.row.id, ...st });
      }
      if (st.breached && cfg.onLimit === "PAUSE_ENTRIES_AND_CLOSE_COPIER_POSITIONS" && !this.closeRequested.has(rt.row.id)) {
        this.closeRequested.add(rt.row.id);
        await this.onCloseRequest?.(rt.row.id, `daily loss limit reached (${dayKey})`);
      }
    }
  }

  /** Copier-managed lots open on a route and on an account. */
  async exposure(routeId: string, accountId: string): Promise<{ routeLots: number; accountLots: number; routeOpenPositions: number }> {
    const rows = await this.db
      .select({ routeId: copyLinks.routeId, vol: copyLinks.followerVolumeCurrent, status: copyLinks.status })
      .from(copyLinks)
      .where(and(eq(copyLinks.followerAccountId, accountId), inArray(copyLinks.status, ["OPEN", "OPENING", "PENDING_ORDER"]), isNull(copyLinks.closedAt)));
    let routeLots = 0,
      accountLots = 0,
      routeOpenPositions = 0;
    for (const r of rows) {
      accountLots += r.vol;
      if (r.routeId === routeId) {
        routeLots += r.vol;
        routeOpenPositions++;
      }
    }
    return { routeLots, accountLots, routeOpenPositions };
  }
}

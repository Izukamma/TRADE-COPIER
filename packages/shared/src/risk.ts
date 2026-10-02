import type { DailyLossConfig } from "./schemas";

/** Returns the trading-day key (YYYY-MM-DD of the day that started at the configured reset). */
export function tradingDayKey(now: number, timezone: string, resetTime: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  const [rh, rm] = resetTime.split(":").map(Number) as [number, number];
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  let y = Number(parts.year), m = Number(parts.month), d = Number(parts.day);
  if (minutes < rh * 60 + rm) {
    const prev = new Date(Date.UTC(y, m - 1, d) - 86_400_000);
    y = prev.getUTCFullYear();
    m = prev.getUTCMonth() + 1;
    d = prev.getUTCDate();
  }
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function baselineFrom(cfg: DailyLossConfig, balance: number, equity: number): number {
  switch (cfg.baseline) {
    case "START_BALANCE":
      return balance;
    case "START_EQUITY":
      return equity;
    case "HIGHER_OF_BALANCE_EQUITY":
      return Math.max(balance, equity);
  }
}

export interface DailyLossStatus {
  dayKey: string;
  baseline: number;
  current: number;
  loss: number;
  limit: number;
  breached: boolean;
  /** Fraction of the limit consumed, 0..1+ */
  usage: number;
}

export function evaluateDailyLoss(
  cfg: DailyLossConfig,
  dayKey: string,
  baseline: number,
  balance: number,
  equity: number,
): DailyLossStatus {
  const current = cfg.basis === "EQUITY" ? equity : cfg.includeFloating ? balance + (equity - balance) : balance;
  const loss = Math.max(0, baseline - current);
  const limit = cfg.limitType === "AMOUNT" ? cfg.limitValue : (baseline * cfg.limitValue) / 100;
  return { dayKey, baseline, current, loss, limit, breached: cfg.enabled && loss >= limit, usage: limit > 0 ? loss / limit : 0 };
}

/** Margin estimate check: returns false when free margin is insufficient by the safety factor. */
export function marginSufficient(freeMargin: number | null, requiredMargin: number | null, safetyFactor: number): { ok: boolean; reason?: string } {
  if (freeMargin === null) return { ok: true, reason: "free margin not reported by platform; margin check skipped" };
  if (requiredMargin === null) return freeMargin > 0 ? { ok: true, reason: "margin requirement unknown; only positive free margin verified" } : { ok: false, reason: "no free margin" };
  if (freeMargin < requiredMargin * safetyFactor)
    return { ok: false, reason: `free margin ${freeMargin.toFixed(2)} < required ${requiredMargin.toFixed(2)} x ${safetyFactor}` };
  return { ok: true };
}

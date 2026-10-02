/**
 * Currency conversion. Rates are supplied by the engine (from account quotes or an explicit
 * manual table); nothing here fetches data. Missing rates are an error, never a guess.
 */

export interface FxRate {
  /** 1 unit of `base` = `rate` units of `quote`. */
  base: string;
  quote: string;
  rate: number;
  time: number;
  source: string;
}

export class FxTable {
  private rates = new Map<string, FxRate>();
  constructor(rates: FxRate[] = []) {
    for (const r of rates) this.set(r);
  }
  set(r: FxRate) {
    if (!(r.rate > 0)) throw new Error(`invalid fx rate ${r.base}${r.quote}=${r.rate}`);
    this.rates.set(`${r.base.toUpperCase()}/${r.quote.toUpperCase()}`, { ...r, base: r.base.toUpperCase(), quote: r.quote.toUpperCase() });
  }
  /** Returns the conversion factor from `from` into `to`, or null when unavailable. */
  factor(from: string, to: string, maxAgeMs?: number, now = Date.now()): number | null {
    const f = from.toUpperCase();
    const t = to.toUpperCase();
    if (f === t) return 1;
    const fresh = (r: FxRate | undefined) => (r && (maxAgeMs === undefined || now - r.time <= maxAgeMs) ? r : undefined);
    const direct = fresh(this.rates.get(`${f}/${t}`));
    if (direct) return direct.rate;
    const inverse = fresh(this.rates.get(`${t}/${f}`));
    if (inverse) return 1 / inverse.rate;
    // One hop through USD.
    if (f !== "USD" && t !== "USD") {
      const a = this.factor(f, "USD", maxAgeMs, now);
      const b = this.factor("USD", t, maxAgeMs, now);
      if (a !== null && b !== null) return a * b;
    }
    return null;
  }
  convert(amount: number, from: string, to: string, maxAgeMs?: number, now?: number): number | null {
    const k = this.factor(from, to, maxAgeMs, now);
    return k === null ? null : amount * k;
  }
}

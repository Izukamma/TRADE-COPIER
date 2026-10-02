import type { FxTable } from "./fx";
import type { SlTpPolicy } from "./schemas";
import type { InstrumentSpec, Quote, Side } from "./types";
import { roundTo, roundToTick } from "./volume";

/** Canonical groups used only for *suggestions*. Every mapping must be confirmed by the owner. */
const ALIASES: Record<string, string[]> = {
  US30: ["US30", "DJ30", "DJI", "DJI30", "WS30", "USA30", "DOW", "DOWJONES", "YM", "US30CASH", "DJ30CASH", "US30INDEX"],
  NAS100: ["NAS100", "NDX", "NDX100", "USTEC", "US100", "USTECH", "NASDAQ", "NAS", "NQ", "NAS100CASH", "US100CASH"],
  SPX500: ["SPX500", "US500", "SP500", "SPX", "USA500", "ES", "US500CASH", "SPX500CASH", "SP500CASH"],
  GER40: ["GER40", "DE40", "DAX40", "GER30", "DE30", "DAX", "GER40CASH", "DE40CASH"],
  UK100: ["UK100", "FTSE100", "FTSE", "UK100CASH"],
  XAUUSD: ["XAUUSD", "GOLD", "XAU"],
  XAGUSD: ["XAGUSD", "SILVER", "XAG"],
  USOIL: ["USOIL", "WTI", "XTIUSD", "CL", "USOILCASH", "OILCASH"],
};

const SUFFIX_RE = /([._\-#!+](cash|pro|ecn|raw|std|r|m|i|c|a|b|x|z|sb|spot|stp|n|f|p|v)?|(cash|pro|ecn|raw|spot))$/i;

/** Strips common broker suffixes/prefixes and punctuation: "US30.cash" -> "US30", "EURUSDm" -> "EURUSD". */
export function canonicalSymbol(name: string): string {
  let s = name.trim().toUpperCase();
  for (let i = 0; i < 3; i++) {
    const next = s.replace(SUFFIX_RE, "");
    if (next === s || next.length < 3) break;
    s = next;
  }
  s = s.replace(/[^A-Z0-9]/g, "");
  // Trailing single lowercase-style account suffix on 7-char FX names, e.g. EURUSDM.
  if (/^[A-Z]{6}[A-Z]$/.test(s) && !Object.values(ALIASES).some((a) => a.includes(s))) s = s.slice(0, 6);
  return s;
}

function aliasGroup(canonical: string): string | null {
  for (const [group, names] of Object.entries(ALIASES)) if (names.includes(canonical)) return group;
  return null;
}

export interface MappingSuggestion {
  masterSymbol: string;
  followerSymbol: string;
  confidence: "EXACT" | "NORMALIZED" | "ALIAS";
  note: string;
}

/** Suggests follower symbols for each master symbol. Suggestions are never activated automatically. */
export function suggestMappings(masterSymbols: string[], followerSymbols: string[]): MappingSuggestion[] {
  const out: MappingSuggestion[] = [];
  const fByUpper = new Map(followerSymbols.map((s) => [s.toUpperCase(), s]));
  const fByCanon = new Map<string, string[]>();
  const fByGroup = new Map<string, string[]>();
  for (const f of followerSymbols) {
    const c = canonicalSymbol(f);
    fByCanon.set(c, [...(fByCanon.get(c) ?? []), f]);
    const g = aliasGroup(c);
    if (g) fByGroup.set(g, [...(fByGroup.get(g) ?? []), f]);
  }
  for (const m of masterSymbols) {
    const exact = fByUpper.get(m.toUpperCase());
    if (exact) {
      out.push({ masterSymbol: m, followerSymbol: exact, confidence: "EXACT", note: "same name; contract specs still need confirmation" });
      continue;
    }
    const c = canonicalSymbol(m);
    const byCanon = fByCanon.get(c);
    if (byCanon && byCanon.length === 1) {
      out.push({ masterSymbol: m, followerSymbol: byCanon[0]!, confidence: "NORMALIZED", note: "broker suffix differs" });
      continue;
    }
    const g = aliasGroup(c);
    const byGroup = g ? fByGroup.get(g) : undefined;
    if (byGroup && byGroup.length >= 1) {
      for (const f of byGroup)
        out.push({
          masterSymbol: m,
          followerSymbol: f,
          confidence: "ALIAS",
          note: `both look like ${g}; index CFDs differ in contract size, tick value and price basis — verify`,
        });
    }
  }
  return out;
}

export type CheckSeverity = "ok" | "info" | "warning" | "error";
export interface MappingCheck {
  code: string;
  severity: CheckSeverity;
  message: string;
}

/** Validates a master->follower mapping using both instrument specs and (optionally) live quotes. */
export function validateMapping(
  master: InstrumentSpec | null,
  follower: InstrumentSpec | null,
  ctx: { followerCurrency: string; fx: FxTable; masterQuote?: Quote | null; followerQuote?: Quote | null; maxQuoteAgeMs?: number; now?: number },
): MappingCheck[] {
  const checks: MappingCheck[] = [];
  const now = ctx.now ?? Date.now();
  if (!master) checks.push({ code: "MASTER_SPEC_MISSING", severity: "error", message: "master instrument specification has not been synchronised" });
  if (!follower) checks.push({ code: "FOLLOWER_SPEC_MISSING", severity: "error", message: "follower instrument specification has not been synchronised" });
  if (!master || !follower) return checks;

  if (!follower.tradable) checks.push({ code: "NOT_TRADABLE", severity: "error", message: `${follower.symbol} is not tradable on the follower` });
  if (!follower.orderKinds.includes("MARKET"))
    checks.push({ code: "NO_MARKET", severity: "error", message: "follower instrument does not accept market orders" });
  for (const k of ["LIMIT", "STOP"] as const)
    if (!follower.orderKinds.includes(k))
      checks.push({ code: `NO_${k}`, severity: "warning", message: `follower does not accept ${k} orders: pending ${k} copies will be rejected` });

  for (const f of follower.missingFields)
    checks.push({ code: "FOLLOWER_FIELD_MISSING", severity: "warning", message: `follower did not report ${f}` });
  for (const f of master.missingFields)
    checks.push({ code: "MASTER_FIELD_MISSING", severity: "warning", message: `master did not report ${f}` });

  if (master.contractSize !== null && follower.contractSize !== null && master.contractSize !== follower.contractSize)
    checks.push({
      code: "CONTRACT_SIZE_DIFFERS",
      severity: "warning",
      message: `contract size differs (master ${master.contractSize}, follower ${follower.contractSize}): equal lots are NOT equal exposure; use normalised sizing`,
    });
  if (master.tickSize !== follower.tickSize)
    checks.push({ code: "TICK_SIZE_DIFFERS", severity: "info", message: `tick size differs (master ${master.tickSize}, follower ${follower.tickSize})` });
  if (master.digits !== follower.digits)
    checks.push({ code: "DIGITS_DIFFER", severity: "info", message: `price precision differs (master ${master.digits}, follower ${follower.digits}); prices will be rounded to follower ticks` });

  const tvc = follower.tickValueCurrency ?? follower.profitCurrency;
  if (tvc && tvc.toUpperCase() !== ctx.followerCurrency.toUpperCase()) {
    const k = ctx.fx.factor(tvc, ctx.followerCurrency, ctx.maxQuoteAgeMs, now);
    checks.push(
      k === null
        ? { code: "FX_MISSING", severity: "error", message: `currency conversion ${tvc}->${ctx.followerCurrency} required but no rate is available` }
        : { code: "FX_REQUIRED", severity: "info", message: `currency conversion ${tvc}->${ctx.followerCurrency} required (rate ${roundTo(k, 6)})` },
    );
  }
  if (follower.tickValue === null && (follower.contractSize === null || !follower.profitCurrency))
    checks.push({ code: "NO_VALUE_DATA", severity: "error", message: "follower tick value and contract size unavailable: only FIXED sizing is possible and risk sizing is refused" });

  if (follower.stopsDistance > 0)
    checks.push({ code: "STOPS_LEVEL", severity: "info", message: `follower requires SL/TP at least ${follower.stopsDistance} away from price` });

  const mq = ctx.masterQuote;
  const fq = ctx.followerQuote;
  const maxAge = ctx.maxQuoteAgeMs ?? 60_000;
  if (mq && fq) {
    if (now - mq.time > maxAge || now - fq.time > maxAge) {
      checks.push({ code: "QUOTE_STALE", severity: "warning", message: "quotes are stale; price-basis comparison skipped" });
    } else {
      const mMid = (mq.bid + mq.ask) / 2;
      const fMid = (fq.bid + fq.ask) / 2;
      const rel = Math.abs(mMid - fMid) / Math.max(mMid, fMid);
      if (rel > 0.02)
        checks.push({
          code: "PRICE_BASIS_DIFFERS",
          severity: "error",
          message: `prices differ by ${roundTo(rel * 100, 2)}% (master ${mMid}, follower ${fMid}): different underlying or quoting convention`,
        });
      else if (rel > 0.002)
        checks.push({
          code: "PRICE_OFFSET",
          severity: "warning",
          message: `price offset ${roundTo(mMid - fMid, follower.digits)} (${roundTo(rel * 100, 3)}%): prefer DISTANCE_FROM_ENTRY for SL/TP`,
        });
    }
  } else {
    checks.push({ code: "NO_QUOTES", severity: "info", message: "live quotes unavailable; price-basis check not performed" });
  }
  if (!checks.some((c) => c.severity === "error" || c.severity === "warning"))
    checks.push({ code: "OK", severity: "ok", message: "no blocking differences found" });
  return checks;
}

export const hasBlockingChecks = (checks: MappingCheck[]) => checks.some((c) => c.severity === "error");

export interface LevelMappingInput {
  side: Side;
  policySl: SlTpPolicy;
  policyTp: SlTpPolicy;
  masterEntry: number;
  masterSl: number | null;
  masterTp: number | null;
  /** Follower reference entry: fill price when known, quote otherwise. */
  followerEntry: number;
  followerSpec: InstrumentSpec;
}

export interface LevelMappingResult {
  sl: number | null;
  tp: number | null;
  notes: string[];
}

export function mapProtectiveLevels(i: LevelMappingInput): LevelMappingResult {
  const notes: string[] = [];
  const conv = (lvl: number | null, policy: SlTpPolicy, label: string): number | null => {
    if (lvl === null || lvl <= 0 || policy === "NONE") return null;
    let v: number;
    if (policy === "ABSOLUTE_PRICE") v = lvl;
    else {
      const dist = lvl - i.masterEntry;
      v = i.followerEntry + dist;
      notes.push(`${label} distance ${roundTo(dist, i.followerSpec.digits)} applied to follower entry ${i.followerEntry}`);
    }
    return roundToTick(v, i.followerSpec.tickSize, i.followerSpec.digits);
  };
  return { sl: conv(i.masterSl, i.policySl, "SL"), tp: conv(i.masterTp, i.policyTp, "TP"), notes };
}

/**
 * Validates SL/TP against direction and stop-distance rules, using the follower quote.
 * BUY: SL < bid - stops, TP > bid + stops. SELL: SL > ask + stops, TP < ask - stops.
 */
export function validateProtectiveLevels(
  side: Side,
  sl: number | null,
  tp: number | null,
  quote: Pick<Quote, "bid" | "ask">,
  spec: Pick<InstrumentSpec, "stopsDistance" | "digits">,
): { ok: true } | { ok: false; reason: string } {
  const d = spec.stopsDistance;
  const ref = side === "BUY" ? quote.bid : quote.ask;
  const fmt = (n: number) => roundTo(n, spec.digits);
  if (sl !== null) {
    if (side === "BUY" && !(sl < ref - d)) return { ok: false, reason: `SL ${sl} must be below ${fmt(ref - d)} (bid ${ref} - stops ${d})` };
    if (side === "SELL" && !(sl > ref + d)) return { ok: false, reason: `SL ${sl} must be above ${fmt(ref + d)} (ask ${ref} + stops ${d})` };
  }
  if (tp !== null) {
    if (side === "BUY" && !(tp > ref + d)) return { ok: false, reason: `TP ${tp} must be above ${fmt(ref + d)} (bid ${ref} + stops ${d})` };
    if (side === "SELL" && !(tp < ref - d)) return { ok: false, reason: `TP ${tp} must be below ${fmt(ref - d)} (ask ${ref} - stops ${d})` };
  }
  return { ok: true };
}

/** Entry deviation in follower ticks between the master entry and the follower quote. */
export function entryDeviationPoints(side: Side, masterEntry: number, quote: Pick<Quote, "bid" | "ask">, tickSize: number): number {
  const px = side === "BUY" ? quote.ask : quote.bid;
  return Math.abs(px - masterEntry) / tickSize;
}

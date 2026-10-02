import type { FxTable } from "./fx";
import type { SizingConfig } from "./schemas";
import type { InstrumentSpec } from "./types";
import { normalizeVolume, roundTo } from "./volume";

export interface SizingAccount {
  balance: number;
  equity: number;
  currency: string;
}

export interface SizingInput {
  sizing: SizingConfig;
  maxOrderLots: number;
  masterVolume: number;
  masterSpec: InstrumentSpec;
  followerSpec: InstrumentSpec;
  masterAccount: SizingAccount;
  followerAccount: SizingAccount;
  /** Follower-side expected entry price (quote) — needed for risk sizing. */
  followerEntryPrice?: number;
  /** Follower-side stop loss price after SL mapping — needed for risk sizing. */
  followerStopLoss?: number | null;
  fx: FxTable;
  fxMaxAgeMs?: number;
  now?: number;
}

export type SizingResult =
  | {
      ok: true;
      volume: number;
      rawVolume: number;
      explanation: string[];
      /** Estimated loss at SL in follower currency (when SL known). */
      riskAtStop: number | null;
      /** Follower money per 1.0 price move for the final volume, in follower currency. */
      moneyPerPoint: number | null;
    }
  | { ok: false; reason: string; explanation: string[] };

/**
 * Money value of a 1.0 price move for 1 lot, expressed in `targetCurrency`.
 * Uses tick value/tick size where available, otherwise contract size in the profit currency.
 * Returns null with a reason when the instrument data or FX rate is insufficient.
 */
export function valuePerPriceUnit(
  spec: InstrumentSpec,
  targetCurrency: string,
  fx: FxTable,
  fxMaxAgeMs?: number,
  now?: number,
): { value: number; via: string } | { value: null; reason: string } {
  const unverified = (f: string) => spec.missingFields.includes(f);
  const tickPathOk = !unverified("tickValue") && !unverified("tickValueCurrency") && !unverified("tickSize");
  const contractPathOk = !unverified("contractSize") && !unverified("profitCurrency");
  if (tickPathOk && spec.tickValue !== null && spec.tickValue > 0 && spec.tickSize > 0 && spec.tickValueCurrency) {
    const raw = spec.tickValue / spec.tickSize;
    const k = fx.factor(spec.tickValueCurrency, targetCurrency, fxMaxAgeMs, now);
    if (k === null) return { value: null, reason: `no FX rate ${spec.tickValueCurrency}->${targetCurrency} for ${spec.symbol}` };
    return { value: raw * k, via: `tickValue ${spec.tickValue} ${spec.tickValueCurrency} / tickSize ${spec.tickSize}` };
  }
  if (contractPathOk && spec.contractSize !== null && spec.contractSize > 0 && spec.profitCurrency) {
    const k = fx.factor(spec.profitCurrency, targetCurrency, fxMaxAgeMs, now);
    if (k === null) return { value: null, reason: `no FX rate ${spec.profitCurrency}->${targetCurrency} for ${spec.symbol}` };
    return { value: spec.contractSize * k, via: `contractSize ${spec.contractSize} ${spec.profitCurrency}` };
  }
  return {
    value: null,
    reason: `${spec.symbol}: tick value/contract size/profit currency unavailable or unverified (${spec.missingFields.join(", ") || "no data"}); confirm a manual spec override`,
  };
}

export function computeFollowerVolume(input: SizingInput): SizingResult {
  const { sizing, followerSpec, masterSpec, followerAccount, masterAccount, fx } = input;
  const ccy = followerAccount.currency;
  const explanation: string[] = [];
  const fail = (reason: string): SizingResult => ({ ok: false, reason, explanation });

  if (!followerSpec.tradable) return fail(`${followerSpec.symbol} is not tradable on the follower`);
  const fVpp = valuePerPriceUnit(followerSpec, ccy, fx, input.fxMaxAgeMs, input.now);
  let desired: number;
  let hardCap = input.maxOrderLots;

  switch (sizing.mode) {
    case "FIXED": {
      desired = sizing.lots;
      explanation.push(`fixed ${sizing.lots} lots`);
      break;
    }
    case "MULTIPLIER": {
      if (!sizing.normalizeContracts) {
        const same =
          masterSpec.contractSize !== null &&
          masterSpec.contractSize === followerSpec.contractSize &&
          masterSpec.tickSize === followerSpec.tickSize &&
          masterSpec.tickValue === followerSpec.tickValue &&
          masterSpec.tickValueCurrency === followerSpec.tickValueCurrency;
        if (!same) {
          return fail(
            "raw lot multiplier refused: master and follower instruments do not report identical contract specifications; enable contract normalisation",
          );
        }
        desired = input.masterVolume * sizing.multiplier;
        explanation.push(`raw multiplier ${input.masterVolume} x ${sizing.multiplier} (identical specs verified)`);
        break;
      }
      const mVpp = valuePerPriceUnit(masterSpec, ccy, fx, input.fxMaxAgeMs, input.now);
      if (mVpp.value === null) return fail(`master exposure unknown: ${mVpp.reason}`);
      if (fVpp.value === null) return fail(`follower exposure unknown: ${fVpp.reason}`);
      desired = (input.masterVolume * mVpp.value * sizing.multiplier) / fVpp.value;
      explanation.push(
        `master ${input.masterVolume} lots = ${roundTo(input.masterVolume * mVpp.value, 4)} ${ccy}/pt (${mVpp.via})`,
        `x ${sizing.multiplier} / follower ${roundTo(fVpp.value, 6)} ${ccy}/pt per lot (${fVpp.via})`,
      );
      break;
    }
    case "EQUITY_PROPORTIONAL": {
      const mVpp = valuePerPriceUnit(masterSpec, ccy, fx, input.fxMaxAgeMs, input.now);
      if (mVpp.value === null) return fail(`master exposure unknown: ${mVpp.reason}`);
      if (fVpp.value === null) return fail(`follower exposure unknown: ${fVpp.reason}`);
      const mEq = fx.convert(masterAccount.equity, masterAccount.currency, ccy, input.fxMaxAgeMs, input.now);
      if (mEq === null) return fail(`no FX rate ${masterAccount.currency}->${ccy} for master equity`);
      if (!(mEq > 0)) return fail("master equity is not positive");
      if (!(followerAccount.equity > 0)) return fail("follower equity is not positive");
      const ratio = followerAccount.equity / mEq;
      desired = ((input.masterVolume * mVpp.value) / fVpp.value) * ratio * sizing.factor;
      explanation.push(
        `equity ratio ${roundTo(followerAccount.equity, 2)} / ${roundTo(mEq, 2)} ${ccy} = ${roundTo(ratio, 6)}`,
        `exposure-equivalent lots ${roundTo((input.masterVolume * mVpp.value) / fVpp.value, 6)} x ratio x ${sizing.factor}`,
      );
      break;
    }
    case "RISK_PERCENT": {
      const sl = input.followerStopLoss;
      const entry = input.followerEntryPrice;
      if (sl === null || sl === undefined || !(sl > 0)) return fail("risk sizing requires a valid stop loss on the master trade");
      if (entry === undefined || !(entry > 0)) return fail("risk sizing requires a follower quote");
      const dist = Math.abs(entry - sl);
      if (!(dist > 0)) return fail("stop loss distance is zero");
      if (fVpp.value === null) return fail(`risk sizing refused: ${fVpp.reason}`);
      const base = sizing.basis === "EQUITY" ? followerAccount.equity : followerAccount.balance;
      if (!(base > 0)) return fail(`follower ${sizing.basis.toLowerCase()} is not positive`);
      const riskAmount = (base * sizing.riskPercent) / 100;
      const lossPerLot = dist * fVpp.value;
      desired = riskAmount / lossPerLot;
      hardCap = Math.min(hardCap, desired);
      explanation.push(
        `risk ${sizing.riskPercent}% of ${sizing.basis.toLowerCase()} ${roundTo(base, 2)} = ${roundTo(riskAmount, 2)} ${ccy}`,
        `SL distance ${roundTo(dist, 8)} x ${roundTo(fVpp.value, 6)} ${ccy}/pt = ${roundTo(lossPerLot, 4)} ${ccy} per lot`,
      );
      break;
    }
  }

  const norm = normalizeVolume(desired, followerSpec, { mode: "down", hardCap });
  if (!norm.ok) {
    explanation.push(norm.reason);
    return fail(norm.reason);
  }
  explanation.push(
    `raw ${roundTo(desired, 6)} -> ${norm.volume} lots (step ${followerSpec.volumeStep}, min ${followerSpec.volumeMin}, max ${followerSpec.volumeMax}, order cap ${input.maxOrderLots})`,
  );
  const mpp = fVpp.value !== null ? fVpp.value * norm.volume : null;
  const riskAtStop =
    mpp !== null && input.followerStopLoss && input.followerEntryPrice
      ? Math.abs(input.followerEntryPrice - input.followerStopLoss) * mpp
      : null;
  return { ok: true, volume: norm.volume, rawVolume: desired, explanation, riskAtStop, moneyPerPoint: mpp };
}

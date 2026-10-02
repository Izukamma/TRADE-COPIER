import { describe, expect, it } from "vitest";
import { FxTable } from "../src/fx";
import { computeFollowerVolume, valuePerPriceUnit } from "../src/sizing";
import type { InstrumentSpec } from "../src/types";

const spec = (p: Partial<InstrumentSpec> & Pick<InstrumentSpec, "symbol">): InstrumentSpec => ({
  digits: 2,
  tickSize: 0.01,
  tickValue: 0.01,
  tickValueCurrency: "USD",
  contractSize: 1,
  profitCurrency: "USD",
  volumeMin: 0.01,
  volumeMax: 100,
  volumeStep: 0.01,
  stopsDistance: 0,
  orderKinds: ["MARKET", "LIMIT", "STOP"],
  tradable: true,
  missingFields: [],
  fetchedAt: 0,
  ...p,
});

// US30 at broker A: 1 lot = $1/point. DJ30 at broker B: 1 lot = $10/point, 0.1 lot steps.
const us30 = spec({ symbol: "US30" });
const dj30 = spec({ symbol: "DJ30.cash", digits: 1, tickSize: 0.1, tickValue: 1, contractSize: 10, volumeMin: 0.1, volumeStep: 0.1 });
const fx = new FxTable([{ base: "GBP", quote: "USD", rate: 1.25, time: Date.now(), source: "test" }]);
const usd = { balance: 100_000, equity: 100_000, currency: "USD" };
const gbp = { balance: 50_000, equity: 48_000, currency: "GBP" };

describe("sizing across contract specifications and currencies", () => {
  it("value per point converts tick value into the account currency", () => {
    expect(valuePerPriceUnit(dj30, "USD", fx)).toMatchObject({ value: 10 });
    expect(valuePerPriceUnit(dj30, "GBP", fx)).toMatchObject({ value: 8 });
  });

  it("fixed lots are respected and rounded down to the follower step", () => {
    const r = computeFollowerVolume({ sizing: { mode: "FIXED", lots: 0.25 }, maxOrderLots: 5, masterVolume: 3, masterSpec: us30, followerSpec: dj30, masterAccount: usd, followerAccount: gbp, fx });
    expect(r).toMatchObject({ ok: true, volume: 0.2 });
  });

  it("normalised multiplier converts exposure, not lots (equal lots != equal exposure)", () => {
    // 2 lots US30 = $2/pt. DJ30 lot = $10/pt -> 0.2 lots.
    const r = computeFollowerVolume({ sizing: { mode: "MULTIPLIER", multiplier: 1, normalizeContracts: true }, maxOrderLots: 5, masterVolume: 2, masterSpec: us30, followerSpec: dj30, masterAccount: usd, followerAccount: gbp, fx });
    expect(r).toMatchObject({ ok: true, volume: 0.2 });
  });

  it("raw lot multiplier is refused when specs differ", () => {
    const r = computeFollowerVolume({ sizing: { mode: "MULTIPLIER", multiplier: 1, normalizeContracts: false }, maxOrderLots: 5, masterVolume: 2, masterSpec: us30, followerSpec: dj30, masterAccount: usd, followerAccount: gbp, fx });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/identical contract specifications/);
  });

  it("equity-proportional sizing converts master equity into follower currency", () => {
    // follower equity 48,000 GBP = 60,000 USD; ratio 0.6 vs 100k master. 5 lots US30 = $5/pt -> 0.5 DJ30 lots * 0.6 = 0.3
    const r = computeFollowerVolume({ sizing: { mode: "EQUITY_PROPORTIONAL", factor: 1 }, maxOrderLots: 5, masterVolume: 5, masterSpec: us30, followerSpec: dj30, masterAccount: usd, followerAccount: gbp, fx });
    expect(r).toMatchObject({ ok: true, volume: 0.3 });
  });

  it("risk sizing uses SL distance, tick value and currency, rounding down", () => {
    // 1% of 48,000 GBP = 480 GBP. SL 100 points * 8 GBP/pt/lot = 800 GBP per lot -> 0.6 lots
    const r = computeFollowerVolume({ sizing: { mode: "RISK_PERCENT", riskPercent: 1, basis: "EQUITY" }, maxOrderLots: 5, masterVolume: 1, masterSpec: us30, followerSpec: dj30, masterAccount: usd, followerAccount: gbp, followerEntryPrice: 42000, followerStopLoss: 41900, fx });
    expect(r).toMatchObject({ ok: true, volume: 0.6 });
    expect(r.ok && r.riskAtStop).toBeCloseTo(480, 6);
  });

  it("risk sizing rejects entries without a stop loss", () => {
    const r = computeFollowerVolume({ sizing: { mode: "RISK_PERCENT", riskPercent: 1, basis: "EQUITY" }, maxOrderLots: 5, masterVolume: 1, masterSpec: us30, followerSpec: dj30, masterAccount: usd, followerAccount: gbp, followerEntryPrice: 42000, followerStopLoss: null, fx });
    expect(r.ok).toBe(false);
  });

  it("risk sizing rejects when the minimum lot would exceed the risk budget", () => {
    // 0.05% of 48,000 = 24 GBP; min 0.1 lot at 1000 points SL = 800 GBP -> reject, never round up
    const r = computeFollowerVolume({ sizing: { mode: "RISK_PERCENT", riskPercent: 0.05, basis: "EQUITY" }, maxOrderLots: 5, masterVolume: 1, masterSpec: us30, followerSpec: dj30, masterAccount: usd, followerAccount: gbp, followerEntryPrice: 42000, followerStopLoss: 41000, fx });
    expect(r.ok).toBe(false);
  });

  it("refuses sizing when FX conversion is unavailable", () => {
    const r = computeFollowerVolume({ sizing: { mode: "MULTIPLIER", multiplier: 1, normalizeContracts: true }, maxOrderLots: 5, masterVolume: 2, masterSpec: us30, followerSpec: dj30, masterAccount: usd, followerAccount: { ...gbp, currency: "JPY" }, fx });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/FX/);
  });

  it("refuses non-fixed sizing when tick value data is unverified", () => {
    const tl = spec({ symbol: "US30", missingFields: ["tickValueCurrency"], contractSize: null });
    const r = computeFollowerVolume({ sizing: { mode: "RISK_PERCENT", riskPercent: 1, basis: "EQUITY" }, maxOrderLots: 5, masterVolume: 1, masterSpec: us30, followerSpec: tl, masterAccount: usd, followerAccount: usd, followerEntryPrice: 42000, followerStopLoss: 41900, fx });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/unverified/);
  });

  it("applies the max order cap", () => {
    const r = computeFollowerVolume({ sizing: { mode: "MULTIPLIER", multiplier: 10, normalizeContracts: true }, maxOrderLots: 1, masterVolume: 5, masterSpec: us30, followerSpec: dj30, masterAccount: usd, followerAccount: gbp, fx });
    expect(r).toMatchObject({ ok: true, volume: 1 });
  });

  it("EURUSD in a GBP account: contract-size path when tick data is missing", () => {
    const eur = spec({ symbol: "EURUSD", digits: 5, tickSize: 0.00001, tickValue: null, tickValueCurrency: null, contractSize: 100_000, profitCurrency: "USD" });
    const v = valuePerPriceUnit(eur, "GBP", fx);
    expect(v.value).toBeCloseTo(80_000, 6); // 100k units * 0.8 GBP per USD
  });
});

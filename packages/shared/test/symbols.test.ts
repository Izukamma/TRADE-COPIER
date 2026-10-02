import { describe, expect, it } from "vitest";
import { FxTable } from "../src/fx";
import { canonicalSymbol, mapProtectiveLevels, suggestMappings, validateMapping, validateProtectiveLevels } from "../src/symbols";
import type { InstrumentSpec } from "../src/types";

const spec = (p: Partial<InstrumentSpec> & Pick<InstrumentSpec, "symbol">): InstrumentSpec => ({
  digits: 2, tickSize: 0.01, tickValue: 0.01, tickValueCurrency: "USD", contractSize: 1, profitCurrency: "USD",
  volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, stopsDistance: 0, orderKinds: ["MARKET", "LIMIT", "STOP"],
  tradable: true, missingFields: [], fetchedAt: 0, ...p,
});

describe("symbol mapping", () => {
  it("canonicalises broker suffixes", () => {
    expect(canonicalSymbol("US30.cash")).toBe("US30");
    expect(canonicalSymbol("EURUSD.r")).toBe("EURUSD");
    expect(canonicalSymbol("EURUSDm")).toBe("EURUSD");
    expect(canonicalSymbol("XAUUSD.pro")).toBe("XAUUSD");
  });

  it("suggests index mappings across naming conventions without auto-confirming", () => {
    const s = suggestMappings(["US30", "NAS100", "SPX500", "EURUSD"], ["DJ30.cash", "USTEC", "US500.cash", "EURUSD.r", "GER40"]);
    const by = Object.fromEntries(s.map((x) => [x.masterSymbol, x]));
    expect(by.US30).toMatchObject({ followerSymbol: "DJ30.cash", confidence: "ALIAS" });
    expect(by.NAS100).toMatchObject({ followerSymbol: "USTEC", confidence: "ALIAS" });
    expect(by.SPX500).toMatchObject({ followerSymbol: "US500.cash", confidence: "ALIAS" });
    expect(by.EURUSD).toMatchObject({ followerSymbol: "EURUSD.r", confidence: "NORMALIZED" });
    expect(by.US30!.note).toMatch(/verify/);
  });

  it("flags differing contract specs between Dow CFDs and a price-basis mismatch", () => {
    const fx = new FxTable();
    const now = Date.now();
    const checks = validateMapping(spec({ symbol: "US30" }), spec({ symbol: "DJ30", contractSize: 10, tickValue: 1, tickSize: 0.1, digits: 1 }), {
      followerCurrency: "USD", fx, now,
      masterQuote: { symbol: "US30", bid: 42000, ask: 42002, time: now },
      followerQuote: { symbol: "DJ30", bid: 4200, ask: 4200.2, time: now },
    });
    expect(checks.find((c) => c.code === "CONTRACT_SIZE_DIFFERS")?.severity).toBe("warning");
    expect(checks.find((c) => c.code === "PRICE_BASIS_DIFFERS")?.severity).toBe("error");
  });

  it("errors when FX conversion is required but missing", () => {
    const checks = validateMapping(spec({ symbol: "US30" }), spec({ symbol: "US30" }), { followerCurrency: "EUR", fx: new FxTable() });
    expect(checks.some((c) => c.code === "FX_MISSING" && c.severity === "error")).toBe(true);
  });

  it("maps SL/TP by absolute price or by distance from entry", () => {
    const f = spec({ symbol: "DJ30", tickSize: 0.1, digits: 1 });
    const abs = mapProtectiveLevels({ side: "BUY", policySl: "ABSOLUTE_PRICE", policyTp: "ABSOLUTE_PRICE", masterEntry: 42000, masterSl: 41900.07, masterTp: 42200, followerEntry: 42010, followerSpec: f });
    expect(abs).toMatchObject({ sl: 41900.1, tp: 42200 });
    const dist = mapProtectiveLevels({ side: "BUY", policySl: "DISTANCE_FROM_ENTRY", policyTp: "NONE", masterEntry: 42000, masterSl: 41900, masterTp: 42200, followerEntry: 42010, followerSpec: f });
    expect(dist).toMatchObject({ sl: 41910, tp: null });
  });

  it("validates stop distances and direction", () => {
    const q = { bid: 100, ask: 100.2 };
    expect(validateProtectiveLevels("BUY", 99, 101, q, { stopsDistance: 0.5, digits: 2 }).ok).toBe(true);
    expect(validateProtectiveLevels("BUY", 99.8, null, q, { stopsDistance: 0.5, digits: 2 }).ok).toBe(false);
    expect(validateProtectiveLevels("SELL", 99, null, q, { stopsDistance: 0, digits: 2 }).ok).toBe(false);
    expect(validateProtectiveLevels("SELL", 101, 99, q, { stopsDistance: 0.5, digits: 2 }).ok).toBe(true);
  });
});

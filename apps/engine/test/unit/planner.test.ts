import { describe, expect, it } from "vitest";
import { accountRiskSchema, defaultFollowerSettings, followerSettingsSchema, FxTable, type InstrumentSpec, type MasterEventPayload } from "@gtc/shared";
import { SIMULATOR_CAPABILITIES } from "@gtc/adapters";
import { partialCloseVolume, plan, type PlanContext } from "../../src/planner";

const NOW = 1_800_000_000_000;
const spec: InstrumentSpec = { symbol: "DJ30", digits: 1, tickSize: 0.1, tickValue: 1, tickValueCurrency: "USD", contractSize: 10, profitCurrency: "USD", volumeMin: 0.1, volumeMax: 50, volumeStep: 0.1, stopsDistance: 5, orderKinds: ["MARKET", "LIMIT", "STOP"], tradable: true, missingFields: [], fetchedAt: NOW };
const mspec: InstrumentSpec = { ...spec, symbol: "US30", digits: 2, tickSize: 0.01, tickValue: 0.01, contractSize: 1, volumeMin: 0.01, volumeStep: 0.01, stopsDistance: 0 };

const ev = (p: Partial<MasterEventPayload> = {}): MasterEventPayload => ({ type: "POSITION_OPENED", masterKey: "1", positionId: "1", symbol: "US30", side: "BUY", kind: "MARKET", volume: 2, price: 42000, sl: 41900, tp: 42300, openTime: NOW - 1000, tag: null, magic: null, ...p });

function ctx(over: Partial<PlanContext> = {}, settings: Record<string, unknown> = {}): PlanContext {
  return {
    now: NOW,
    liveTradingEnabled: false,
    event: ev(),
    eventDetectedAt: NOW - 500,
    eventSource: "POLL",
    settings: followerSettingsSchema.parse({ ...defaultFollowerSettings(), sizing: { mode: "MULTIPLIER", multiplier: 1, normalizeContracts: true }, maxOrderLots: 5, ...settings }),
    pauses: { global: false, group: false, route: false, account: false },
    dailyLossBreached: false,
    follower: {
      environment: "DEMO",
      liveExecutionArmed: false,
      capabilities: SIMULATOR_CAPABILITIES,
      snapshot: { account: { balance: 50_000, equity: 50_000, currency: "USD", freeMargin: 40_000, marginUsed: 0, accounting: "HEDGING", serverTime: null, fetchedAt: NOW }, positions: [], orders: [] },
      snapshotAgeMs: 1000,
      risk: accountRiskSchema.parse({}),
      magic: 1,
    },
    master: { equity: 100_000, balance: 100_000, currency: "USD", spec: mspec },
    mapping: { followerSymbol: "DJ30", status: "CONFIRMED" },
    followerSpec: spec,
    followerQuote: { symbol: "DJ30", bid: 42000.5, ask: 42001.5, time: NOW - 100 },
    followerQuoteError: null,
    link: null,
    exposure: { routeLots: 0, accountLots: 0, routeOpenPositions: 0 },
    unrelatedPositionsOnSymbol: 0,
    fx: new FxTable(),
    clientId: "abcdefghjkmn",
    tag: "gtc1:abcdefghjkmn",
    ...over,
  };
}

const openLink = { id: "L", status: "OPEN" as const, followerPositionId: "F1", followerOrderId: null, followerSymbol: "DJ30", side: "BUY" as const, masterVolumeCurrent: 2, followerVolumeCurrent: 0.2, masterOpenPrice: 42000, followerOpenPrice: 42001.5 };

describe("planner: entries", () => {
  it("plans a normalised market entry with mapped SL/TP", () => {
    const p = plan(ctx());
    expect(p.kind).toBe("SUBMIT");
    if (p.kind !== "SUBMIT") return;
    expect(p.command).toMatchObject({ kind: "OPEN_MARKET", symbol: "DJ30", side: "BUY", volume: 0.2, sl: 41900, tp: 42300, tag: "gtc1:abcdefghjkmn" });
  });

  it("rejects stale entries (no replay after reconnect)", () => {
    const p = plan(ctx({ event: ev({ openTime: NOW - 120_000 }) }));
    expect(p).toMatchObject({ kind: "SKIP" });
    expect((p as { reason: string }).reason).toMatch(/stale entry/);
  });

  it("explicit existing-position copies bypass the age check", () => {
    expect(plan(ctx({ event: ev({ openTime: NOW - 3_600_000 }), eventSource: "EXISTING" })).kind).toBe("SUBMIT");
  });

  it("skips entries while paused at any level", () => {
    for (const k of ["global", "group", "route", "account"] as const) {
      const p = plan(ctx({ pauses: { global: false, group: false, route: false, account: false, [k]: true } }));
      expect(p.kind).toBe("SKIP");
    }
    expect(plan(ctx({ dailyLossBreached: true })).kind).toBe("SKIP");
  });

  it("enforces the LIVE gate", () => {
    const base = ctx();
    const live = ctx({ follower: { ...base.follower, environment: "LIVE", liveExecutionArmed: true } });
    expect(plan(live)).toMatchObject({ kind: "REJECT" });
    expect(plan({ ...live, liveTradingEnabled: true }).kind).toBe("SUBMIT");
  });

  it("applies mandatory SL, direction, symbol and EA filters", () => {
    expect(plan(ctx({ event: ev({ sl: null }) }, { requireStopLoss: true })).kind).toBe("SKIP");
    expect(plan(ctx({}, { allowedDirections: "SELL_ONLY" })).kind).toBe("SKIP");
    expect(plan(ctx({}, { allowedSymbols: ["NAS100"] })).kind).toBe("SKIP");
    expect(plan(ctx({ event: ev({ magic: 42 }) })).kind).toBe("SKIP");
    expect(plan(ctx({ event: ev({ magic: 42 }) }, { sourceFilter: { manual: true, eaMagics: [42] } })).kind).toBe("SUBMIT");
    expect(plan(ctx({}, { sourceFilter: { manual: false, eaMagics: [] } })).kind).toBe("SKIP");
  });

  it("rejects price deviation beyond the limit and unconfirmed mappings", () => {
    const far = ctx({ followerQuote: { symbol: "DJ30", bid: 42100, ask: 42101, time: NOW } }, { maxEntryDeviationPoints: 50 });
    expect(plan(far)).toMatchObject({ kind: "REJECT" });
    expect(plan(ctx({ mapping: { followerSymbol: "DJ30", status: "SUGGESTED" } }))).toMatchObject({ kind: "REJECT" });
  });

  it("rejects invalid stop distances rather than dropping the SL", () => {
    const p = plan(ctx({ event: ev({ sl: 41998 }) }));
    expect(p).toMatchObject({ kind: "REJECT" });
    expect((p as { reason: string }).reason).toMatch(/SL\/TP invalid/);
  });

  it("blocks netting followers unless symbols are exclusive and free of unrelated positions", () => {
    const base = ctx();
    const netting = { ...base.follower, snapshot: { ...base.follower.snapshot!, account: { ...base.follower.snapshot!.account, accounting: "NETTING" as const } } };
    expect(plan(ctx({ follower: netting }))).toMatchObject({ kind: "REJECT" });
    expect(plan(ctx({ follower: netting }, { nettingExclusiveSymbols: true })).kind).toBe("SUBMIT");
    expect(plan(ctx({ follower: netting, unrelatedPositionsOnSymbol: 1 }, { nettingExclusiveSymbols: true }))).toMatchObject({ kind: "REJECT" });
  });

  it("enforces exposure caps without rounding past them and max positions", () => {
    expect(plan(ctx({ exposure: { routeLots: 4.9, accountLots: 0, routeOpenPositions: 1 } }, { maxExposureLots: 5 }))).toMatchObject({ kind: "REJECT" });
    expect(plan(ctx({ exposure: { routeLots: 0, accountLots: 0, routeOpenPositions: 10 } }, { maxOpenPositions: 10 }))).toMatchObject({ kind: "REJECT" });
  });

  it("refuses stale follower account data", () => {
    const base = ctx();
    expect(plan(ctx({ follower: { ...base.follower, snapshotAgeMs: 120_000 } }))).toMatchObject({ kind: "REJECT" });
  });

  it("suppresses duplicate entries when a link exists", () => {
    expect(plan(ctx({ link: openLink })).kind).toBe("SKIP");
  });

  it("does not substitute order types the follower lacks", () => {
    const p = plan(ctx({ event: ev({ type: "ORDER_PLACED", kind: "STOP", price: 42100 }), followerSpec: { ...spec, orderKinds: ["MARKET", "LIMIT"] } }, { copyPendingOrders: true }));
    expect(p).toMatchObject({ kind: "REJECT" });
  });
});

describe("planner: management continues while entries are paused", () => {
  const paused = { global: true, group: true, route: true, account: true };
  it("copies closes, partial closes and SL/TP changes while paused", () => {
    expect(plan(ctx({ pauses: paused, link: openLink, event: ev({ type: "POSITION_CLOSED", volume: 0 }) })).kind).toBe("SUBMIT");
    const partial = plan(ctx({ pauses: paused, link: openLink, event: ev({ type: "POSITION_PARTIALLY_CLOSED", previousVolume: 2, volume: 1 }) }));
    expect(partial).toMatchObject({ kind: "SUBMIT", command: { kind: "CLOSE_POSITION", volume: 0.1, positionId: "F1" } });
    const mod = plan(ctx({ pauses: paused, link: openLink, event: ev({ type: "POSITION_MODIFIED", sl: 41950, tp: 42400 }) }));
    expect(mod).toMatchObject({ kind: "SUBMIT", command: { kind: "MODIFY_POSITION", sl: 41950, tp: 42400 } });
  });

  it("never re-opens a diverged (manually closed) follower position", () => {
    const p = plan(ctx({ link: { ...openLink, status: "DIVERGED" }, event: ev({ type: "POSITION_MODIFIED" }) }));
    expect(p.kind).toBe("SKIP");
    expect(plan(ctx({ link: { ...openLink, status: "DIVERGED" } })).kind).toBe("SKIP");
  });

  it("cancels the follower pending order when the master cancels", () => {
    const l = { ...openLink, status: "PENDING_ORDER" as const, followerPositionId: null, followerOrderId: "O9" };
    expect(plan(ctx({ link: l, event: ev({ type: "ORDER_CANCELLED", kind: "LIMIT" }) }, { copyPendingOrders: true }))).toMatchObject({ kind: "SUBMIT", command: { kind: "CANCEL_PENDING", orderId: "O9" } });
  });

  it("owner close-all applies even when close copying is disabled", () => {
    expect(plan(ctx({ link: openLink, event: ev({ type: "POSITION_CLOSED" }) }, { copyFullCloses: false })).kind).toBe("SKIP");
    expect(plan(ctx({ link: openLink, eventSource: "CONTROL", event: ev({ type: "POSITION_CLOSED" }) }, { copyFullCloses: false })).kind).toBe("SUBMIT");
  });
});

describe("partial close quantities", () => {
  const s = { volumeStep: 0.1, volumeMin: 0.1 };
  it("keeps remaining exposure proportional or below, respecting the step", () => {
    expect(partialCloseVolume({ followerVolumeCurrent: 1 }, 2, 1, s, "CLOSE_ALL")).toMatchObject({ close: 0.5, full: false });
    expect(partialCloseVolume({ followerVolumeCurrent: 0.2 }, 2, 1.5, s, "CLOSE_ALL")).toMatchObject({ close: 0.1, full: false });
    expect(partialCloseVolume({ followerVolumeCurrent: 0.3 }, 1, 0.1, s, "CLOSE_ALL")).toMatchObject({ close: 0.3, full: true });
    expect(partialCloseVolume({ followerVolumeCurrent: 0.3 }, 1, 0.1, s, "KEEP_MIN")).toMatchObject({ close: 0.2, full: false });
  });
});

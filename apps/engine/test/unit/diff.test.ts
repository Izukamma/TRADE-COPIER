import { describe, expect, it } from "vitest";
import type { TradingSnapshot } from "@gtc/shared";
import { diffSnapshots } from "../../src/diff";

const acct = { balance: 1, equity: 1, currency: "USD", freeMargin: 1, marginUsed: 0, accounting: "HEDGING" as const, serverTime: null, fetchedAt: 0 };
const pos = (id: string, p: Partial<TradingSnapshot["positions"][number]> = {}) => ({ id, symbol: "US30", side: "BUY" as const, volume: 1, openPrice: 42000, openTime: 1000, sl: null, tp: null, tag: null, ...p });
const snap = (positions: TradingSnapshot["positions"], orders: TradingSnapshot["orders"] = []): TradingSnapshot => ({ account: acct, positions, orders });
const none = () => false;

describe("master snapshot diff", () => {
  it("detects open, modify, partial close and close with deterministic keys", () => {
    const s0 = snap([]);
    const s1 = snap([pos("1")]);
    const r1 = diffSnapshots(s0, s1, { version: 0, aliases: {} }, none);
    expect(r1.events.map((e) => [e.payload.type, e.eventKey])).toEqual([["POSITION_OPENED", "open:1"]]);
    const again = diffSnapshots(s0, s1, { version: 0, aliases: {} }, none);
    expect(again.events[0]!.eventKey).toBe(r1.events[0]!.eventKey);

    const s2 = snap([pos("1", { sl: 41900, volume: 0.6 })]);
    const r2 = diffSnapshots(s1, s2, r1.state, none);
    expect(r2.events.map((e) => e.payload.type).sort()).toEqual(["POSITION_MODIFIED", "POSITION_PARTIALLY_CLOSED"]);
    const partial = r2.events.find((e) => e.payload.type === "POSITION_PARTIALLY_CLOSED")!;
    expect(partial.payload).toMatchObject({ previousVolume: 1, volume: 0.6, masterKey: "1" });

    const r3 = diffSnapshots(s2, snap([]), r2.state, none);
    expect(r3.events.map((e) => e.payload.type)).toEqual(["POSITION_CLOSED"]);
  });

  it("ignores copier-tagged trades and linked follower positions (loop prevention)", () => {
    const r = diffSnapshots(snap([]), snap([pos("9", { tag: "gtc1:abcdefghjkmn" }), pos("10")]), { version: 0, aliases: {} }, (t) => t.tag?.startsWith("gtc1:") === true || t.id === "10");
    expect(r.events).toHaveLength(0);
  });

  it("links a filled pending order to its position and keeps the order id as master key", () => {
    const order = { id: "77", symbol: "US30", side: "BUY" as const, kind: "LIMIT" as const, volume: 1, price: 41950, sl: null, tp: null, createdTime: 1, tag: null };
    const r1 = diffSnapshots(snap([]), snap([], [order]), { version: 0, aliases: {} }, none);
    expect(r1.events[0]!.payload.type).toBe("ORDER_PLACED");
    const r2 = diffSnapshots(snap([], [order]), snap([pos("500")]), r1.state, none);
    expect(r2.events[0]!.payload).toMatchObject({ type: "ORDER_FILLED", masterKey: "77", positionId: "500" });
    const r3 = diffSnapshots(snap([pos("500")]), snap([pos("500", { tp: 42500 })]), r2.state, none);
    expect(r3.events[0]!.payload).toMatchObject({ type: "POSITION_MODIFIED", masterKey: "77" });
  });

  it("reports cancelled pending orders and modifications", () => {
    const o = { id: "5", symbol: "US30", side: "SELL" as const, kind: "STOP" as const, volume: 1, price: 41000, sl: null, tp: null, createdTime: 1, tag: null };
    const r1 = diffSnapshots(snap([], [o]), snap([], [{ ...o, price: 41010 }]), { version: 3, aliases: {} }, none);
    expect(r1.events[0]!.payload.type).toBe("ORDER_MODIFIED");
    const r2 = diffSnapshots(snap([], [o]), snap([]), r1.state, none);
    expect(r2.events[0]!.payload.type).toBe("ORDER_CANCELLED");
  });

  it("splits a netting reversal into close + new open with a distinct key", () => {
    const r = diffSnapshots(snap([pos("1")]), snap([pos("1", { side: "SELL", volume: 0.5 })]), { version: 4, aliases: {} }, none);
    expect(r.events.map((e) => e.payload.type)).toEqual(["POSITION_CLOSED", "POSITION_OPENED"]);
    expect(r.events[1]!.payload.masterKey).toBe("1#r5");
  });

  it("detects scale-ins separately", () => {
    const r = diffSnapshots(snap([pos("1")]), snap([pos("1", { volume: 2 })]), { version: 0, aliases: {} }, none);
    expect(r.events[0]!.payload).toMatchObject({ type: "POSITION_INCREASED", previousVolume: 1, volume: 2 });
  });
});

describe("MT4 partial close (remainder gets a new ticket)", () => {
  it("is a partial close of the original trade, not close + new open", () => {
    const r = diffSnapshots(snap([pos("100", { volume: 1 })]), snap([pos("101", { volume: 0.4, replacesId: "100" })]), { version: 1, aliases: {} }, none);
    expect(r.events.map((e) => e.payload.type)).toEqual(["POSITION_PARTIALLY_CLOSED"]);
    expect(r.events[0]!.payload).toMatchObject({ masterKey: "100", positionId: "101", previousVolume: 1, volume: 0.4 });
    const r2 = diffSnapshots(snap([pos("101", { volume: 0.4, replacesId: "100" })]), snap([]), r.state, none);
    expect(r2.events[0]!.payload).toMatchObject({ type: "POSITION_CLOSED", masterKey: "100" });
  });
  it("excludes copier magic numbers even when the comment was rewritten", () => {
    const r = diffSnapshots(snap([]), snap([pos("7", { tag: "from #6", magic: 7710001 })]), { version: 0, aliases: {} }, (t) => t.magic === 7710001);
    expect(r.events).toHaveLength(0);
  });
});

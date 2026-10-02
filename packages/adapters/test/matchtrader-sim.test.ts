import { describe, expect, it, vi } from "vitest";
import { MatchTraderAdapter } from "../src/matchtrader/adapter";
import { SimBroker } from "../src/simulator/broker";

describe("Match-Trader adapter (mocked HTTP, not a real account)", () => {
  const login = { token: "co", accounts: [{ tradingAccountId: "77", tradingApiToken: "tat" }] };
  const mk = (unverified = false) => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const f = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: init.headers as Record<string, string> });
      if (url.endsWith("/manager/co-login")) return new Response(JSON.stringify(login));
      if (url.endsWith("/balance")) return new Response(JSON.stringify({ balance: 5000, equity: 5010, currency: "USD", freeMargin: 4000 }));
      if (url.endsWith("/open-positions")) return new Response(JSON.stringify({ positions: [{ id: "A1", symbol: "US30", side: "BUY", volume: 0.1, openPrice: 42000, stopLoss: 0, takeProfit: 0, openTime: "2026-01-01T00:00:00Z" }] }));
      if (url.endsWith("/position/open")) return new Response(JSON.stringify({ status: "OK", orderId: "X" }));
      return new Response("{}", { status: 404 });
    });
    const a = new MatchTraderAdapter({ baseUrl: "https://mtr.example.com", email: "e", password: "p", brokerId: "0", systemUuid: "00000000-0000-0000-0000-000000000000", account: "77", fetchImpl: f as unknown as typeof fetch, enableUnverifiedBodies: unverified });
    return { a, calls };
  };

  it("logs in, sends Auth-trading-api header and parses balance/positions", async () => {
    const { a, calls } = mk();
    await a.connect();
    const s = await a.getSnapshot();
    expect(s.account).toMatchObject({ balance: 5000, equity: 5010 });
    expect(s.positions[0]).toMatchObject({ id: "A1", sl: null, tp: null });
    expect(calls.find((c) => c.url.endsWith("/balance"))!.headers["Auth-trading-api"]).toBe("tat");
  });

  it("opens with the documented body and refuses unverified operations by default", async () => {
    const { a, calls } = mk();
    await a.connect();
    await a.submit({ kind: "OPEN_MARKET", clientId: "c", tag: "t", symbol: "US30", side: "SELL", volume: 0.1, sl: 42100, tp: null });
    expect(calls.find((c) => c.url.endsWith("/position/open"))!.body).toEqual({ instrument: "US30", orderSide: "SELL", volume: 0.1, slPrice: 42100, tpPrice: 0, isMobile: false });
    expect(await a.submit({ kind: "CLOSE_POSITION", clientId: "c", tag: "t", symbol: "US30", positionId: "A1" })).toMatchObject({ status: "REJECTED", retryable: false });
    expect(await a.submit({ kind: "PLACE_PENDING", clientId: "c", tag: "t", symbol: "US30", side: "BUY", volume: 0.1, price: 1, pendingKind: "LIMIT" })).toMatchObject({ status: "REJECTED" });
    expect(a.capabilities.orderTagging).toBe(false);
    expect(a.capabilities.integrationStatus).toBe("AWAITING_ACCESS");
  });

  it("reconciles tag-less opens only when exactly one new position matches", async () => {
    const { a } = mk();
    await a.connect();
    // Pre-submit snapshot recorded A1; after submission the mock still has only A1 -> not found.
    await a.submit({ kind: "OPEN_MARKET", clientId: "c1", tag: "t", symbol: "US30", side: "BUY", volume: 0.1 });
    expect(await a.reconcile({ kind: "OPEN_MARKET", clientId: "c1", tag: "t", symbol: "US30", side: "BUY", volume: 0.1 }, Date.now())).toMatchObject({ found: false, conclusive: true });
    expect(await a.reconcile({ kind: "OPEN_MARKET", clientId: "unknown", tag: "t", symbol: "US30", side: "BUY", volume: 0.1 }, Date.now())).toMatchObject({ conclusive: false });
  });
});

describe("simulator broker", () => {
  it("enforces volume steps and stop distances and supports netting", () => {
    const b = new SimBroker("SIM-BETA", { accounting: "NETTING", seed: 1 });
    expect(b.openMarket("DJ30.cash", "BUY", 0.15, null, null, null).ok).toBe(false);
    expect(b.openMarket("DJ30.cash", "BUY", 0.2, null, null, null).ok).toBe(true);
    expect(b.openMarket("DJ30.cash", "BUY", 0.1, null, null, null).ok).toBe(true);
    expect(b.snapshot().positions).toHaveLength(1);
    expect(b.snapshot().positions[0]!.volume).toBeCloseTo(0.3);
    const q = b.quote("DJ30.cash");
    expect(b.openMarket("DJ30.cash", "SELL", 0.1, q.ask + 1, null, null).ok).toBe(false); // inside stops distance
  });

  it("reconciles lost responses by tag", async () => {
    const b = new SimBroker("SIM-ALPHA", { seed: 2 });
    b.state.faults.lostResponseRate = 1;
    const cmd = { kind: "OPEN_MARKET" as const, clientId: "c", tag: "gtc1:abcdefghjkmn", symbol: "US30", side: "BUY" as const, volume: 0.1 };
    expect((await b.execute(cmd)).status).toBe("UNKNOWN");
    expect(b.reconcile(cmd, Date.now() - 1000)).toMatchObject({ found: true, filled: true });
  });
});

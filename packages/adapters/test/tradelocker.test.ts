import { describe, expect, it, vi } from "vitest";
import { TradeLockerAdapter, parseTradeLockerInstrument } from "../src/tradelocker/adapter";
import { httpJson } from "../src/http";
import { SlidingWindowLimiter, RateLimitWaitExceeded } from "../src/rate-limit";

/** Mock TradeLocker backend implementing the paths used by the official SDK. Not a real server. */
function jwt(expSecFromNow: number) {
  const p = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecFromNow })).toString("base64url");
  return `eyJhbGciOiJIUzI1NiJ9.${p}.sig`;
}

interface MockOpts {
  placeBehaviour?: "ok" | "500" | "timeout" | "429" | "400" | "reset";
  accessExp?: number;
}

function mockBackend(o: MockOpts = {}) {
  const calls: { method: string; path: string; headers: Record<string, string>; body: unknown }[] = [];
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const path = u.pathname.replace("/backend-api", "");
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: String(init.method), path, headers, body });
    if (path === "/auth/jwt/token") return json(201, { accessToken: jwt(o.accessExp ?? 3600 * 4), refreshToken: jwt(3600 * 24 * 7) });
    if (path === "/auth/jwt/refresh") return json(201, { accessToken: jwt(3600 * 4), refreshToken: jwt(3600 * 24 * 7) });
    if (path === "/auth/jwt/all-accounts") return json(200, { accounts: [{ id: "555", accNum: "2", currency: "USD", name: "demo", accountBalance: "1000" }] });
    if (!headers.accnum || headers.accnum !== "2") return json(400, { s: "error", errmsg: "missing accNum" });
    if (path === "/trade/config")
      return json(200, {
        s: "ok",
        d: {
          positionsConfig: { columns: ["id", "tradableInstrumentId", "routeId", "side", "qty", "avgPrice", "stopLossId", "takeProfitId", "openDate", "unrealizedPl", "strategyId"].map((id) => ({ id })) },
          ordersConfig: { columns: ["id", "tradableInstrumentId", "routeId", "qty", "side", "type", "status", "filledQty", "avgPrice", "price", "stopPrice", "validity", "expireDate", "createdDate", "lastModified", "isOpen", "positionId", "stopLoss", "stopLossType", "takeProfit", "takeProfitType", "strategyId"].map((id) => ({ id })) },
          ordersHistoryConfig: { columns: ["id", "tradableInstrumentId", "routeId", "qty", "side", "type", "status", "filledQty", "avgPrice", "price", "stopPrice", "validity", "expireDate", "createdDate", "lastModified", "isOpen", "positionId", "stopLoss", "stopLossType", "takeProfit", "takeProfitType", "strategyId"].map((id) => ({ id })) },
          accountDetailsConfig: { columns: ["balance", "projectedBalance", "availableFunds", "initialMarginReq"].map((id) => ({ id })) },
          rateLimits: [{ rateLimitType: "PLACE_ORDER", measure: "SECONDS", intervalNum: 1, limit: 10 }],
        },
      });
    if (path === "/trade/accounts/555/instruments") return json(200, { s: "ok", d: { instruments: [{ tradableInstrumentId: 101, id: 9, name: "US30", routes: [{ id: 11, type: "INFO" }, { id: 12, type: "TRADE" }] }] } });
    if (path === "/trade/accounts/555/state") return json(200, { s: "ok", d: { accountDetailsData: [1000, 1012.5, 900, 50] } });
    if (path === "/trade/accounts/555/positions") return json(200, { s: "ok", d: { positions: [["P1", 101, 12, "buy", 0.5, 42000, "SL1", "0", 1700000000000, 12.5, "gtc1:abcdefghjkmn"]] } });
    if (path === "/trade/accounts/555/orders") return json(200, { s: "ok", d: { orders: [["SL1", 101, 12, 0.5, "sell", "stop", "Working", 0, 0, 0, 41900, "GTC", 0, 1, 1, true, "P1", null, null, null, null, null]] } });
    if (path === "/trade/accounts/555/ordersHistory")
      return json(200, { s: "ok", d: { ordersHistory: [["O7", 101, 12, 0.5, "buy", "market", "Filled", 0.5, 42001, 0, 0, "IOC", 0, Date.now(), Date.now(), false, "P9", null, null, null, null, "gtc1:zzzzzzzzzzzz"]] } });
    if (path === "/trade/quotes") return json(200, { s: "ok", d: { ap: 42002, bp: 42000, as: 1, bs: 1 } });
    if (path === "/trade/instruments/101") return json(200, { s: "ok", d: { name: "US30", lotSize: 1, lotStep: 0.01, minOrderSize: 0.01, maxOrderSize: 100, tickSize: [{ leftRangeLimit: 0, rightRangeLimit: 1e9, tickSize: 0.01 }], tickCost: [{ leftRangeLimit: 0, rightRangeLimit: 1e9, tickCost: 0.01 }], quotingCurrency: "USD" } });
    if (path === "/trade/accounts/555/orders" && init.method === "POST") return json(200, {});
    if (path.startsWith("/trade/accounts/555/orders")) return json(404, {});
    return json(404, { s: "error", errmsg: `unmocked ${path}` });
  });
  // POST /orders behaviour
  const wrapped = vi.fn(async (url: string, init: RequestInit) => {
    if (String(init.method) === "POST" && url.includes("/trade/accounts/555/orders")) {
      calls.push({ method: "POST", path: "/trade/accounts/555/orders", headers: {}, body: JSON.parse(String(init.body)) });
      switch (o.placeBehaviour ?? "ok") {
        case "ok":
          return new Response(JSON.stringify({ s: "ok", d: { orderId: "O7" } }), { status: 200 });
        case "500":
          return new Response("upstream", { status: 502 });
        case "429":
          return new Response("{}", { status: 429, headers: { "retry-after": "3" } });
        case "400":
          return new Response(JSON.stringify({ s: "error", errmsg: "Invalid qty" }), { status: 400 });
        case "timeout":
          throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
        case "reset":
          throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      }
    }
    return impl(url, init);
  });
  return { fetchImpl: wrapped as unknown as typeof fetch, calls };
}

const mk = (o: MockOpts = {}) => {
  const m = mockBackend(o);
  const tokens: unknown[] = [];
  const a = new TradeLockerAdapter({ baseUrl: "https://demo.tradelocker.com", email: "e@example.com", password: "pw", server: "SRV", account: "555", fetchImpl: m.fetchImpl, onTokens: (t) => tokens.push(t) });
  return { a, ...m, tokens };
};

describe("TradeLocker adapter (mocked HTTP, not a real account)", () => {
  it("authenticates, resolves accNum, loads config and maps column arrays", async () => {
    const { a, calls, tokens } = mk();
    await a.connect();
    expect(tokens).toHaveLength(1);
    const snap = await a.getSnapshot();
    expect(snap.account).toMatchObject({ balance: 1000, equity: 1012.5, freeMargin: 900, currency: "USD" });
    expect(snap.positions[0]).toMatchObject({ id: "P1", symbol: "US30", side: "BUY", volume: 0.5, sl: 41900, tp: null, tag: "gtc1:abcdefghjkmn" });
    expect(snap.orders).toHaveLength(0); // the SL order is protective, not a pending entry
    const tradeCall = calls.find((c) => c.path === "/trade/accounts/555/state")!;
    expect(tradeCall.headers.accnum).toBe("2");
    expect(tradeCall.headers.authorization).toMatch(/^Bearer /);
    expect(a.health().rateLimits.find((r) => r.name === "PLACE_ORDER")?.limit).toBe(9);
  });

  it("places market orders with the SDK body shape and strategyId tag; acceptance is not a fill", async () => {
    const { a, calls } = mk();
    await a.connect();
    const out = await a.submit({ kind: "OPEN_MARKET", clientId: "c", tag: "gtc1:abcdefghjkmn", symbol: "US30", side: "BUY", volume: 0.5, sl: 41900, tp: null });
    expect(out).toEqual({ status: "ACCEPTED", orderId: "O7", filled: false });
    const body = calls.find((c) => c.method === "POST" && c.path === "/trade/accounts/555/orders")!.body as Record<string, unknown>;
    expect(body).toMatchObject({ qty: "0.5", routeId: "12", side: "buy", validity: "IOC", tradableInstrumentId: "101", type: "market", stopLoss: 41900, stopLossType: "absolute", strategyId: "gtc1:abcdefghjkmn" });
  });

  it("classifies 5xx and timeouts on order placement as UNKNOWN (reconcile before retry)", async () => {
    for (const b of ["500", "timeout"] as const) {
      const { a } = mk({ placeBehaviour: b });
      await a.connect();
      const out = await a.submit({ kind: "OPEN_MARKET", clientId: "c", tag: "t", symbol: "US30", side: "BUY", volume: 0.5 });
      expect(out.status).toBe("UNKNOWN");
    }
  });

  it("classifies 429 and refused connections as retryable rejections, 400 as final", async () => {
    let r = mk({ placeBehaviour: "429" });
    await r.a.connect();
    expect(await r.a.submit({ kind: "OPEN_MARKET", clientId: "c", tag: "t", symbol: "US30", side: "BUY", volume: 0.5 })).toMatchObject({ status: "REJECTED", retryable: true });
    r = mk({ placeBehaviour: "reset" });
    await r.a.connect();
    expect(await r.a.submit({ kind: "OPEN_MARKET", clientId: "c", tag: "t", symbol: "US30", side: "BUY", volume: 0.5 })).toMatchObject({ status: "REJECTED", retryable: true });
    r = mk({ placeBehaviour: "400" });
    await r.a.connect();
    expect(await r.a.submit({ kind: "OPEN_MARKET", clientId: "c", tag: "t", symbol: "US30", side: "BUY", volume: 0.5 })).toMatchObject({ status: "REJECTED", retryable: false });
  });

  it("reconciles an ambiguous submission through order history by tag", async () => {
    const { a } = mk();
    await a.connect();
    const r = await a.reconcile({ kind: "OPEN_MARKET", clientId: "c", tag: "gtc1:zzzzzzzzzzzz", symbol: "US30", side: "BUY", volume: 0.5 }, Date.now() - 5000);
    expect(r).toMatchObject({ found: true, conclusive: true, positionId: "P9", filled: true, fillPrice: 42001 });
    const miss = await a.reconcile({ kind: "OPEN_MARKET", clientId: "c", tag: "gtc1:nothere00000", symbol: "US30", side: "BUY", volume: 0.5 }, Date.now() - 5000);
    expect(miss).toMatchObject({ found: false, conclusive: true });
  });

  it("refreshes tokens that are close to expiry", async () => {
    const { a, calls } = mk({ accessExp: 60 });
    await a.connect();
    await a.getSnapshot();
    expect(calls.some((c) => c.path === "/auth/jwt/refresh")).toBe(true);
    expect(a.health().tokenRefreshes).toBeGreaterThan(0);
  });

  it("closes positions with qty and partial qty", async () => {
    const { a, calls } = mk();
    await a.connect();
    await a.submit({ kind: "CLOSE_POSITION", clientId: "c", tag: "t", symbol: "US30", positionId: "P1", volume: 0.2 });
    const del = calls.find((c) => c.method === "DELETE" && c.path === "/trade/positions/P1")!;
    expect(del.body).toEqual({ qty: "0.2" });
  });

  it("parses instrument details defensively and marks unverified fields", () => {
    const s = parseTradeLockerInstrument("US30", { tradableInstrumentId: 1 }, { lotSize: 1, lotStep: 0.01, tickSize: [{ tickSize: 0.01 }], tickCost: [{ tickCost: 0.01 }], quotingCurrency: "USD" });
    expect(s).toMatchObject({ contractSize: 1, volumeStep: 0.01, tickSize: 0.01, tickValue: 0.01 });
    expect(s.missingFields).toEqual(expect.arrayContaining(["volumeMin", "volumeMax", "tickValueCurrency"]));
  });

  it("refuses non-https base URLs", () => {
    expect(() => new TradeLockerAdapter({ baseUrl: "http://demo.tradelocker.com", email: "", password: "", server: "", account: "1" })).toThrow();
  });
});

describe("HTTP classification and rate limiting", () => {
  it("treats a GET timeout as not-sent and a mutation timeout as ambiguous", async () => {
    const f = (async () => {
      throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    expect((await httpJson({ method: "GET", url: "https://x" }, f)).ok).toBe(false);
    const g = await httpJson({ method: "GET", url: "https://x" }, f);
    const p = await httpJson({ method: "POST", url: "https://x", body: {} }, f);
    expect(!g.ok && g.failure.kind).toBe("NOT_SENT");
    expect(!p.ok && p.failure.kind).toBe("AMBIGUOUS");
  });

  it("sliding window waits for a slot and gives up past the allowed wait", async () => {
    const l = new SlidingWindowLimiter("t", 2, 200);
    await l.acquire();
    await l.acquire();
    const start = Date.now();
    await l.acquire(1000);
    expect(Date.now() - start).toBeGreaterThanOrEqual(150);
    const l2 = new SlidingWindowLimiter("t2", 1, 10_000);
    await l2.acquire();
    await expect(l2.acquire(50)).rejects.toBeInstanceOf(RateLimitWaitExceeded);
  });
});

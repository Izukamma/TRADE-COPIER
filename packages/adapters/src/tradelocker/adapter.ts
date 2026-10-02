import type {
  ExecutionCommand,
  InstrumentSpec,
  PendingOrder,
  PlatformCapabilities,
  Position,
  Quote,
  ReconcileResult,
  Side,
  SubmitOutcome,
  TradingSnapshot,
} from "@gtc/shared";
import { decimalsOf } from "@gtc/shared";
import { httpJson, jwtExpiryMs, LatencyTracker, pickNumber, pickString, summarize, type FetchLike, type HttpFailure } from "../http";
import { RateLimitWaitExceeded, SlidingWindowLimiter } from "../rate-limit";
import { AdapterError, type AdapterHealth, type PlatformAdapter } from "../types";

/**
 * TradeLocker REST adapter.
 *
 * Endpoint paths, headers and request bodies follow the official TradeLocker Python SDK
 * (tradelocker 0.56.2 on PyPI, github.com/TradeLocker/tradelocker-python) and the public
 * reference at https://public-api.tradelocker.com/ :
 *   POST /auth/jwt/token {email,password,server}      -> accessToken, refreshToken
 *   POST /auth/jwt/refresh {refreshToken}
 *   GET  /auth/jwt/all-accounts                        -> accounts[{id, accNum, currency, ...}]
 *   GET  /trade/config                                 -> column layouts + rateLimits
 *   GET  /trade/accounts/{id}/state | positions | orders | ordersHistory | instruments
 *   GET  /trade/instruments/{tradableInstrumentId}?routeId=<INFO>
 *   GET  /trade/quotes?tradableInstrumentId&routeId=<INFO>
 *   POST /trade/accounts/{id}/orders                   (place; strategyId tag max 32 chars)
 *   PATCH/DELETE /trade/positions/{positionId}         (modify / close, qty "0" = full)
 *   PATCH/DELETE /trade/orders/{orderId}
 * Every /trade/* request carries the `accNum` header.
 *
 * Not verified against a live account from this environment (vendor hosts are blocked here):
 * instrument-detail field names and the PATCH bodies for modifications. Unknown instrument
 * fields are reported in `missingFields` and risk sizing refuses such instruments.
 * The official Streams API requires a developer API key; without one this adapter polls.
 */

export interface TradeLockerOptions {
  /** https://demo.tradelocker.com or https://live.tradelocker.com */
  baseUrl: string;
  email: string;
  password: string;
  server: string;
  /** Account id (as shown in TradeLocker) or accNum. */
  account: string;
  developerApiKey?: string;
  pollIntervalMs?: number;
  fetchImpl?: FetchLike;
  cachedTokens?: { accessToken: string; refreshToken: string } | null;
  onTokens?: (t: { accessToken: string; refreshToken: string }) => void;
  requestTimeoutMs?: number;
}

export const TRADELOCKER_CAPABILITIES: PlatformCapabilities = {
  canBeMaster: true,
  canBeFollower: true,
  marketOrders: true,
  pendingLimit: true,
  pendingStop: true,
  modifyPositionSlTp: true,
  modifyPendingOrder: true,
  partialClose: true,
  orderTagging: true,
  masterDetection: "poll",
  integrationStatus: "IMPLEMENTED_UNVERIFIED",
  notes: [
    "Paths from the official SDK; not yet exercised against a demo account.",
    "Polling (Streams API needs a developer API key).",
    "Copier trades are tagged through strategyId.",
  ],
};

type Row = Record<string, unknown>;

interface TlInstrument {
  tradableInstrumentId: number;
  name: string;
  infoRoute: string | null;
  tradeRoute: string | null;
}

export class TradeLockerAdapter implements PlatformAdapter {
  readonly platform = "TRADELOCKER" as const;
  readonly capabilities = TRADELOCKER_CAPABILITIES;

  private api: string;
  private fetchImpl: FetchLike;
  private accessToken = "";
  private refreshToken = "";
  private accountId = "";
  private accNum = "";
  private currency = "";
  private columns: Record<string, string[]> = {};
  private limiters = new Map<string, SlidingWindowLimiter>();
  private defaultLimiter = new SlidingWindowLimiter("DEFAULT", 2, 1000);
  private instrumentsByName = new Map<string, TlInstrument>();
  private instrumentsById = new Map<number, TlInstrument>();
  private specCache = new Map<string, InstrumentSpec>();
  private latency = new LatencyTracker();
  private h = { connected: false, lastOkAt: null as number | null, lastError: null as string | null, lastErrorAt: null as number | null, reconnects: 0, tokenRefreshes: 0, rateLimited: 0, requests: 0 };

  constructor(private o: TradeLockerOptions) {
    if (!o.baseUrl.startsWith("https://")) throw new AdapterError("PROTOCOL", "TradeLocker base URL must be https");
    this.api = `${o.baseUrl.replace(/\/+$/, "")}/backend-api`;
    this.fetchImpl = o.fetchImpl ?? fetch;
    if (o.cachedTokens) {
      this.accessToken = o.cachedTokens.accessToken;
      this.refreshToken = o.cachedTokens.refreshToken;
    }
  }

  /* ------------------------------------ plumbing ------------------------------------ */

  private fail(f: HttpFailure | string) {
    this.h.lastError = typeof f === "string" ? f : `${f.kind}: ${f.message}`;
    this.h.lastErrorAt = Date.now();
  }

  private async authenticate(): Promise<void> {
    const r = await httpJson<{ accessToken?: string; refreshToken?: string }>(
      { method: "POST", url: `${this.api}/auth/jwt/token`, body: { email: this.o.email, password: this.o.password, server: this.o.server }, headers: this.devHeader(), timeoutMs: this.o.requestTimeoutMs },
      this.fetchImpl,
    );
    if (!r.ok) {
      this.fail(r.failure);
      throw new AdapterError(r.failure.kind === "AUTH" || r.failure.kind === "CLIENT" ? "AUTH" : "NETWORK", `TradeLocker authentication failed: ${r.failure.message}`);
    }
    if (!r.data?.accessToken || !r.data?.refreshToken) throw new AdapterError("PROTOCOL", "TradeLocker auth response missing tokens");
    this.setTokens(r.data.accessToken, r.data.refreshToken);
  }

  private setTokens(a: string, r: string) {
    this.accessToken = a;
    this.refreshToken = r;
    this.o.onTokens?.({ accessToken: a, refreshToken: r });
  }

  private async ensureToken(): Promise<void> {
    const now = Date.now();
    const accessExp = this.accessToken ? jwtExpiryMs(this.accessToken) : null;
    const refreshExp = this.refreshToken ? jwtExpiryMs(this.refreshToken) : null;
    if (!this.accessToken || (refreshExp !== null && refreshExp < now)) return this.authenticate();
    // Refresh when < 30 minutes left (same threshold as the official SDK).
    if (accessExp !== null && accessExp - now < 30 * 60_000) {
      const r = await httpJson<{ accessToken?: string; refreshToken?: string }>(
        { method: "POST", url: `${this.api}/auth/jwt/refresh`, body: { refreshToken: this.refreshToken }, headers: this.devHeader(), timeoutMs: this.o.requestTimeoutMs },
        this.fetchImpl,
      );
      if (r.ok && r.data?.accessToken && r.data?.refreshToken) {
        this.setTokens(r.data.accessToken, r.data.refreshToken);
        this.h.tokenRefreshes++;
      } else {
        await this.authenticate();
        this.h.tokenRefreshes++;
      }
    }
  }

  private devHeader(): Record<string, string> {
    return this.o.developerApiKey ? { "developer-api-key": this.o.developerApiKey } : {};
  }

  private limiterFor(route: string): SlidingWindowLimiter {
    return this.limiters.get(route) ?? this.defaultLimiter;
  }

  /** Authenticated request. Returns parsed body or throws AdapterError; mutating callers use `raw`. */
  private async raw<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, route: string, opts: { query?: Record<string, string | number>; body?: unknown; accNum?: boolean } = {}) {
    await this.ensureToken();
    try {
      await this.limiterFor(route).acquire(method === "GET" ? 5000 : 2000);
    } catch (e) {
      if (e instanceof RateLimitWaitExceeded) {
        this.h.rateLimited++;
        throw new AdapterError("RATE_LIMIT", e.message, e.waitMs);
      }
      throw e;
    }
    const qs = opts.query ? "?" + new URLSearchParams(Object.entries(opts.query).map(([k, v]) => [k, String(v)])).toString() : "";
    const headers: Record<string, string> = { authorization: `Bearer ${this.accessToken}`, ...this.devHeader() };
    if (opts.accNum !== false) headers.accNum = this.accNum;
    this.h.requests++;
    const r = await httpJson<T>({ method, url: `${this.api}${path}${qs}`, headers, body: opts.body, timeoutMs: this.o.requestTimeoutMs }, this.fetchImpl);
    this.latency.add(r.latencyMs);
    if (r.ok) {
      this.h.lastOkAt = Date.now();
      this.h.connected = true;
    } else {
      this.fail(r.failure);
      if (r.failure.kind === "RATE_LIMIT") this.h.rateLimited++;
      if (r.failure.kind === "AUTH") this.accessToken = ""; // force re-auth next time
    }
    return r;
  }

  private async get<T = Row>(path: string, route: string, query?: Record<string, string | number>, accNum = true): Promise<T> {
    const r = await this.raw<{ s?: string; d?: unknown; errmsg?: string } & Row>("GET", path, route, { query, accNum });
    if (!r.ok) {
      const f = r.failure;
      throw new AdapterError(f.kind === "AUTH" ? "AUTH" : f.kind === "RATE_LIMIT" ? "RATE_LIMIT" : f.kind === "CLIENT" ? "PROTOCOL" : "NETWORK", `GET ${path}: ${f.message}`, f.kind === "RATE_LIMIT" ? f.retryAfterMs : undefined);
    }
    const body = r.data;
    if (body && typeof body === "object" && "s" in body && body.s !== "ok") throw new AdapterError("PROTOCOL", `GET ${path}: ${body.errmsg ?? summarize(body)}`);
    return body as T;
  }

  private rowsToObjects(rows: unknown, configKey: string): Row[] {
    const cols = this.columns[configKey];
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => {
      if (Array.isArray(row) && cols) return Object.fromEntries(cols.map((c, i) => [c, row[i]]));
      return (row ?? {}) as Row;
    });
  }

  /* ------------------------------------ lifecycle ------------------------------------ */

  async connect(): Promise<void> {
    const wasConnected = this.h.connected;
    await this.ensureToken();
    const accounts = await this.get<{ accounts?: Row[] }>("/auth/jwt/all-accounts", "GET_ACCOUNTS", undefined, false);
    const list = accounts.accounts ?? [];
    const want = this.o.account.trim();
    const acc = list.find((a) => String(a.id) === want) ?? list.find((a) => String(a.accNum) === want);
    if (!acc) throw new AdapterError("AUTH", `TradeLocker account ${want} not found for this login (${list.length} accounts visible)`);
    this.accountId = String(acc.id);
    this.accNum = String(acc.accNum);
    this.currency = String(acc.currency ?? "");

    const cfg = await this.get<{ d?: Row }>("/trade/config", "GET_CONFIG");
    const d = (cfg.d ?? {}) as Row;
    for (const key of ["positionsConfig", "ordersConfig", "ordersHistoryConfig", "filledOrdersConfig", "accountDetailsConfig"]) {
      const cols = (d[key] as { columns?: { id: string }[] } | undefined)?.columns;
      if (cols) this.columns[key] = cols.map((c) => c.id);
    }
    const rl = (d.rateLimits as { rateLimitType: string; measure: string; intervalNum: number; limit: number }[] | undefined) ?? [];
    for (const l of rl) {
      const unit = l.measure === "MINUTES" ? 60_000 : 1000;
      // Keep a 10% safety margin under the documented limit.
      this.limiters.set(l.rateLimitType, new SlidingWindowLimiter(l.rateLimitType, Math.max(1, Math.floor(l.limit * 0.9)), l.intervalNum * unit));
    }
    await this.loadInstrumentList();
    if (wasConnected) this.h.reconnects++;
    this.h.connected = true;
  }

  async disconnect(): Promise<void> {
    this.h.connected = false;
  }

  health(): AdapterHealth {
    return {
      ...this.h,
      avgLatencyMs: this.latency.avg(),
      detection: { mode: "poll", intervalMs: this.o.pollIntervalMs ?? 1000 },
      rateLimits: [...this.limiters.values()].map((l) => ({ name: l.name, limit: l.limit, windowMs: l.windowMs, used: l.used() })),
    };
  }

  private async loadInstrumentList() {
    const r = await this.get<{ d?: { instruments?: Row[] } }>(`/trade/accounts/${this.accountId}/instruments`, "GET_INSTRUMENTS");
    this.instrumentsByName.clear();
    this.instrumentsById.clear();
    for (const i of r.d?.instruments ?? []) {
      const routes = (i.routes as { id: number | string; type: string }[] | undefined) ?? [];
      const inst: TlInstrument = {
        tradableInstrumentId: Number(i.tradableInstrumentId),
        name: String(i.name),
        infoRoute: routes.find((x) => x.type === "INFO")?.id?.toString() ?? null,
        tradeRoute: routes.find((x) => x.type === "TRADE")?.id?.toString() ?? null,
      };
      this.instrumentsByName.set(inst.name, inst);
      this.instrumentsById.set(inst.tradableInstrumentId, inst);
    }
  }

  private inst(symbol: string): TlInstrument {
    const i = this.instrumentsByName.get(symbol);
    if (!i) throw new AdapterError("PROTOCOL", `TradeLocker instrument ${symbol} not available on this account`);
    return i;
  }

  /* ------------------------------------ reads ------------------------------------ */

  async getSnapshot(): Promise<TradingSnapshot> {
    const [state, pos, ord] = await Promise.all([
      this.get<{ d?: { accountDetailsData?: unknown[] } }>(`/trade/accounts/${this.accountId}/state`, "GET_ACCOUNTS_STATE"),
      this.get<{ d?: { positions?: unknown[] } }>(`/trade/accounts/${this.accountId}/positions`, "GET_POSITIONS"),
      this.get<{ d?: { orders?: unknown[] } }>(`/trade/accounts/${this.accountId}/orders`, "GET_ORDERS"),
    ]);
    const cols = this.columns.accountDetailsConfig ?? [];
    const vals = state.d?.accountDetailsData ?? [];
    const st: Row = Object.fromEntries(cols.map((c, i) => [c, vals[i]]));
    const balance = pickNumber(st, ["balance"]);
    const equity = pickNumber(st, ["projectedBalance", "equity"]);
    if (balance === null || equity === null) throw new AdapterError("PROTOCOL", "TradeLocker state missing balance/projectedBalance");

    const orders = this.rowsToObjects(ord.d?.orders, "ordersConfig");
    const ordersById = new Map(orders.map((o) => [String(o.id), o]));
    const positionsRaw = this.rowsToObjects(pos.d?.positions, "positionsConfig");
    const protectiveIds = new Set<string>();
    const positions: Position[] = positionsRaw.map((p) => {
      const slId = p.stopLossId ? String(p.stopLossId) : null;
      const tpId = p.takeProfitId ? String(p.takeProfitId) : null;
      if (slId && slId !== "0") protectiveIds.add(slId);
      if (tpId && tpId !== "0") protectiveIds.add(tpId);
      const slOrder = slId ? ordersById.get(slId) : undefined;
      const tpOrder = tpId ? ordersById.get(tpId) : undefined;
      const inst = this.instrumentsById.get(Number(p.tradableInstrumentId));
      return {
        id: String(p.id),
        symbol: inst?.name ?? `#${p.tradableInstrumentId}`,
        side: String(p.side).toLowerCase() === "sell" ? "SELL" : "BUY",
        volume: Number(p.qty),
        openPrice: Number(p.avgPrice),
        openTime: Number(p.openDate) || 0,
        sl: slOrder ? pickNumber(slOrder, ["stopPrice", "price"]) : null,
        tp: tpOrder ? pickNumber(tpOrder, ["price", "stopPrice"]) : null,
        tag: (p.strategyId as string | null) || null,
        profit: pickNumber(p, ["unrealizedPl"]),
      } satisfies Position;
    });
    const pending: PendingOrder[] = orders
      .filter((o) => !protectiveIds.has(String(o.id)) && (o.type === "limit" || o.type === "stop") && !o.positionId)
      .map((o) => {
        const inst = this.instrumentsById.get(Number(o.tradableInstrumentId));
        return {
          id: String(o.id),
          symbol: inst?.name ?? `#${o.tradableInstrumentId}`,
          side: String(o.side).toLowerCase() === "sell" ? "SELL" : "BUY",
          kind: o.type === "limit" ? "LIMIT" : "STOP",
          volume: Number(o.qty),
          price: Number(o.type === "stop" ? (o.stopPrice ?? o.price) : o.price),
          sl: pickNumber(o, ["stopLoss"]),
          tp: pickNumber(o, ["takeProfit"]),
          createdTime: Number(o.createdDate) || 0,
          tag: (o.strategyId as string | null) || null,
        } satisfies PendingOrder;
      });
    return {
      account: {
        balance,
        equity,
        currency: this.currency,
        freeMargin: pickNumber(st, ["availableFunds"]),
        marginUsed: pickNumber(st, ["initialMarginReq"]),
        // TradeLocker positions are tracked individually per position id.
        accounting: "HEDGING",
        serverTime: null,
        fetchedAt: Date.now(),
      },
      positions,
      orders: pending,
    };
  }

  async getInstruments(symbols?: string[]): Promise<InstrumentSpec[]> {
    if (this.instrumentsByName.size === 0) await this.loadInstrumentList();
    // Instrument details are one request each: callers pass the symbols they need.
    const names = symbols ?? [];
    const out: InstrumentSpec[] = [];
    for (const name of names) {
      const inst = this.instrumentsByName.get(name);
      if (!inst) continue;
      const r = await this.get<{ d?: Row }>(`/trade/instruments/${inst.tradableInstrumentId}`, "GET_INSTRUMENT_DETAILS", {
        routeId: inst.infoRoute ?? "",
        locale: "en",
      });
      const spec = parseTradeLockerInstrument(name, inst, r.d ?? {});
      this.specCache.set(name, spec);
      out.push(spec);
    }
    return out;
  }

  async listSymbols(): Promise<string[]> {
    if (this.instrumentsByName.size === 0) await this.loadInstrumentList();
    return [...this.instrumentsByName.keys()];
  }

  async getQuote(symbol: string): Promise<Quote> {
    const inst = this.inst(symbol);
    const r = await this.get<{ d?: Row }>("/trade/quotes", "QUOTES", { tradableInstrumentId: inst.tradableInstrumentId, routeId: inst.infoRoute ?? "" });
    const bid = pickNumber(r.d, ["bp"]);
    const ask = pickNumber(r.d, ["ap"]);
    if (bid === null || ask === null) throw new AdapterError("PROTOCOL", `TradeLocker quote for ${symbol} missing bp/ap`);
    return { symbol, bid, ask, time: Date.now() };
  }

  /* ------------------------------------ execution ------------------------------------ */

  private outcomeFromFailure(f: HttpFailure): SubmitOutcome {
    switch (f.kind) {
      case "NOT_SENT":
        return { status: "REJECTED", reason: `not sent: ${f.message}`, retryable: true };
      case "RATE_LIMIT":
        return { status: "REJECTED", reason: `rate limited: ${f.message}`, retryable: true };
      case "AUTH":
        return { status: "REJECTED", reason: `authentication: ${f.message}`, retryable: true };
      case "CLIENT":
        return { status: "REJECTED", reason: f.message, retryable: false };
      case "SERVER":
      case "AMBIGUOUS":
        return { status: "UNKNOWN", reason: f.message };
    }
  }

  async submit(cmd: ExecutionCommand): Promise<SubmitOutcome> {
    try {
      switch (cmd.kind) {
        case "OPEN_MARKET":
        case "PLACE_PENDING": {
          const inst = this.inst(cmd.symbol);
          if (!inst.tradeRoute) return { status: "REJECTED", reason: `no TRADE route for ${cmd.symbol}`, retryable: false };
          const pendingKind = cmd.kind === "PLACE_PENDING" ? cmd.pendingKind : undefined;
          const body = {
            price: pendingKind === "LIMIT" ? cmd.price : undefined,
            stopPrice: pendingKind === "STOP" ? cmd.price : undefined,
            qty: String(cmd.volume),
            routeId: inst.tradeRoute,
            side: cmd.side === "SELL" ? "sell" : "buy",
            validity: cmd.kind === "OPEN_MARKET" ? "IOC" : "GTC",
            tradableInstrumentId: String(inst.tradableInstrumentId),
            type: cmd.kind === "OPEN_MARKET" ? "market" : pendingKind === "LIMIT" ? "limit" : "stop",
            takeProfit: cmd.tp ?? undefined,
            takeProfitType: cmd.tp ? "absolute" : undefined,
            stopLoss: cmd.sl ?? undefined,
            stopLossType: cmd.sl ? "absolute" : undefined,
            strategyId: cmd.tag.slice(0, 32),
          };
          const r = await this.raw<{ s?: string; d?: { orderId?: string | number }; errmsg?: string }>("POST", `/trade/accounts/${this.accountId}/orders`, "PLACE_ORDER", { body });
          if (!r.ok) return this.outcomeFromFailure(r.failure);
          if (r.data?.s !== "ok" || r.data?.d?.orderId === undefined) return { status: "REJECTED", reason: r.data?.errmsg ?? summarize(r.data), retryable: false };
          // Acceptance only: the fill (position id, price) is established by reconcile().
          return { status: "ACCEPTED", orderId: String(r.data.d.orderId), filled: false };
        }
        case "MODIFY_POSITION": {
          const body = { stopLoss: cmd.sl ?? null, takeProfit: cmd.tp ?? null };
          return this.simple(await this.raw("PATCH", `/trade/positions/${cmd.positionId}`, "MODIFY_POSITION", { body }), { positionId: cmd.positionId });
        }
        case "CLOSE_POSITION": {
          const body = { qty: String(cmd.volume ?? 0) };
          return this.simple(await this.raw("DELETE", `/trade/positions/${cmd.positionId}`, "MODIFY_POSITION", { body }), { positionId: cmd.positionId });
        }
        case "MODIFY_PENDING": {
          const body: Row = { stopLoss: cmd.sl ?? null, takeProfit: cmd.tp ?? null };
          if (cmd.price !== undefined) body[cmd.pendingKind === "STOP" ? "stopPrice" : "price"] = cmd.price;
          return this.simple(await this.raw("PATCH", `/trade/orders/${cmd.orderId}`, "MODIFY_ORDER", { body }), { orderId: cmd.orderId });
        }
        case "CANCEL_PENDING":
          return this.simple(await this.raw("DELETE", `/trade/orders/${cmd.orderId}`, "MODIFY_ORDER"), { orderId: cmd.orderId });
      }
    } catch (e) {
      if (e instanceof AdapterError) return { status: "REJECTED", reason: e.message, retryable: e.kind !== "PROTOCOL" && e.kind !== "NOT_SUPPORTED" };
      throw e;
    }
  }

  private simple(r: Awaited<ReturnType<TradeLockerAdapter["raw"]>>, ids: { orderId?: string; positionId?: string }): SubmitOutcome {
    if (!r.ok) return this.outcomeFromFailure(r.failure);
    const body = r.data as { s?: string; errmsg?: string } | undefined;
    if (body?.s !== "ok") return { status: "REJECTED", reason: body?.errmsg ?? summarize(body), retryable: false };
    return { status: "ACCEPTED", ...ids };
  }

  async reconcile(cmd: ExecutionCommand, sinceMs: number): Promise<ReconcileResult> {
    try {
      if (cmd.kind === "OPEN_MARKET" || cmd.kind === "PLACE_PENDING") {
        const hist = await this.get<{ d?: { ordersHistory?: unknown[] } }>(`/trade/accounts/${this.accountId}/ordersHistory`, "GET_ORDERS_HISTORY", { from: sinceMs - 60_000 });
        const rows = this.rowsToObjects(hist.d?.ordersHistory, "ordersHistoryConfig");
        const mine = rows.filter((o) => o.strategyId === cmd.tag);
        const filled = mine.find((o) => o.status === "Filled");
        if (filled)
          return { found: true, conclusive: true, orderId: String(filled.id), positionId: filled.positionId ? String(filled.positionId) : undefined, filled: true, fillPrice: pickNumber(filled, ["avgPrice"]) ?? undefined, filledVolume: pickNumber(filled, ["filledQty", "qty"]) ?? undefined };
        const rejected = mine.find((o) => ["Refused", "Cancelled", "Unplaced", "Removed"].includes(String(o.status)));
        const active = await this.get<{ d?: { orders?: unknown[] } }>(`/trade/accounts/${this.accountId}/orders`, "GET_ORDERS");
        const act = this.rowsToObjects(active.d?.orders, "ordersConfig").find((o) => o.strategyId === cmd.tag);
        if (act) return { found: true, conclusive: true, orderId: String(act.id), filled: false };
        if (rejected) return { found: false, conclusive: true, detail: `order ${rejected.id} ended ${rejected.status}` };
        return { found: false, conclusive: true };
      }
      if (cmd.kind === "CLOSE_POSITION" || cmd.kind === "MODIFY_POSITION") {
        const snap = await this.getSnapshot();
        const pos = snap.positions.find((p) => p.id === cmd.positionId);
        if (cmd.kind === "CLOSE_POSITION") {
          if (!pos) return { found: true, conclusive: true, positionId: cmd.positionId, filled: true };
          return { found: false, conclusive: false, detail: `position still open with ${pos.volume}; partial closes need volume comparison by caller` };
        }
        if (!pos) return { found: false, conclusive: true, detail: "position closed" };
        return { found: pos.sl === (cmd.sl ?? null) && pos.tp === (cmd.tp ?? null), conclusive: true };
      }
      const snap = await this.getSnapshot();
      const o = snap.orders.find((x) => x.id === cmd.orderId);
      if (cmd.kind === "CANCEL_PENDING") return { found: !o, conclusive: true };
      return { found: !!o && o.sl === (cmd.sl ?? null) && o.tp === (cmd.tp ?? null), conclusive: true };
    } catch (e) {
      return { found: false, conclusive: false, detail: (e as Error).message };
    }
  }
}

/** Parses an instrument-details payload defensively. Field names not in the SDK are candidates. */
export function parseTradeLockerInstrument(name: string, inst: { tradableInstrumentId: number }, d: Row): InstrumentSpec {
  const missing: string[] = [];
  const firstRange = (v: unknown, key: string): number | null => {
    if (typeof v === "number") return v;
    if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) return Number(v);
    if (Array.isArray(v) && v.length) return pickNumber(v[0] as Row, [key, "value"]);
    return null;
  };
  const tickSize = firstRange(d.tickSize, "tickSize");
  const tickCost = firstRange(d.tickCost, "tickCost");
  const lotSize = pickNumber(d, ["lotSize", "contractSize"]);
  const lotStep = pickNumber(d, ["lotStep", "qtyStep", "volumeStep"]);
  const minQty = pickNumber(d, ["minOrderSize", "minLot", "minQty"]);
  const maxQty = pickNumber(d, ["maxOrderSize", "maxLot", "maxQty"]);
  const digits = pickNumber(d, ["precision", "decimals", "digits"]);
  const quoteCcy = pickString(d, ["quotingCurrency", "quoteCurrency", "settlementCurrency"]);
  const baseCcy = pickString(d, ["baseCurrency"]);
  if (tickSize === null) missing.push("tickSize");
  if (tickCost === null) missing.push("tickValue");
  if (lotSize === null) missing.push("contractSize");
  if (lotStep === null) missing.push("volumeStep");
  if (minQty === null) missing.push("volumeMin");
  if (maxQty === null) missing.push("volumeMax");
  if (!quoteCcy) missing.push("profitCurrency");
  // The SDK does not document which currency tickCost is expressed in.
  if (tickCost !== null) missing.push("tickValueCurrency");
  const ts = tickSize ?? 0.00001;
  return {
    symbol: name,
    platformId: String(inst.tradableInstrumentId),
    description: pickString(d, ["description", "localizedName"]) ?? undefined,
    digits: digits ?? decimalsOf(ts),
    tickSize: ts,
    tickValue: tickCost,
    // TradeLocker tickCost currency is not documented in the SDK; assume quote currency and flag it.
    tickValueCurrency: quoteCcy,
    contractSize: lotSize,
    baseCurrency: baseCcy,
    quoteCurrency: quoteCcy,
    profitCurrency: quoteCcy,
    volumeMin: minQty ?? lotStep ?? 0.01,
    volumeMax: maxQty ?? 100,
    volumeStep: lotStep ?? 0.01,
    stopsDistance: 0,
    orderKinds: ["MARKET", "LIMIT", "STOP"],
    tradable: true,
    missingFields: missing,
    fetchedAt: Date.now(),
  };
}

export const tlSide = (s: Side) => (s === "SELL" ? "sell" : "buy");

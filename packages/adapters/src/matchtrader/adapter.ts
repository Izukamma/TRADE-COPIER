import type {
  ExecutionCommand,
  InstrumentSpec,
  PlatformCapabilities,
  Position,
  Quote,
  ReconcileResult,
  SubmitOutcome,
  TradingSnapshot,
} from "@gtc/shared";
import { httpJson, LatencyTracker, pickNumber, pickString, summarize, type FetchLike, type HttpFailure } from "../http";
import { RateLimitWaitExceeded, SlidingWindowLimiter } from "../rate-limit";
import { AdapterError, type AdapterHealth, type PlatformAdapter } from "../types";

/**
 * Match-Trader Platform API adapter (trader-side API, not the broker Manager API).
 *
 * Sources (see docs/platforms/matchtrader.md):
 *  - Match-Trader Platform API PDF, docs.match-trade.com/wp-content/uploads/2024/05/MTR-Match-TraderPlatformAPI.pdf
 *  - Interactive reference https://app.theneo.io/match-trade/platform-api
 *
 * Documented in the excerpts we could read:
 *   POST {platform}/manager/co-login {email,password,brokerId} -> token, accounts[{tradingAccountId, tradingApiToken, ...}]
 *   GET  {platform}/mtr-api/{SYSTEM_UUID}/balance
 *   GET  {platform}/mtr-api/{SYSTEM_UUID}/open-positions
 *   POST {platform}/mtr-api/{SYSTEM_UUID}/position/open {instrument, orderSide, volume, slPrice, tpPrice, isMobile}
 *   POST {platform}/mtr-api/{SYSTEM_UUID}/position/edit         (path documented; body not verified)
 *   POST {platform}/mtr-api/{SYSTEM_UUID}/positions/close       (path documented; body not verified)
 *   Requests carry the `Auth-trading-api` header (trading API token) and the co-auth token.
 *
 * Not available to us: exact paths for symbols, quotes, partial close and pending orders, and
 * rate limits. Those endpoints are left unconfigured (null) and the corresponding operations are
 * rejected with a clear reason until their paths are copied from the official docs into the
 * environment. Edit/close request bodies are gated behind MATCHTRADER_ENABLE_UNVERIFIED_BODIES.
 * The vendor documentation hosts are blocked from the build environment, so nothing here has
 * been exercised against a real account.
 */

export interface MatchTraderEndpointConfig {
  symbols: string | null;
  quotes: string | null;
  partialClose: string | null;
  activeOrders: string | null;
  createPending: string | null;
  cancelPending: string | null;
}

export interface MatchTraderOptions {
  /** Broker platform URL, e.g. https://platform.<broker>.com */
  baseUrl: string;
  email: string;
  password: string;
  brokerId: string;
  /** System UUID used in /mtr-api/{SYSTEM_UUID}/... (from the platform / broker). */
  systemUuid: string;
  /** tradingAccountId to operate on. */
  account: string;
  endpoints?: Partial<MatchTraderEndpointConfig>;
  enableUnverifiedBodies?: boolean;
  /** Requests per second budget (rate limits are not documented in what we could access). */
  requestsPerSecond?: number;
  pollIntervalMs?: number;
  fetchImpl?: FetchLike;
  requestTimeoutMs?: number;
}

export function matchTraderCapabilities(ep: MatchTraderEndpointConfig, unverifiedBodies: boolean): PlatformCapabilities {
  return {
    canBeMaster: true,
    canBeFollower: true,
    marketOrders: true,
    pendingLimit: !!ep.createPending,
    pendingStop: !!ep.createPending,
    modifyPositionSlTp: unverifiedBodies,
    modifyPendingOrder: false,
    partialClose: !!ep.partialClose && unverifiedBodies,
    orderTagging: false,
    masterDetection: "poll",
    integrationStatus: "AWAITING_ACCESS",
    notes: [
      "Login, balance, open positions and market open follow documented endpoints; not exercised against an account.",
      "No order tag field documented: copier trades are identified by stored position links; reconciliation may be inconclusive.",
      ...(ep.symbols ? [] : ["Symbols endpoint path not configured: enter instrument specs manually."]),
      ...(ep.quotes ? [] : ["Quotes endpoint path not configured: entry deviation checks unavailable."]),
      ...(unverifiedBodies ? ["Edit/close request bodies are UNVERIFIED and enabled by configuration."] : ["Edit/close disabled until request bodies are verified."]),
    ],
  };
}

type Row = Record<string, unknown>;

export class MatchTraderAdapter implements PlatformAdapter {
  readonly platform = "MATCHTRADER" as const;
  readonly capabilities: PlatformCapabilities;
  private base: string;
  private fetchImpl: FetchLike;
  private coToken = "";
  private tradingToken = "";
  private ep: MatchTraderEndpointConfig;
  private limiter: SlidingWindowLimiter;
  private latency = new LatencyTracker();
  /** Position ids observed just before each open submission, for tag-less reconciliation. */
  private preSubmitIds = new Map<string, Set<string>>();
  private h = { connected: false, lastOkAt: null as number | null, lastError: null as string | null, lastErrorAt: null as number | null, reconnects: 0, tokenRefreshes: 0, rateLimited: 0, requests: 0 };

  constructor(private o: MatchTraderOptions) {
    if (!o.baseUrl.startsWith("https://")) throw new AdapterError("PROTOCOL", "Match-Trader platform URL must be https");
    if (!/^[0-9a-fA-F-]{8,64}$/.test(o.systemUuid)) throw new AdapterError("PROTOCOL", "Match-Trader system UUID looks invalid");
    this.base = o.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.ep = { symbols: null, quotes: null, partialClose: null, activeOrders: null, createPending: null, cancelPending: null, ...o.endpoints };
    this.capabilities = matchTraderCapabilities(this.ep, !!o.enableUnverifiedBodies);
    this.limiter = new SlidingWindowLimiter("MTR", o.requestsPerSecond ?? 2, 1000);
  }

  private mtr(path: string) {
    return `${this.base}/mtr-api/${this.o.systemUuid}${path.startsWith("/") ? path : `/${path}`}`;
  }

  private fail(f: HttpFailure) {
    this.h.lastError = `${f.kind}: ${f.message}`;
    this.h.lastErrorAt = Date.now();
    if (f.kind === "RATE_LIMIT") this.h.rateLimited++;
  }

  private headers(): Record<string, string> {
    return { "Auth-trading-api": this.tradingToken, cookie: `co-auth=${this.coToken}` };
  }

  private async req<T>(method: "GET" | "POST", url: string, body?: unknown) {
    if (!this.tradingToken) await this.login();
    try {
      await this.limiter.acquire(method === "GET" ? 5000 : 2000);
    } catch (e) {
      if (e instanceof RateLimitWaitExceeded) throw new AdapterError("RATE_LIMIT", e.message, e.waitMs);
      throw e;
    }
    this.h.requests++;
    const r = await httpJson<T>({ method, url, headers: this.headers(), body, timeoutMs: this.o.requestTimeoutMs }, this.fetchImpl);
    this.latency.add(r.latencyMs);
    if (r.ok) {
      this.h.lastOkAt = Date.now();
      this.h.connected = true;
    } else {
      this.fail(r.failure);
      if (r.failure.kind === "AUTH") this.tradingToken = "";
    }
    return r;
  }

  private async getJson<T = unknown>(url: string): Promise<T> {
    const r = await this.req<T>("GET", url);
    if (!r.ok) throw new AdapterError(r.failure.kind === "AUTH" ? "AUTH" : r.failure.kind === "RATE_LIMIT" ? "RATE_LIMIT" : "NETWORK", r.failure.message);
    return r.data;
  }

  private async login() {
    const r = await httpJson<Row>(
      { method: "POST", url: `${this.base}/manager/co-login`, body: { email: this.o.email, password: this.o.password, brokerId: this.o.brokerId }, timeoutMs: this.o.requestTimeoutMs },
      this.fetchImpl,
    );
    if (!r.ok) {
      this.fail(r.failure);
      throw new AdapterError(r.failure.kind === "AUTH" || r.failure.kind === "CLIENT" ? "AUTH" : "NETWORK", `Match-Trader login failed: ${r.failure.message}`);
    }
    const token = pickString(r.data, ["token"]);
    const accounts = (r.data?.accounts as Row[] | undefined) ?? [];
    const acc = accounts.find((a) => String(a.tradingAccountId) === this.o.account);
    if (!token) throw new AdapterError("PROTOCOL", "Match-Trader login response missing token");
    if (!acc) throw new AdapterError("AUTH", `trading account ${this.o.account} not found in login response (${accounts.length} accounts)`);
    const tradingToken = pickString(acc, ["tradingApiToken"]);
    if (!tradingToken) throw new AdapterError("PROTOCOL", "Match-Trader account missing tradingApiToken");
    if (this.coToken) this.h.tokenRefreshes++;
    this.coToken = token;
    this.tradingToken = tradingToken;
  }

  async connect() {
    const was = this.h.connected;
    await this.login();
    await this.getJson(this.mtr("/balance"));
    if (was) this.h.reconnects++;
    this.h.connected = true;
  }
  async disconnect() {
    this.h.connected = false;
  }

  health(): AdapterHealth {
    return {
      ...this.h,
      avgLatencyMs: this.latency.avg(),
      detection: { mode: "poll", intervalMs: this.o.pollIntervalMs ?? 1500 },
      rateLimits: [{ name: this.limiter.name, limit: this.limiter.limit, windowMs: this.limiter.windowMs, used: this.limiter.used() }],
    };
  }

  async getSnapshot(): Promise<TradingSnapshot> {
    const [bal, pos] = await Promise.all([this.getJson<Row>(this.mtr("/balance")), this.getJson<Row | Row[]>(this.mtr("/open-positions"))]);
    const balance = pickNumber(bal, ["balance"]);
    const equity = pickNumber(bal, ["equity"]);
    if (balance === null || equity === null) throw new AdapterError("PROTOCOL", `Match-Trader balance response missing balance/equity: ${summarize(bal)}`);
    const list = (Array.isArray(pos) ? pos : ((pos.positions as Row[] | undefined) ?? [])) as Row[];
    const positions: Position[] = list.map((p) => ({
      id: String(p.id ?? p.positionId),
      symbol: String(p.symbol ?? p.instrument),
      side: String(p.side ?? p.orderSide).toUpperCase() === "SELL" ? "SELL" : "BUY",
      volume: pickNumber(p, ["volume"]) ?? 0,
      openPrice: pickNumber(p, ["openPrice", "price"]) ?? 0,
      openTime: parseTime(p.openTime ?? p.time),
      sl: nz(pickNumber(p, ["stopLoss", "slPrice", "sl"])),
      tp: nz(pickNumber(p, ["takeProfit", "tpPrice", "tp"])),
      tag: null,
      profit: pickNumber(p, ["profit", "netProfit"]),
    }));
    let orders: TradingSnapshot["orders"] = [];
    if (this.ep.activeOrders) {
      const ao = await this.getJson<Row | Row[]>(this.mtr(this.ep.activeOrders));
      const arr = (Array.isArray(ao) ? ao : ((ao.orders as Row[] | undefined) ?? [])) as Row[];
      orders = arr.map((o) => ({
        id: String(o.id ?? o.orderId),
        symbol: String(o.symbol ?? o.instrument),
        side: String(o.side ?? o.orderSide).toUpperCase() === "SELL" ? "SELL" : "BUY",
        kind: String(o.type ?? "").toUpperCase().includes("STOP") ? "STOP" : "LIMIT",
        volume: pickNumber(o, ["volume"]) ?? 0,
        price: pickNumber(o, ["price", "activationPrice"]) ?? 0,
        sl: nz(pickNumber(o, ["stopLoss", "slPrice"])),
        tp: nz(pickNumber(o, ["takeProfit", "tpPrice"])),
        createdTime: parseTime(o.creationTime ?? o.time),
        tag: null,
      }));
    }
    return {
      account: {
        balance,
        equity,
        currency: pickString(bal, ["currency"]) ?? "",
        freeMargin: pickNumber(bal, ["freeMargin", "free_margin"]),
        marginUsed: pickNumber(bal, ["margin"]),
        accounting: "HEDGING",
        serverTime: null,
        fetchedAt: Date.now(),
      },
      positions,
      orders,
    };
  }

  async getInstruments(symbols?: string[]): Promise<InstrumentSpec[]> {
    if (!this.ep.symbols) return [];
    const data = await this.getJson<Row | Row[]>(this.mtr(this.ep.symbols));
    const arr = (Array.isArray(data) ? data : ((data.symbols as Row[] | undefined) ?? [])) as Row[];
    return arr
      .filter((s) => !symbols || symbols.includes(String(s.symbol ?? s.name)))
      .map((s) => {
        const missing: string[] = [];
        const tickSize = pickNumber(s, ["tickSize", "pipSize"]);
        const contract = pickNumber(s, ["contractSize", "lotSize"]);
        const step = pickNumber(s, ["volumeStep", "lotStep"]);
        const min = pickNumber(s, ["minVolume", "volumeMin"]);
        const max = pickNumber(s, ["maxVolume", "volumeMax"]);
        const digits = pickNumber(s, ["digits", "precision", "pricePrecision"]);
        const profitCcy = pickString(s, ["profitCurrency", "quoteCurrency"]);
        for (const [k, v] of Object.entries({ tickSize, contractSize: contract, volumeStep: step, volumeMin: min, volumeMax: max, digits, profitCurrency: profitCcy })) if (v === null) missing.push(k);
        missing.push("tickValue", "tickValueCurrency");
        return {
          symbol: String(s.symbol ?? s.name),
          digits: digits ?? 5,
          tickSize: tickSize ?? 0.00001,
          tickValue: null,
          tickValueCurrency: null,
          contractSize: contract,
          profitCurrency: profitCcy,
          volumeMin: min ?? 0.01,
          volumeMax: max ?? 100,
          volumeStep: step ?? 0.01,
          stopsDistance: 0,
          orderKinds: this.ep.createPending ? ["MARKET", "LIMIT", "STOP"] : ["MARKET"],
          tradable: true,
          missingFields: missing,
          fetchedAt: Date.now(),
        } satisfies InstrumentSpec;
      });
  }

  async listSymbols(): Promise<string[]> {
    if (this.ep.symbols) return (await this.getInstruments()).map((s) => s.symbol);
    // Without a symbols endpoint, symbols seen in open positions are the only ones we know.
    return [...new Set((await this.getSnapshot()).positions.map((p) => p.symbol))];
  }

  async getQuote(symbol: string): Promise<Quote> {
    if (!this.ep.quotes) throw new AdapterError("NOT_VERIFIED", "Match-Trader quotes endpoint not configured");
    const q = await this.getJson<Row | Row[]>(`${this.mtr(this.ep.quotes)}?symbols=${encodeURIComponent(symbol)}`);
    const row = (Array.isArray(q) ? q[0] : q) as Row | undefined;
    const bid = pickNumber(row, ["bid"]);
    const ask = pickNumber(row, ["ask"]);
    if (bid === null || ask === null) throw new AdapterError("PROTOCOL", `Match-Trader quote missing bid/ask: ${summarize(row)}`);
    return { symbol, bid, ask, time: Date.now() };
  }

  private outcome(f: HttpFailure): SubmitOutcome {
    if (f.kind === "NOT_SENT" || f.kind === "RATE_LIMIT" || f.kind === "AUTH") return { status: "REJECTED", reason: f.message, retryable: true };
    if (f.kind === "CLIENT") return { status: "REJECTED", reason: f.message, retryable: false };
    return { status: "UNKNOWN", reason: f.message };
  }

  async submit(cmd: ExecutionCommand): Promise<SubmitOutcome> {
    try {
      switch (cmd.kind) {
        case "OPEN_MARKET": {
          // Record positions before submitting so reconcile() can find the new one without a tag.
          const before = await this.getSnapshot();
          this.preSubmitIds.set(cmd.clientId, new Set(before.positions.map((p) => p.id)));
          const body = { instrument: cmd.symbol, orderSide: cmd.side, volume: cmd.volume, slPrice: cmd.sl ?? 0, tpPrice: cmd.tp ?? 0, isMobile: false };
          const r = await this.req<Row>("POST", this.mtr("/position/open"), body);
          if (!r.ok) return this.outcome(r.failure);
          const status = pickString(r.data, ["status"]);
          if (status && !["OK", "SUCCESS"].includes(status.toUpperCase())) return { status: "REJECTED", reason: `${status}: ${pickString(r.data, ["errorMessage", "message"]) ?? summarize(r.data)}`, retryable: false };
          const orderId = pickString(r.data, ["orderId", "id"]);
          const positionId = pickString(r.data, ["positionId"]);
          return { status: "ACCEPTED", orderId: orderId ?? undefined, positionId: positionId ?? undefined, filled: false };
        }
        case "MODIFY_POSITION": {
          if (!this.o.enableUnverifiedBodies) return { status: "REJECTED", reason: "Match-Trader position edit disabled: request body not verified", retryable: false };
          const r = await this.req<Row>("POST", this.mtr("/position/edit"), { id: cmd.positionId, instrument: cmd.symbol, slPrice: cmd.sl ?? 0, tpPrice: cmd.tp ?? 0, isMobile: false });
          return r.ok ? { status: "ACCEPTED", positionId: cmd.positionId } : this.outcome(r.failure);
        }
        case "CLOSE_POSITION": {
          if (!this.o.enableUnverifiedBodies) return { status: "REJECTED", reason: "Match-Trader close disabled: request body not verified", retryable: false };
          if (cmd.volume !== undefined && cmd.volume > 0) {
            if (!this.ep.partialClose) return { status: "REJECTED", reason: "Match-Trader partial close endpoint not configured", retryable: false };
            const r = await this.req<Row>("POST", this.mtr(this.ep.partialClose), { positionId: cmd.positionId, instrument: cmd.symbol, orderSide: cmd.side, volume: cmd.volume, isMobile: false });
            return r.ok ? { status: "ACCEPTED", positionId: cmd.positionId } : this.outcome(r.failure);
          }
          const r = await this.req<Row>("POST", this.mtr("/positions/close"), { positionIds: [cmd.positionId], isMobile: false });
          return r.ok ? { status: "ACCEPTED", positionId: cmd.positionId } : this.outcome(r.failure);
        }
        case "PLACE_PENDING":
        case "MODIFY_PENDING":
        case "CANCEL_PENDING":
          return { status: "REJECTED", reason: "Match-Trader pending-order endpoints are not configured/verified", retryable: false };
      }
    } catch (e) {
      if (e instanceof AdapterError) return { status: "REJECTED", reason: e.message, retryable: e.kind === "NETWORK" || e.kind === "RATE_LIMIT" || e.kind === "AUTH" };
      throw e;
    }
  }

  async reconcile(cmd: ExecutionCommand, sinceMs: number): Promise<ReconcileResult> {
    try {
      const snap = await this.getSnapshot();
      if (cmd.kind === "OPEN_MARKET") {
        const before = this.preSubmitIds.get(cmd.clientId);
        if (!before) return { found: false, conclusive: false, detail: "no pre-submission snapshot (engine restarted); manual check required" };
        const candidates = snap.positions.filter(
          (p) => !before.has(p.id) && p.symbol === cmd.symbol && p.side === cmd.side && Math.abs(p.volume - (cmd.volume ?? 0)) < 1e-9 && (p.openTime === 0 || p.openTime >= sinceMs - 5000),
        );
        if (candidates.length === 1) {
          const c = candidates[0]!;
          return { found: true, conclusive: true, positionId: c.id, filled: true, fillPrice: c.openPrice, filledVolume: c.volume };
        }
        if (candidates.length === 0) return { found: false, conclusive: true };
        return { found: false, conclusive: false, detail: `${candidates.length} matching new positions; cannot attribute without a tag` };
      }
      if (cmd.kind === "CLOSE_POSITION") {
        const pos = snap.positions.find((p) => p.id === cmd.positionId);
        return pos ? { found: false, conclusive: false, detail: `position open with ${pos.volume}` } : { found: true, conclusive: true, filled: true };
      }
      if (cmd.kind === "MODIFY_POSITION") {
        const pos = snap.positions.find((p) => p.id === cmd.positionId);
        if (!pos) return { found: false, conclusive: true, detail: "position closed" };
        return { found: pos.sl === (cmd.sl ?? null) && pos.tp === (cmd.tp ?? null), conclusive: true };
      }
      return { found: false, conclusive: true };
    } catch (e) {
      return { found: false, conclusive: false, detail: (e as Error).message };
    }
  }
}

function nz(n: number | null): number | null {
  return n === null || n === 0 ? null : n;
}

function parseTime(v: unknown): number {
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

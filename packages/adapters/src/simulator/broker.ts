import type {
  ExecutionCommand,
  InstrumentSpec,
  PendingOrder,
  Position,
  PositionAccounting,
  Quote,
  ReconcileResult,
  Side,
  SubmitOutcome,
  TradingSnapshot,
} from "@gtc/shared";
import { floorToStep, roundTo, roundToTick } from "@gtc/shared";

/**
 * In-process simulated broker. SIMULATION accounts use this instead of any network
 * connection. It is deliberately strict (volume rules, stop distances, tags) so routes
 * behave like they would against a real platform, and supports fault injection for
 * ambiguous-timeout and rejection testing. Nothing here represents real market data.
 */

export interface SimSymbolDef {
  spec: Omit<InstrumentSpec, "fetchedAt" | "missingFields">;
  start: number;
  spread: number;
  /** Std-dev of per-second random walk, in price units. */
  vol: number;
}

const base = (s: Partial<InstrumentSpec> & Pick<InstrumentSpec, "symbol" | "digits" | "tickSize">) => ({
  tickValue: null,
  tickValueCurrency: "USD",
  contractSize: null,
  profitCurrency: "USD",
  volumeMin: 0.01,
  volumeMax: 100,
  volumeStep: 0.01,
  stopsDistance: 0,
  orderKinds: ["MARKET", "LIMIT", "STOP"] as InstrumentSpec["orderKinds"],
  tradable: true,
  ...s,
});

/** Two deliberately different "brokers" so cross-spec sizing can be exercised. */
export const SIM_PROFILES: Record<string, { currency: string; symbols: SimSymbolDef[] }> = {
  "SIM-ALPHA": {
    currency: "USD",
    symbols: [
      { start: 42000, spread: 2, vol: 4, spec: base({ symbol: "US30", digits: 2, tickSize: 0.01, tickValue: 0.01, contractSize: 1 }) },
      { start: 19500, spread: 1.5, vol: 3, spec: base({ symbol: "NAS100", digits: 2, tickSize: 0.01, tickValue: 0.01, contractSize: 1 }) },
      { start: 5600, spread: 0.5, vol: 0.8, spec: base({ symbol: "SPX500", digits: 2, tickSize: 0.01, tickValue: 0.01, contractSize: 1 }) },
      { start: 1.085, spread: 0.00008, vol: 0.00006, spec: base({ symbol: "EURUSD", digits: 5, tickSize: 0.00001, tickValue: 1, contractSize: 100000, baseCurrency: "EUR", quoteCurrency: "USD" }) },
      { start: 1.27, spread: 0.0001, vol: 0.00007, spec: base({ symbol: "GBPUSD", digits: 5, tickSize: 0.00001, tickValue: 1, contractSize: 100000, baseCurrency: "GBP", quoteCurrency: "USD" }) },
      { start: 2400, spread: 0.3, vol: 0.4, spec: base({ symbol: "XAUUSD", digits: 2, tickSize: 0.01, tickValue: 1, contractSize: 100 }) },
    ],
  },
  "SIM-BETA": {
    currency: "GBP",
    symbols: [
      { start: 42003, spread: 3, vol: 4, spec: base({ symbol: "DJ30.cash", digits: 1, tickSize: 0.1, tickValue: 1, contractSize: 10, volumeMin: 0.1, volumeStep: 0.1, volumeMax: 50, stopsDistance: 5 }) },
      { start: 19502, spread: 2, vol: 3, spec: base({ symbol: "USTEC.cash", digits: 1, tickSize: 0.1, tickValue: 2, contractSize: 20, volumeMin: 0.1, volumeStep: 0.1, volumeMax: 50, stopsDistance: 5 }) },
      { start: 5601, spread: 0.5, vol: 0.8, spec: base({ symbol: "US500.cash", digits: 2, tickSize: 0.25, tickValue: 12.5, contractSize: 50, volumeMin: 0.1, volumeStep: 0.1, volumeMax: 50, stopsDistance: 1 }) },
      { start: 1.085, spread: 0.0001, vol: 0.00006, spec: base({ symbol: "EURUSD.r", digits: 5, tickSize: 0.00001, tickValue: 1, contractSize: 100000, baseCurrency: "EUR", quoteCurrency: "USD" }) },
      { start: 1.27, spread: 0.0001, vol: 0.00007, spec: base({ symbol: "GBPUSD.r", digits: 5, tickSize: 0.00001, tickValue: 1, contractSize: 100000, baseCurrency: "GBP", quoteCurrency: "USD" }) },
      { start: 2400.2, spread: 0.4, vol: 0.4, spec: base({ symbol: "XAUUSD.r", digits: 2, tickSize: 0.01, tickValue: 1, contractSize: 100 }) },
    ],
  },
};

export interface SimFaults {
  /** Probability [0..1] a submission is rejected by the "broker". */
  rejectRate: number;
  /** Probability the submission executes but the response is lost (ambiguous). */
  lostResponseRate: number;
  /** Probability the submission fails before reaching the broker. */
  notSentRate: number;
  latencyMs: number;
}

interface SimPosition extends Position {}
interface SimOrder extends PendingOrder {}
interface SimHistory {
  orderId: string;
  positionId: string | null;
  tag: string | null;
  kind: string;
  status: "FILLED" | "PLACED" | "CANCELLED" | "REJECTED" | "MODIFIED" | "CLOSED";
  volume: number;
  price: number | null;
  time: number;
}

export interface SimState {
  profile: string;
  accounting: PositionAccounting;
  balance: number;
  currency: string;
  nextId: number;
  prices: Record<string, { mid: number; time: number }>;
  positions: SimPosition[];
  orders: SimOrder[];
  history: SimHistory[];
  faults: SimFaults;
}

export class SimBroker {
  state: SimState;
  private defs: Map<string, SimSymbolDef>;
  private rand: () => number;
  /** Called after every state change so the engine can persist the simulator. */
  onChange?: () => void;
  now: () => number = () => Date.now();

  constructor(profile: string, opts: { balance?: number; accounting?: PositionAccounting; state?: SimState; seed?: number } = {}) {
    const p = SIM_PROFILES[profile];
    if (!p) throw new Error(`unknown simulator profile ${profile}`);
    this.defs = new Map(p.symbols.map((s) => [s.spec.symbol, s]));
    let seed = opts.seed ?? 0x9e3779b9;
    this.rand = () => {
      // mulberry32: deterministic for tests
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    this.state =
      opts.state ??
      ({
        profile,
        accounting: opts.accounting ?? "HEDGING",
        balance: opts.balance ?? 100_000,
        currency: p.currency,
        nextId: 1000,
        prices: Object.fromEntries(p.symbols.map((s) => [s.spec.symbol, { mid: s.start, time: Date.now() }])),
        positions: [],
        orders: [],
        history: [],
        faults: { rejectRate: 0, lostResponseRate: 0, notSentRate: 0, latencyMs: 0 },
      } satisfies SimState);
  }

  symbols(): string[] {
    return [...this.defs.keys()];
  }

  spec(symbol: string): InstrumentSpec {
    const d = this.defs.get(symbol);
    if (!d) throw new Error(`unknown symbol ${symbol}`);
    return { ...d.spec, missingFields: [], fetchedAt: this.now() };
  }

  /** Advances the random walk to now and returns the quote. */
  quote(symbol: string): Quote {
    const d = this.defs.get(symbol);
    const p = this.state.prices[symbol];
    if (!d || !p) throw new Error(`unknown symbol ${symbol}`);
    const now = this.now();
    const dt = Math.max(0, (now - p.time) / 1000);
    if (dt > 0) {
      const steps = Math.min(Math.ceil(dt), 60);
      for (let i = 0; i < steps; i++) p.mid += (this.rand() - 0.5) * 2 * d.vol * Math.sqrt(dt / steps);
      p.time = now;
    }
    const half = d.spread / 2;
    return {
      symbol,
      bid: roundToTick(p.mid - half, d.spec.tickSize, d.spec.digits),
      ask: roundToTick(p.mid + half, d.spec.tickSize, d.spec.digits),
      time: now,
    };
  }

  setMid(symbol: string, mid: number) {
    const p = this.state.prices[symbol];
    if (!p) throw new Error(`unknown symbol ${symbol}`);
    p.mid = mid;
    p.time = this.now();
    this.checkPendingAndStops();
  }

  private id(): string {
    return String(this.state.nextId++);
  }

  private pnl(p: SimPosition, q: Quote): number {
    const spec = this.defs.get(p.symbol)!.spec;
    const exit = p.side === "BUY" ? q.bid : q.ask;
    const diff = p.side === "BUY" ? exit - p.openPrice : p.openPrice - exit;
    const usd = (diff / spec.tickSize) * (spec.tickValue ?? 0) * p.volume;
    return this.toAccountCcy(usd);
  }

  private toAccountCcy(usd: number): number {
    if (this.state.currency === "USD") return usd;
    if (this.state.currency === "GBP") {
      const gbp = this.state.prices["GBPUSD.r"] ?? this.state.prices["GBPUSD"];
      return gbp ? usd / gbp.mid : usd;
    }
    return usd;
  }

  snapshot(): TradingSnapshot {
    this.checkPendingAndStops();
    let floating = 0;
    const positions = this.state.positions.map((p) => {
      const pr = roundTo(this.pnl(p, this.quote(p.symbol)), 2);
      floating += pr;
      return { ...p, profit: pr };
    });
    const equity = roundTo(this.state.balance + floating, 2);
    const marginUsed = roundTo(positions.reduce((a, p) => a + this.marginFor(p.symbol, p.volume), 0), 2);
    return {
      account: {
        balance: roundTo(this.state.balance, 2),
        equity,
        currency: this.state.currency,
        freeMargin: roundTo(equity - marginUsed, 2),
        marginUsed,
        accounting: this.state.accounting,
        serverTime: this.now(),
        fetchedAt: this.now(),
      },
      positions,
      orders: this.state.orders.map((o) => ({ ...o })),
    };
  }

  /** 1:100 leverage on notional, in account currency. */
  marginFor(symbol: string, volume: number): number {
    const d = this.defs.get(symbol)!;
    const q = this.state.prices[symbol]!.mid;
    const notionalUsd = (q / d.spec.tickSize) * (d.spec.tickValue ?? 0) * volume;
    return this.toAccountCcy(notionalUsd / 100);
  }

  private validateVolume(symbol: string, volume: number): string | null {
    const s = this.defs.get(symbol)!.spec;
    if (volume < s.volumeMin - 1e-12) return `volume ${volume} below min ${s.volumeMin}`;
    if (volume > s.volumeMax + 1e-12) return `volume ${volume} above max ${s.volumeMax}`;
    const steps = volume / s.volumeStep;
    if (Math.abs(steps - Math.round(steps)) > 1e-6) return `volume ${volume} not a multiple of step ${s.volumeStep}`;
    return null;
  }

  private validateStops(symbol: string, side: Side, sl: number | null | undefined, tp: number | null | undefined, ref: number): string | null {
    const s = this.defs.get(symbol)!.spec;
    const d = s.stopsDistance;
    if (sl) {
      if (side === "BUY" && !(sl < ref - d)) return `invalid stops: SL ${sl} too close/above price ${ref}`;
      if (side === "SELL" && !(sl > ref + d)) return `invalid stops: SL ${sl} too close/below price ${ref}`;
    }
    if (tp) {
      if (side === "BUY" && !(tp > ref + d)) return `invalid stops: TP ${tp} too close/below price ${ref}`;
      if (side === "SELL" && !(tp < ref - d)) return `invalid stops: TP ${tp} too close/above price ${ref}`;
    }
    return null;
  }

  /* --------------------------- trading primitives (no faults) --------------------------- */

  openMarket(symbol: string, side: Side, volume: number, sl: number | null, tp: number | null, tag: string | null, magic: number | null = null): { ok: true; position: SimPosition; orderId: string } | { ok: false; reason: string } {
    if (!this.defs.has(symbol)) return { ok: false, reason: `unknown symbol ${symbol}` };
    const ve = this.validateVolume(symbol, volume);
    if (ve) return { ok: false, reason: ve };
    const q = this.quote(symbol);
    const price = side === "BUY" ? q.ask : q.bid;
    const se = this.validateStops(symbol, side, sl, tp, side === "BUY" ? q.bid : q.ask);
    if (se) return { ok: false, reason: se };
    const snap = this.snapshot();
    if ((snap.account.freeMargin ?? 0) < this.marginFor(symbol, volume)) return { ok: false, reason: "not enough money" };
    const orderId = this.id();
    if (this.state.accounting === "NETTING") {
      const existing = this.state.positions.find((p) => p.symbol === symbol);
      if (existing) {
        const signed = (existing.side === "BUY" ? 1 : -1) * existing.volume + (side === "BUY" ? 1 : -1) * volume;
        const spec = this.defs.get(symbol)!.spec;
        if (existing.side === side) {
          existing.openPrice = roundTo((existing.openPrice * existing.volume + price * volume) / (existing.volume + volume), spec.digits);
          existing.volume = roundTo(existing.volume + volume, 8);
        } else {
          const closedVol = Math.min(existing.volume, volume);
          this.realize(existing, closedVol, side === "BUY" ? q.ask : q.bid);
          if (Math.abs(signed) < 1e-9) this.state.positions = this.state.positions.filter((p) => p !== existing);
          else if (Math.sign(signed) === (existing.side === "BUY" ? 1 : -1)) existing.volume = roundTo(Math.abs(signed), 8);
          else {
            existing.side = side;
            existing.volume = roundTo(Math.abs(signed), 8);
            existing.openPrice = price;
            existing.openTime = this.now();
          }
        }
        this.state.history.push({ orderId, positionId: existing.id, tag, kind: "MARKET", status: "FILLED", volume, price, time: this.now() });
        this.changed();
        return { ok: true, position: existing, orderId };
      }
    }
    const position: SimPosition = { id: orderId, orderId, symbol, side, volume, openPrice: price, openTime: this.now(), sl, tp, tag, magic, profit: 0 };
    this.state.positions.push(position);
    this.state.history.push({ orderId, positionId: position.id, tag, kind: "MARKET", status: "FILLED", volume, price, time: this.now() });
    this.changed();
    return { ok: true, position, orderId };
  }

  placePending(symbol: string, side: Side, kind: "LIMIT" | "STOP", volume: number, price: number, sl: number | null, tp: number | null, tag: string | null, magic: number | null = null): { ok: true; order: SimOrder } | { ok: false; reason: string } {
    if (!this.defs.has(symbol)) return { ok: false, reason: `unknown symbol ${symbol}` };
    const ve = this.validateVolume(symbol, volume);
    if (ve) return { ok: false, reason: ve };
    const q = this.quote(symbol);
    const ref = side === "BUY" ? q.ask : q.bid;
    const valid = kind === "LIMIT" ? (side === "BUY" ? price < ref : price > ref) : side === "BUY" ? price > ref : price < ref;
    if (!valid) return { ok: false, reason: `invalid ${kind} price ${price} for ${side} at ${ref}` };
    const se = this.validateStops(symbol, side, sl, tp, price);
    if (se) return { ok: false, reason: se };
    const order: SimOrder = { id: this.id(), symbol, side, kind, volume, price, sl, tp, createdTime: this.now(), tag, magic };
    this.state.orders.push(order);
    this.state.history.push({ orderId: order.id, positionId: null, tag, kind, status: "PLACED", volume, price, time: this.now() });
    this.changed();
    return { ok: true, order };
  }

  modifyPosition(positionId: string, sl: number | null, tp: number | null): { ok: true } | { ok: false; reason: string } {
    const p = this.state.positions.find((x) => x.id === positionId);
    if (!p) return { ok: false, reason: `position ${positionId} not found` };
    const q = this.quote(p.symbol);
    const se = this.validateStops(p.symbol, p.side, sl, tp, p.side === "BUY" ? q.bid : q.ask);
    if (se) return { ok: false, reason: se };
    p.sl = sl;
    p.tp = tp;
    this.changed();
    return { ok: true };
  }

  modifyPending(orderId: string, price: number | undefined, sl: number | null, tp: number | null): { ok: true } | { ok: false; reason: string } {
    const o = this.state.orders.find((x) => x.id === orderId);
    if (!o) return { ok: false, reason: `order ${orderId} not found` };
    if (price !== undefined) o.price = price;
    o.sl = sl;
    o.tp = tp;
    this.changed();
    return { ok: true };
  }

  cancelPending(orderId: string): { ok: true } | { ok: false; reason: string } {
    const o = this.state.orders.find((x) => x.id === orderId);
    if (!o) return { ok: false, reason: `order ${orderId} not found` };
    this.state.orders = this.state.orders.filter((x) => x !== o);
    this.state.history.push({ orderId, positionId: null, tag: o.tag, kind: o.kind, status: "CANCELLED", volume: o.volume, price: o.price, time: this.now() });
    this.changed();
    return { ok: true };
  }

  private realize(p: SimPosition, volume: number, _exit: number) {
    const q = this.quote(p.symbol);
    const full = this.pnl(p, q);
    this.state.balance = roundTo(this.state.balance + (full * volume) / p.volume, 2);
  }

  closePosition(positionId: string, volume?: number): { ok: true; closedVolume: number; price: number } | { ok: false; reason: string } {
    const p = this.state.positions.find((x) => x.id === positionId);
    if (!p) return { ok: false, reason: `position ${positionId} not found` };
    const spec = this.defs.get(p.symbol)!.spec;
    const vol = volume === undefined || volume >= p.volume - 1e-12 ? p.volume : floorToStep(volume, spec.volumeStep);
    if (vol <= 0) return { ok: false, reason: `close volume ${volume} rounds to zero` };
    if (vol < p.volume && p.volume - vol < spec.volumeMin - 1e-12) return { ok: false, reason: `remaining volume would be below minimum ${spec.volumeMin}` };
    const q = this.quote(p.symbol);
    const price = p.side === "BUY" ? q.bid : q.ask;
    this.realize(p, vol, price);
    if (vol >= p.volume - 1e-12) this.state.positions = this.state.positions.filter((x) => x !== p);
    else p.volume = roundTo(p.volume - vol, 8);
    this.state.history.push({ orderId: this.id(), positionId, tag: p.tag, kind: "CLOSE", status: "CLOSED", volume: vol, price, time: this.now() });
    this.changed();
    return { ok: true, closedVolume: vol, price };
  }

  /** Fills pending orders whose price was touched, and triggers SL/TP. */
  checkPendingAndStops() {
    let changed = false;
    for (const o of [...this.state.orders]) {
      const q = this.quoteNoAdvance(o.symbol);
      const ref = o.side === "BUY" ? q.ask : q.bid;
      const hit = o.kind === "LIMIT" ? (o.side === "BUY" ? ref <= o.price : ref >= o.price) : o.side === "BUY" ? ref >= o.price : ref <= o.price;
      if (hit) {
        this.state.orders = this.state.orders.filter((x) => x !== o);
        const pos: SimPosition = { id: o.id, orderId: o.id, symbol: o.symbol, side: o.side, volume: o.volume, openPrice: ref, openTime: this.now(), sl: o.sl, tp: o.tp, tag: o.tag, magic: o.magic ?? null, profit: 0 };
        this.state.positions.push(pos);
        this.state.history.push({ orderId: o.id, positionId: pos.id, tag: o.tag, kind: o.kind, status: "FILLED", volume: o.volume, price: ref, time: this.now() });
        changed = true;
      }
    }
    for (const p of [...this.state.positions]) {
      const q = this.quoteNoAdvance(p.symbol);
      const exit = p.side === "BUY" ? q.bid : q.ask;
      const slHit = p.sl !== null && (p.side === "BUY" ? exit <= p.sl : exit >= p.sl);
      const tpHit = p.tp !== null && (p.side === "BUY" ? exit >= p.tp : exit <= p.tp);
      if (slHit || tpHit) {
        this.realize(p, p.volume, exit);
        this.state.positions = this.state.positions.filter((x) => x !== p);
        this.state.history.push({ orderId: this.id(), positionId: p.id, tag: p.tag, kind: slHit ? "SL" : "TP", status: "CLOSED", volume: p.volume, price: exit, time: this.now() });
        changed = true;
      }
    }
    if (changed) this.changed();
  }

  private quoteNoAdvance(symbol: string): Quote {
    const d = this.defs.get(symbol)!;
    const p = this.state.prices[symbol]!;
    const half = d.spread / 2;
    return { symbol, bid: roundToTick(p.mid - half, d.spec.tickSize, d.spec.digits), ask: roundToTick(p.mid + half, d.spec.tickSize, d.spec.digits), time: p.time };
  }

  private changed() {
    this.onChange?.();
  }

  /* --------------------------- adapter-facing execution with faults --------------------------- */

  async execute(cmd: ExecutionCommand): Promise<SubmitOutcome> {
    const f = this.state.faults;
    if (f.latencyMs > 0) await new Promise((r) => setTimeout(r, f.latencyMs));
    if (f.notSentRate > 0 && this.rand() < f.notSentRate) return { status: "REJECTED", reason: "simulated connection refused (not sent)", retryable: true };
    if (f.rejectRate > 0 && this.rand() < f.rejectRate) return { status: "REJECTED", reason: "simulated broker rejection", retryable: false };
    const outcome = this.apply(cmd);
    if (outcome.status === "ACCEPTED" && f.lostResponseRate > 0 && this.rand() < f.lostResponseRate)
      return { status: "UNKNOWN", reason: "simulated response timeout after execution" };
    return outcome;
  }

  apply(cmd: ExecutionCommand): SubmitOutcome {
    const tag = cmd.tag;
    switch (cmd.kind) {
      case "OPEN_MARKET": {
        const r = this.openMarket(cmd.symbol, cmd.side!, cmd.volume!, cmd.sl ?? null, cmd.tp ?? null, tag, cmd.magic ?? null);
        if (!r.ok) return { status: "REJECTED", reason: r.reason, retryable: false };
        return { status: "ACCEPTED", orderId: r.orderId, positionId: r.position.id, filled: true, fillPrice: r.position.openPrice, filledVolume: cmd.volume };
      }
      case "PLACE_PENDING": {
        const r = this.placePending(cmd.symbol, cmd.side!, cmd.pendingKind!, cmd.volume!, cmd.price!, cmd.sl ?? null, cmd.tp ?? null, tag, cmd.magic ?? null);
        if (!r.ok) return { status: "REJECTED", reason: r.reason, retryable: false };
        return { status: "ACCEPTED", orderId: r.order.id, filled: false };
      }
      case "MODIFY_POSITION": {
        const r = this.modifyPosition(cmd.positionId!, cmd.sl ?? null, cmd.tp ?? null);
        return r.ok ? { status: "ACCEPTED", positionId: cmd.positionId } : { status: "REJECTED", reason: r.reason, retryable: false };
      }
      case "MODIFY_PENDING": {
        const r = this.modifyPending(cmd.orderId!, cmd.price, cmd.sl ?? null, cmd.tp ?? null);
        return r.ok ? { status: "ACCEPTED", orderId: cmd.orderId } : { status: "REJECTED", reason: r.reason, retryable: false };
      }
      case "CLOSE_POSITION": {
        const r = this.closePosition(cmd.positionId!, cmd.volume);
        return r.ok
          ? { status: "ACCEPTED", positionId: cmd.positionId, filled: true, fillPrice: r.price, filledVolume: r.closedVolume }
          : { status: "REJECTED", reason: r.reason, retryable: false };
      }
      case "CANCEL_PENDING": {
        const r = this.cancelPending(cmd.orderId!);
        return r.ok ? { status: "ACCEPTED", orderId: cmd.orderId } : { status: "REJECTED", reason: r.reason, retryable: false };
      }
    }
  }

  /** Reconciliation by tag through the order history, like a real platform would allow. */
  reconcile(cmd: ExecutionCommand, sinceMs: number): ReconcileResult {
    if (cmd.kind === "OPEN_MARKET" || cmd.kind === "PLACE_PENDING") {
      const h = this.state.history.find((x) => x.tag === cmd.tag && x.time >= sinceMs - 1000 && (x.status === "FILLED" || x.status === "PLACED"));
      if (!h) return { found: false, conclusive: true };
      return { found: true, conclusive: true, orderId: h.orderId, positionId: h.positionId ?? undefined, filled: h.status === "FILLED", fillPrice: h.price ?? undefined, filledVolume: h.volume };
    }
    if (cmd.kind === "CLOSE_POSITION") {
      const pos = this.state.positions.find((p) => p.id === cmd.positionId);
      const closed = this.state.history.find((x) => x.positionId === cmd.positionId && x.status === "CLOSED" && x.time >= sinceMs - 1000);
      if (closed) return { found: true, conclusive: true, positionId: cmd.positionId, filled: true, fillPrice: closed.price ?? undefined, filledVolume: closed.volume };
      return { found: false, conclusive: !!pos, detail: pos ? "position still open" : "position not found and no close record" };
    }
    if (cmd.kind === "MODIFY_POSITION") {
      const pos = this.state.positions.find((p) => p.id === cmd.positionId);
      if (!pos) return { found: false, conclusive: true, detail: "position no longer open" };
      return { found: pos.sl === (cmd.sl ?? null) && pos.tp === (cmd.tp ?? null), conclusive: true };
    }
    if (cmd.kind === "CANCEL_PENDING") {
      const o = this.state.orders.find((x) => x.id === cmd.orderId);
      return { found: !o, conclusive: true };
    }
    const o = this.state.orders.find((x) => x.id === cmd.orderId);
    return { found: !!o && o.sl === (cmd.sl ?? null) && o.tp === (cmd.tp ?? null), conclusive: true };
  }
}

import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { bridgeCommands, type Db } from "@gtc/db";
import type { BridgeSync, ExecutionCommand, InstrumentSpec, Quote, TradingSnapshot } from "@gtc/shared";

export interface BridgeCommandWire {
  id: string;
  clientId: string;
  kind: ExecutionCommand["kind"];
  symbol: string;
  side: string;
  volume: number;
  price: number;
  sl: number;
  tp: number;
  positionTicket: string;
  orderTicket: string;
  pendingKind: string;
  tag: string;
  magic: number;
}

export interface BridgeState {
  sync: BridgeSync;
  receivedAt: number;
  snapshot: TradingSnapshot;
  quotes: Map<string, Quote>;
  specs: Map<string, InstrumentSpec>;
}

/** Retcodes that mean the order certainly did not execute and may be retried. */
const RETRYABLE_MT5 = new Set([10004, 10020, 10021, 10024, 10031]); // requote, price changed, no quotes, too many requests, no connection
const RETRYABLE_MT4 = new Set([4, 6, 8, 128, 129, 135, 136, 137, 138, 141, 146]);

export function retcodeRetryable(platform: "MT4" | "MT5", retcode: number): boolean {
  return platform === "MT5" ? RETRYABLE_MT5.has(retcode) : RETRYABLE_MT4.has(retcode);
}

/**
 * In-process state shared between the bridge HTTP server and MtBridgeAdapter instances.
 * The durable part (commands, results) lives in `bridge_commands`.
 */
export class BridgeHub {
  private states = new Map<string, BridgeState>();
  private watch = new Map<string, Set<string>>();
  private specsRequested = new Set<string>();
  private waiters = new Map<string, (() => void)[]>();
  constructor(private db: Db) {}

  state(accountId: string) {
    return this.states.get(accountId);
  }

  setWatchSymbols(accountId: string, symbols: string[]) {
    const prev = this.watch.get(accountId);
    const next = new Set(symbols);
    if (!prev || [...next].some((s) => !prev.has(s))) this.specsRequested.add(accountId);
    this.watch.set(accountId, next);
  }

  requestSpecs(accountId: string) {
    this.specsRequested.add(accountId);
  }

  watchSymbols(accountId: string) {
    return [...(this.watch.get(accountId) ?? [])];
  }

  /** Ingests a validated sync from an EA; returns commands to deliver. */
  async ingest(accountId: string, sync: BridgeSync): Promise<{ commands: BridgeCommandWire[]; watchSymbols: string[]; sendSymbols: boolean }> {
    const now = Date.now();
    const prev = this.states.get(accountId);
    const quotes = prev?.quotes ?? new Map<string, Quote>();
    for (const q of sync.quotes) quotes.set(q.symbol, { symbol: q.symbol, bid: q.bid, ask: q.ask, time: q.time });
    const specs = prev?.specs ?? new Map<string, InstrumentSpec>();
    if (sync.symbols) {
      for (const s of sync.symbols) {
        specs.set(s.symbol, {
          symbol: s.symbol,
          description: s.description,
          digits: s.digits,
          tickSize: s.tickSize,
          tickValue: s.tickValue,
          tickValueCurrency: sync.account.currency,
          contractSize: s.contractSize,
          baseCurrency: s.baseCurrency ?? null,
          profitCurrency: s.profitCurrency ?? null,
          volumeMin: s.volumeMin,
          volumeMax: s.volumeMax,
          volumeStep: s.volumeStep,
          stopsDistance: s.stopsLevelPoints * s.tickSize,
          freezeDistance: s.freezeLevelPoints * s.tickSize,
          orderKinds: ["MARKET", "LIMIT", "STOP"],
          tradable: s.tradeAllowed,
          marginPerLot: s.marginPerLot ?? null,
          missingFields: [],
          source: "PLATFORM",
          fetchedAt: now,
        });
        if (s.bid && s.ask) quotes.set(s.symbol, { symbol: s.symbol, bid: s.bid, ask: s.ask, time: s.quoteTime ?? now });
      }
      this.specsRequested.delete(accountId);
    }
    const snapshot: TradingSnapshot = {
      account: {
        balance: sync.account.balance,
        equity: sync.account.equity,
        currency: sync.account.currency,
        freeMargin: sync.account.freeMargin,
        marginUsed: sync.account.margin,
        accounting: sync.accounting,
        serverTime: sync.serverTime,
        fetchedAt: now,
      },
      positions: sync.positions.map((p) => ({
        id: p.ticket,
        symbol: p.symbol,
        side: p.side,
        volume: p.volume,
        openPrice: p.openPrice,
        openTime: p.openTime,
        sl: p.sl && p.sl > 0 ? p.sl : null,
        tp: p.tp && p.tp > 0 ? p.tp : null,
        tag: p.comment,
        magic: p.magic,
        orderId: p.orderTicket ?? null,
        replacesId: p.fromTicket ?? null,
        profit: p.profit ?? null,
      })),
      orders: sync.orders.map((o) => ({
        id: o.ticket,
        symbol: o.symbol,
        side: o.side,
        kind: o.kind,
        volume: o.volume,
        price: o.price,
        sl: o.sl && o.sl > 0 ? o.sl : null,
        tp: o.tp && o.tp > 0 ? o.tp : null,
        createdTime: o.createdTime,
        tag: o.comment,
        magic: o.magic,
      })),
    };
    this.states.set(accountId, { sync, receivedAt: now, snapshot, quotes, specs });

    // Record command results.
    for (const r of sync.results) {
      await this.db
        .update(bridgeCommands)
        .set({ status: r.ok ? "DONE" : "FAILED", result: r as unknown as Record<string, unknown>, completedAt: new Date() })
        .where(and(eq(bridgeCommands.accountId, accountId), eq(bridgeCommands.id, r.commandId), inArray(bridgeCommands.status, ["PENDING", "DELIVERED"])));
      this.wake(r.commandId);
    }

    // Expire undelivered commands past their deadline (they will be reported as not executed).
    await this.db
      .update(bridgeCommands)
      .set({ status: "EXPIRED", completedAt: new Date() })
      .where(and(eq(bridgeCommands.accountId, accountId), eq(bridgeCommands.status, "PENDING"), lt(bridgeCommands.expiresAt, new Date())));

    // Deliver pending commands, plus redeliver delivered-without-result after 15s (EA dedups by tag).
    const due = await this.db.execute(sql`
      update bridge_commands set status = 'DELIVERED', delivered_at = now(), deliveries = deliveries + 1
       where account_id = ${accountId}
         and expires_at > now()
         and ((status = 'PENDING') or (status = 'DELIVERED' and delivered_at < now() - interval '15 seconds' and deliveries < 3))
       returning id, client_id, command`);
    const commands = (due as unknown as { id: string; client_id: string; command: ExecutionCommand }[]).map((r) => toWire(r.id, r.command));
    return { commands, watchSymbols: this.watchSymbols(accountId), sendSymbols: this.specsRequested.has(accountId) || !prev };
  }

  waitFor(commandId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, timeoutMs);
      const list = this.waiters.get(commandId) ?? [];
      list.push(done);
      this.waiters.set(commandId, list);
      function done() {
        clearTimeout(t);
        resolve();
      }
    });
  }

  private wake(commandId: string) {
    const list = this.waiters.get(commandId);
    this.waiters.delete(commandId);
    list?.forEach((f) => f());
  }
}

function toWire(id: string, c: ExecutionCommand): BridgeCommandWire {
  return {
    id,
    clientId: c.clientId,
    kind: c.kind,
    symbol: c.symbol,
    side: c.side ?? "",
    volume: c.volume ?? 0,
    price: c.price ?? 0,
    sl: c.sl ?? 0,
    tp: c.tp ?? 0,
    positionTicket: c.positionId ?? "",
    orderTicket: c.orderId ?? "",
    pendingKind: c.pendingKind ?? "",
    tag: c.tag,
    magic: c.magic ?? 0,
  };
}

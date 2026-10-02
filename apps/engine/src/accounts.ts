import { and, eq } from "drizzle-orm";
import { appSettings, connectionEvents, instruments, tradingAccounts, type Db } from "@gtc/db";
import {
  AdapterError,
  MatchTraderAdapter,
  SimulatorAdapter,
  TradeLockerAdapter,
  type PlatformAdapter,
} from "@gtc/adapters";
import { canonicalSymbol, FxTable, type InstrumentSpec, type Quote, type TradingSnapshot } from "@gtc/shared";
import { decryptSecret, encryptSecret, type KeyRing } from "@gtc/shared/crypto";
import { MtBridgeAdapter } from "./bridge/adapter";
import type { BridgeHub } from "./bridge/hub";
import type { EngineConfig } from "./config";
import type { Log } from "./logger";
import type { SimStore } from "./sim-store";

export type AccountRow = typeof tradingAccounts.$inferSelect;

export interface AccountRuntime {
  row: AccountRow;
  adapter: PlatformAdapter | null;
  buildError: string | null;
  connected: boolean;
  nextConnectAt: number;
  connectFailures: number;
  snapshot: TradingSnapshot | null;
  snapshotAt: number | null;
  nextRefreshAt: number;
  refreshing: boolean;
  isMaster: boolean;
  specs: Map<string, InstrumentSpec>;
  quotes: Map<string, Quote>;
  lastStatus: string;
  instrumentsSyncedAt: number | null;
}

/**
 * Owns one adapter per enabled account. Status shown in the dashboard comes from here and
 * reflects real connectivity (successful authenticated calls), never the saved record alone.
 */
export class ConnectionManager {
  runtimes = new Map<string, AccountRuntime>();
  private manualFx: { base: string; quote: string; rate: number; time: number }[] = [];
  /** Symbols the engine needs specs for on an account (mapped symbols). */
  neededSymbols: (accountId: string) => string[] = () => [];
  /** Hook invoked after each successful master snapshot. */
  onMasterSnapshot?: (accountId: string, snap: TradingSnapshot) => Promise<void>;

  constructor(
    private db: Db,
    private cfg: EngineConfig,
    private ring: KeyRing,
    private hub: BridgeHub,
    private sims: SimStore,
    private log: Log,
  ) {}

  setManualFx(rates: { base: string; quote: string; rate: number; time: number }[]) {
    this.manualFx = rates;
  }

  /** Reloads account rows; rebuilds adapters whose configuration changed. */
  async reload(masterIds: Set<string>) {
    const rows = await this.db.select().from(tradingAccounts);
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row.enabled) continue;
      seen.add(row.id);
      const rt = this.runtimes.get(row.id);
      if (rt && rt.row.updatedAt.getTime() === row.updatedAt.getTime()) {
        rt.isMaster = masterIds.has(row.id);
        rt.row = row;
        continue;
      }
      if (rt?.adapter) await rt.adapter.disconnect().catch(() => {});
      const fresh: AccountRuntime = {
        row,
        adapter: null,
        buildError: null,
        connected: false,
        nextConnectAt: 0,
        connectFailures: 0,
        snapshot: rt?.snapshot ?? null,
        snapshotAt: rt?.snapshotAt ?? null,
        nextRefreshAt: 0,
        refreshing: false,
        isMaster: masterIds.has(row.id),
        specs: rt?.specs ?? new Map(),
        quotes: rt?.quotes ?? new Map(),
        lastStatus: rt?.lastStatus ?? row.connectionStatus,
        instrumentsSyncedAt: null,
      };
      try {
        fresh.adapter = await this.build(row);
      } catch (e) {
        fresh.buildError = (e as Error).message;
      }
      // Load persisted specs (incl. manual overrides).
      const specRows = await this.db.select().from(instruments).where(eq(instruments.accountId, row.id));
      for (const s of specRows) fresh.specs.set(s.symbol, s.spec);
      this.runtimes.set(row.id, fresh);
    }
    for (const id of [...this.runtimes.keys()]) {
      if (!seen.has(id)) {
        await this.runtimes.get(id)?.adapter?.disconnect().catch(() => {});
        this.runtimes.delete(id);
        this.sims.drop(id);
      }
    }
  }

  private async build(row: AccountRow): Promise<PlatformAdapter> {
    if (row.environment === "SIMULATION") {
      const profile = row.server && row.server.startsWith("SIM-") ? row.server : "SIM-ALPHA";
      const broker = await this.sims.get(row.id, profile, row.accounting === "NETTING" ? "NETTING" : "HEDGING");
      return new SimulatorAdapter(broker, this.cfg.SIM_POLL_MS);
    }
    if (row.platform === "MT4" || row.platform === "MT5") return new MtBridgeAdapter(row.platform, row.id, this.hub, this.db);
    if (!row.credentialsEnc) throw new Error("credentials not set");
    const creds = JSON.parse(decryptSecret(this.ring, row.credentialsEnc, `account:${row.id}:credentials`)) as { login: string; password: string; brokerId?: string };
    if (!row.apiBaseUrl) throw new Error("API base URL not set");
    if (row.platform === "TRADELOCKER") {
      const host = new URL(row.apiBaseUrl).hostname;
      if (row.environment === "DEMO" && host === "live.tradelocker.com") throw new Error("DEMO account configured with the LIVE TradeLocker host");
      if (row.environment === "LIVE" && host === "demo.tradelocker.com") throw new Error("LIVE account configured with the DEMO TradeLocker host");
      let cached: { accessToken: string; refreshToken: string } | null = null;
      if (row.sessionEnc) {
        try {
          cached = JSON.parse(decryptSecret(this.ring, row.sessionEnc, `account:${row.id}:session`));
        } catch {
          cached = null;
        }
      }
      return new TradeLockerAdapter({
        baseUrl: row.apiBaseUrl,
        email: creds.login,
        password: creds.password,
        server: row.server ?? "",
        account: row.externalAccountId,
        developerApiKey: this.cfg.TRADELOCKER_DEVELOPER_API_KEY,
        pollIntervalMs: this.cfg.TRADELOCKER_POLL_MS,
        cachedTokens: cached,
        onTokens: (t) => {
          const enc = encryptSecret(this.ring, JSON.stringify(t), `account:${row.id}:session`);
          // Persist without bumping updated_at (which would rebuild the adapter).
          void this.db.update(tradingAccounts).set({ sessionEnc: enc }).where(eq(tradingAccounts.id, row.id)).catch(() => {});
          void this.event(row.id, "TOKEN_REFRESH", "session tokens updated");
        },
      });
    }
    if (row.platform === "MATCHTRADER") {
      return new MatchTraderAdapter({
        baseUrl: row.apiBaseUrl,
        email: creds.login,
        password: creds.password,
        brokerId: creds.brokerId ?? "",
        systemUuid: row.server ?? "",
        account: row.externalAccountId,
        enableUnverifiedBodies: this.cfg.MATCHTRADER_ENABLE_UNVERIFIED_BODIES && row.environment !== "LIVE",
        requestsPerSecond: this.cfg.MATCHTRADER_REQUESTS_PER_SECOND,
        pollIntervalMs: this.cfg.MATCHTRADER_POLL_MS,
        endpoints: {
          symbols: this.cfg.MATCHTRADER_PATH_SYMBOLS ?? null,
          quotes: this.cfg.MATCHTRADER_PATH_QUOTES ?? null,
          partialClose: this.cfg.MATCHTRADER_PATH_PARTIAL_CLOSE ?? null,
          activeOrders: this.cfg.MATCHTRADER_PATH_ACTIVE_ORDERS ?? null,
        },
      });
    }
    throw new Error(`unsupported platform ${row.platform}`);
  }

  private masterPollMs(rt: AccountRuntime): number {
    if (rt.row.environment === "SIMULATION") return this.cfg.SIM_POLL_MS;
    if (rt.row.platform === "TRADELOCKER") return this.cfg.TRADELOCKER_POLL_MS;
    if (rt.row.platform === "MATCHTRADER") return this.cfg.MATCHTRADER_POLL_MS;
    return 250; // bridges push; we just read the latest sync
  }

  async event(accountId: string, kind: string, detail: string) {
    await this.db
      .insert(connectionEvents)
      .values({ accountId, kind, detail: detail.slice(0, 1000) })
      .catch(() => {});
  }

  private async setStatus(rt: AccountRuntime, status: string, detail: string | null, extra: Partial<AccountRow> = {}) {
    const changed = rt.lastStatus !== status;
    rt.lastStatus = status;
    await this.db
      .update(tradingAccounts)
      .set({ connectionStatus: status, statusDetail: detail?.slice(0, 500) ?? null, ...extra })
      .where(eq(tradingAccounts.id, rt.row.id));
    if (changed) await this.event(rt.row.id, status, detail ?? "");
  }

  /** One scheduling pass: connect, refresh snapshots, persist status. */
  async tick() {
    const now = Date.now();
    await Promise.all(
      [...this.runtimes.values()].map(async (rt) => {
        if (rt.refreshing) return;
        if (!rt.adapter) {
          if (rt.lastStatus !== "NOT_CONFIGURED") await this.setStatus(rt, "NOT_CONFIGURED", rt.buildError);
          return;
        }
        if (!rt.connected) {
          if (now < rt.nextConnectAt) return;
          rt.refreshing = true;
          try {
            await this.setStatus(rt, rt.adapter.platform === "MT4" || rt.adapter.platform === "MT5" ? "AWAITING_BRIDGE" : "CONNECTING", null);
            await rt.adapter.connect();
            rt.connected = true;
            rt.connectFailures = 0;
            rt.nextRefreshAt = 0;
            await this.event(rt.row.id, "CONNECT", `${rt.adapter.platform} connected`);
          } catch (e) {
            rt.connectFailures++;
            const backoff = Math.min(60_000, 1000 * 2 ** Math.min(rt.connectFailures, 6));
            rt.nextConnectAt = Date.now() + backoff;
            const err = e as AdapterError;
            const status = err instanceof AdapterError && err.kind === "AUTH" ? "AUTH_FAILED" : rt.adapter.platform === "MT4" || rt.adapter.platform === "MT5" ? "AWAITING_BRIDGE" : "DISCONNECTED";
            await this.setStatus(rt, status, `${err.message} (retry in ${Math.round(backoff / 1000)}s)`);
          } finally {
            rt.refreshing = false;
          }
          return;
        }
        if (now < rt.nextRefreshAt) return;
        rt.refreshing = true;
        try {
          const snap = await rt.adapter.getSnapshot();
          rt.snapshot = snap;
          rt.snapshotAt = Date.now();
          rt.nextRefreshAt = Date.now() + (rt.isMaster ? this.masterPollMs(rt) : this.cfg.FOLLOWER_REFRESH_MS);
          const h = rt.adapter.health();
          const degraded = h.lastErrorAt !== null && Date.now() - h.lastErrorAt < 30_000;
          const status = degraded ? "DEGRADED" : "CONNECTED";
          const a = snap.account;
          const balanceChanged = rt.row.balance !== a.balance || rt.row.equity !== a.equity || rt.lastStatus !== status;
          if (balanceChanged || !rt.row.lastSyncAt || Date.now() - rt.row.lastSyncAt.getTime() > 5000) {
            const extra = { balance: a.balance, equity: a.equity, freeMargin: a.freeMargin, marginUsed: a.marginUsed, currency: a.currency || rt.row.currency, accounting: a.accounting, lastSyncAt: new Date(), capabilities: rt.adapter.capabilities };
            Object.assign(rt.row, extra);
            await this.setStatus(rt, status, degraded ? h.lastError : null, extra);
          }
          if (rt.isMaster && this.onMasterSnapshot) await this.onMasterSnapshot(rt.row.id, snap);
          if (!rt.instrumentsSyncedAt || Date.now() - rt.instrumentsSyncedAt > 30 * 60_000) void this.syncInstruments(rt.row.id).catch(() => {});
        } catch (e) {
          const err = e as Error;
          rt.nextRefreshAt = Date.now() + 2000;
          if (err instanceof AdapterError && (err.kind === "AUTH" || err.kind === "NETWORK")) {
            rt.connected = false;
            rt.connectFailures++;
            rt.nextConnectAt = Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(rt.connectFailures, 6));
            await this.setStatus(rt, err.kind === "AUTH" ? "AUTH_FAILED" : rt.adapter.platform === "MT4" || rt.adapter.platform === "MT5" ? "AWAITING_BRIDGE" : "DISCONNECTED", err.message);
            await this.event(rt.row.id, "DISCONNECT", err.message);
          } else {
            await this.setStatus(rt, "DEGRADED", err.message);
          }
        } finally {
          rt.refreshing = false;
        }
      }),
    );
  }

  /** Fetches instrument specs; for API platforms only mapped/needed symbols to respect rate limits. */
  async syncInstruments(accountId: string, symbols?: string[]): Promise<number> {
    const rt = this.runtimes.get(accountId);
    if (!rt?.adapter || !rt.connected) throw new Error("account not connected");
    // API platforms: per-symbol detail calls are rate limited, so only fetch needed symbols.
    const perSymbol = rt.row.platform === "TRADELOCKER" && rt.row.environment !== "SIMULATION";
    const wanted = symbols ?? (perSymbol ? [...new Set([...rt.specs.keys(), ...this.neededSymbols(accountId)])] : undefined);
    const names = await rt.adapter.listSymbols();
    await this.db
      .insert(appSettings)
      .values({ key: `symbols:${accountId}`, value: names })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: names, updatedAt: new Date() } });
    const specs = perSymbol && (!wanted || wanted.length === 0) ? [] : await rt.adapter.getInstruments(wanted);
    for (const spec of specs) {
      const existing = rt.specs.get(spec.symbol);
      // Manual overrides win until the owner clears them.
      if (existing?.source === "MANUAL") continue;
      rt.specs.set(spec.symbol, { ...spec, source: "PLATFORM" });
      await this.db
        .insert(instruments)
        .values({ accountId, symbol: spec.symbol, spec: { ...spec, source: "PLATFORM" } })
        .onConflictDoUpdate({ target: [instruments.accountId, instruments.symbol], set: { spec: { ...spec, source: "PLATFORM" }, updatedAt: new Date() } });
    }
    rt.instrumentsSyncedAt = Date.now();
    return specs.length;
  }

  async quote(accountId: string, symbol: string, maxAgeMs = 500): Promise<Quote> {
    const rt = this.runtimes.get(accountId);
    if (!rt?.adapter) throw new Error("account not available");
    const cached = rt.quotes.get(symbol);
    if (cached && Date.now() - cached.time <= maxAgeMs) return cached;
    const q = await rt.adapter.getQuote(symbol);
    rt.quotes.set(symbol, q);
    await this.db
      .update(instruments)
      .set({ bid: q.bid, ask: q.ask, quoteTime: new Date(q.time) })
      .where(and(eq(instruments.accountId, accountId), eq(instruments.symbol, symbol)))
      .catch(() => {});
    return q;
  }

  /** FX table from currency-pair quotes on any connected account plus manual rates. */
  fx(): FxTable {
    const t = new FxTable();
    for (const r of this.manualFx) t.set({ ...r, source: "manual" });
    for (const rt of this.runtimes.values()) {
      for (const q of rt.quotes.values()) {
        const c = canonicalSymbol(q.symbol);
        if (!/^[A-Z]{6}$/.test(c) || !(q.bid > 0 && q.ask > 0)) continue;
        t.set({ base: c.slice(0, 3), quote: c.slice(3), rate: (q.bid + q.ask) / 2, time: q.time, source: `${rt.row.nickname}:${q.symbol}` });
      }
    }
    return t;
  }

  /** Keeps FX pairs fresh: quotes the major USD crosses needed by configured account currencies. */
  async refreshFxQuotes() {
    const currencies = new Set([...this.runtimes.values()].map((r) => r.row.currency).filter((c): c is string => !!c && c !== "USD"));
    if (currencies.size === 0) return;
    for (const rt of this.runtimes.values()) {
      if (!rt.connected || !rt.adapter) continue;
      for (const sym of rt.specs.keys()) {
        const c = canonicalSymbol(sym);
        if (!/^[A-Z]{6}$/.test(c)) continue;
        if ([...currencies].some((ccy) => c === `${ccy}USD` || c === `USD${ccy}`)) await this.quote(rt.row.id, sym, 60_000).catch(() => {});
      }
    }
  }
}

import { and, eq } from "drizzle-orm";
import { bridgeCommands, type Db } from "@gtc/db";
import type { ExecutionCommand, InstrumentSpec, PlatformCapabilities, Quote, ReconcileResult, SubmitOutcome, TradingSnapshot } from "@gtc/shared";
import { AdapterError, type AdapterHealth, type PlatformAdapter } from "@gtc/adapters";
import { retcodeRetryable, type BridgeHub } from "./hub";

export const mtCapabilities = (platform: "MT4" | "MT5"): PlatformCapabilities => ({
  canBeMaster: true,
  canBeFollower: true,
  marketOrders: true,
  pendingLimit: true,
  pendingStop: true,
  modifyPositionSlTp: true,
  modifyPendingOrder: true,
  partialClose: true,
  orderTagging: true,
  masterDetection: "bridge",
  integrationStatus: "IMPLEMENTED_UNVERIFIED",
  notes: [
    `${platform} Expert Advisor bridge; EA source provided, not compiled or run in this environment.`,
    "Terminal login credentials never leave the terminal; the EA authenticates with a revocable device token.",
    "Copier trades carry the gtc1:<id> comment and the configured magic number.",
  ],
});

interface BridgeResult {
  ok: boolean;
  retcode: number;
  message: string;
  orderTicket: string | null;
  positionTicket: string | null;
  fillPrice: number | null;
  filledVolume: number | null;
}

/** Engine-side adapter for an MT4/MT5 terminal running the GTC bridge EA. */
export class MtBridgeAdapter implements PlatformAdapter {
  readonly capabilities: PlatformCapabilities;
  private stats = { requests: 0, lastError: null as string | null, lastErrorAt: null as number | null };

  constructor(
    readonly platform: "MT4" | "MT5",
    private accountId: string,
    private hub: BridgeHub,
    private db: Db,
    private opts: { staleMs?: number; submitTimeoutMs?: number; commandTtlMs?: number } = {},
  ) {
    this.capabilities = mtCapabilities(platform);
  }

  private fresh() {
    const s = this.hub.state(this.accountId);
    if (!s) throw new AdapterError("NETWORK", "bridge has not connected yet");
    if (Date.now() - s.receivedAt > (this.opts.staleMs ?? 10_000)) throw new AdapterError("NETWORK", `bridge silent for ${Math.round((Date.now() - s.receivedAt) / 1000)}s`);
    if (!s.sync.terminalConnected) throw new AdapterError("NETWORK", "terminal reports no connection to trade server");
    return s;
  }

  async connect() {
    this.fresh();
  }
  async disconnect() {}

  health(): AdapterHealth {
    const s = this.hub.state(this.accountId);
    const connected = !!s && Date.now() - s.receivedAt < (this.opts.staleMs ?? 10_000) && s.sync.terminalConnected;
    return {
      connected,
      lastOkAt: s?.receivedAt ?? null,
      lastError: this.stats.lastError,
      lastErrorAt: this.stats.lastErrorAt,
      reconnects: 0,
      tokenRefreshes: 0,
      rateLimited: 0,
      requests: this.stats.requests,
      avgLatencyMs: null,
      detection: { mode: "bridge", intervalMs: 300 },
      rateLimits: [],
    };
  }

  async getSnapshot(): Promise<TradingSnapshot> {
    return this.fresh().snapshot;
  }

  async getInstruments(symbols?: string[]): Promise<InstrumentSpec[]> {
    const s = this.fresh();
    if (symbols?.some((x) => !s.specs.has(x))) this.hub.requestSpecs(this.accountId);
    return [...s.specs.values()].filter((x) => !symbols || symbols.includes(x.symbol));
  }

  async listSymbols(): Promise<string[]> {
    const s = this.fresh();
    return [...new Set([...s.specs.keys(), ...s.sync.positions.map((p) => p.symbol)])];
  }

  async getQuote(symbol: string): Promise<Quote> {
    const s = this.fresh();
    const q = s.quotes.get(symbol);
    if (!q) {
      this.hub.setWatchSymbols(this.accountId, [...new Set([...this.hub.watchSymbols(this.accountId), symbol])]);
      throw new AdapterError("NETWORK", `no quote for ${symbol} yet (added to bridge watch list)`);
    }
    return q;
  }

  async submit(cmd: ExecutionCommand): Promise<SubmitOutcome> {
    try {
      this.fresh();
    } catch (e) {
      return { status: "REJECTED", reason: (e as Error).message, retryable: true };
    }
    this.stats.requests++;
    const ttl = this.opts.commandTtlMs ?? 10_000;
    const inserted = await this.db
      .insert(bridgeCommands)
      .values({ accountId: this.accountId, clientId: cmd.clientId, command: cmd, expiresAt: new Date(Date.now() + ttl) })
      .onConflictDoNothing({ target: bridgeCommands.clientId })
      .returning({ id: bridgeCommands.id });
    let id = inserted[0]?.id;
    if (!id) {
      // Same clientId already queued (resubmission after restart): never enqueue twice.
      const existing = await this.db.query.bridgeCommands.findFirst({ where: eq(bridgeCommands.clientId, cmd.clientId) });
      if (!existing) return { status: "UNKNOWN", reason: "bridge command conflict" };
      id = existing.id;
    }
    await this.hub.waitFor(id, this.opts.submitTimeoutMs ?? 12_000);
    return this.outcomeFor(id);
  }

  private async outcomeFor(id: string): Promise<SubmitOutcome> {
    const row = await this.db.query.bridgeCommands.findFirst({ where: eq(bridgeCommands.id, id) });
    if (!row) return { status: "UNKNOWN", reason: "bridge command missing" };
    const r = row.result as unknown as BridgeResult | null;
    if (row.status === "DONE" && r)
      return {
        status: "ACCEPTED",
        orderId: r.orderTicket ?? undefined,
        positionId: r.positionTicket ?? undefined,
        filled: row.command.kind === "OPEN_MARKET" || row.command.kind === "CLOSE_POSITION" ? r.fillPrice !== null : undefined,
        fillPrice: r.fillPrice ?? undefined,
        filledVolume: r.filledVolume ?? undefined,
      };
    if (row.status === "FAILED" && r) {
      this.stats.lastError = `${r.retcode}: ${r.message}`;
      this.stats.lastErrorAt = Date.now();
      return { status: "REJECTED", reason: `${this.platform} retcode ${r.retcode}: ${r.message}`, retryable: retcodeRetryable(this.platform, r.retcode) };
    }
    if (row.status === "PENDING") {
      // Never delivered: withdraw it atomically so the EA cannot pick it up later.
      const withdrawn = await this.db
        .update(bridgeCommands)
        .set({ status: "EXPIRED", completedAt: new Date() })
        .where(and(eq(bridgeCommands.id, id), eq(bridgeCommands.status, "PENDING")))
        .returning({ id: bridgeCommands.id });
      if (withdrawn.length) return { status: "REJECTED", reason: "bridge did not collect the command in time (withdrawn, not executed)", retryable: true };
      return this.outcomeFor(id);
    }
    if (row.status === "EXPIRED") return { status: "REJECTED", reason: "bridge command expired before delivery", retryable: true };
    return { status: "UNKNOWN", reason: "bridge received the command but has not reported a result" };
  }

  async reconcile(cmd: ExecutionCommand, _sinceMs: number): Promise<ReconcileResult> {
    const row = await this.db.query.bridgeCommands.findFirst({ where: eq(bridgeCommands.clientId, cmd.clientId) });
    if (!row) return { found: false, conclusive: true, detail: "command never queued" };
    const r = row.result as unknown as BridgeResult | null;
    if (row.status === "DONE" && r)
      return { found: true, conclusive: true, orderId: r.orderTicket ?? undefined, positionId: r.positionTicket ?? undefined, filled: r.fillPrice !== null, fillPrice: r.fillPrice ?? undefined, filledVolume: r.filledVolume ?? undefined };
    if (row.status === "FAILED" || row.status === "EXPIRED") return { found: false, conclusive: true, detail: `bridge command ${row.status}` };
    // DELIVERED without result: look for the tag in the terminal's current state.
    const s = this.hub.state(this.accountId);
    if (s && Date.now() - s.receivedAt < 10_000) {
      const pos = s.snapshot.positions.find((p) => p.tag === cmd.tag);
      if (pos && (cmd.kind === "OPEN_MARKET")) return { found: true, conclusive: true, positionId: pos.id, filled: true, fillPrice: pos.openPrice, filledVolume: pos.volume };
      const ord = s.snapshot.orders.find((o) => o.tag === cmd.tag);
      if (ord && cmd.kind === "PLACE_PENDING") return { found: true, conclusive: true, orderId: ord.id, filled: false };
    }
    return { found: false, conclusive: false, detail: "bridge delivered the command; result not yet reported" };
  }
}

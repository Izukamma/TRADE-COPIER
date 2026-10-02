import type { ExecutionCommand, InstrumentSpec, PlatformCapabilities, Quote, ReconcileResult, SubmitOutcome, TradingSnapshot } from "@gtc/shared";
import type { AdapterHealth, PlatformAdapter } from "../types";
import { SimBroker } from "./broker";

export const SIMULATOR_CAPABILITIES: PlatformCapabilities = {
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
  integrationStatus: "SIMULATED",
  notes: ["In-process simulator. No broker connection; prices are a random walk."],
};

export class SimulatorAdapter implements PlatformAdapter {
  readonly platform = "SIMULATOR" as const;
  readonly capabilities = SIMULATOR_CAPABILITIES;
  private connected = false;
  private stats = { requests: 0, lastOkAt: null as number | null };

  constructor(
    public readonly broker: SimBroker,
    private pollIntervalMs = 500,
  ) {}

  async connect() {
    this.connected = true;
    this.stats.lastOkAt = Date.now();
  }
  async disconnect() {
    this.connected = false;
  }
  health(): AdapterHealth {
    return {
      connected: this.connected,
      lastOkAt: this.stats.lastOkAt,
      lastError: null,
      lastErrorAt: null,
      reconnects: 0,
      tokenRefreshes: 0,
      rateLimited: 0,
      requests: this.stats.requests,
      avgLatencyMs: this.broker.state.faults.latencyMs,
      detection: { mode: "poll", intervalMs: this.pollIntervalMs },
      rateLimits: [],
    };
  }
  private touch() {
    if (!this.connected) throw new Error("simulator adapter not connected");
    this.stats.requests++;
    this.stats.lastOkAt = Date.now();
  }
  async getSnapshot(): Promise<TradingSnapshot> {
    this.touch();
    return this.broker.snapshot();
  }
  async getInstruments(symbols?: string[]): Promise<InstrumentSpec[]> {
    this.touch();
    return (symbols ?? this.broker.symbols()).filter((s) => this.broker.symbols().includes(s)).map((s) => this.broker.spec(s));
  }
  async listSymbols(): Promise<string[]> {
    this.touch();
    return this.broker.symbols();
  }
  async getQuote(symbol: string): Promise<Quote> {
    this.touch();
    return this.broker.quote(symbol);
  }
  async submit(cmd: ExecutionCommand): Promise<SubmitOutcome> {
    this.touch();
    return this.broker.execute(cmd);
  }
  async reconcile(cmd: ExecutionCommand, sinceMs: number): Promise<ReconcileResult> {
    this.touch();
    return this.broker.reconcile(cmd, sinceMs);
  }
}

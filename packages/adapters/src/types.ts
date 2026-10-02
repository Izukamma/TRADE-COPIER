import type {
  ExecutionCommand,
  InstrumentSpec,
  Platform,
  PlatformCapabilities,
  Quote,
  ReconcileResult,
  SubmitOutcome,
  TradingSnapshot,
} from "@gtc/shared";

export interface AdapterHealth {
  connected: boolean;
  lastOkAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  reconnects: number;
  tokenRefreshes: number;
  rateLimited: number;
  requests: number;
  /** Average REST round-trip in ms (rolling). */
  avgLatencyMs: number | null;
  /** Detection mode and the expected worst-case detection delay. */
  detection: { mode: "push" | "poll" | "bridge"; intervalMs: number };
  rateLimits: { name: string; limit: number; windowMs: number; used: number }[];
}

/**
 * Consistent interface across MT4, MT5, TradeLocker, Match-Trader and the simulator.
 * Implementations must never place an order from read methods, must not retry
 * non-idempotent submissions internally, and must report ambiguous outcomes as UNKNOWN.
 */
export interface PlatformAdapter {
  readonly platform: Platform | "SIMULATOR";
  readonly capabilities: PlatformCapabilities;
  /** Authenticate (or verify a bridge is connected). Throws AdapterError. */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  health(): AdapterHealth;
  /** Account state + open positions + pending orders, read-only. */
  getSnapshot(): Promise<TradingSnapshot>;
  /** Instrument specs. `symbols` limits the fetch where the platform requires per-symbol calls. */
  getInstruments(symbols?: string[]): Promise<InstrumentSpec[]>;
  /** Names of tradable symbols (cheap; used for mapping suggestions). */
  listSymbols(): Promise<string[]>;
  getQuote(symbol: string): Promise<Quote>;
  submit(cmd: ExecutionCommand): Promise<SubmitOutcome>;
  /** Establish whether `cmd` reached the platform, using its tag/client id and order history. */
  reconcile(cmd: ExecutionCommand, sinceMs: number): Promise<ReconcileResult>;
}

export type AdapterErrorKind = "AUTH" | "NETWORK" | "RATE_LIMIT" | "PROTOCOL" | "NOT_SUPPORTED" | "NOT_VERIFIED" | "REJECTED";

export class AdapterError extends Error {
  constructor(
    public kind: AdapterErrorKind,
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

/**
 * Core domain types shared by the dashboard, the engine and the adapters.
 * Prices are plain numbers (IEEE doubles) rounded to instrument digits at the edges;
 * volumes are handled through the integer-step helpers in ./volume.ts.
 */

export const PLATFORMS = ["MT4", "MT5", "TRADELOCKER", "MATCHTRADER"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** SIMULATION never touches a broker. DEMO and LIVE use real platform connectivity. */
export const ENVIRONMENTS = ["SIMULATION", "DEMO", "LIVE"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const ACCOUNT_CLASSES = ["PERSONAL", "EVALUATION", "FUNDED"] as const;
export type AccountClass = (typeof ACCOUNT_CLASSES)[number];

export type Side = "BUY" | "SELL";
export type OrderKind = "MARKET" | "LIMIT" | "STOP";

/** How positions are accounted on the account. MT5 can be either; MT4 is always hedging. */
export type PositionAccounting = "HEDGING" | "NETTING" | "UNKNOWN";

export type ConnectionStatus =
  | "NOT_CONFIGURED"
  | "CONNECTING"
  | "CONNECTED"
  | "DEGRADED"
  | "DISCONNECTED"
  | "AUTH_FAILED"
  | "AWAITING_BRIDGE";

export interface PlatformCapabilities {
  canBeMaster: boolean;
  canBeFollower: boolean;
  marketOrders: boolean;
  pendingLimit: boolean;
  pendingStop: boolean;
  modifyPositionSlTp: boolean;
  modifyPendingOrder: boolean;
  partialClose: boolean;
  /** true when the platform lets us tag orders (comment / strategyId / magic). */
  orderTagging: boolean;
  /** "push" = official event stream, "poll" = REST polling, "bridge" = EA pushes. */
  masterDetection: "push" | "poll" | "bridge";
  /** Integration state for honesty in the dashboard. */
  integrationStatus: "IMPLEMENTED_UNVERIFIED" | "VERIFIED_DEMO" | "SIMULATED" | "AWAITING_ACCESS";
  notes: string[];
}

export interface AccountSnapshot {
  balance: number;
  equity: number;
  currency: string;
  freeMargin: number | null;
  marginUsed: number | null;
  accounting: PositionAccounting;
  serverTime: number | null;
  fetchedAt: number;
}

export interface InstrumentSpec {
  symbol: string;
  /** Platform-native instrument id when different from the symbol (TradeLocker tradableInstrumentId). */
  platformId?: string;
  description?: string;
  digits: number;
  tickSize: number;
  /** Value of one tick move for one lot, in tickValueCurrency. */
  tickValue: number | null;
  tickValueCurrency: string | null;
  contractSize: number | null;
  baseCurrency?: string | null;
  quoteCurrency?: string | null;
  profitCurrency?: string | null;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  /** Minimum SL/TP distance from current price, in price units (0 = none). */
  stopsDistance: number;
  /** Pending order freeze distance, in price units. */
  freezeDistance?: number;
  orderKinds: OrderKind[];
  tradable: boolean;
  /** Fields the platform did not return; risk sizing refuses instruments with gaps it needs. */
  missingFields: string[];
  /** Margin required for 1 lot in account currency, when the platform reports it. */
  marginPerLot?: number | null;
  /** "PLATFORM" when synchronised, "MANUAL" when the owner entered/confirmed an override. */
  source?: "PLATFORM" | "MANUAL";
  fetchedAt: number;
}

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  time: number;
}

export interface Position {
  /** Platform position identifier (MT ticket, TL positionId, MTR position id). */
  id: string;
  symbol: string;
  side: Side;
  volume: number;
  openPrice: number;
  openTime: number;
  sl: number | null;
  tp: number | null;
  /** Comment / strategyId / tag returned by the platform, used to recognise copier trades. */
  tag: string | null;
  magic?: number | null;
  /** Originating order id when known (needed to connect fills of pending orders). */
  orderId?: string | null;
  /** MT4: ticket this position replaced after a partial close (remainder gets a new ticket). */
  replacesId?: string | null;
  profit?: number | null;
}

export interface PendingOrder {
  id: string;
  symbol: string;
  side: Side;
  kind: Exclude<OrderKind, "MARKET">;
  volume: number;
  price: number;
  sl: number | null;
  tp: number | null;
  createdTime: number;
  tag: string | null;
  magic?: number | null;
}

export interface TradingSnapshot {
  account: AccountSnapshot;
  positions: Position[];
  orders: PendingOrder[];
}

/** Master events detected by the engine (or pushed by a bridge). */
export type MasterEventType =
  | "POSITION_OPENED"
  | "POSITION_INCREASED"
  | "POSITION_MODIFIED"
  | "POSITION_PARTIALLY_CLOSED"
  | "POSITION_CLOSED"
  | "ORDER_PLACED"
  | "ORDER_MODIFIED"
  | "ORDER_CANCELLED"
  | "ORDER_FILLED";

export interface MasterEventPayload {
  type: MasterEventType;
  /**
   * Stable identity of the master trade across its lifetime: the originating pending order id
   * when the position came from a copied pending order, otherwise the position id.
   */
  masterKey: string;
  positionId?: string;
  orderId?: string;
  symbol: string;
  side: Side;
  kind?: OrderKind;
  /** Volume of the master position/order after the event. */
  volume: number;
  /** Volume before the event (for partial closes and increases). */
  previousVolume?: number;
  price?: number;
  sl: number | null;
  tp: number | null;
  /** Master open/placement time (platform clock, ms). */
  openTime: number;
  tag: string | null;
  magic?: number | null;
}

/** Execution state machine states (see ./state-machine.ts). */
export const EXEC_STATES = [
  "DETECTED",
  "QUEUED",
  "SUBMITTED",
  "ACCEPTED",
  "FILLED",
  "REJECTED",
  "SKIPPED",
  "UNKNOWN",
  "RECONCILED",
  "NEEDS_ATTENTION",
] as const;
export type ExecState = (typeof EXEC_STATES)[number];

export type CommandKind =
  | "OPEN_MARKET"
  | "PLACE_PENDING"
  | "MODIFY_POSITION"
  | "MODIFY_PENDING"
  | "CLOSE_POSITION"
  | "CANCEL_PENDING";

/** A deterministic instruction sent to a follower adapter. */
export interface ExecutionCommand {
  kind: CommandKind;
  /** Unique id for idempotency/reconciliation; embedded in the order tag when possible. */
  clientId: string;
  symbol: string;
  side?: Side;
  volume?: number;
  price?: number;
  sl?: number | null;
  tp?: number | null;
  positionId?: string;
  orderId?: string;
  pendingKind?: Exclude<OrderKind, "MARKET">;
  /** Tag to attach on the follower: comment / strategyId. */
  tag: string;
  magic?: number;
}

export type SubmitOutcome =
  | { status: "ACCEPTED"; orderId?: string; positionId?: string; filled?: boolean; fillPrice?: number; filledVolume?: number; raw?: unknown }
  | { status: "REJECTED"; reason: string; retryable: boolean; raw?: unknown }
  /** Transport failed after the request may have reached the platform. Must reconcile before retrying. */
  | { status: "UNKNOWN"; reason: string };

export interface ReconcileResult {
  found: boolean;
  orderId?: string;
  positionId?: string;
  filled?: boolean;
  fillPrice?: number;
  filledVolume?: number;
  /** false when the platform cannot answer reliably (e.g. no tag support and ambiguous matches). */
  conclusive: boolean;
  detail?: string;
}

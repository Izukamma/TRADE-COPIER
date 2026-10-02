import { z } from "zod";
import { ACCOUNT_CLASSES, ENVIRONMENTS, PLATFORMS } from "./types";

const symbolName = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._#\-+/!$]+$/, "invalid symbol");

export const sizingSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("FIXED"), lots: z.number().positive().max(1000) }),
  z.object({
    mode: z.literal("MULTIPLIER"),
    multiplier: z.number().positive().max(100),
    /**
     * When true (default) the multiplier is applied to the master's money-per-point exposure
     * and converted to follower lots using both contract specifications. When false it is
     * a raw lot multiplier, only allowed when both instruments report identical specs.
     */
    normalizeContracts: z.boolean().default(true),
  }),
  z.object({
    mode: z.literal("EQUITY_PROPORTIONAL"),
    /** Additional factor on top of follower/master equity ratio. */
    factor: z.number().positive().max(100).default(1),
  }),
  z.object({
    mode: z.literal("RISK_PERCENT"),
    /** Percent of follower equity risked between entry and stop loss. */
    riskPercent: z.number().positive().max(10),
    basis: z.enum(["EQUITY", "BALANCE"]).default("EQUITY"),
  }),
]);
export type SizingConfig = z.infer<typeof sizingSchema>;

export const slTpPolicySchema = z.enum([
  /** Copy master SL/TP as absolute prices (after symbol price offset = none). */
  "ABSOLUTE_PRICE",
  /** Copy SL/TP as a distance from the master entry, re-applied to the follower entry/fill. */
  "DISTANCE_FROM_ENTRY",
  /** Do not copy this level. */
  "NONE",
]);
export type SlTpPolicy = z.infer<typeof slTpPolicySchema>;

export const followerSettingsSchema = z.object({
  sizing: sizingSchema,
  /** Hard cap on a single copied order, in follower lots. */
  maxOrderLots: z.number().positive().max(1000),
  /** Cap on total copier-managed exposure for this route, in follower lots, across all symbols. */
  maxExposureLots: z.number().positive().max(10000),
  maxOpenPositions: z.number().int().positive().max(500),
  /** Empty = all mapped symbols. Values are master symbols. */
  allowedSymbols: z.array(symbolName).max(500).default([]),
  allowedDirections: z.enum(["BOTH", "BUY_ONLY", "SELL_ONLY"]).default("BOTH"),
  copyMarketOrders: z.boolean().default(true),
  copyPendingOrders: z.boolean().default(false),
  copySl: slTpPolicySchema.default("ABSOLUTE_PRICE"),
  copyTp: slTpPolicySchema.default("ABSOLUTE_PRICE"),
  copyModifications: z.boolean().default(true),
  copyCancellations: z.boolean().default(true),
  copyPartialCloses: z.boolean().default(true),
  copyFullCloses: z.boolean().default(true),
  /** Reject entries whose master open time is older than this. */
  maxEntryAgeSeconds: z.number().int().min(1).max(3600).default(30),
  /**
   * Reject when the follower quote deviates from the master fill by more than this many follower
   * ticks. null disables the check (required for followers without a quotes endpoint).
   */
  maxEntryDeviationPoints: z.number().min(0).max(10_000_000).nullable().default(5000),
  /** Which master trades to copy. */
  sourceFilter: z
    .object({
      manual: z.boolean().default(true),
      /** Copy EA trades only for these magic numbers (MT only). Empty = none. */
      eaMagics: z.array(z.number().int().min(1)).max(100).default([]),
    })
    .default({ manual: true, eaMagics: [] }),
  requireStopLoss: z.boolean().default(false),
  partialCloseRemainder: z.enum(["CLOSE_ALL", "KEEP_MIN"]).default("CLOSE_ALL"),
  /** Behaviour when a copied follower position disappears while the master is still open. */
  divergencePolicy: z.enum(["FLAG_ONLY", "FLAG_AND_DETACH"]).default("FLAG_ONLY"),
  /** Explicit opt-in: copy master positions that already exist when the route starts. */
  copyExistingOnStart: z.boolean().default(false),
  /** MT5 netting followers: explicit acknowledgement that symbols are exclusive to the copier. */
  nettingExclusiveSymbols: z.boolean().default(false),
  marginSafetyFactor: z.number().min(1).max(10).default(1.5),
});
export type FollowerSettings = z.infer<typeof followerSettingsSchema>;

export const defaultFollowerSettings = (): FollowerSettings =>
  followerSettingsSchema.parse({
    sizing: { mode: "FIXED", lots: 0.01 },
    maxOrderLots: 1,
    maxExposureLots: 5,
    maxOpenPositions: 10,
  });

export const dailyLossSchema = z.object({
  enabled: z.boolean().default(false),
  /** IANA zone used to determine the trading-day boundary. */
  resetTimezone: z.string().min(1).max(64).default("UTC"),
  /** Local reset time HH:MM. */
  resetTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("00:00"),
  basis: z.enum(["BALANCE", "EQUITY"]).default("EQUITY"),
  /** Whether floating P&L counts toward the loss when basis = BALANCE. */
  includeFloating: z.boolean().default(true),
  baseline: z.enum(["START_BALANCE", "START_EQUITY", "HIGHER_OF_BALANCE_EQUITY"]).default("HIGHER_OF_BALANCE_EQUITY"),
  limitType: z.enum(["AMOUNT", "PERCENT"]).default("PERCENT"),
  limitValue: z.number().positive().max(1_000_000).default(4),
  onLimit: z.enum(["PAUSE_ENTRIES", "PAUSE_ENTRIES_AND_CLOSE_COPIER_POSITIONS"]).default("PAUSE_ENTRIES"),
});
export type DailyLossConfig = z.infer<typeof dailyLossSchema>;

export const accountRiskSchema = z.object({
  dailyLoss: dailyLossSchema.default(dailyLossSchema.parse({})),
  /** Max copier-managed lots open on this follower account (all routes). */
  maxAccountExposureLots: z.number().positive().max(100000).default(20),
  /** Minimum free margin ratio after the order (free margin / required margin). */
  minFreeMarginAfterOrder: z.number().min(0).default(0),
  /** Account data older than this is stale: entries blocked. */
  staleAccountSeconds: z.number().int().min(5).max(3600).default(60),
  staleQuoteSeconds: z.number().int().min(1).max(3600).default(30),
});
export type AccountRiskConfig = z.infer<typeof accountRiskSchema>;

export const accountCreateSchema = z.object({
  nickname: z.string().trim().min(1).max(80),
  platform: z.enum(PLATFORMS),
  environment: z.enum(ENVIRONMENTS),
  accountClass: z.enum(ACCOUNT_CLASSES),
  brokerName: z.string().trim().min(1).max(120),
  /** Platform account identifier (login / accNum / tradingAccountId). Not a secret. */
  externalAccountId: z.string().trim().min(1).max(64),
  /** Platform server / brand / broker id, if required. */
  server: z.string().trim().max(200).optional(),
  /** Base URL for API platforms (e.g. https://demo.tradelocker.com, Match-Trader platform URL). */
  apiBaseUrl: z
    .string()
    .trim()
    .url()
    .refine((u) => u.startsWith("https://"), "must be https")
    .optional(),
});
export type AccountCreateInput = z.infer<typeof accountCreateSchema>;

/** Credentials are submitted once from the dashboard, encrypted server-side, never returned. */
export const apiCredentialSchema = z.object({
  login: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(500),
  /** Match-Trader broker id when required. */
  brokerId: z.string().trim().max(100).optional(),
});

export const symbolMappingSchema = z.object({
  masterAccountId: z.string().uuid(),
  followerAccountId: z.string().uuid(),
  masterSymbol: symbolName,
  followerSymbol: symbolName,
});

export const groupCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  masterAccountId: z.string().uuid(),
});

export const pauseScopeSchema = z.enum(["GLOBAL", "GROUP", "ROUTE"]);

/* --------------------------- MetaTrader bridge protocol --------------------------- */

const num = z.number().finite();
export const bridgeSymbolSchema = z.object({
  symbol: symbolName,
  description: z.string().max(200).optional(),
  digits: z.number().int().min(0).max(10),
  tickSize: num.positive(),
  tickValue: num.nonnegative(),
  contractSize: num.positive(),
  profitCurrency: z.string().max(10).optional(),
  baseCurrency: z.string().max(10).optional(),
  volumeMin: num.positive(),
  volumeMax: num.positive(),
  volumeStep: num.positive(),
  stopsLevelPoints: z.number().int().min(0),
  freezeLevelPoints: z.number().int().min(0).default(0),
  tradeAllowed: z.boolean(),
  /** Margin for 1 lot in account currency (OrderCalcMargin / MODE_MARGINREQUIRED). */
  marginPerLot: num.nonnegative().optional(),
  bid: num.nonnegative().optional(),
  ask: num.nonnegative().optional(),
  quoteTime: z.number().int().optional(),
});

export const bridgePositionSchema = z.object({
  ticket: z.string().min(1).max(32),
  symbol: symbolName,
  side: z.enum(["BUY", "SELL"]),
  volume: num.positive(),
  openPrice: num,
  openTime: z.number().int(),
  sl: num.nullable(),
  tp: num.nullable(),
  comment: z.string().max(64).nullable(),
  magic: z.number().int().nullable(),
  profit: num.nullable().optional(),
  orderTicket: z.string().max(32).nullable().optional(),
});

export const bridgeOrderSchema = z.object({
  ticket: z.string().min(1).max(32),
  symbol: symbolName,
  side: z.enum(["BUY", "SELL"]),
  kind: z.enum(["LIMIT", "STOP"]),
  volume: num.positive(),
  price: num,
  sl: num.nullable(),
  tp: num.nullable(),
  createdTime: z.number().int(),
  comment: z.string().max(64).nullable(),
  magic: z.number().int().nullable(),
});

export const bridgeSyncSchema = z.object({
  protocol: z.literal(1),
  platform: z.enum(["MT4", "MT5"]),
  login: z.string().min(1).max(32),
  server: z.string().max(128),
  eaVersion: z.string().max(32),
  terminalConnected: z.boolean(),
  tradeAllowed: z.boolean(),
  accounting: z.enum(["HEDGING", "NETTING"]),
  account: z.object({
    balance: num,
    equity: num,
    currency: z.string().min(3).max(10),
    freeMargin: num,
    margin: num,
  }),
  serverTime: z.number().int(),
  positions: z.array(bridgePositionSchema).max(1000),
  orders: z.array(bridgeOrderSchema).max(1000),
  /** Quotes for the watch list the engine returned in its last response. */
  quotes: z
    .array(z.object({ symbol: symbolName, bid: num, ask: num, time: z.number().int() }))
    .max(500)
    .default([]),
  /** Optional: include on first sync and when the watch list changes. */
  symbols: z.array(bridgeSymbolSchema).max(2000).optional(),
  /** Results of commands executed since the last sync. */
  results: z
    .array(
      z.object({
        commandId: z.string().min(1).max(64),
        ok: z.boolean(),
        retcode: z.number().int(),
        message: z.string().max(256),
        orderTicket: z.string().max(32).nullable(),
        positionTicket: z.string().max(32).nullable(),
        fillPrice: num.nullable(),
        filledVolume: num.nullable(),
        executedAt: z.number().int(),
      }),
    )
    .max(200)
    .default([]),
});
export type BridgeSync = z.infer<typeof bridgeSyncSchema>;

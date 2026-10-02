import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  AccountRiskConfig,
  ExecState,
  ExecutionCommand,
  FollowerSettings,
  InstrumentSpec,
  MappingCheck,
  MasterEventPayload,
  PlatformCapabilities,
  TradingSnapshot,
} from "@gtc/shared";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const created = () => ts("created_at").notNull().defaultNow();
const updated = () => ts("updated_at").notNull().defaultNow();

/* ----------------------------- Authentication (Better Auth) ----------------------------- */

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  twoFactorEnabled: boolean("two_factor_enabled").default(false),
  createdAt: created(),
  updatedAt: updated(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: ts("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: created(),
  updatedAt: updated(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const authAccount = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: ts("access_token_expires_at"),
  refreshTokenExpiresAt: ts("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: created(),
  updatedAt: updated(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: ts("expires_at").notNull(),
  createdAt: created(),
  updatedAt: updated(),
});

export const twoFactor = pgTable("two_factor", {
  id: text("id").primaryKey(),
  secret: text("secret").notNull(),
  backupCodes: text("backup_codes").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

/* ------------------------------------ Trading accounts ------------------------------------ */

export const tradingAccounts = pgTable(
  "trading_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nickname: text("nickname").notNull(),
    platform: text("platform").$type<"MT4" | "MT5" | "TRADELOCKER" | "MATCHTRADER">().notNull(),
    environment: text("environment").$type<"SIMULATION" | "DEMO" | "LIVE">().notNull(),
    accountClass: text("account_class").$type<"PERSONAL" | "EVALUATION" | "FUNDED">().notNull(),
    brokerName: text("broker_name").notNull(),
    externalAccountId: text("external_account_id").notNull(),
    server: text("server"),
    apiBaseUrl: text("api_base_url"),
    /** AES-GCM encrypted JSON credentials (API platforms only). Never selected by the dashboard. */
    credentialsEnc: text("credentials_enc"),
    /** AES-GCM encrypted session tokens cached by the engine. */
    sessionEnc: text("session_enc"),
    currency: text("currency"),
    balance: doublePrecision("balance"),
    equity: doublePrecision("equity"),
    freeMargin: doublePrecision("free_margin"),
    marginUsed: doublePrecision("margin_used"),
    accounting: text("accounting").$type<"HEDGING" | "NETTING" | "UNKNOWN">().notNull().default("UNKNOWN"),
    lastSyncAt: ts("last_sync_at"),
    connectionStatus: text("connection_status").notNull().default("NOT_CONFIGURED"),
    statusDetail: text("status_detail"),
    capabilities: jsonb("capabilities").$type<PlatformCapabilities>(),
    riskConfig: jsonb("risk_config").$type<AccountRiskConfig>().notNull(),
    /** LIVE follower accounts need this AND LIVE_TRADING_ENABLED=true in the engine environment. */
    liveExecutionArmed: boolean("live_execution_armed").notNull().default(false),
    entriesPaused: boolean("entries_paused").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("trading_accounts_identity").on(t.platform, t.environment, t.server, t.externalAccountId)],
);

export const deviceTokens = pgTable("device_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => tradingAccounts.id, { onDelete: "cascade" }),
  tokenId: text("token_id").notNull().unique(),
  secretEnc: text("secret_enc").notNull(),
  label: text("label").notNull(),
  scope: text("scope").notNull().default("bridge:account"),
  createdAt: created(),
  lastUsedAt: ts("last_used_at"),
  lastIp: text("last_ip"),
  revokedAt: ts("revoked_at"),
});

export const bridgeNonces = pgTable(
  "bridge_nonces",
  {
    tokenId: text("token_id").notNull(),
    nonce: text("nonce").notNull(),
    seenAt: created(),
  },
  (t) => [primaryKey({ columns: [t.tokenId, t.nonce] }), index("bridge_nonces_seen").on(t.seenAt)],
);

export const instruments = pgTable(
  "instruments",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => tradingAccounts.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    spec: jsonb("spec").$type<InstrumentSpec>().notNull(),
    bid: doublePrecision("bid"),
    ask: doublePrecision("ask"),
    quoteTime: ts("quote_time"),
    updatedAt: updated(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.symbol] })],
);

/* ------------------------------------ Groups & routes ------------------------------------ */

export const copierGroups = pgTable("copier_groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  masterAccountId: uuid("master_account_id")
    .notNull()
    .references(() => tradingAccounts.id, { onDelete: "restrict" }),
  entriesPaused: boolean("entries_paused").notNull().default(false),
  createdAt: created(),
  updatedAt: updated(),
});

export const routes = pgTable(
  "routes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => copierGroups.id, { onDelete: "cascade" }),
    followerAccountId: uuid("follower_account_id")
      .notNull()
      .references(() => tradingAccounts.id, { onDelete: "restrict" }),
    settings: jsonb("settings").$type<FollowerSettings>().notNull(),
    active: boolean("active").notNull().default(false),
    entriesPaused: boolean("entries_paused").notNull().default(false),
    /** Set when the owner previewed sizing for the current settings. Activation requires it. */
    previewedAt: ts("previewed_at"),
    settingsVersion: integer("settings_version").notNull().default(1),
    previewedVersion: integer("previewed_version"),
    activatedAt: ts("activated_at"),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("routes_group_follower").on(t.groupId, t.followerAccountId)],
);

export const symbolMappings = pgTable(
  "symbol_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    masterAccountId: uuid("master_account_id")
      .notNull()
      .references(() => tradingAccounts.id, { onDelete: "cascade" }),
    followerAccountId: uuid("follower_account_id")
      .notNull()
      .references(() => tradingAccounts.id, { onDelete: "cascade" }),
    masterSymbol: text("master_symbol").notNull(),
    followerSymbol: text("follower_symbol").notNull(),
    status: text("status").$type<"SUGGESTED" | "CONFIRMED" | "DISABLED">().notNull().default("SUGGESTED"),
    checks: jsonb("checks").$type<MappingCheck[]>().notNull().default([]),
    confirmedAt: ts("confirmed_at"),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("symbol_mappings_pair").on(t.masterAccountId, t.followerAccountId, t.masterSymbol)],
);

/* ------------------------------------ Events & execution ------------------------------------ */

export const masterSnapshots = pgTable("master_snapshots", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => tradingAccounts.id, { onDelete: "cascade" }),
  snapshot: jsonb("snapshot").$type<TradingSnapshot>().notNull(),
  /** Positions present when watching started; never copied unless a route opts in. */
  baselineIds: jsonb("baseline_ids").$type<string[]>().notNull().default([]),
  baselineTakenAt: ts("baseline_taken_at").notNull().defaultNow(),
  updatedAt: updated(),
});

export const masterEvents = pgTable(
  "master_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => tradingAccounts.id, { onDelete: "cascade" }),
    eventKey: text("event_key").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<MasterEventPayload>().notNull(),
    source: text("source").$type<"POLL" | "STREAM" | "BRIDGE" | "SIMULATION">().notNull(),
    platformTime: ts("platform_time"),
    detectedAt: ts("detected_at").notNull().defaultNow(),
    routedAt: ts("routed_at"),
  },
  (t) => [
    uniqueIndex("master_events_dedup").on(t.accountId, t.eventKey),
    index("master_events_unrouted").on(t.routedAt).where(sql`routed_at is null`),
  ],
);

export const executionJobs = pgTable(
  "execution_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    masterEventId: uuid("master_event_id")
      .notNull()
      .references(() => masterEvents.id, { onDelete: "cascade" }),
    routeId: uuid("route_id")
      .notNull()
      .references(() => routes.id, { onDelete: "cascade" }),
    followerAccountId: uuid("follower_account_id")
      .notNull()
      .references(() => tradingAccounts.id, { onDelete: "cascade" }),
    /** Jobs sharing a key run strictly in `seq` order (route + master position/order). */
    orderingKey: text("ordering_key").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    eventType: text("event_type").notNull(),
    state: text("state").$type<ExecState>().notNull(),
    clientId: text("client_id").notNull().unique(),
    command: jsonb("command").$type<ExecutionCommand>(),
    attempts: integer("attempts").notNull().default(0),
    reconcileAttempts: integer("reconcile_attempts").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
    lockedBy: text("locked_by"),
    lockedUntil: ts("locked_until"),
    reason: text("reason"),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    followerOrderId: text("follower_order_id"),
    followerPositionId: text("follower_position_id"),
    requestedVolume: doublePrecision("requested_volume"),
    filledVolume: doublePrecision("filled_volume"),
    masterPrice: doublePrecision("master_price"),
    fillPrice: doublePrecision("fill_price"),
    priceDiffPoints: doublePrecision("price_diff_points"),
    masterTime: ts("master_time"),
    detectedAt: ts("detected_at"),
    queuedAt: ts("queued_at"),
    submittedAt: ts("submitted_at"),
    acceptedAt: ts("accepted_at"),
    filledAt: ts("filled_at"),
    finishedAt: ts("finished_at"),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex("execution_jobs_event_route").on(t.masterEventId, t.routeId),
    index("execution_jobs_claim").on(t.state, t.nextAttemptAt),
    index("execution_jobs_ordering").on(t.orderingKey, t.seq),
  ],
);

export const jobTransitions = pgTable(
  "job_transitions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => executionJobs.id, { onDelete: "cascade" }),
    fromState: text("from_state"),
    toState: text("to_state").notNull(),
    detail: text("detail"),
    at: created(),
  },
  (t) => [index("job_transitions_job").on(t.jobId)],
);

export const copyLinks = pgTable(
  "copy_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    routeId: uuid("route_id")
      .notNull()
      .references(() => routes.id, { onDelete: "cascade" }),
    masterAccountId: uuid("master_account_id").notNull(),
    followerAccountId: uuid("follower_account_id").notNull(),
    /** Master position id; for pending copies the master order id until it fills. */
    masterKey: text("master_key").notNull(),
    masterPositionId: text("master_position_id"),
    masterOrderId: text("master_order_id"),
    followerPositionId: text("follower_position_id"),
    followerOrderId: text("follower_order_id"),
    clientId: text("client_id").notNull(),
    masterSymbol: text("master_symbol").notNull(),
    followerSymbol: text("follower_symbol").notNull(),
    side: text("side").$type<"BUY" | "SELL">().notNull(),
    masterVolumeInitial: doublePrecision("master_volume_initial").notNull(),
    masterVolumeCurrent: doublePrecision("master_volume_current").notNull(),
    followerVolumeInitial: doublePrecision("follower_volume_initial").notNull(),
    followerVolumeCurrent: doublePrecision("follower_volume_current").notNull(),
    masterOpenPrice: doublePrecision("master_open_price"),
    followerOpenPrice: doublePrecision("follower_open_price"),
    status: text("status")
      .$type<"PENDING_ORDER" | "OPENING" | "OPEN" | "CLOSED" | "CANCELLED" | "DIVERGED" | "DETACHED" | "FAILED">()
      .notNull(),
    statusDetail: text("status_detail"),
    realizedPnl: doublePrecision("realized_pnl"),
    openedAt: ts("opened_at"),
    closedAt: ts("closed_at"),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex("copy_links_route_master").on(t.routeId, t.masterKey),
    index("copy_links_follower_pos").on(t.followerAccountId, t.followerPositionId),
  ],
);

/** Durable outbox for MetaTrader bridges (the EA pulls these). */
export const bridgeCommands = pgTable(
  "bridge_commands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => tradingAccounts.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull().unique(),
    command: jsonb("command").$type<ExecutionCommand>().notNull(),
    status: text("status").$type<"PENDING" | "DELIVERED" | "DONE" | "FAILED" | "EXPIRED">().notNull().default("PENDING"),
    deliveries: integer("deliveries").notNull().default(0),
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: created(),
    deliveredAt: ts("delivered_at"),
    completedAt: ts("completed_at"),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [index("bridge_commands_pending").on(t.accountId, t.status)],
);

/* ------------------------------------ Risk & control ------------------------------------ */

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updated(),
});

export const dailyBaselines = pgTable(
  "daily_baselines",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => tradingAccounts.id, { onDelete: "cascade" }),
    dayKey: text("day_key").notNull(),
    baseline: doublePrecision("baseline").notNull(),
    balance: doublePrecision("balance").notNull(),
    equity: doublePrecision("equity").notNull(),
    /** true when the first observation came after the reset time (engine was down). */
    late: boolean("late").notNull().default(false),
    breachedAt: ts("breached_at"),
    takenAt: created(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.dayKey] })],
);

export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    severity: text("severity").$type<"INFO" | "WARNING" | "CRITICAL">().notNull(),
    code: text("code").notNull(),
    message: text("message").notNull(),
    accountId: uuid("account_id"),
    routeId: uuid("route_id"),
    jobId: uuid("job_id"),
    dedupKey: text("dedup_key"),
    createdAt: created(),
    acknowledgedAt: ts("acknowledged_at"),
  },
  (t) => [uniqueIndex("alerts_dedup").on(t.dedupKey), index("alerts_open").on(t.acknowledgedAt)],
);

export const controlCommands = pgTable(
  "control_commands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").$type<"PENDING" | "RUNNING" | "DONE" | "FAILED">().notNull().default("PENDING"),
    requestedBy: text("requested_by").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: created(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [index("control_commands_pending").on(t.status, t.createdAt)],
);

/* ------------------------------------ Diagnostics ------------------------------------ */

export const engineHeartbeats = pgTable("engine_heartbeats", {
  instanceId: text("instance_id").primaryKey(),
  startedAt: ts("started_at").notNull(),
  lastBeatAt: ts("last_beat_at").notNull(),
  version: text("version").notNull(),
  liveTradingEnabled: boolean("live_trading_enabled").notNull(),
  stats: jsonb("stats").$type<Record<string, unknown>>().notNull().default({}),
});

export const connectionEvents = pgTable(
  "connection_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    accountId: uuid("account_id").notNull(),
    kind: text("kind").notNull(),
    detail: text("detail"),
    at: created(),
  },
  (t) => [index("connection_events_account").on(t.accountId, t.at)],
);

export const engineLogs = pgTable(
  "engine_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    level: text("level").notNull(),
    component: text("component").notNull(),
    message: text("message").notNull(),
    context: jsonb("context").$type<Record<string, unknown>>(),
    at: created(),
  },
  (t) => [index("engine_logs_at").on(t.at)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    target: text("target"),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    ip: text("ip"),
    at: created(),
  },
  (t) => [index("audit_log_at").on(t.at)],
);

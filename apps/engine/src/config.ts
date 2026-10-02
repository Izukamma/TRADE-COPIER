import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  ENGINE_INSTANCE_ID: z.string().default(`engine-${process.pid}`),
  /** Global kill switch for LIVE follower execution. Defaults to disabled. */
  LIVE_TRADING_ENABLED: bool,
  BRIDGE_HOST: z.string().default("0.0.0.0"),
  BRIDGE_PORT: z.coerce.number().int().default(8787),
  /** Max allowed clock skew for signed bridge requests. */
  BRIDGE_MAX_SKEW_MS: z.coerce.number().int().default(30_000),
  TRADELOCKER_DEVELOPER_API_KEY: z.string().optional(),
  TRADELOCKER_POLL_MS: z.coerce.number().int().min(250).default(1000),
  MATCHTRADER_POLL_MS: z.coerce.number().int().min(500).default(1500),
  MATCHTRADER_REQUESTS_PER_SECOND: z.coerce.number().min(0.1).default(2),
  MATCHTRADER_ENABLE_UNVERIFIED_BODIES: bool,
  MATCHTRADER_PATH_SYMBOLS: z.string().optional(),
  MATCHTRADER_PATH_QUOTES: z.string().optional(),
  MATCHTRADER_PATH_PARTIAL_CLOSE: z.string().optional(),
  MATCHTRADER_PATH_ACTIVE_ORDERS: z.string().optional(),
  SIM_POLL_MS: z.coerce.number().int().min(100).default(500),
  FOLLOWER_REFRESH_MS: z.coerce.number().int().min(100).default(5000),
  EXECUTOR_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  LOG_RETENTION_DAYS: z.coerce.number().int().min(1).default(14),
});

export type EngineConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  const r = schema.safeParse(env);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid engine configuration: ${issues}`);
  }
  return r.data;
}

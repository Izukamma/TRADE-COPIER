import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { appSettings, copierGroups, createDb, routes, runMigrations, symbolMappings, tradingAccounts, type DbHandle } from "@gtc/db";
import { accountRiskSchema, defaultFollowerSettings, followerSettingsSchema } from "@gtc/shared";
import { loadKeyRing } from "@gtc/shared/crypto";
import { loadConfig } from "../../src/config";
import { Engine } from "../../src/engine";
import { nullLogger } from "../../src/logger";

export const TEST_DB = process.env.DATABASE_URL_TEST ?? "postgres://postgres@127.0.0.1:5432/gtc_test";
export const ring = loadKeyRing({ GTC_ENCRYPTION_KEYS: `t1:${randomBytes(32).toString("base64")}`, GTC_ENCRYPTION_ACTIVE_KEY_ID: "t1" } as NodeJS.ProcessEnv);

let migrated = false;
export async function freshDb(): Promise<DbHandle> {
  if (!migrated) {
    await runMigrations(TEST_DB);
    migrated = true;
  }
  const h = createDb(TEST_DB, { max: 10 });
  const tables = (await h.db.execute(sql`select tablename from pg_tables where schemaname='public' and tablename not like '__drizzle%'`)) as unknown as { tablename: string }[];
  await h.db.execute(sql.raw(`truncate ${tables.map((t) => `"${t.tablename}"`).join(", ")} restart identity cascade`));
  return h;
}

export function testConfig(over: Record<string, string> = {}) {
  return loadConfig({ DATABASE_URL: TEST_DB, ENGINE_INSTANCE_ID: `test-${randomBytes(3).toString("hex")}`, SIM_POLL_MS: "100", FOLLOWER_REFRESH_MS: "300", BRIDGE_PORT: "0", ...over } as NodeJS.ProcessEnv);
}

export function startEngine(h: DbHandle, over: Record<string, string> = {}) {
  const e = new Engine(h.db, testConfig(over), ring, nullLogger);
  return e;
}

export async function until<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 15_000, label = "condition"): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${(last as Error).message}` : ""}`);
}

export interface SimSetup {
  master: string;
  follower: string;
  group: string;
  route: string;
}

/** Two SIMULATION accounts with confirmed mappings and an active route. */
export async function seedSim(h: DbHandle, settings: Record<string, unknown> = {}, opts: { followerAccounting?: "HEDGING" | "NETTING" } = {}): Promise<SimSetup> {
  const risk = accountRiskSchema.parse({});
  const [m] = await h.db.insert(tradingAccounts).values({ nickname: "SIM master", platform: "MT5", environment: "SIMULATION", accountClass: "PERSONAL", brokerName: "sim", externalAccountId: "M1", server: "SIM-ALPHA", accounting: "HEDGING", riskConfig: risk }).returning();
  const [f] = await h.db.insert(tradingAccounts).values({ nickname: "SIM follower", platform: "TRADELOCKER", environment: "SIMULATION", accountClass: "EVALUATION", brokerName: "sim", externalAccountId: "F1", server: "SIM-BETA", accounting: opts.followerAccounting ?? "HEDGING", riskConfig: risk }).returning();
  const [g] = await h.db.insert(copierGroups).values({ name: "g", masterAccountId: m!.id }).returning();
  const s = followerSettingsSchema.parse({ ...defaultFollowerSettings(), sizing: { mode: "MULTIPLIER", multiplier: 1, normalizeContracts: true }, maxOrderLots: 5, maxExposureLots: 20, maxEntryDeviationPoints: null, copyPendingOrders: true, ...settings });
  const [r] = await h.db.insert(routes).values({ groupId: g!.id, followerAccountId: f!.id, settings: s, active: true, activatedAt: new Date() }).returning();
  for (const [ms, fs] of [["US30", "DJ30.cash"], ["EURUSD", "EURUSD.r"], ["XAUUSD", "XAUUSD.r"]] as const)
    await h.db.insert(symbolMappings).values({ masterAccountId: m!.id, followerAccountId: f!.id, masterSymbol: ms, followerSymbol: fs, status: "CONFIRMED", confirmedAt: new Date() });
  await h.db.insert(appSettings).values({ key: "fx.manual", value: [{ base: "GBP", quote: "USD", rate: 1.25, time: Date.now() + 3_600_000 }] });
  return { master: m!.id, follower: f!.id, group: g!.id, route: r!.id };
}

/** Waits until the engine has connected both accounts and taken the master baseline. */
export async function ready(e: Engine, s: SimSetup) {
  await until(async () => {
    const m = e.conn.runtimes.get(s.master);
    const f = e.conn.runtimes.get(s.follower);
    return m?.connected && f?.connected && m.snapshot && f.snapshot && f.specs.size > 0 && m.specs.size > 0;
  }, 15_000, "accounts connected");
  await new Promise((r) => setTimeout(r, 400));
}

export const sim = (e: Engine, accountId: string) => (e.conn.runtimes.get(accountId)!.adapter as unknown as { broker: import("@gtc/adapters").SimBroker }).broker;

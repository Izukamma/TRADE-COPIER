import "server-only";
import { desc, eq } from "drizzle-orm";
import { appSettings, engineHeartbeats, tradingAccounts } from "@gtc/db";
import { db } from "./db";

/** Account columns safe for the dashboard. Encrypted credentials/session columns are never selected. */
export const accountCols = {
  id: tradingAccounts.id,
  nickname: tradingAccounts.nickname,
  platform: tradingAccounts.platform,
  environment: tradingAccounts.environment,
  accountClass: tradingAccounts.accountClass,
  brokerName: tradingAccounts.brokerName,
  externalAccountId: tradingAccounts.externalAccountId,
  server: tradingAccounts.server,
  apiBaseUrl: tradingAccounts.apiBaseUrl,
  currency: tradingAccounts.currency,
  balance: tradingAccounts.balance,
  equity: tradingAccounts.equity,
  freeMargin: tradingAccounts.freeMargin,
  marginUsed: tradingAccounts.marginUsed,
  accounting: tradingAccounts.accounting,
  lastSyncAt: tradingAccounts.lastSyncAt,
  connectionStatus: tradingAccounts.connectionStatus,
  statusDetail: tradingAccounts.statusDetail,
  capabilities: tradingAccounts.capabilities,
  riskConfig: tradingAccounts.riskConfig,
  liveExecutionArmed: tradingAccounts.liveExecutionArmed,
  entriesPaused: tradingAccounts.entriesPaused,
  enabled: tradingAccounts.enabled,
  createdAt: tradingAccounts.createdAt,
  updatedAt: tradingAccounts.updatedAt,
};

export async function listAccounts() {
  return db().select(accountCols).from(tradingAccounts).orderBy(tradingAccounts.createdAt);
}

export async function getAccount(id: string) {
  const rows = await db().select(accountCols).from(tradingAccounts).where(eq(tradingAccounts.id, id));
  return rows[0] ?? null;
}

export async function hasCredentials(id: string): Promise<boolean> {
  const rows = await db().select({ c: tradingAccounts.credentialsEnc }).from(tradingAccounts).where(eq(tradingAccounts.id, id));
  return !!rows[0]?.c;
}

export interface HeartbeatStats {
  executor?: Record<string, number | null>;
  queue?: Record<string, number>;
  accounts?: {
    id: string;
    nickname: string;
    platform: string;
    environment: string;
    status: string;
    connected: boolean;
    isMaster: boolean;
    snapshotAgeMs: number | null;
    health: {
      connected: boolean;
      lastOkAt: number | null;
      lastError: string | null;
      lastErrorAt: number | null;
      reconnects: number;
      tokenRefreshes: number;
      rateLimited: number;
      requests: number;
      avgLatencyMs: number | null;
      detection: { mode: string; intervalMs: number };
      rateLimits: { name: string; limit: number; windowMs: number; used: number }[];
    } | null;
    dailyLoss: { dayKey: string; baseline: number; current: number; loss: number; limit: number; breached: boolean; usage: number; late: boolean } | null;
  }[];
  globalPause?: { paused: boolean; reason?: string };
  uptimeSec?: number;
  memoryMb?: number;
}

export async function latestHeartbeat() {
  const rows = await db().select().from(engineHeartbeats).orderBy(desc(engineHeartbeats.lastBeatAt)).limit(1);
  const r = rows[0];
  return r ? { ...r, stats: r.stats as HeartbeatStats } : null;
}

export async function setting<T>(key: string): Promise<T | null> {
  const r = await db().query.appSettings.findFirst({ where: eq(appSettings.key, key) });
  return (r?.value as T | undefined) ?? null;
}

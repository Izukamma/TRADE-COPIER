import { and, eq } from "drizzle-orm";
import { copierGroups, createDb, routes, symbolMappings, tradingAccounts } from "@gtc/db";
import { accountRiskSchema, defaultFollowerSettings, followerSettingsSchema } from "@gtc/shared";

/**
 * Creates SIMULATION-only accounts and a route so the full pipeline can be exercised without
 * any broker. Never creates DEMO/LIVE accounts. Usage: pnpm sim:seed
 */
async function main() {
  const { db, close } = createDb();
  const risk = accountRiskSchema.parse({});
  const upsert = async (nickname: string, profile: string, ext: string) => {
    const existing = await db.query.tradingAccounts.findFirst({ where: and(eq(tradingAccounts.environment, "SIMULATION"), eq(tradingAccounts.externalAccountId, ext)) });
    if (existing) return existing;
    const [row] = await db
      .insert(tradingAccounts)
      .values({ nickname, platform: "MT5", environment: "SIMULATION", accountClass: "PERSONAL", brokerName: `Simulator ${profile}`, externalAccountId: ext, server: profile, accounting: "HEDGING", riskConfig: risk })
      .returning();
    return row!;
  };
  const master = await upsert("SIM Master (Alpha, USD)", "SIM-ALPHA", "SIM-1001");
  const follower = await upsert("SIM Follower (Beta, GBP)", "SIM-BETA", "SIM-2001");
  let group = await db.query.copierGroups.findFirst({ where: eq(copierGroups.masterAccountId, master.id) });
  if (!group) [group] = await db.insert(copierGroups).values({ name: "Simulation group", masterAccountId: master.id }).returning();
  const settings = followerSettingsSchema.parse({
    ...defaultFollowerSettings(),
    sizing: { mode: "MULTIPLIER", multiplier: 1, normalizeContracts: true },
    maxOrderLots: 5,
    maxExposureLots: 20,
    maxEntryDeviationPoints: 200,
    copyPendingOrders: true,
  });
  let route = await db.query.routes.findFirst({ where: eq(routes.groupId, group!.id) });
  if (!route) [route] = await db.insert(routes).values({ groupId: group!.id, followerAccountId: follower.id, settings, active: false }).returning();
  for (const [m, f] of [["US30", "DJ30.cash"], ["NAS100", "USTEC.cash"], ["SPX500", "US500.cash"], ["EURUSD", "EURUSD.r"], ["XAUUSD", "XAUUSD.r"]] as const) {
    await db
      .insert(symbolMappings)
      .values({ masterAccountId: master.id, followerAccountId: follower.id, masterSymbol: m, followerSymbol: f, status: "SUGGESTED" })
      .onConflictDoNothing();
  }
  console.log(JSON.stringify({ master: master.id, follower: follower.id, group: group!.id, route: route!.id }, null, 2));
  console.log("Mappings are SUGGESTED: confirm them and preview sizing in the dashboard before activating the route.");
  await close();
}
main();

"use server";
import { and, eq } from "drizzle-orm";
import { appSettings, controlCommands, copierGroups, copyLinks, instruments, routes, symbolMappings, tradingAccounts } from "@gtc/db";
import {
  canonicalSymbol,
  computeFollowerVolume,
  followerSettingsSchema,
  FxTable,
  defaultFollowerSettings,
  groupCreateSchema,
  validateNewRoute,
  type FollowerSettings,
} from "@gtc/shared";
import { ownerAction } from "@/lib/authz";
import { db } from "@/lib/db";

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};
const num = (f: FormData, k: string) => (str(f, k) === undefined ? undefined : Number(str(f, k)));
const bool = (f: FormData, k: string) => f.get(k) === "on";

async function edges() {
  const rs = await db().select({ id: routes.id, groupId: routes.groupId, follower: routes.followerAccountId, active: routes.active }).from(routes);
  const gs = await db().select().from(copierGroups);
  const gm = new Map(gs.map((g) => [g.id, g.masterAccountId]));
  return rs.map((r) => ({ routeId: r.id, groupId: r.groupId, masterAccountId: gm.get(r.groupId)!, followerAccountId: r.follower, active: true }));
}

export const createGroup = ownerAction("group.create", async (_o, f) => {
  const input = groupCreateSchema.parse({ name: str(f, "name"), masterAccountId: str(f, "masterAccountId") });
  const master = await db().query.tradingAccounts.findFirst({ where: eq(tradingAccounts.id, input.masterAccountId) });
  if (!master) return { ok: false, message: "Master account not found." };
  const existing = await edges();
  if (existing.some((e) => e.followerAccountId === input.masterAccountId)) return { ok: false, message: "That account is a follower in another group; chained copying is not supported." };
  const [g] = await db().insert(copierGroups).values(input).returning({ id: copierGroups.id });
  return { ok: true, message: "Group created.", data: { id: g!.id } };
});

export const addFollower = ownerAction("route.create", async (_o, f) => {
  const groupId = str(f, "groupId")!;
  const followerAccountId = str(f, "followerAccountId")!;
  const g = await db().query.copierGroups.findFirst({ where: eq(copierGroups.id, groupId) });
  if (!g) return { ok: false, message: "Group not found." };
  const check = validateNewRoute(await edges(), { groupId, masterAccountId: g.masterAccountId, followerAccountId, active: true });
  if (!check.ok) return { ok: false, message: check.reason };
  const follower = await db().query.tradingAccounts.findFirst({ where: eq(tradingAccounts.id, followerAccountId) });
  const master = await db().query.tradingAccounts.findFirst({ where: eq(tradingAccounts.id, g.masterAccountId) });
  if (!follower || !master) return { ok: false, message: "Account not found." };
  if ((master.environment === "SIMULATION") !== (follower.environment === "SIMULATION"))
    return { ok: false, message: "Simulation accounts can only be routed to simulation accounts." };
  await db().insert(routes).values({ groupId, followerAccountId, settings: defaultFollowerSettings(), active: false });
  return { ok: true, message: "Follower added (inactive). Configure settings, confirm symbol mappings, preview sizing, then activate." };
});

function settingsFromForm(f: FormData): FollowerSettings {
  const mode = str(f, "sizingMode") ?? "FIXED";
  const sizing =
    mode === "FIXED"
      ? { mode, lots: num(f, "lots") }
      : mode === "MULTIPLIER"
        ? { mode, multiplier: num(f, "multiplier"), normalizeContracts: bool(f, "normalizeContracts") }
        : mode === "EQUITY_PROPORTIONAL"
          ? { mode, factor: num(f, "factor") ?? 1 }
          : { mode, riskPercent: num(f, "riskPercent"), basis: str(f, "riskBasis") ?? "EQUITY" };
  const list = (k: string) => (str(f, k) ?? "").split(/[\s,]+/).filter(Boolean);
  return followerSettingsSchema.parse({
    sizing,
    maxOrderLots: num(f, "maxOrderLots"),
    maxExposureLots: num(f, "maxExposureLots"),
    maxOpenPositions: num(f, "maxOpenPositions"),
    allowedSymbols: list("allowedSymbols"),
    allowedDirections: str(f, "allowedDirections"),
    copyMarketOrders: bool(f, "copyMarketOrders"),
    copyPendingOrders: bool(f, "copyPendingOrders"),
    copySl: str(f, "copySl"),
    copyTp: str(f, "copyTp"),
    copyModifications: bool(f, "copyModifications"),
    copyCancellations: bool(f, "copyCancellations"),
    copyPartialCloses: bool(f, "copyPartialCloses"),
    copyFullCloses: bool(f, "copyFullCloses"),
    maxEntryAgeSeconds: num(f, "maxEntryAgeSeconds"),
    maxEntryDeviationPoints: str(f, "maxEntryDeviationPoints") === undefined ? null : num(f, "maxEntryDeviationPoints"),
    sourceFilter: { manual: bool(f, "copyManual"), eaMagics: list("eaMagics").map(Number) },
    requireStopLoss: bool(f, "requireStopLoss"),
    partialCloseRemainder: str(f, "partialCloseRemainder"),
    divergencePolicy: str(f, "divergencePolicy"),
    copyExistingOnStart: bool(f, "copyExistingOnStart"),
    nettingExclusiveSymbols: bool(f, "nettingExclusiveSymbols"),
    marginSafetyFactor: num(f, "marginSafetyFactor") ?? 1.5,
  });
}

export const saveRouteSettings = ownerAction("route.settings", async (_o, f) => {
  const id = str(f, "id")!;
  const r = await db().query.routes.findFirst({ where: eq(routes.id, id) });
  if (!r) return { ok: false, message: "Route not found." };
  const settings = settingsFromForm(f);
  await db()
    .update(routes)
    .set({ settings, settingsVersion: r.settingsVersion + 1, updatedAt: new Date() })
    .where(eq(routes.id, id));
  return { ok: true, message: r.active ? "Saved and applied to the running route. Preview again to review sizing." : "Saved. Preview sizing before activating." };
});

async function fxTable(accountIds: string[]): Promise<FxTable> {
  const t = new FxTable();
  const manual = await db().query.appSettings.findFirst({ where: eq(appSettings.key, "fx.manual") });
  for (const r of (manual?.value as { base: string; quote: string; rate: number; time: number }[] | undefined) ?? []) if (r.rate > 0) t.set({ ...r, source: "manual" });
  for (const id of accountIds) {
    const rows = await db().select().from(instruments).where(eq(instruments.accountId, id));
    for (const r of rows) {
      const c = canonicalSymbol(r.symbol);
      if (/^[A-Z]{6}$/.test(c) && r.bid && r.ask && r.quoteTime) t.set({ base: c.slice(0, 3), quote: c.slice(3), rate: (r.bid + r.ask) / 2, time: r.quoteTime.getTime(), source: r.symbol });
    }
  }
  return t;
}

/** Sizing preview for each confirmed mapping (deterministic, same code path as the engine). */
export const previewSizing = ownerAction("route.preview", async (_o, f) => {
  const id = str(f, "id")!;
  const masterVolume = num(f, "masterVolume") ?? 1;
  const slPoints = num(f, "slPoints");
  const r = await db().query.routes.findFirst({ where: eq(routes.id, id) });
  if (!r) return { ok: false, message: "Route not found." };
  const g = (await db().query.copierGroups.findFirst({ where: eq(copierGroups.id, r.groupId) }))!;
  const master = (await db().query.tradingAccounts.findFirst({ where: eq(tradingAccounts.id, g.masterAccountId) }))!;
  const follower = (await db().query.tradingAccounts.findFirst({ where: eq(tradingAccounts.id, r.followerAccountId) }))!;
  const settings = followerSettingsSchema.parse(r.settings);
  const maps = await db().select().from(symbolMappings).where(and(eq(symbolMappings.masterAccountId, master.id), eq(symbolMappings.followerAccountId, follower.id), eq(symbolMappings.status, "CONFIRMED")));
  if (!maps.length) return { ok: false, message: "No confirmed symbol mappings for this pair yet." };
  if (master.equity === null || follower.equity === null || !follower.currency) return { ok: false, message: "Account balances have not been synchronised yet (engine must connect both accounts)." };
  const fx = await fxTable([master.id, follower.id]);
  const rows: Record<string, unknown>[] = [];
  for (const m of maps) {
    const ms = await db().query.instruments.findFirst({ where: and(eq(instruments.accountId, master.id), eq(instruments.symbol, m.masterSymbol)) });
    const fs = await db().query.instruments.findFirst({ where: and(eq(instruments.accountId, follower.id), eq(instruments.symbol, m.followerSymbol)) });
    if (!fs) {
      rows.push({ symbol: `${m.masterSymbol} → ${m.followerSymbol}`, result: "follower spec missing" });
      continue;
    }
    const entry = fs.ask ?? fs.bid ?? undefined;
    const sl = slPoints && entry ? entry - slPoints : undefined;
    const res = computeFollowerVolume({
      sizing: settings.sizing,
      maxOrderLots: settings.maxOrderLots,
      masterVolume,
      masterSpec: ms?.spec ?? fs.spec,
      followerSpec: fs.spec,
      masterAccount: { balance: master.balance ?? 0, equity: master.equity ?? 0, currency: master.currency ?? follower.currency },
      followerAccount: { balance: follower.balance ?? 0, equity: follower.equity ?? 0, currency: follower.currency },
      followerEntryPrice: entry,
      followerStopLoss: sl,
      fx,
    });
    rows.push({
      symbol: `${m.masterSymbol} → ${m.followerSymbol}`,
      result: res.ok ? `${res.volume} lots` : `REJECTED: ${res.reason}`,
      riskAtStop: res.ok && res.riskAtStop !== null ? `${res.riskAtStop.toFixed(2)} ${follower.currency}` : "",
      explanation: res.explanation.join(" · "),
    });
  }
  await db().update(routes).set({ previewedAt: new Date(), previewedVersion: r.settingsVersion }).where(eq(routes.id, id));
  return { ok: true, message: `Preview for a ${masterVolume}-lot master trade${slPoints ? ` with ${slPoints}-point SL` : ""}.`, data: { rows } };
});

export const setRouteActive = ownerAction("route.activate", async (o, f) => {
  const id = str(f, "id")!;
  const active = str(f, "value") === "true";
  const r = await db().query.routes.findFirst({ where: eq(routes.id, id) });
  if (!r) return { ok: false, message: "Route not found." };
  if (!active) {
    await db().update(routes).set({ active: false, updatedAt: new Date() }).where(eq(routes.id, id));
    return { ok: true, message: "Route deactivated. Open copier positions are no longer managed until reactivated." };
  }
  if (r.previewedVersion !== r.settingsVersion) return { ok: false, message: "Preview sizing for the current settings before activating." };
  const g = (await db().query.copierGroups.findFirst({ where: eq(copierGroups.id, r.groupId) }))!;
  const confirmed = await db().select({ id: symbolMappings.id }).from(symbolMappings).where(and(eq(symbolMappings.masterAccountId, g.masterAccountId), eq(symbolMappings.followerAccountId, r.followerAccountId), eq(symbolMappings.status, "CONFIRMED")));
  if (!confirmed.length) return { ok: false, message: "Confirm at least one symbol mapping first." };
  const check = validateNewRoute((await edges()).filter((e) => e.routeId !== id), { groupId: r.groupId, masterAccountId: g.masterAccountId, followerAccountId: r.followerAccountId, active: true });
  if (!check.ok) return { ok: false, message: check.reason };
  await db().update(routes).set({ active: true, activatedAt: new Date(), updatedAt: new Date() }).where(eq(routes.id, id));
  const settings = followerSettingsSchema.parse(r.settings);
  if (settings.copyExistingOnStart) await db().insert(controlCommands).values({ kind: "COPY_EXISTING", payload: { routeId: id }, requestedBy: `owner:${o.userId}` });
  await db().insert(controlCommands).values({ kind: "RELOAD", payload: {}, requestedBy: `owner:${o.userId}` });
  return { ok: true, message: settings.copyExistingOnStart ? "Activated; existing master positions will be copied (explicit option)." : "Activated. Existing master positions are NOT copied; only new trades." };
});

export const setPause = ownerAction("pause.set", async (_o, f) => {
  const scope = str(f, "scope");
  const id = str(f, "id");
  const value = str(f, "value") === "true";
  if (scope === "GLOBAL") {
    const v = { paused: value, reason: str(f, "reason") ?? (value ? "paused by owner" : undefined), at: new Date().toISOString() };
    await db().insert(appSettings).values({ key: "pause.global", value: v }).onConflictDoUpdate({ target: appSettings.key, set: { value: v, updatedAt: new Date() } });
  } else if (scope === "GROUP" && id) await db().update(copierGroups).set({ entriesPaused: value }).where(eq(copierGroups.id, id));
  else if (scope === "ROUTE" && id) await db().update(routes).set({ entriesPaused: value }).where(eq(routes.id, id));
  else if (scope === "ACCOUNT" && id) await db().update(tradingAccounts).set({ entriesPaused: value }).where(eq(tradingAccounts.id, id));
  else return { ok: false, message: "invalid scope" };
  return { ok: true, message: value ? "New entries paused. Exits, SL/TP and partial closes continue." : "Entries resumed." };
});

export const deleteRoute = ownerAction("route.delete", async (_o, f) => {
  const id = str(f, "id")!;
  const r = await db().query.routes.findFirst({ where: eq(routes.id, id) });
  if (!r) return { ok: false, message: "Route not found." };
  if (r.active) return { ok: false, message: "Deactivate the route first." };
  const history = await db().select({ id: copyLinks.id }).from(copyLinks).where(eq(copyLinks.routeId, id)).limit(1);
  if (history.length) return { ok: false, message: "This route has trade history; keep it deactivated instead of deleting (history is preserved)." };
  await db().delete(routes).where(eq(routes.id, id));
  return { ok: true, message: "Follower removed from group." };
});

export const deleteGroup = ownerAction("group.delete", async (_o, f) => {
  const id = str(f, "id")!;
  const rs = await db().select().from(routes).where(eq(routes.groupId, id));
  if (rs.length) return { ok: false, message: "Remove all followers first (routes with history cannot be deleted)." };
  await db().delete(copierGroups).where(eq(copierGroups.id, id));
  return { ok: true, message: "Group deleted." };
});

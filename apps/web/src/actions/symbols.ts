"use server";
import { and, eq } from "drizzle-orm";
import { appSettings, controlCommands, instruments, symbolMappings, tradingAccounts } from "@gtc/db";
import { canonicalSymbol, FxTable, hasBlockingChecks, suggestMappings, validateMapping, type InstrumentSpec } from "@gtc/shared";
import { z } from "zod";
import { ownerAction } from "@/lib/authz";
import { db } from "@/lib/db";

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};

async function symbolList(accountId: string): Promise<string[]> {
  const r = await db().query.appSettings.findFirst({ where: eq(appSettings.key, `symbols:${accountId}`) });
  const specs = await db().select({ s: instruments.symbol }).from(instruments).where(eq(instruments.accountId, accountId));
  return [...new Set([...((r?.value as string[] | undefined) ?? []), ...specs.map((x) => x.s)])];
}

export const suggest = ownerAction("mapping.suggest", async (_o, f) => {
  const masterId = str(f, "masterAccountId")!;
  const followerId = str(f, "followerAccountId")!;
  const ms = await symbolList(masterId);
  const fs = await symbolList(followerId);
  if (!ms.length || !fs.length) return { ok: false, message: "Symbol lists not synchronised yet. Use “Sync instruments” on both accounts (engine must be connected)." };
  const sug = suggestMappings(ms, fs);
  let n = 0;
  for (const s of sug) {
    const r = await db()
      .insert(symbolMappings)
      .values({ masterAccountId: masterId, followerAccountId: followerId, masterSymbol: s.masterSymbol, followerSymbol: s.followerSymbol, status: "SUGGESTED", checks: [{ code: `SUGGESTED_${s.confidence}`, severity: "info", message: s.note }] })
      .onConflictDoNothing()
      .returning({ id: symbolMappings.id });
    n += r.length;
  }
  return { ok: true, message: `${n} new suggestion(s). Suggestions are inactive until you confirm each one.` };
});

export const addMapping = ownerAction("mapping.add", async (_o, f) => {
  const v = z
    .object({ masterAccountId: z.string().uuid(), followerAccountId: z.string().uuid(), masterSymbol: z.string().min(1).max(64), followerSymbol: z.string().min(1).max(64) })
    .parse({ masterAccountId: str(f, "masterAccountId"), followerAccountId: str(f, "followerAccountId"), masterSymbol: str(f, "masterSymbol"), followerSymbol: str(f, "followerSymbol") });
  await db()
    .insert(symbolMappings)
    .values({ ...v, status: "SUGGESTED" })
    .onConflictDoUpdate({ target: [symbolMappings.masterAccountId, symbolMappings.followerAccountId, symbolMappings.masterSymbol], set: { followerSymbol: v.followerSymbol, status: "SUGGESTED", confirmedAt: null, updatedAt: new Date() } });
  // Ask the engine to fetch the specs it now needs.
  await db().insert(controlCommands).values([
    { kind: "SYNC_INSTRUMENTS", payload: { accountId: v.masterAccountId, symbols: [v.masterSymbol] }, requestedBy: "owner" },
    { kind: "SYNC_INSTRUMENTS", payload: { accountId: v.followerAccountId, symbols: [v.followerSymbol] }, requestedBy: "owner" },
  ]);
  return { ok: true, message: "Mapping saved as SUGGESTED. Validate and confirm it once specifications are synchronised." };
});

async function fx(): Promise<FxTable> {
  const t = new FxTable();
  const manual = await db().query.appSettings.findFirst({ where: eq(appSettings.key, "fx.manual") });
  for (const r of (manual?.value as { base: string; quote: string; rate: number; time: number }[] | undefined) ?? []) if (r.rate > 0) t.set({ ...r, source: "manual" });
  const rows = await db().select().from(instruments);
  for (const r of rows) {
    const c = canonicalSymbol(r.symbol);
    if (/^[A-Z]{6}$/.test(c) && r.bid && r.ask && r.quoteTime) t.set({ base: c.slice(0, 3), quote: c.slice(3), rate: (r.bid + r.ask) / 2, time: r.quoteTime.getTime(), source: r.symbol });
  }
  return t;
}

/** Validate (and optionally confirm) a mapping. Confirmation is refused while blocking errors exist. */
export const validateOrConfirm = ownerAction("mapping.confirm", async (_o, f) => {
  const id = str(f, "id")!;
  const confirm = str(f, "confirm") === "true";
  const m = await db().query.symbolMappings.findFirst({ where: eq(symbolMappings.id, id) });
  if (!m) return { ok: false, message: "Mapping not found." };
  const follower = await db().query.tradingAccounts.findFirst({ where: eq(tradingAccounts.id, m.followerAccountId) });
  const ms = await db().query.instruments.findFirst({ where: and(eq(instruments.accountId, m.masterAccountId), eq(instruments.symbol, m.masterSymbol)) });
  const fs = await db().query.instruments.findFirst({ where: and(eq(instruments.accountId, m.followerAccountId), eq(instruments.symbol, m.followerSymbol)) });
  const q = (r: typeof ms) => (r && r.bid && r.ask && r.quoteTime ? { symbol: r.symbol, bid: r.bid, ask: r.ask, time: r.quoteTime.getTime() } : null);
  const checks = validateMapping(ms?.spec ?? null, fs?.spec ?? null, { followerCurrency: follower?.currency ?? "USD", fx: await fx(), masterQuote: q(ms), followerQuote: q(fs), maxQuoteAgeMs: 5 * 60_000 });
  const blocking = hasBlockingChecks(checks);
  if (confirm && blocking) {
    await db().update(symbolMappings).set({ checks, updatedAt: new Date() }).where(eq(symbolMappings.id, id));
    return { ok: false, message: "Cannot confirm: resolve the errors listed in the checks first." };
  }
  await db()
    .update(symbolMappings)
    .set({ checks, ...(confirm ? { status: "CONFIRMED" as const, confirmedAt: new Date() } : {}), updatedAt: new Date() })
    .where(eq(symbolMappings.id, id));
  return { ok: true, message: confirm ? "Mapping confirmed." : blocking ? "Validation found blocking errors." : "Validation passed (not yet confirmed)." };
});

export const disableMapping = ownerAction("mapping.disable", async (_o, f) => {
  await db().update(symbolMappings).set({ status: "DISABLED", confirmedAt: null, updatedAt: new Date() }).where(eq(symbolMappings.id, str(f, "id")!));
  return { ok: true, message: "Mapping disabled; new entries on this symbol are rejected (open copies keep being managed)." };
});

const specOverride = z.object({
  digits: z.coerce.number().int().min(0).max(10),
  tickSize: z.coerce.number().positive(),
  tickValue: z.coerce.number().positive(),
  tickValueCurrency: z.string().regex(/^[A-Z]{3}$/),
  contractSize: z.coerce.number().positive(),
  volumeMin: z.coerce.number().positive(),
  volumeMax: z.coerce.number().positive(),
  volumeStep: z.coerce.number().positive(),
  stopsDistance: z.coerce.number().min(0),
});

/** Manual instrument specification (e.g. platforms that do not report tick value). Marked MANUAL. */
export const saveSpecOverride = ownerAction("instrument.override", async (_o, f) => {
  const accountId = str(f, "accountId")!;
  const symbol = str(f, "symbol")!;
  const v = specOverride.parse(Object.fromEntries(["digits", "tickSize", "tickValue", "tickValueCurrency", "contractSize", "volumeMin", "volumeMax", "volumeStep", "stopsDistance"].map((k) => [k, str(f, k)])));
  if (v.volumeMax < v.volumeMin) return { ok: false, message: "volumeMax must be ≥ volumeMin" };
  const spec: InstrumentSpec = { symbol, ...v, profitCurrency: v.tickValueCurrency, orderKinds: ["MARKET", "LIMIT", "STOP"], tradable: true, missingFields: [], source: "MANUAL", fetchedAt: Date.now() };
  await db()
    .insert(instruments)
    .values({ accountId, symbol, spec })
    .onConflictDoUpdate({ target: [instruments.accountId, instruments.symbol], set: { spec, updatedAt: new Date() } });
  await db().insert(controlCommands).values({ kind: "RELOAD", payload: {}, requestedBy: "owner" });
  return { ok: true, message: "Manual specification saved (source MANUAL). Verify it against the broker's contract specification." };
});

export const saveFxRates = ownerAction("fx.manual", async (_o, f) => {
  const text = str(f, "rates") ?? "";
  const rates: { base: string; quote: string; rate: number; time: number }[] = [];
  for (const line of text.split(/\n+/)) {
    const m = /^\s*([A-Z]{3})\s*\/?\s*([A-Z]{3})\s*[=:\s]\s*([0-9.]+)\s*$/.exec(line.toUpperCase());
    if (!m) continue;
    rates.push({ base: m[1]!, quote: m[2]!, rate: Number(m[3]), time: Date.now() });
  }
  await db().insert(appSettings).values({ key: "fx.manual", value: rates }).onConflictDoUpdate({ target: appSettings.key, set: { value: rates, updatedAt: new Date() } });
  return { ok: true, message: `${rates.length} manual FX rate(s) saved. Live quotes take precedence when fresh.` };
});

"use server";
import { and, eq, isNull } from "drizzle-orm";
import { controlCommands, copierGroups, deviceTokens, routes, tradingAccounts } from "@gtc/db";
import { accountCreateSchema, accountRiskSchema, apiCredentialSchema, dailyLossSchema } from "@gtc/shared";
import { encryptSecret, generateDeviceToken } from "@gtc/shared/crypto";
import { ownerAction } from "@/lib/authz";
import { db } from "@/lib/db";
import { keyRing } from "@/lib/secrets";

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};
const bool = (f: FormData, k: string) => f.get(k) === "on" || f.get(k) === "true";
const num = (f: FormData, k: string) => {
  const v = str(f, k);
  return v === undefined ? undefined : Number(v);
};

export const createAccount = ownerAction("account.create", async (_o, f) => {
  const input = accountCreateSchema.parse({
    nickname: str(f, "nickname"),
    platform: str(f, "platform"),
    environment: str(f, "environment"),
    accountClass: str(f, "accountClass"),
    brokerName: str(f, "brokerName"),
    externalAccountId: str(f, "externalAccountId"),
    server: str(f, "server"),
    apiBaseUrl: str(f, "apiBaseUrl"),
  });
  if (input.environment !== "SIMULATION" && (input.platform === "TRADELOCKER" || input.platform === "MATCHTRADER") && !input.apiBaseUrl)
    return { ok: false, message: "API platforms need the HTTPS base URL." };
  if (input.environment === "SIMULATION" && input.server && !["SIM-ALPHA", "SIM-BETA"].includes(input.server))
    return { ok: false, message: "Simulation accounts use server SIM-ALPHA or SIM-BETA (simulator profiles)." };
  const [row] = await db()
    .insert(tradingAccounts)
    .values({ ...input, server: input.environment === "SIMULATION" ? (input.server ?? "SIM-ALPHA") : input.server, riskConfig: accountRiskSchema.parse({}) })
    .returning({ id: tradingAccounts.id });
  return { ok: true, message: "Account record created. Status will show once the engine connects — a saved record is not a connection.", data: { id: row!.id } };
});

/** Credentials are encrypted immediately and never returned to the browser. */
export const setCredentials = ownerAction("account.credentials", async (_o, f) => {
  const id = str(f, "id")!;
  const acc = await db().query.tradingAccounts.findFirst({ where: eq(tradingAccounts.id, id) });
  if (!acc) return { ok: false, message: "Account not found." };
  if (acc.platform === "MT4" || acc.platform === "MT5") return { ok: false, message: "MetaTrader logins stay in the terminal. Issue a device token instead." };
  if (acc.environment === "SIMULATION") return { ok: false, message: "Simulation accounts have no credentials." };
  const c = apiCredentialSchema.parse({ login: str(f, "login"), password: f.get("password"), brokerId: str(f, "brokerId") });
  if (acc.platform === "MATCHTRADER" && !c.brokerId) return { ok: false, message: "Match-Trader requires the broker id." };
  const enc = encryptSecret(keyRing(), JSON.stringify(c), `account:${id}:credentials`);
  await db().update(tradingAccounts).set({ credentialsEnc: enc, sessionEnc: null, updatedAt: new Date() }).where(eq(tradingAccounts.id, id));
  return { ok: true, message: "Credentials stored encrypted. Use “Test connection” to verify." };
});

export const clearCredentials = ownerAction("account.credentials.clear", async (_o, f) => {
  const id = str(f, "id")!;
  await db().update(tradingAccounts).set({ credentialsEnc: null, sessionEnc: null, updatedAt: new Date() }).where(eq(tradingAccounts.id, id));
  return { ok: true, message: "Credentials removed." };
});

export const issueDeviceToken = ownerAction("device_token.issue", async (_o, f) => {
  const id = str(f, "id")!;
  const acc = await db().query.tradingAccounts.findFirst({ where: eq(tradingAccounts.id, id) });
  if (!acc || (acc.platform !== "MT4" && acc.platform !== "MT5")) return { ok: false, message: "Device tokens are for MT4/MT5 bridge accounts." };
  const label = (str(f, "label") ?? "terminal").slice(0, 60);
  const t = generateDeviceToken();
  await db().insert(deviceTokens).values({ accountId: id, tokenId: t.tokenId, secretEnc: encryptSecret(keyRing(), t.secret, `device-token:${t.tokenId}`), label });
  return { ok: true, message: `Token ${t.tokenId} issued for login ${acc.externalAccountId}.`, data: { secretOnce: t.display } };
});

export const revokeDeviceToken = ownerAction("device_token.revoke", async (_o, f) => {
  const tokenId = str(f, "tokenId")!;
  await db().update(deviceTokens).set({ revokedAt: new Date() }).where(and(eq(deviceTokens.tokenId, tokenId), isNull(deviceTokens.revokedAt)));
  return { ok: true, message: "Token revoked; the bridge will be refused on its next request." };
});

export const updateAccountRisk = ownerAction("account.risk", async (_o, f) => {
  const id = str(f, "id")!;
  const daily = dailyLossSchema.parse({
    enabled: bool(f, "dl_enabled"),
    resetTimezone: str(f, "dl_tz") ?? "UTC",
    resetTime: str(f, "dl_time") ?? "00:00",
    basis: str(f, "dl_basis") ?? "EQUITY",
    includeFloating: bool(f, "dl_floating"),
    baseline: str(f, "dl_baseline") ?? "HIGHER_OF_BALANCE_EQUITY",
    limitType: str(f, "dl_type") ?? "PERCENT",
    limitValue: num(f, "dl_value") ?? 4,
    onLimit: str(f, "dl_on") ?? "PAUSE_ENTRIES",
  });
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: daily.resetTimezone });
  } catch {
    return { ok: false, message: `Unknown timezone ${daily.resetTimezone}` };
  }
  const risk = accountRiskSchema.parse({
    dailyLoss: daily,
    maxAccountExposureLots: num(f, "maxAccountExposureLots"),
    minFreeMarginAfterOrder: num(f, "minFreeMarginAfterOrder"),
    staleAccountSeconds: num(f, "staleAccountSeconds"),
    staleQuoteSeconds: num(f, "staleQuoteSeconds"),
  });
  await db().update(tradingAccounts).set({ riskConfig: risk }).where(eq(tradingAccounts.id, id));
  return { ok: true, message: "Risk settings saved. These are copier controls, not a guarantee of prop-firm rule compliance." };
});

export const setAccountFlags = ownerAction("account.flags", async (_o, f) => {
  const id = str(f, "id")!;
  const flag = str(f, "flag");
  const value = str(f, "value") === "true";
  if (flag === "entriesPaused") await db().update(tradingAccounts).set({ entriesPaused: value }).where(eq(tradingAccounts.id, id));
  else if (flag === "enabled") await db().update(tradingAccounts).set({ enabled: value, updatedAt: new Date() }).where(eq(tradingAccounts.id, id));
  else return { ok: false, message: "unknown flag" };
  return { ok: true, message: "Saved." };
});

/** Arming LIVE execution needs a typed confirmation; the engine also requires LIVE_TRADING_ENABLED. */
export const armLive = ownerAction("account.arm_live", async (_o, f) => {
  const id = str(f, "id")!;
  const arm = str(f, "value") === "true";
  const acc = await db().query.tradingAccounts.findFirst({ where: eq(tradingAccounts.id, id) });
  if (!acc) return { ok: false, message: "Account not found." };
  if (acc.environment !== "LIVE") return { ok: false, message: "Only LIVE accounts need arming." };
  if (arm && str(f, "confirm") !== `ARM ${acc.externalAccountId}`) return { ok: false, message: "Confirmation phrase did not match." };
  await db().update(tradingAccounts).set({ liveExecutionArmed: arm }).where(eq(tradingAccounts.id, id));
  return { ok: true, message: arm ? "Armed. Orders are still blocked unless the engine runs with LIVE_TRADING_ENABLED=true." : "Disarmed." };
});

export const deleteAccount = ownerAction("account.delete", async (_o, f) => {
  const id = str(f, "id")!;
  const acc = await db().query.tradingAccounts.findFirst({ where: eq(tradingAccounts.id, id) });
  if (!acc) return { ok: false, message: "Account not found." };
  if (str(f, "confirm") !== `DELETE ${acc.nickname}`) return { ok: false, message: "Confirmation phrase did not match." };
  const asMaster = await db().select({ id: copierGroups.id }).from(copierGroups).where(eq(copierGroups.masterAccountId, id));
  const asFollower = await db().select({ id: routes.id }).from(routes).where(eq(routes.followerAccountId, id));
  if (asMaster.length || asFollower.length) return { ok: false, message: "Remove the account from all groups first." };
  await db().delete(tradingAccounts).where(eq(tradingAccounts.id, id));
  return { ok: true, message: "Account deleted." };
});

/** Dashboard -> engine requests. The dashboard never talks to brokers itself. */
export const requestControl = ownerAction("control.request", async (o, f) => {
  const kind = str(f, "kind")!;
  const allowed = ["TEST_CONNECTION", "SYNC_INSTRUMENTS", "RELOAD", "COPY_EXISTING", "RESOLVE_JOB", "DETACH_LINK"];
  if (!allowed.includes(kind)) return { ok: false, message: "Unsupported request." };
  const payload: Record<string, unknown> = {};
  for (const k of ["accountId", "routeId", "jobId", "linkId", "note"]) if (str(f, k)) payload[k] = str(f, k);
  if (str(f, "symbols")) payload.symbols = str(f, "symbols")!.split(/[\s,]+/).filter(Boolean).slice(0, 200);
  if (kind === "COPY_EXISTING" && str(f, "confirm") !== "COPY EXISTING") return { ok: false, message: "Confirmation phrase did not match." };
  const [row] = await db().insert(controlCommands).values({ kind, payload, requestedBy: `owner:${o.userId}` }).returning({ id: controlCommands.id });
  return { ok: true, message: `Sent to engine (request ${row!.id.slice(0, 8)}). Results appear under Diagnostics → Engine requests.` };
});

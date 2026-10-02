import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { copierGroups, copyLinks, deviceTokens, executionJobs, routes, symbolMappings, tradingAccounts, type DbHandle } from "@gtc/db";
import { accountRiskSchema, defaultFollowerSettings, followerSettingsSchema, type BridgeSync } from "@gtc/shared";
import { bridgeCanonical, encryptSecret, generateDeviceToken, hmacHex, sha256Hex } from "@gtc/shared/crypto";
import { createBridgeServer } from "../../src/bridge/server";
import { nullLogger } from "../../src/logger";
import { freshDb, ring, sim, startEngine, until } from "./harness";
import type { Engine } from "../../src/engine";
import type { Server } from "node:http";

/**
 * Exercises the MT bridge HTTP protocol with a fake EA written in TypeScript. This verifies the
 * engine side only; the real MQL4/MQL5 EAs have NOT been compiled or run here.
 */
let h: DbHandle | null = null;
let engine: Engine | null = null;
let server: Server | null = null;
afterEach(async () => {
  server?.close();
  await engine?.stop();
  await h?.close();
  h = server = engine = null;
});

const PATH = "/bridge/v1/sync";

async function setup() {
  h = await freshDb();
  const risk = accountRiskSchema.parse({});
  const [master] = await h.db.insert(tradingAccounts).values({ nickname: "SIM master", platform: "MT5", environment: "SIMULATION", accountClass: "PERSONAL", brokerName: "sim", externalAccountId: "M1", server: "SIM-ALPHA", riskConfig: risk }).returning();
  const [mt5] = await h.db.insert(tradingAccounts).values({ nickname: "MT5 demo (fake EA)", platform: "MT5", environment: "DEMO", accountClass: "EVALUATION", brokerName: "test", externalAccountId: "5550001", server: "Demo-Server", riskConfig: risk }).returning();
  const tok = generateDeviceToken();
  await h.db.insert(deviceTokens).values({ accountId: mt5!.id, tokenId: tok.tokenId, secretEnc: encryptSecret(ring, tok.secret, `device-token:${tok.tokenId}`), label: "test" });
  const [g] = await h.db.insert(copierGroups).values({ name: "g", masterAccountId: master!.id }).returning();
  const settings = followerSettingsSchema.parse({ ...defaultFollowerSettings(), sizing: { mode: "FIXED", lots: 0.1 }, maxEntryDeviationPoints: null });
  await h.db.insert(routes).values({ groupId: g!.id, followerAccountId: mt5!.id, settings, active: true });
  await h.db.insert(symbolMappings).values({ masterAccountId: master!.id, followerAccountId: mt5!.id, masterSymbol: "US30", followerSymbol: "US30.cash", status: "CONFIRMED" });
  engine = startEngine(h);
  await engine.start();
  server = createBridgeServer({ db: h.db, ring, hub: engine.hub, log: nullLogger, maxSkewMs: 30_000, onSync: (id) => engine!.bridgeSynced(id) });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return { master: master!, mt5: mt5!, tok, url: `http://127.0.0.1:${port}${PATH}` };
}

function syncBody(over: Partial<BridgeSync> = {}): BridgeSync {
  return {
    protocol: 1, platform: "MT5", login: "5550001", server: "Demo-Server", eaVersion: "test", terminalConnected: true, tradeAllowed: true, accounting: "HEDGING",
    account: { balance: 10_000, equity: 10_000, currency: "USD", freeMargin: 9_000, margin: 0 }, serverTime: Date.now(),
    positions: [], orders: [], quotes: [{ symbol: "US30.cash", bid: 42000, ask: 42002, time: Date.now() }],
    symbols: [{ symbol: "US30.cash", digits: 2, tickSize: 0.01, tickValue: 0.01, contractSize: 1, profitCurrency: "USD", volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, stopsLevelPoints: 0, freezeLevelPoints: 0, tradeAllowed: true, bid: 42000, ask: 42002 }],
    results: [],
    ...over,
  };
}

async function post(url: string, tokenId: string, secret: string, body: string, o: { ts?: number; nonce?: string; sig?: string } = {}) {
  const ts = String(o.ts ?? Date.now());
  const nonce = o.nonce ?? randomBytes(16).toString("hex");
  const sig = o.sig ?? hmacHex(secret, bridgeCanonical(ts, nonce, "POST", PATH, body));
  const res = await fetch(url, { method: "POST", body, headers: { "x-gtc-key": tokenId, "x-gtc-ts": ts, "x-gtc-nonce": nonce, "x-gtc-sig": sig } });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text), sig: res.headers.get("x-gtc-sig"), ts, nonce };
}

describe("MetaTrader bridge protocol (fake EA)", () => {
  it("authenticates signed requests and rejects bad signatures, replays, skew, revoked tokens and wrong logins", async () => {
    const s = await setup();
    const body = JSON.stringify(syncBody());
    const ok = await post(s.url, s.tok.tokenId, s.tok.secret, body);
    expect(ok.status).toBe(200);
    expect(ok.json.ok).toBe(true);
    // Response is signed so the EA can verify it.
    expect(ok.sig).toBe(hmacHex(s.tok.secret, `${ok.ts}\n${ok.nonce}\n${sha256Hex(ok.text)}`));

    expect((await post(s.url, s.tok.tokenId, "wrong-secret", body)).status).toBe(401);
    expect((await post(s.url, s.tok.tokenId, s.tok.secret, body, { nonce: ok.nonce })).status).toBe(401); // replay
    expect((await post(s.url, s.tok.tokenId, s.tok.secret, body, { ts: Date.now() - 120_000 })).status).toBe(401);
    const wrongLogin = JSON.stringify(syncBody({ login: "999" }));
    expect((await post(s.url, s.tok.tokenId, s.tok.secret, wrongLogin)).status).toBe(403);
    await h!.db.update(deviceTokens).set({ revokedAt: new Date() }).where(eq(deviceTokens.tokenId, s.tok.tokenId));
    expect((await post(s.url, s.tok.tokenId, s.tok.secret, body)).status).toBe(401);
  });

  it("delivers commands to the EA and applies its results (MT5 follower of a simulated master)", async () => {
    const s = await setup();
    const ea = async (results: BridgeSync["results"] = [], positions: BridgeSync["positions"] = []) =>
      (await post(s.url, s.tok.tokenId, s.tok.secret, JSON.stringify(syncBody({ results, positions })))).json as { commands: { id: string; kind: string; symbol: string; volume: number; tag: string }[] };
    // Keep the fake terminal alive and wait for the engine to see both accounts.
    await ea();
    await until(async () => engine!.conn.runtimes.get(s.mt5.id)?.connected && engine!.conn.runtimes.get(s.master.id)?.connected && engine!.conn.runtimes.get(s.mt5.id)!.specs.size > 0, 15_000, "connected");
    await new Promise((r) => setTimeout(r, 400));
    sim(engine!, s.master.id).openMarket("US30", "BUY", 1, null, null, null);

    // Poll like the EA would until a command arrives.
    let cmd: { id: string; kind: string; symbol: string; volume: number; tag: string } | undefined;
    await until(async () => {
      const r = await ea();
      cmd = r.commands[0];
      return cmd;
    }, 15_000, "command delivered");
    expect(cmd).toMatchObject({ kind: "OPEN_MARKET", symbol: "US30.cash", volume: 0.1 });
    expect(cmd!.tag).toMatch(/^gtc1:/);

    const position = { ticket: "880001", symbol: "US30.cash", side: "BUY" as const, volume: 0.1, openPrice: 42002, openTime: Date.now(), sl: null, tp: null, comment: cmd!.tag, magic: 7710001, orderTicket: "880001" };
    await ea([{ commandId: cmd!.id, ok: true, retcode: 10009, message: "done", orderTicket: "880001", positionTicket: "880001", fillPrice: 42002, filledVolume: 0.1, executedAt: Date.now() }], [position]);
    const link = await until(async () => (await h!.db.select().from(copyLinks)).find((l) => l.status === "OPEN"), 15_000, "link open");
    expect(link.followerPositionId).toBe("880001");
    const job = (await h!.db.select().from(executionJobs))[0]!;
    expect(job.state).toBe("FILLED");
    expect(job.fillPrice).toBe(42002);
  });
});

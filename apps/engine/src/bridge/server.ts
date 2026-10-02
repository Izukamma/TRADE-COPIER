import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { and, eq, isNull, lt } from "drizzle-orm";
import { auditLog, bridgeNonces, deviceTokens, tradingAccounts, type Db } from "@gtc/db";
import { bridgeSyncSchema } from "@gtc/shared";
import { bridgeCanonical, decryptSecret, hmacHex, safeEqualHex, sha256Hex, type KeyRing } from "@gtc/shared/crypto";
import type { Log } from "../logger";
import type { BridgeHub } from "./hub";

export interface BridgeServerDeps {
  db: Db;
  ring: KeyRing;
  hub: BridgeHub;
  log: Log;
  maxSkewMs: number;
  /** Called after each accepted sync so the engine can react (master diff). */
  onSync?: (accountId: string) => void;
  /** Liveness provider for /healthz. */
  health?: () => Record<string, unknown>;
}

const MAX_BODY = 2 * 1024 * 1024;
const SYNC_PATH = "/bridge/v1/sync";

/**
 * HTTP endpoint for MT4/MT5 bridge EAs. Run it behind a TLS-terminating reverse proxy
 * (Caddy in docker-compose). Every request is authenticated with a scoped device token:
 *   X-GTC-Key: <tokenId>   X-GTC-Ts: <unix ms>   X-GTC-Nonce: <hex>   X-GTC-Sig: HMAC-SHA256(secret, canonical)
 * canonical = ts \n nonce \n METHOD \n path \n sha256(body). Nonces are single-use (replay
 * protection), timestamps must be within the configured skew, tokens are revocable, and a token
 * only works for the terminal login it was issued for.
 */
export function createBridgeServer(deps: BridgeServerDeps): Server {
  return createServer((req, res) => {
    handle(deps, req, res).catch((e) => {
      deps.log.error("bridge", "unhandled bridge error", { err: (e as Error).message });
      send(res, 500, { ok: false, error: "internal" });
    });
  });
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handle(deps: BridgeServerDeps, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://bridge");
  if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true, ...(deps.health?.() ?? {}) });
  if (req.method !== "POST" || url.pathname !== SYNC_PATH) return send(res, 404, { ok: false, error: "not found" });

  const body = await readBody(req);
  if (body === null) return send(res, 413, { ok: false, error: "body too large" });

  const tokenId = String(req.headers["x-gtc-key"] ?? "");
  const ts = String(req.headers["x-gtc-ts"] ?? "");
  const nonce = String(req.headers["x-gtc-nonce"] ?? "");
  const sig = String(req.headers["x-gtc-sig"] ?? "").toLowerCase();
  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? null;
  const deny = (reason: string, status = 401) => {
    deps.log.warn("bridge", "bridge request denied", { reason, tokenId: tokenId.slice(0, 16), ip });
    return send(res, status, { ok: false, error: "unauthorized" });
  };

  if (!/^[0-9a-f]{16}$/.test(tokenId) || !/^\d{10,16}$/.test(ts) || !/^[0-9a-f]{16,64}$/i.test(nonce) || !/^[0-9a-f]{64}$/.test(sig)) return deny("malformed auth headers");
  if (Math.abs(Date.now() - Number(ts)) > deps.maxSkewMs) return deny("timestamp outside allowed skew");

  const token = await deps.db.query.deviceTokens.findFirst({ where: and(eq(deviceTokens.tokenId, tokenId), isNull(deviceTokens.revokedAt)) });
  if (!token) return deny("unknown or revoked token");
  let secret: string;
  try {
    secret = decryptSecret(deps.ring, token.secretEnc, `device-token:${token.tokenId}`);
  } catch {
    return deny("token secret undecryptable");
  }
  const expected = hmacHex(secret, bridgeCanonical(ts, nonce, "POST", SYNC_PATH, body));
  if (!safeEqualHex(expected, sig)) return deny("bad signature");

  // Single-use nonce.
  const fresh = await deps.db.insert(bridgeNonces).values({ tokenId, nonce: nonce.toLowerCase() }).onConflictDoNothing().returning({ n: bridgeNonces.nonce });
  if (fresh.length === 0) return deny("replayed nonce");

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return send(res, 400, { ok: false, error: "invalid json" });
  }
  const parsed = bridgeSyncSchema.safeParse(json);
  if (!parsed.success) {
    deps.log.warn("bridge", "invalid bridge payload", { issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) });
    return send(res, 400, { ok: false, error: "invalid payload" });
  }
  const sync = parsed.data;

  const account = await deps.db.query.tradingAccounts.findFirst({ where: eq(tradingAccounts.id, token.accountId) });
  if (!account || !account.enabled) return deny("account disabled", 403);
  if (account.platform !== sync.platform) return deny(`platform mismatch (${sync.platform} vs ${account.platform})`, 403);
  if (account.externalAccountId !== sync.login) {
    await deps.db.insert(auditLog).values({ actor: `bridge:${tokenId}`, action: "bridge.login_mismatch", target: account.id, detail: { reported: sync.login }, ip });
    return deny("terminal login does not match the token's account", 403);
  }

  await deps.db.update(deviceTokens).set({ lastUsedAt: new Date(), lastIp: ip }).where(eq(deviceTokens.id, token.id));
  const out = await deps.hub.ingest(account.id, sync);
  deps.onSync?.(account.id);

  const response = JSON.stringify({ ok: true, serverTime: Date.now(), pollMs: 300, commands: out.commands, watchSymbols: out.watchSymbols, sendSymbols: out.sendSymbols });
  const respSig = hmacHex(secret, `${ts}\n${nonce}\n${sha256Hex(response)}`);
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "x-gtc-sig": respSig });
  res.end(response);
}

/** Deletes nonces older than the replay window (called periodically). */
export async function pruneNonces(db: Db, olderThanMs: number) {
  await db.delete(bridgeNonces).where(lt(bridgeNonces.seenAt, new Date(Date.now() - olderThanMs)));
}

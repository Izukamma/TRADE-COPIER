import { describe, expect, it } from "vitest";
import { bridgeCanonical, decryptSecret, encryptSecret, generateDeviceToken, hmacHex, loadKeyRing, parseDeviceToken, safeEqualHex } from "../src/crypto";
import { redact, redactString } from "../src/redact";
import { evaluateDailyLoss, tradingDayKey } from "../src/risk";
import { validateNewRoute, type RouteEdge } from "../src/routing";
import { canTransition } from "../src/state-machine";
import { clientIdFor, clientIdFromTag, isCopierTag, tagFor } from "../src/tags";
import { dailyLossSchema } from "../src/schemas";

const key = Buffer.alloc(32, 7).toString("base64");
const ring = loadKeyRing({ GTC_ENCRYPTION_KEYS: `k1:${key},k0:${Buffer.alloc(32, 1).toString("base64")}`, GTC_ENCRYPTION_ACTIVE_KEY_ID: "k1" } as NodeJS.ProcessEnv);

describe("secret encryption", () => {
  it("round-trips and binds to the record (AAD)", () => {
    const blob = encryptSecret(ring, '{"password":"x"}', "account:1:credentials");
    expect(blob).not.toContain("password");
    expect(decryptSecret(ring, blob, "account:1:credentials")).toBe('{"password":"x"}');
    expect(() => decryptSecret(ring, blob, "account:2:credentials")).toThrow();
  });
  it("rejects bad key configuration", () => {
    expect(() => loadKeyRing({ GTC_ENCRYPTION_KEYS: "k1:short", GTC_ENCRYPTION_ACTIVE_KEY_ID: "k1" } as NodeJS.ProcessEnv)).toThrow();
    expect(() => loadKeyRing({} as NodeJS.ProcessEnv)).toThrow();
  });
});

describe("device tokens and signatures", () => {
  it("generates parseable tokens and verifies HMAC signatures in constant time", () => {
    const t = generateDeviceToken();
    expect(parseDeviceToken(t.display)).toEqual({ tokenId: t.tokenId, secret: t.secret });
    expect(parseDeviceToken("gtcd_bad")).toBeNull();
    const msg = bridgeCanonical("1700000000000", "abcd1234abcd1234", "POST", "/bridge/v1/sync", "{}");
    const sig = hmacHex(t.secret, msg);
    expect(safeEqualHex(sig, hmacHex(t.secret, msg))).toBe(true);
    expect(safeEqualHex(sig, hmacHex("other", msg))).toBe(false);
    expect(safeEqualHex(sig, "zz")).toBe(false);
  });
});

describe("redaction", () => {
  it("removes secrets from objects and strings", () => {
    expect(redact({ password: "p", nested: { accessToken: "t", ok: 1 } })).toEqual({ password: "[REDACTED]", nested: { accessToken: "[REDACTED]", ok: 1 } });
    expect(redactString("Authorization: Bearer abc.def.ghi")).not.toContain("abc.def");
    expect(redactString("token gtcd_0123456789abcdef_" + "a".repeat(43))).not.toContain("aaaa");
  });
});

describe("copier tags", () => {
  it("is deterministic and recognisable", () => {
    const id = clientIdFor("event-1:route-1");
    expect(id).toHaveLength(12);
    expect(clientIdFor("event-1:route-1")).toBe(id);
    expect(isCopierTag(tagFor(id))).toBe(true);
    expect(clientIdFromTag(tagFor(id))).toBe(id);
    expect(isCopierTag("manual")).toBe(false);
  });
});

describe("route graph", () => {
  const e = (m: string, f: string, g = "g"): RouteEdge => ({ routeId: `${m}${f}`, groupId: g, masterAccountId: m, followerAccountId: f, active: true });
  it("blocks self-copy, duplicates, chains and loops", () => {
    expect(validateNewRoute([], { groupId: "g", masterAccountId: "A", followerAccountId: "A", active: true }).ok).toBe(false);
    expect(validateNewRoute([e("A", "B")], { groupId: "g2", masterAccountId: "A", followerAccountId: "B", active: true }).ok).toBe(false);
    expect(validateNewRoute([e("A", "B")], { groupId: "g2", masterAccountId: "B", followerAccountId: "C", active: true }).ok).toBe(false);
    expect(validateNewRoute([e("A", "B")], { groupId: "g2", masterAccountId: "C", followerAccountId: "A", active: true }).ok).toBe(false);
    expect(validateNewRoute([e("A", "B")], { groupId: "g", masterAccountId: "A", followerAccountId: "C", active: true }).ok).toBe(true);
  });
});

describe("execution state machine", () => {
  it("distinguishes acceptance from fills and forces reconciliation of UNKNOWN", () => {
    expect(canTransition("SUBMITTED", "ACCEPTED")).toBe(true);
    expect(canTransition("ACCEPTED", "FILLED")).toBe(true);
    expect(canTransition("UNKNOWN", "SUBMITTED")).toBe(false);
    expect(canTransition("UNKNOWN", "RECONCILED")).toBe(true);
    expect(canTransition("FILLED", "SUBMITTED")).toBe(false);
    expect(canTransition("SKIPPED", "QUEUED")).toBe(false);
  });
});

describe("daily loss", () => {
  it("computes trading-day keys in the reset timezone", () => {
    // 2026-03-10 21:30 UTC = 17:30 New York (EDT). Reset 17:00 NY -> new day 2026-03-10.
    expect(tradingDayKey(Date.UTC(2026, 2, 10, 21, 30), "America/New_York", "17:00")).toBe("2026-03-10");
    expect(tradingDayKey(Date.UTC(2026, 2, 10, 20, 30), "America/New_York", "17:00")).toBe("2026-03-09");
    expect(tradingDayKey(Date.UTC(2026, 2, 10, 23, 30), "Europe/London", "00:00")).toBe("2026-03-10");
  });
  it("evaluates balance vs equity basis and floating P&L treatment", () => {
    const cfg = dailyLossSchema.parse({ enabled: true, basis: "BALANCE", includeFloating: false, limitType: "AMOUNT", limitValue: 1000 });
    expect(evaluateDailyLoss(cfg, "d", 100_000, 99_500, 98_000).breached).toBe(false);
    const withFloat = { ...cfg, includeFloating: true };
    expect(evaluateDailyLoss(withFloat, "d", 100_000, 99_500, 98_000).breached).toBe(true);
    const pct = dailyLossSchema.parse({ enabled: true, basis: "EQUITY", limitType: "PERCENT", limitValue: 4 });
    expect(evaluateDailyLoss(pct, "d", 100_000, 100_000, 96_100)).toMatchObject({ breached: false, limit: 4000 });
    expect(evaluateDailyLoss(pct, "d", 100_000, 100_000, 96_000).breached).toBe(true);
  });
});

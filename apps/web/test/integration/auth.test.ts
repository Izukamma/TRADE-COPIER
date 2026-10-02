import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDb, runMigrations, type DbHandle } from "@gtc/db";
import { buildAuth } from "../../src/lib/auth-core";
import { isOwnerSession } from "../../src/lib/authz";

/** Real Better Auth + PostgreSQL through its HTTP handler (no mocks). */
const URL_BASE = "http://localhost:3000";
const DB = process.env.DATABASE_URL_TEST ?? "postgres://postgres@127.0.0.1:5432/gtc_test";
let h: DbHandle;
let auth: ReturnType<typeof buildAuth>;
const password = randomBytes(18).toString("base64url");

const req = (path: string, body: unknown, ip = "198.51.100.7") =>
  auth.handler(new Request(`${URL_BASE}/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json", origin: URL_BASE, "x-forwarded-for": ip }, body: JSON.stringify(body) }));

beforeAll(async () => {
  await runMigrations(DB);
  h = createDb(DB, { max: 3 });
  await h.db.execute(sql`truncate "user", "session", "account", "verification", "two_factor" cascade`);
  auth = buildAuth(h.db, { BETTER_AUTH_URL: URL_BASE, BETTER_AUTH_SECRET: randomBytes(32).toString("base64url") });
  const ctx = await auth.$context;
  const u = await ctx.internalAdapter.createUser({ email: "owner@example.com", name: "Owner", emailVerified: true }, { method: "email-password" });
  await ctx.internalAdapter.linkAccount({ userId: u.id, providerId: "credential", accountId: u.id, password: await ctx.password.hash(password) });
});
afterAll(async () => {
  await h.close();
});

describe("authentication (Better Auth, real database)", () => {
  it("public sign-up is disabled", async () => {
    const r = await req("/sign-up/email", { email: "attacker@example.com", password: "a-long-password-123", name: "x" });
    expect(r.status).toBe(400);
    const users = await h.db.execute(sql`select count(*)::int n from "user"`);
    expect((users as unknown as { n: number }[])[0]!.n).toBe(1);
  });

  it("owner signs in and receives an httpOnly session cookie; the session resolves to the owner", async () => {
    const r = await req("/sign-in/email", { email: "owner@example.com", password });
    expect(r.status).toBe(200);
    const cookie = r.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/gtc\.session_token=/);
    expect(cookie.toLowerCase()).toContain("httponly");
    const token = /gtc\.session_token=([^;]+)/.exec(cookie)![1]!;
    const s = await auth.api.getSession({ headers: new Headers({ cookie: `gtc.session_token=${token}` }) });
    expect(isOwnerSession(s, "owner@example.com")).toBe(true);
    expect(isOwnerSession(s, "other@example.com")).toBe(false);
  });

  it("forged session cookies do not authenticate", async () => {
    const s = await auth.api.getSession({ headers: new Headers({ cookie: "gtc.session_token=forged.signature" }) });
    expect(s).toBeNull();
  });

  it("wrong passwords fail and repeated attempts are rate limited", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await req("/sign-in/email", { email: "owner@example.com", password: "wrong-password-xyz" }, "192.0.2.44")).status);
    expect(statuses.slice(0, 3).every((s) => s === 401)).toBe(true);
    expect(statuses).toContain(429);
  });
});

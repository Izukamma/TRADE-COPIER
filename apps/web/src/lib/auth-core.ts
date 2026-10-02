import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins/two-factor";
import { authAccount, session, twoFactor as twoFactorTable, user, verification, type Db } from "@gtc/db";

/**
 * Better Auth (maintained library) with email/password only, public sign-up disabled,
 * optional TOTP second factor, DB-backed sessions and built-in rate limiting.
 * Registration being disabled is NOT the authorization boundary: every protected page,
 * server action and route handler calls requireOwner() (see ./authz.ts).
 */
export function buildAuth(db: Db, e: { BETTER_AUTH_URL: string; BETTER_AUTH_SECRET: string }) {
  return betterAuth({
    appName: "Gabriel Trade Copier",
    baseURL: e.BETTER_AUTH_URL,
    secret: e.BETTER_AUTH_SECRET,
    trustedOrigins: [e.BETTER_AUTH_URL],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user, session, account: authAccount, verification, twoFactor: twoFactorTable },
    }),
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12, maxPasswordLength: 256 },
    session: { expiresIn: 60 * 60 * 12, updateAge: 60 * 60, freshAge: 60 * 15 },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 30,
      customRules: { "/sign-in/email": { window: 300, max: 5 }, "/two-factor/*": { window: 300, max: 10 } },
    },
    advanced: { useSecureCookies: e.BETTER_AUTH_URL.startsWith("https://"), cookiePrefix: "gtc" },
    plugins: [twoFactor({ issuer: "Gabriel Trade Copier" }), nextCookies()],
  });
}

export type Auth = ReturnType<typeof buildAuth>;

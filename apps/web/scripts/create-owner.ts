import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { createDb, user } from "@gtc/db";
import { buildAuth } from "../src/lib/auth-core";

/**
 * Creates the single owner account. Public sign-up is disabled, so this CLI (run on the server)
 * is the only way to create a login. Refuses to run if any user exists.
 * Usage: OWNER_EMAIL=you@example.com pnpm owner:create   (password is prompted, not echoed)
 */
async function promptHidden(q: string): Promise<string> {
  let muted = false;
  const out = new Writable({
    write(chunk, enc, cb) {
      if (!muted) process.stdout.write(chunk, enc);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output: out, terminal: true });
  return new Promise((resolve) => {
    rl.question(q, (a) => {
      rl.close();
      process.stdout.write("\n");
      resolve(a);
    });
    muted = true;
  });
}

async function main() {
  const email = process.env.OWNER_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error("OWNER_EMAIL must be set");
  const { db, close } = createDb();
  const existing = await db.select({ id: user.id }).from(user).limit(1);
  if (existing.length) throw new Error("a user already exists; this application supports a single owner");
  const password = process.env.GTC_OWNER_PASSWORD_STDIN === "1" ? (await new Promise<string>((r) => process.stdin.once("data", (d) => r(String(d).trim())))) : await promptHidden("Owner password (min 12 chars): ");
  if (password.length < 12) throw new Error("password must be at least 12 characters");
  if (process.env.GTC_OWNER_PASSWORD_STDIN !== "1") {
    const again = await promptHidden("Repeat password: ");
    if (again !== password) throw new Error("passwords do not match");
  }
  const auth = buildAuth(db, { BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000", BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "" });
  const ctx = await auth.$context;
  const hash = await ctx.password.hash(password);
  const created = await ctx.internalAdapter.createUser({ email, name: "Owner", emailVerified: true }, { method: "email-password" });
  await ctx.internalAdapter.linkAccount({ userId: created.id, providerId: "credential", accountId: created.id, password: hash });
  console.log(`Owner ${email} created. Enable TOTP two-factor in Settings after first login.`);
  await close();
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});

// Creates .env from .env.example for a local SIMULATION run and fills in any placeholder values.
// Values that were already set are kept, so running it again is safe. Used by setup.sh.
// Usage: node scripts/local-env.mjs   (OWNER_EMAIL and GTC_DB_PORT are read from the environment)
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const created = !existsSync(".env");
const lines = readFileSync(created ? ".env.example" : ".env", "utf8").split(/\r?\n/);
const get = (k) => lines.find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1) ?? "";
const set = (k, v) => {
  const i = lines.findIndex((l) => l.startsWith(`${k}=`));
  if (i >= 0) lines[i] = `${k}=${v}`;
  else lines.push(`${k}=${v}`);
};
const isPlaceholder = (v) => !v || /example\.com|replace|REPLACE/.test(v);

if (isPlaceholder(get("GTC_ENCRYPTION_KEYS"))) {
  const keyId = `k${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
  set("GTC_ENCRYPTION_ACTIVE_KEY_ID", keyId);
  set("GTC_ENCRYPTION_KEYS", `${keyId}:${randomBytes(32).toString("base64")}`);
}
if (isPlaceholder(get("BETTER_AUTH_SECRET"))) set("BETTER_AUTH_SECRET", randomBytes(32).toString("base64url"));
if (isPlaceholder(get("GTC_DOMAIN"))) set("GTC_DOMAIN", "localhost");
if (isPlaceholder(get("BETTER_AUTH_URL"))) set("BETTER_AUTH_URL", "http://localhost:3000");
if (isPlaceholder(get("PUBLIC_BRIDGE_URL"))) set("PUBLIC_BRIDGE_URL", "http://localhost:3000");
if (isPlaceholder(get("OWNER_EMAIL")) && process.env.OWNER_EMAIL) set("OWNER_EMAIL", process.env.OWNER_EMAIL);

// A brand-new .env gets its own database password (hex, so it is safe inside the URL).
if (created) {
  const password = randomBytes(18).toString("hex");
  const port = process.env.GTC_DB_PORT || "5432";
  set("POSTGRES_PASSWORD", password);
  set("DATABASE_URL", `postgres://gtc:${password}@localhost:${port}/gtc`);
}

writeFileSync(".env", lines.join("\n"), { mode: 0o600 });
console.log(created ? "created .env" : "updated .env");

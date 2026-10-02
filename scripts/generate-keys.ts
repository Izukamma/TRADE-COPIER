import { randomBytes } from "node:crypto";

/** Prints fresh secrets for .env. Never commit the output. */
const keyId = `k${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
console.log(`# Generated ${new Date().toISOString()} — store outside the repository`);
console.log(`GTC_ENCRYPTION_ACTIVE_KEY_ID=${keyId}`);
console.log(`GTC_ENCRYPTION_KEYS=${keyId}:${randomBytes(32).toString("base64")}`);
console.log(`BETTER_AUTH_SECRET=${randomBytes(32).toString("base64url")}`);
console.log(`POSTGRES_PASSWORD=${randomBytes(24).toString("base64url")}`);

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Secret storage: AES-256-GCM with a key that lives outside the database (environment / secret file).
 * Ciphertexts are bound to their record via AAD so a value copied to another row fails to decrypt.
 * Format: v1:<keyId>:<iv>:<tag>:<ciphertext> (base64url parts)
 */
export interface KeyRing {
  activeKeyId: string;
  keys: Map<string, Buffer>;
}

export function loadKeyRing(env: NodeJS.ProcessEnv = process.env): KeyRing {
  const raw = env.GTC_ENCRYPTION_KEYS;
  const active = env.GTC_ENCRYPTION_ACTIVE_KEY_ID;
  if (!raw || !active) throw new Error("GTC_ENCRYPTION_KEYS and GTC_ENCRYPTION_ACTIVE_KEY_ID must be set (see .env.example)");
  const keys = new Map<string, Buffer>();
  for (const pair of raw.split(",")) {
    const [id, b64] = pair.split(":");
    if (!id || !b64) throw new Error("GTC_ENCRYPTION_KEYS must be 'keyId:base64key[,keyId:base64key]'");
    const k = Buffer.from(b64, "base64");
    if (k.length !== 32) throw new Error(`encryption key ${id} must be 32 bytes`);
    keys.set(id, k);
  }
  if (!keys.has(active)) throw new Error(`active key id ${active} not present in GTC_ENCRYPTION_KEYS`);
  return { activeKeyId: active, keys };
}

export function encryptSecret(ring: KeyRing, plaintext: string, aad: string): string {
  const key = ring.keys.get(ring.activeKeyId)!;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return ["v1", ring.activeKeyId, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(":");
}

export function decryptSecret(ring: KeyRing, blob: string, aad: string): string {
  const [v, keyId, iv, tag, ct] = blob.split(":");
  if (v !== "v1" || !keyId || !iv || !tag || ct === undefined) throw new Error("malformed secret blob");
  const key = ring.keys.get(keyId);
  if (!key) throw new Error(`unknown encryption key id ${keyId}`);
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

/* ------------------------------ Bridge device tokens ------------------------------ */

export interface NewDeviceToken {
  tokenId: string;
  secret: string;
  /** Shown once to the owner, pasted into the EA inputs. */
  display: string;
}

export function generateDeviceToken(): NewDeviceToken {
  const tokenId = randomBytes(8).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  return { tokenId, secret, display: `gtcd_${tokenId}_${secret}` };
}

export function parseDeviceToken(display: string): { tokenId: string; secret: string } | null {
  const m = /^gtcd_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/.exec(display.trim());
  return m ? { tokenId: m[1]!, secret: m[2]! } : null;
}

export const sha256Hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** Canonical string signed by bridges: ts \n nonce \n METHOD \n path \n sha256(body) */
export function bridgeCanonical(ts: string, nonce: string, method: string, path: string, body: string): string {
  return `${ts}\n${nonce}\n${method.toUpperCase()}\n${path}\n${sha256Hex(body)}`;
}

export function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(message, "utf8").digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || !/^[0-9a-f]*$/i.test(a) || !/^[0-9a-f]*$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

import { createHash } from "node:crypto";

/**
 * Copier trade tags. Every follower order the copier places carries `gtc1:<clientId>`
 * (MT comment, TradeLocker strategyId). Positions with this prefix are never treated as
 * master trades, which prevents copying copier-generated trades into another route.
 */
export const TAG_PREFIX = "gtc1:";
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Deterministic 12-char client id derived from a durable job key. */
export function clientIdFor(jobKey: string): string {
  const h = createHash("sha256").update(jobKey).digest();
  let out = "";
  for (let i = 0; i < 12; i++) out += ALPHABET[h[i]! % 32];
  return out;
}

export const tagFor = (clientId: string) => `${TAG_PREFIX}${clientId}`;
export const isCopierTag = (tag: string | null | undefined) => !!tag && tag.trim().toLowerCase().startsWith(TAG_PREFIX);
export function clientIdFromTag(tag: string | null | undefined): string | null {
  if (!isCopierTag(tag)) return null;
  const id = tag!.trim().slice(TAG_PREFIX.length, TAG_PREFIX.length + 12).toLowerCase();
  return /^[0-9a-z]{12}$/.test(id) ? id : null;
}

/** Magic number on copier-placed MetaTrader orders (comments can be altered by brokers). */
export const COPIER_MAGIC = 7_710_001;

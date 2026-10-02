import "server-only";
import { loadKeyRing, type KeyRing } from "@gtc/shared/crypto";

let ring: KeyRing | null = null;
/** Encryption keys come from the environment / secret files, never from the database. */
export function keyRing(): KeyRing {
  if (!ring) ring = loadKeyRing(process.env);
  return ring;
}

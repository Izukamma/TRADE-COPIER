import "server-only";
import { buildAuth, type Auth } from "./auth-core";
import { db } from "./db";
import { env } from "./env";

const g = globalThis as unknown as { __gtcAuth?: Auth };
export function auth(): Auth {
  if (!g.__gtcAuth) g.__gtcAuth = buildAuth(db(), env());
  return g.__gtcAuth;
}

import "server-only";
import { createDb, type DbHandle } from "@gtc/db";
import { env } from "./env";

const g = globalThis as unknown as { __gtcDb?: DbHandle };
export function db() {
  if (!g.__gtcDb) g.__gtcDb = createDb(env().DATABASE_URL, { max: 5 });
  return g.__gtcDb.db;
}

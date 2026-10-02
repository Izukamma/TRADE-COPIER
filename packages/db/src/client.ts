import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;
export type Sql = postgres.Sql;

export interface DbHandle {
  db: Db;
  sql: Sql;
  close: () => Promise<void>;
}

export function createDb(url = process.env.DATABASE_URL, opts: { max?: number } = {}): DbHandle {
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, {
    max: opts.max ?? 10,
    idle_timeout: 30,
    connect_timeout: 10,
    // Never print query parameters (they may contain encrypted secrets).
    debug: false,
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}

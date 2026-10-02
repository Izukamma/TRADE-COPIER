import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createDb } from "./client";

export async function runMigrations(url = process.env.DATABASE_URL) {
  const h = createDb(url, { max: 1 });
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
  try {
    await migrate(h.db, { migrationsFolder: dir });
  } finally {
    await h.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runMigrations()
    .then(() => {
      console.log("migrations applied");
    })
    .catch((e) => {
      console.error("migration failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
}

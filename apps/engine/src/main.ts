import { createDb, runMigrations } from "@gtc/db";
import { loadKeyRing } from "@gtc/shared/crypto";
import { createBridgeServer } from "./bridge/server";
import { loadConfig } from "./config";
import { Engine } from "./engine";
import { createLogger } from "./logger";

/**
 * Gabriel Trade Copier engine: a long-running process, independent of the dashboard.
 * Copying continues with the browser closed. Exits via SIGTERM/SIGINT drain in-flight work.
 */
async function main() {
  const cfg = loadConfig();
  const ring = loadKeyRing();
  if (process.env.GTC_AUTO_MIGRATE !== "false") await runMigrations(cfg.DATABASE_URL);
  const { db, close } = createDb(cfg.DATABASE_URL, { max: 15 });
  const log = createLogger(db, cfg.LOG_LEVEL);
  const engine = new Engine(db, cfg, ring, log);
  await engine.start();

  const server = createBridgeServer({
    db,
    ring,
    hub: engine.hub,
    log,
    maxSkewMs: cfg.BRIDGE_MAX_SKEW_MS,
    onSync: (id) => engine.bridgeSynced(id),
    health: () => ({ engine: "running", version: "0.1.0" }),
  });
  server.listen(cfg.BRIDGE_PORT, cfg.BRIDGE_HOST, () => log.info("bridge", `bridge endpoint listening on ${cfg.BRIDGE_HOST}:${cfg.BRIDGE_PORT}`));

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info("engine", `received ${sig}; shutting down`);
    server.close();
    await engine.stop();
    await close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (e) => log.error("engine", "unhandled rejection", { err: String((e as Error)?.message ?? e) }));
}

main().catch((e) => {
  console.error("engine failed to start:", (e as Error).message);
  process.exit(1);
});

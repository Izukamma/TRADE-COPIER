import { eq, inArray, lt, sql } from "drizzle-orm";
import { appSettings, connectionEvents, copierGroups, engineHeartbeats, engineLogs, routes, symbolMappings, type Db } from "@gtc/db";
import type { KeyRing } from "@gtc/shared/crypto";
import { ConnectionManager } from "./accounts";
import { BridgeHub } from "./bridge/hub";
import { pruneNonces } from "./bridge/server";
import type { EngineConfig } from "./config";
import { ControlProcessor } from "./control";
import { Executor } from "./executor";
import type { Log } from "./logger";
import { LinkMonitor } from "./monitor";
import { RiskService } from "./risk";
import { Router } from "./router";
import { SimStore } from "./sim-store";
import { MasterWatcher } from "./watcher";

export const ENGINE_VERSION = "0.1.0";

/** Periodic task runner with overlap protection and error isolation. */
class Loop {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private kick = false;
  constructor(
    private name: string,
    private everyMs: number,
    private fn: () => Promise<unknown>,
    private log: Log,
  ) {}
  start() {
    const run = async () => {
      if (this.busy) {
        this.kick = true;
        return;
      }
      this.busy = true;
      try {
        await this.fn();
      } catch (e) {
        this.log.error("engine", `${this.name} loop error`, { err: (e as Error).message });
      } finally {
        this.busy = false;
        if (this.kick) {
          this.kick = false;
          setImmediate(run);
        }
      }
    };
    this.timer = setInterval(run, this.everyMs);
    this.trigger = () => setImmediate(run);
    setImmediate(run);
  }
  trigger: () => void = () => {};
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
  async drain(timeoutMs = 15_000) {
    const end = Date.now() + timeoutMs;
    while (this.busy && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  }
}

export class Engine {
  readonly hub: BridgeHub;
  readonly sims: SimStore;
  readonly conn: ConnectionManager;
  readonly watcher: MasterWatcher;
  readonly router: Router;
  readonly risk: RiskService;
  readonly executor: Executor;
  readonly monitor: LinkMonitor;
  readonly control: ControlProcessor;
  private loops: Loop[] = [];
  private startedAt = new Date();
  private masterIds = new Set<string>();
  private needed = new Map<string, Set<string>>();

  constructor(
    private db: Db,
    private cfg: EngineConfig,
    ring: KeyRing,
    private log: Log,
  ) {
    this.hub = new BridgeHub(db);
    this.sims = new SimStore(db);
    this.conn = new ConnectionManager(db, cfg, ring, this.hub, this.sims, log);
    this.watcher = new MasterWatcher(db, log);
    this.router = new Router(db, log);
    this.risk = new RiskService(db, this.conn, log);
    this.executor = new Executor(db, cfg, this.conn, this.risk, log, cfg.ENGINE_INSTANCE_ID);
    this.monitor = new LinkMonitor(db, this.conn, log);
    this.control = new ControlProcessor(db, this.conn, log);

    this.conn.neededSymbols = (id) => [...(this.needed.get(id) ?? [])];
    this.conn.onMasterSnapshot = async (accountId, snap) => {
      const rt = this.conn.runtimes.get(accountId);
      const source = rt?.row.environment === "SIMULATION" ? "SIMULATION" : rt?.row.platform === "MT4" || rt?.row.platform === "MT5" ? "BRIDGE" : "POLL";
      await this.watcher.onSnapshot(accountId, snap, source);
    };
    this.risk.onCloseRequest = async (accountId, reason) => {
      await this.db.insert((await import("@gtc/db")).controlCommands).values({ kind: "CLOSE_COPIER_POSITIONS", payload: { scope: "ACCOUNT", id: accountId, reason }, requestedBy: "engine:daily-loss" });
    };
  }

  /** Reloads routes/accounts/mappings configuration from the database. */
  async reload() {
    const groups = await this.db.select().from(copierGroups);
    const activeRoutes = await this.db.select().from(routes).where(eq(routes.active, true));
    const activeGroupIds = new Set(activeRoutes.map((r) => r.groupId));
    this.masterIds = new Set(groups.filter((g) => activeGroupIds.has(g.id)).map((g) => g.masterAccountId));
    await this.conn.reload(this.masterIds);
    await this.risk.loadGlobal();
    const fxRow = await this.db.query.appSettings.findFirst({ where: eq(appSettings.key, "fx.manual") });
    this.conn.setManualFx(((fxRow?.value as { base: string; quote: string; rate: number; time: number }[] | undefined) ?? []).filter((r) => r.rate > 0));

    // Symbols needing specs/quotes: mapped symbols on both sides.
    const maps = await this.db.select().from(symbolMappings).where(inArray(symbolMappings.status, ["CONFIRMED", "SUGGESTED"]));
    this.needed.clear();
    const add = (acc: string, sym: string) => this.needed.set(acc, new Set([...(this.needed.get(acc) ?? []), sym]));
    for (const m of maps) {
      add(m.masterAccountId, m.masterSymbol);
      add(m.followerAccountId, m.followerSymbol);
    }
    for (const [acc, syms] of this.needed) {
      const rt = this.conn.runtimes.get(acc);
      if (rt && (rt.row.platform === "MT4" || rt.row.platform === "MT5")) this.hub.setWatchSymbols(acc, [...syms]);
    }
  }

  async heartbeat() {
    const accounts = [...this.conn.runtimes.values()].map((rt) => ({
      id: rt.row.id,
      nickname: rt.row.nickname,
      platform: rt.row.platform,
      environment: rt.row.environment,
      status: rt.lastStatus,
      connected: rt.connected,
      isMaster: rt.isMaster,
      snapshotAgeMs: rt.snapshotAt ? Date.now() - rt.snapshotAt : null,
      health: rt.adapter?.health() ?? null,
      dailyLoss: this.risk.dailyStatus.get(rt.row.id) ?? null,
    }));
    const depth = await this.db.execute(sql`select state, count(*)::int as n from execution_jobs where state in ('QUEUED','SUBMITTED','ACCEPTED','UNKNOWN') group by state`);
    const stats = {
      executor: this.executor.stats,
      queue: Object.fromEntries((depth as unknown as { state: string; n: number }[]).map((r) => [r.state, r.n])),
      accounts,
      globalPause: this.risk.globalPause,
      uptimeSec: Math.round((Date.now() - this.startedAt.getTime()) / 1000),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    };
    await this.db
      .insert(engineHeartbeats)
      .values({ instanceId: this.cfg.ENGINE_INSTANCE_ID, startedAt: this.startedAt, lastBeatAt: new Date(), version: ENGINE_VERSION, liveTradingEnabled: this.cfg.LIVE_TRADING_ENABLED, stats })
      .onConflictDoUpdate({ target: engineHeartbeats.instanceId, set: { lastBeatAt: new Date(), stats, liveTradingEnabled: this.cfg.LIVE_TRADING_ENABLED, startedAt: this.startedAt, version: ENGINE_VERSION } });
  }

  async retention() {
    const days = this.cfg.LOG_RETENTION_DAYS;
    await this.db.delete(engineLogs).where(lt(engineLogs.at, new Date(Date.now() - days * 86_400_000)));
    await this.db.delete(connectionEvents).where(lt(connectionEvents.at, new Date(Date.now() - 30 * 86_400_000)));
    await pruneNonces(this.db, 10 * 60_000);
  }

  async start() {
    await this.reload();
    const L = (name: string, ms: number, fn: () => Promise<unknown>) => {
      const l = new Loop(name, ms, fn, this.log);
      this.loops.push(l);
      return l;
    };
    const routerLoop = L("router", 250, () => this.router.routePending());
    const execLoop = L("executor", 100, async () => {
      // Drain while there is work.
      for (let i = 0; i < 20 && (await this.executor.runOnce()) > 0; i++);
    });
    this.watcher.onEvents = () => routerLoop.trigger();
    this.router.onJobs = () => execLoop.trigger();
    this.control.onReload = () => this.reload();
    this.control.onEvents = () => routerLoop.trigger();
    L("config", 3000, () => this.reload());
    L("connections", 100, () => this.conn.tick());
    L("control", 500, () => this.control.runOnce());
    L("risk", 3000, () => this.risk.evaluate());
    L("monitor", 2000, () => this.monitor.run());
    L("fx", 10_000, () => this.conn.refreshFxQuotes());
    L("sim-persist", 1000, () => this.sims.flush());
    L("heartbeat", 2000, () => this.heartbeat());
    L("retention", 3_600_000, () => this.retention());
    for (const l of this.loops) l.start();
    this.log.info("engine", "engine started", { instance: this.cfg.ENGINE_INSTANCE_ID, liveTradingEnabled: this.cfg.LIVE_TRADING_ENABLED });
  }

  /** Bridge sync arrived: read it immediately instead of waiting for the next tick. */
  bridgeSynced(accountId: string) {
    const rt = this.conn.runtimes.get(accountId);
    if (rt) rt.nextRefreshAt = 0;
  }

  async stop() {
    for (const l of this.loops) l.stop();
    for (const l of this.loops) await l.drain();
    await this.sims.flush();
    await this.log.flush();
    this.log.info("engine", "engine stopped");
  }
}

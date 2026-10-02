import { and, asc, eq, inArray } from "drizzle-orm";
import { appSettings, auditLog, controlCommands, copierGroups, copyLinks, executionJobs, masterEvents, routes, tradingAccounts, transitionJob, type Db } from "@gtc/db";
import type { SimFaults } from "@gtc/adapters";
import type { MasterEventPayload, Side } from "@gtc/shared";
import type { ConnectionManager } from "./accounts";
import type { Log } from "./logger";

type Cmd = typeof controlCommands.$inferSelect;
type Result = Record<string, unknown>;

/**
 * Processes owner commands written by the dashboard. The dashboard never talks to a broker:
 * it records intent in `control_commands`, and the engine performs it and records the result.
 */
export class ControlProcessor {
  onReload?: () => Promise<void>;
  onEvents?: () => void;

  constructor(
    private db: Db,
    private conn: ConnectionManager,
    private log: Log,
  ) {}

  async runOnce() {
    const pending = await this.db.select().from(controlCommands).where(eq(controlCommands.status, "PENDING")).orderBy(asc(controlCommands.createdAt)).limit(10);
    for (const c of pending) {
      const claimed = await this.db
        .update(controlCommands)
        .set({ status: "RUNNING", startedAt: new Date() })
        .where(and(eq(controlCommands.id, c.id), eq(controlCommands.status, "PENDING")))
        .returning({ id: controlCommands.id });
      if (!claimed.length) continue;
      let status: "DONE" | "FAILED" = "DONE";
      let result: Result;
      try {
        result = await this.execute(c);
      } catch (e) {
        status = "FAILED";
        result = { error: (e as Error).message };
      }
      await this.db.update(controlCommands).set({ status, result, finishedAt: new Date() }).where(eq(controlCommands.id, c.id));
      await this.db.insert(auditLog).values({ actor: "engine", action: `control.${c.kind}.${status.toLowerCase()}`, target: c.id, detail: result });
    }
  }

  private async execute(c: Cmd): Promise<Result> {
    const p = c.payload as Record<string, unknown>;
    switch (c.kind) {
      case "RELOAD":
        await this.onReload?.();
        return { reloaded: true };
      case "TEST_CONNECTION":
        return this.testConnection(String(p.accountId));
      case "SYNC_INSTRUMENTS": {
        await this.onReload?.();
        const n = await this.conn.syncInstruments(String(p.accountId), Array.isArray(p.symbols) ? (p.symbols as string[]) : undefined);
        return { instruments: n };
      }
      case "CLOSE_COPIER_POSITIONS":
        return this.closeCopierPositions(p as { scope: string; id?: string }, c.requestedBy);
      case "COPY_EXISTING":
        return this.copyExisting(String(p.routeId));
      case "SIM_ACTION":
        return this.simAction(p);
      case "SIM_FAULTS":
        return this.simFaults(String(p.accountId), p.faults as SimFaults);
      case "RESOLVE_JOB": {
        const job = await this.db.query.executionJobs.findFirst({ where: eq(executionJobs.id, String(p.jobId)) });
        if (!job || job.state !== "NEEDS_ATTENTION") throw new Error("job is not awaiting attention");
        await transitionJob(this.db, job, "RECONCILED", { reason: `resolved by owner: ${String(p.note ?? "").slice(0, 200)}` }, "manual resolution");
        return { resolved: true };
      }
      case "DETACH_LINK": {
        await this.db.update(copyLinks).set({ status: "DETACHED", statusDetail: "detached by owner", closedAt: new Date(), updatedAt: new Date() }).where(eq(copyLinks.id, String(p.linkId)));
        return { detached: true };
      }
      default:
        throw new Error(`unknown control command ${c.kind}`);
    }
  }

  private async testConnection(accountId: string): Promise<Result> {
    await this.onReload?.();
    const rt = this.conn.runtimes.get(accountId);
    if (!rt) throw new Error("account not loaded (disabled?)");
    if (!rt.adapter) return { ok: false, status: "NOT_CONFIGURED", detail: rt.buildError };
    rt.connected = false;
    rt.nextConnectAt = 0;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await this.conn.tick();
      if (rt.connected && rt.snapshotAt && rt.snapshotAt > Date.now() - 20_000) break;
      if (rt.lastStatus === "AUTH_FAILED" || rt.lastStatus === "NOT_CONFIGURED") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const h = rt.adapter.health();
    return {
      ok: rt.connected && !!rt.snapshot,
      status: rt.lastStatus,
      balance: rt.snapshot?.account.balance ?? null,
      equity: rt.snapshot?.account.equity ?? null,
      currency: rt.snapshot?.account.currency ?? null,
      positions: rt.snapshot?.positions.length ?? null,
      latencyMs: h.avgLatencyMs,
      lastError: h.lastError,
      capabilities: rt.adapter.capabilities,
    };
  }

  /** Creates CONTROL close events for copier-managed positions in scope; also pauses entries in that scope. */
  private async closeCopierPositions(p: { scope: string; id?: string }, by: string): Promise<Result> {
    const all = await this.db.select().from(copyLinks).where(inArray(copyLinks.status, ["OPEN", "PENDING_ORDER"]));
    let links = all;
    if (p.scope === "ROUTE") links = all.filter((l) => l.routeId === p.id);
    else if (p.scope === "ACCOUNT") links = all.filter((l) => l.followerAccountId === p.id);
    else if (p.scope === "GROUP") {
      const rs = await this.db.select().from(routes).where(eq(routes.groupId, String(p.id)));
      const ids = new Set(rs.map((r) => r.id));
      links = all.filter((l) => ids.has(l.routeId));
    } else if (p.scope !== "GLOBAL") throw new Error("invalid scope");

    // Pause entries first so nothing new opens while closing.
    if (p.scope === "GLOBAL") await this.db.insert(appSettings).values({ key: "pause.global", value: { paused: true, reason: "close copier positions", at: new Date().toISOString() } }).onConflictDoUpdate({ target: appSettings.key, set: { value: { paused: true, reason: "close copier positions", at: new Date().toISOString() }, updatedAt: new Date() } });
    if (p.scope === "ROUTE") await this.db.update(routes).set({ entriesPaused: true }).where(eq(routes.id, String(p.id)));
    if (p.scope === "GROUP") await this.db.update(copierGroups).set({ entriesPaused: true }).where(eq(copierGroups.id, String(p.id)));
    if (p.scope === "ACCOUNT") await this.db.update(tradingAccounts).set({ entriesPaused: true }).where(eq(tradingAccounts.id, String(p.id)));

    const stamp = Date.now();
    let n = 0;
    for (const l of links) {
      const payload: MasterEventPayload = {
        type: l.status === "PENDING_ORDER" ? "ORDER_CANCELLED" : "POSITION_CLOSED",
        masterKey: l.masterKey,
        positionId: l.masterPositionId ?? undefined,
        orderId: l.masterOrderId ?? undefined,
        symbol: l.masterSymbol,
        side: l.side as Side,
        volume: 0,
        previousVolume: l.masterVolumeCurrent,
        sl: null,
        tp: null,
        openTime: 0,
        tag: null,
      };
      await this.db
        .insert(masterEvents)
        .values({ accountId: l.masterAccountId, eventKey: `control:${stamp}:${l.id}`, type: payload.type, payload, source: "CONTROL", targetRouteId: l.routeId })
        .onConflictDoNothing();
      n++;
    }
    this.log.warn("control", `close copier positions requested (${p.scope})`, { by, links: n });
    this.onEvents?.();
    return { scope: p.scope, closeRequests: n, entriesPaused: true };
  }

  /** Explicit, opt-in copy of master positions that already exist (bypasses entry age). */
  private async copyExisting(routeId: string): Promise<Result> {
    const route = await this.db.query.routes.findFirst({ where: eq(routes.id, routeId) });
    if (!route || !route.active) throw new Error("route must be active");
    const group = await this.db.query.copierGroups.findFirst({ where: eq(copierGroups.id, route.groupId) });
    const master = group ? this.conn.runtimes.get(group.masterAccountId) : undefined;
    if (!master?.snapshot) throw new Error("master snapshot unavailable");
    let n = 0;
    for (const p of master.snapshot.positions) {
      if (p.tag && p.tag.startsWith("gtc1:")) continue;
      const payload: MasterEventPayload = {
        type: "POSITION_OPENED",
        masterKey: p.orderId ?? p.id,
        positionId: p.id,
        symbol: p.symbol,
        side: p.side,
        kind: "MARKET",
        volume: p.volume,
        price: p.openPrice,
        sl: p.sl,
        tp: p.tp,
        openTime: p.openTime,
        tag: p.tag,
        magic: p.magic ?? null,
      };
      const r = await this.db
        .insert(masterEvents)
        .values({ accountId: group!.masterAccountId, eventKey: `existing:${routeId}:${p.id}`, type: payload.type, payload, source: "EXISTING", targetRouteId: routeId })
        .onConflictDoNothing()
        .returning({ id: masterEvents.id });
      if (r.length) n++;
    }
    this.onEvents?.();
    return { queued: n, note: "entry-age check bypassed for these explicit copies; price deviation still applies" };
  }

  private simBroker(accountId: string) {
    const rt = this.conn.runtimes.get(accountId);
    if (!rt || rt.row.environment !== "SIMULATION") throw new Error("simulator actions are only allowed on SIMULATION accounts");
    const adapter = rt.adapter as unknown as { broker?: import("@gtc/adapters").SimBroker };
    if (!adapter?.broker) throw new Error("simulator not loaded");
    return { broker: adapter.broker, rt };
  }

  private async simAction(p: Record<string, unknown>): Promise<Result> {
    const { broker, rt } = this.simBroker(String(p.accountId));
    const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
    const action = String(p.action);
    let r: unknown;
    switch (action) {
      case "OPEN":
        r = broker.openMarket(String(p.symbol), p.side === "SELL" ? "SELL" : "BUY", Number(p.volume), num(p.sl), num(p.tp), null, num(p.magic));
        break;
      case "PENDING":
        r = broker.placePending(String(p.symbol), p.side === "SELL" ? "SELL" : "BUY", p.kind === "STOP" ? "STOP" : "LIMIT", Number(p.volume), Number(p.price), num(p.sl), num(p.tp), null, num(p.magic));
        break;
      case "MODIFY":
        r = broker.modifyPosition(String(p.positionId), num(p.sl), num(p.tp));
        break;
      case "CLOSE":
        r = broker.closePosition(String(p.positionId), p.volume !== undefined && p.volume !== null && p.volume !== "" ? Number(p.volume) : undefined);
        break;
      case "CANCEL":
        r = broker.cancelPending(String(p.orderId));
        break;
      case "SET_PRICE":
        broker.setMid(String(p.symbol), Number(p.mid));
        r = { ok: true, quote: broker.quote(String(p.symbol)) };
        break;
      case "DEPOSIT":
        broker.state.balance += Number(p.amount);
        r = { ok: true, balance: broker.state.balance };
        break;
      default:
        throw new Error(`unknown simulator action ${action}`);
    }
    rt.nextRefreshAt = 0;
    return { action, result: r as Result };
  }

  private async simFaults(accountId: string, faults: SimFaults): Promise<Result> {
    const { broker } = this.simBroker(accountId);
    const clamp = (n: unknown) => Math.min(1, Math.max(0, Number(n) || 0));
    broker.state.faults = { rejectRate: clamp(faults.rejectRate), lostResponseRate: clamp(faults.lostResponseRate), notSentRate: clamp(faults.notSentRate), latencyMs: Math.min(30_000, Math.max(0, Number(faults.latencyMs) || 0)) };
    return { faults: broker.state.faults };
  }
}

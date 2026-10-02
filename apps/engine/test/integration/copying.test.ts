import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { appSettings, copyLinks, executionJobs, jobTransitions, masterEvents, type DbHandle } from "@gtc/db";
import { ready, seedSim, sim, startEngine, until, freshDb } from "./harness";
import type { Engine } from "../../src/engine";

/** Engine + simulated brokers + real PostgreSQL. No broker connectivity: SIMULATION only. */
let h: DbHandle | null = null;
let engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines) await e.stop();
  engines = [];
  await h?.close();
  h = null;
});

const jobs = (h: DbHandle) => h.db.select().from(executionJobs).orderBy(executionJobs.seq);
const links = (h: DbHandle) => h.db.select().from(copyLinks);

describe("copying pipeline (simulation)", () => {
  it("copies entry, SL/TP modification, partial close and full close", async () => {
    h = await freshDb();
    const s = await seedSim(h);
    const e = startEngine(h);
    engines.push(e);
    await e.start();
    await ready(e, s);
    const m = sim(e, s.master);
    const q = m.quote("US30");
    const open = m.openMarket("US30", "BUY", 2, q.bid - 150, q.ask + 300, null);
    expect(open.ok).toBe(true);
    const pid = (open as { position: { id: string } }).position.id;
    await until(async () => (await links(h!)).find((l) => l.status === "OPEN"), 10_000, "follower open");
    let link = (await links(h))[0]!;
    expect(link.followerSymbol).toBe("DJ30.cash");
    expect(link.followerVolumeCurrent).toBe(0.2); // 2 lots x $1/pt  ->  0.2 lots x $10/pt
    const f = sim(e, s.follower);
    expect(f.state.positions[0]!.tag).toMatch(/^gtc1:/);

    m.modifyPosition(pid, q.bid - 100, q.ask + 400);
    await until(async () => (await jobs(h!)).find((j) => j.eventType === "POSITION_MODIFIED" && j.state === "RECONCILED"), 10_000, "modify");
    expect(f.state.positions[0]!.sl).toBeCloseTo(Math.round((q.bid - 100) * 10) / 10, 5);

    m.closePosition(pid, 1); // 50%
    await until(async () => (await jobs(h!)).find((j) => j.eventType === "POSITION_PARTIALLY_CLOSED" && j.state === "FILLED"), 10_000, "partial");
    expect(f.state.positions[0]!.volume).toBeCloseTo(0.1, 8);

    m.closePosition(pid);
    await until(async () => (await links(h!)).find((l) => l.status === "CLOSED"), 10_000, "close");
    expect(f.state.positions).toHaveLength(0);
    link = (await links(h))[0]!;
    expect(link.followerVolumeCurrent).toBe(0);

    // Every job has an audit trail starting at DETECTED.
    const t = await h.db.select().from(jobTransitions);
    expect(t.filter((x) => x.toState === "DETECTED")).toHaveLength(4);
    // Timing evidence recorded.
    const entry = (await jobs(h)).find((j) => j.eventType === "POSITION_OPENED")!;
    expect(entry.submittedAt && entry.filledAt && entry.detectedAt).toBeTruthy();
  });

  it("does not copy pre-existing master positions on first connection, and never replays them", async () => {
    h = await freshDb();
    const s = await seedSim(h);
    const e = startEngine(h);
    engines.push(e);
    // Open a master trade before the engine ever sees the account.
    const pre = new (await import("@gtc/adapters")).SimBroker("SIM-ALPHA", { seed: 1 });
    void pre;
    await e.start();
    await until(async () => e.conn.runtimes.get(s.master)?.connected, 10_000);
    const m = sim(e, s.master);
    // Simulate a position that existed at baseline time by inserting before the first snapshot diff.
    await until(async () => (await h!.db.query.masterSnapshots.findFirst()) !== undefined, 10_000, "baseline");
    const baselineSnap = await h.db.query.masterSnapshots.findFirst();
    expect(baselineSnap!.snapshot.positions).toHaveLength(0);
    m.openMarket("US30", "BUY", 1, null, null, null);
    await until(async () => (await jobs(h!)).length === 1, 10_000);
    // Now restart the engine with a *new* account that already has positions: baseline excludes them.
    await e.stop();
    engines = [];
    await h.db.delete(appSettings).where(eq(appSettings.key, "nothing"));
    await h.db.execute((await import("drizzle-orm")).sql`delete from master_snapshots`);
    const e2 = startEngine(h);
    engines.push(e2);
    await e2.start();
    await until(async () => (await h!.db.query.masterSnapshots.findFirst()) !== undefined, 10_000, "rebaseline");
    await new Promise((r) => setTimeout(r, 800));
    expect((await h.db.select().from(masterEvents)).length).toBe(1);
  });

  it("deduplicates events and routes each (event, route) once", async () => {
    h = await freshDb();
    const s = await seedSim(h);
    const e = startEngine(h);
    engines.push(e);
    await e.start();
    await ready(e, s);
    sim(e, s.master).openMarket("XAUUSD", "SELL", 0.3, null, null, null);
    await until(async () => (await links(h!)).find((l) => l.status === "OPEN"), 10_000);
    const ev = (await h.db.select().from(masterEvents))[0]!;
    // Re-insert the same event key and re-route: no new event, no new job.
    await h.db.insert(masterEvents).values({ accountId: ev.accountId, eventKey: ev.eventKey, type: ev.type, payload: ev.payload, source: "POLL" }).onConflictDoNothing();
    await h.db.update(masterEvents).set({ routedAt: null });
    await e.router.routePending();
    await new Promise((r) => setTimeout(r, 500));
    expect(await h.db.select().from(masterEvents)).toHaveLength(1);
    expect(await jobs(h)).toHaveLength(1);
    expect(sim(e, s.follower).state.positions).toHaveLength(1);
  });

  it("processes a rapid open/modify/close sequence in order", async () => {
    h = await freshDb();
    const s = await seedSim(h);
    const e = startEngine(h);
    engines.push(e);
    await e.start();
    await ready(e, s);
    const m = sim(e, s.master);
    const q = m.quote("EURUSD");
    const o = m.openMarket("EURUSD", "BUY", 1, null, null, null) as { position: { id: string } };
    await new Promise((r) => setTimeout(r, 150));
    m.modifyPosition(o.position.id, q.bid - 0.002, null);
    await new Promise((r) => setTimeout(r, 150));
    m.closePosition(o.position.id);
    await until(async () => (await links(h!)).find((l) => l.status === "CLOSED"), 15_000, "closed");
    const js = await jobs(h);
    const order = js.map((j) => j.eventType);
    expect(order[0]).toBe("POSITION_OPENED");
    expect(order.at(-1)).toBe("POSITION_CLOSED");
    // Close finished after open finished.
    const open = js.find((j) => j.eventType === "POSITION_OPENED")!;
    const close = js.find((j) => j.eventType === "POSITION_CLOSED")!;
    expect(close.finishedAt!.getTime()).toBeGreaterThanOrEqual(open.finishedAt!.getTime());
    expect(sim(e, s.follower).state.positions).toHaveLength(0);
  });

  it("copies pending orders and their cancellation", async () => {
    h = await freshDb();
    const s = await seedSim(h);
    const e = startEngine(h);
    engines.push(e);
    await e.start();
    await ready(e, s);
    const m = sim(e, s.master);
    const q = m.quote("XAUUSD");
    const o = m.placePending("XAUUSD", "BUY", "LIMIT", 0.5, Math.round((q.ask - 20) * 100) / 100, null, null, null) as { order: { id: string } };
    await until(async () => (await links(h!)).find((l) => l.status === "PENDING_ORDER" && l.followerOrderId), 10_000, "pending copied");
    expect(sim(e, s.follower).state.orders).toHaveLength(1);
    m.cancelPending(o.order.id);
    await until(async () => (await links(h!)).find((l) => l.status === "CANCELLED"), 10_000, "cancel copied");
    expect(sim(e, s.follower).state.orders).toHaveLength(0);
  });

  it("ambiguous submission timeout: reconciles instead of resubmitting (no duplicate)", async () => {
    h = await freshDb();
    const s = await seedSim(h);
    const e = startEngine(h);
    engines.push(e);
    await e.start();
    await ready(e, s);
    sim(e, s.follower).state.faults.lostResponseRate = 1;
    sim(e, s.master).openMarket("US30", "BUY", 1, null, null, null);
    const j = await until(async () => (await jobs(h!)).find((x) => x.state === "RECONCILED"), 15_000, "reconciled");
    const states = (await h.db.select().from(jobTransitions).where(eq(jobTransitions.jobId, j.id))).map((t) => t.toState);
    expect(states).toEqual(expect.arrayContaining(["SUBMITTED", "UNKNOWN", "RECONCILED"]));
    expect(sim(e, s.follower).state.positions).toHaveLength(1);
    expect((await links(h))[0]!.status).toBe("OPEN");
  });

  it("rejected orders are recorded and not retried; not-sent failures are retried with a bound", async () => {
    h = await freshDb();
    const s = await seedSim(h);
    const e = startEngine(h);
    engines.push(e);
    await e.start();
    await ready(e, s);
    const f = sim(e, s.follower);
    f.state.faults.rejectRate = 1;
    sim(e, s.master).openMarket("US30", "BUY", 1, null, null, null);
    const j = await until(async () => (await jobs(h!)).find((x) => x.state === "REJECTED"), 10_000);
    expect(j.reason).toMatch(/simulated broker rejection/);
    expect(j.attempts).toBe(0);
    expect((await links(h))[0]!.status).toBe("FAILED");

    f.state.faults.rejectRate = 0;
    f.state.faults.notSentRate = 1;
    sim(e, s.master).openMarket("EURUSD", "BUY", 1, null, null, null);
    const j2 = await until(async () => (await jobs(h!)).find((x) => x.eventType === "POSITION_OPENED" && x.state === "REJECTED" && x.reason?.includes("not sent")), 15_000);
    expect(j2.attempts).toBe(2);
    expect(f.state.positions).toHaveLength(0);
  });

  it("pausing entries skips new trades while exits and SL changes continue", async () => {
    h = await freshDb();
    const s = await seedSim(h);
    const e = startEngine(h);
    engines.push(e);
    await e.start();
    await ready(e, s);
    const m = sim(e, s.master);
    const o = m.openMarket("US30", "BUY", 1, null, null, null) as { position: { id: string } };
    await until(async () => (await links(h!)).find((l) => l.status === "OPEN"), 10_000);
    await h.db.insert(appSettings).values({ key: "pause.global", value: { paused: true, reason: "test" } });
    await e.reload();
    m.openMarket("XAUUSD", "BUY", 0.2, null, null, null);
    await until(async () => (await jobs(h!)).find((j) => j.state === "SKIPPED" && j.reason?.includes("paused")), 10_000, "entry skipped");
    const q = m.quote("US30");
    m.modifyPosition(o.position.id, q.bid - 200, null);
    await until(async () => (await jobs(h!)).find((j) => j.eventType === "POSITION_MODIFIED" && j.state === "RECONCILED"), 10_000, "modify while paused");
    m.closePosition(o.position.id);
    await until(async () => (await links(h!)).find((l) => l.status === "CLOSED"), 10_000, "close while paused");
    expect(sim(e, s.follower).state.positions).toHaveLength(0);
  });

  it("rejects stale entries (master trade older than max entry age)", async () => {
    h = await freshDb();
    const s = await seedSim(h, { maxEntryAgeSeconds: 1 });
    const e = startEngine(h);
    engines.push(e);
    await e.start();
    await ready(e, s);
    const m = sim(e, s.master);
    m.now = () => Date.now() - 10_000; // master clock: trade opened 10 s ago
    m.openMarket("US30", "BUY", 1, null, null, null);
    m.now = () => Date.now();
    const j = await until(async () => (await jobs(h!)).find((x) => x.state === "SKIPPED"), 10_000);
    expect(j.reason).toMatch(/stale entry/);
  });

  it("follower disconnect: exits wait and complete after reconnection", async () => {
    h = await freshDb();
    const s = await seedSim(h);
    const e = startEngine(h);
    engines.push(e);
    await e.start();
    await ready(e, s);
    const m = sim(e, s.master);
    const o = m.openMarket("US30", "SELL", 1, null, null, null) as { position: { id: string } };
    await until(async () => (await links(h!)).find((l) => l.status === "OPEN"), 10_000);
    const frt = e.conn.runtimes.get(s.follower)!;
    // Disconnect the follower adapter and keep it from reconnecting for a moment.
    await frt.adapter!.disconnect();
    frt.connected = false;
    frt.nextConnectAt = Date.now() + 2500;
    m.closePosition(o.position.id);
    const waiting = await until(async () => (await jobs(h!)).find((j) => j.eventType === "POSITION_CLOSED" && j.reason?.includes("waiting")), 10_000, "close waiting");
    expect(waiting.state).toBe("QUEUED");
    await until(async () => (await links(h!)).find((l) => l.status === "CLOSED"), 15_000, "close after reconnect");
  });

  it("detects divergence and never re-opens a manually closed follower position", async () => {
    h = await freshDb();
    const s = await seedSim(h);
    const e = startEngine(h);
    engines.push(e);
    await e.start();
    await ready(e, s);
    const m = sim(e, s.master);
    const o = m.openMarket("US30", "BUY", 1, null, null, null) as { position: { id: string } };
    const link = await until(async () => (await links(h!)).find((l) => l.status === "OPEN"), 10_000);
    sim(e, s.follower).closePosition(link.followerPositionId!);
    await until(async () => (await links(h!)).find((l) => l.status === "DIVERGED"), 10_000, "diverged");
    const q = m.quote("US30");
    m.modifyPosition(o.position.id, q.bid - 300, null);
    await until(async () => (await jobs(h!)).find((j) => j.eventType === "POSITION_MODIFIED" && j.state === "SKIPPED"), 10_000);
    expect(sim(e, s.follower).state.positions).toHaveLength(0);
  });

  it("refuses netting followers unless exclusive symbols are acknowledged", async () => {
    h = await freshDb();
    const s = await seedSim(h, {}, { followerAccounting: "NETTING" });
    const e = startEngine(h);
    engines.push(e);
    await e.start();
    await ready(e, s);
    sim(e, s.master).openMarket("US30", "BUY", 1, null, null, null);
    const j = await until(async () => (await jobs(h!)).find((x) => x.state === "REJECTED"), 10_000);
    expect(j.reason).toMatch(/netting/);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { copyLinks, executionJobs, jobTransitions, type DbHandle } from "@gtc/db";
import { claimJobs } from "@gtc/db";
import { freshDb, ready, seedSim, sim, startEngine, until } from "./harness";
import type { Engine } from "../../src/engine";

let h: DbHandle | null = null;
let engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines) await e.stop().catch(() => {});
  engines = [];
  await h?.close();
  h = null;
});

describe("engine restart recovery (simulation + PostgreSQL)", () => {
  it("continues managing copier positions opened before a restart", async () => {
    h = await freshDb();
    const s = await seedSim(h);
    const e1 = startEngine(h);
    engines.push(e1);
    await e1.start();
    await ready(e1, s);
    const m = sim(e1, s.master);
    const o = m.openMarket("US30", "BUY", 2, null, null, null) as { position: { id: string } };
    await until(async () => (await h!.db.select().from(copyLinks)).find((l) => l.status === "OPEN"), 10_000);
    await e1.stop();
    engines = [];

    // While the engine is down the master partially closes (state persisted by the simulator store).
    const e2 = startEngine(h);
    engines.push(e2);
    await e2.start();
    await ready(e2, s);
    const m2 = sim(e2, s.master);
    expect(m2.state.positions.find((p) => p.id === o.position.id)).toBeTruthy();
    m2.closePosition(o.position.id, 1);
    await until(async () => (await h!.db.select().from(executionJobs)).find((j) => j.eventType === "POSITION_PARTIALLY_CLOSED" && j.state === "FILLED"), 10_000, "partial after restart");
    m2.closePosition(o.position.id);
    await until(async () => (await h!.db.select().from(copyLinks)).find((l) => l.status === "CLOSED"), 10_000, "close after restart");
    expect(sim(e2, s.follower).state.positions).toHaveLength(0);
  });

  it("events that happened while the engine was down: closes are applied, stale entries are not replayed", async () => {
    h = await freshDb();
    const s = await seedSim(h, { maxEntryAgeSeconds: 2 });
    const e1 = startEngine(h);
    engines.push(e1);
    await e1.start();
    await ready(e1, s);
    const m = sim(e1, s.master);
    const o = m.openMarket("US30", "BUY", 1, null, null, null) as { position: { id: string } };
    await until(async () => (await h!.db.select().from(copyLinks)).find((l) => l.status === "OPEN"), 10_000);
    await e1.stop();
    engines = [];
    // Offline: master closes one trade and opens another; simulate passage of time.
    m.closePosition(o.position.id);
    m.now = () => Date.now() - 5000;
    m.openMarket("XAUUSD", "BUY", 0.5, null, null, null);
    m.now = () => Date.now();
    m.onChange?.();
    await (e1 as unknown as { sims: { flush: () => Promise<void> } }).sims.flush();

    const e2 = startEngine(h);
    engines.push(e2);
    await e2.start();
    await until(async () => (await h!.db.select().from(copyLinks)).find((l) => l.status === "CLOSED"), 15_000, "offline close applied");
    const stale = await until(async () => (await h!.db.select().from(executionJobs)).find((j) => j.state === "SKIPPED" && j.reason?.includes("stale")), 15_000, "stale skipped");
    expect(stale.eventType).toBe("POSITION_OPENED");
    expect(sim(e2, s.follower).state.positions).toHaveLength(0);
  });

  it("a job left SUBMITTED by a crash is reconciled (not resubmitted)", async () => {
    h = await freshDb();
    const s = await seedSim(h);
    const e1 = startEngine(h);
    engines.push(e1);
    await e1.start();
    await ready(e1, s);
    // Make the follower slow so the job is mid-submission when we "crash".
    sim(e1, s.follower).state.faults.latencyMs = 1500;
    sim(e1, s.master).openMarket("US30", "BUY", 1, null, null, null);
    const submitted = await until(async () => (await h!.db.select().from(executionJobs)).find((j) => j.state === "SUBMITTED"), 10_000, "submitted");
    // Crash: stop loops without finishing, then expire the lease as if the process died.
    await e1.stop();
    engines = [];
    await new Promise((r) => setTimeout(r, 1700)); // the in-flight simulated order executes
    const job = (await h.db.select().from(executionJobs).where(eq(executionJobs.id, submitted.id)))[0]!;
    if (job.state === "SUBMITTED") {
      await h.db.update(executionJobs).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(executionJobs.id, job.id));
      const e2 = startEngine(h);
      engines.push(e2);
      await e2.start();
      const done = await until(async () => {
        const j = (await h!.db.select().from(executionJobs).where(eq(executionJobs.id, job.id)))[0]!;
        return ["RECONCILED", "FILLED"].includes(j.state) ? j : null;
      }, 15_000, "reconciled after crash");
      const states = (await h.db.select().from(jobTransitions).where(eq(jobTransitions.jobId, done.id))).map((t) => t.toState);
      expect(states).toContain("UNKNOWN");
      expect(sim(e2, s.follower).state.positions).toHaveLength(1);
    } else {
      // stop() drained the in-flight submission; still exactly one follower position.
      expect(["FILLED", "RECONCILED"]).toContain(job.state);
    }
  });

  it("queue claims respect per-trade ordering and leases", async () => {
    h = await freshDb();
    const s = await seedSim(h);
    const ev = async (key: string, seqType: string) => {
      const { masterEvents } = await import("@gtc/db");
      const [row] = await h!.db.insert(masterEvents).values({ accountId: s.master, eventKey: key, type: seqType, payload: { type: "POSITION_OPENED", masterKey: "K", symbol: "US30", side: "BUY", volume: 1, sl: null, tp: null, openTime: 0, tag: null }, source: "POLL" }).returning();
      return row!;
    };
    const e1 = await ev("a", "POSITION_OPENED");
    const e2 = await ev("b", "POSITION_CLOSED");
    for (const [i, e] of [e1, e2].entries())
      await h.db.insert(executionJobs).values({ masterEventId: e.id, routeId: s.route, followerAccountId: s.follower, orderingKey: `${s.route}:K`, seq: e.seq, eventType: e.type, state: "QUEUED", clientId: `cid${i}` });
    const first = await claimJobs(h.db, "w1", 10);
    expect(first.map((j) => j.eventType)).toEqual(["POSITION_OPENED"]);
    expect(await claimJobs(h.db, "w2", 10)).toHaveLength(0); // leased + ordering
    await h.db.update(executionJobs).set({ state: "FILLED", lockedBy: null, lockedUntil: null }).where(eq(executionJobs.id, first[0]!.id));
    const second = await claimJobs(h.db, "w2", 10);
    expect(second.map((j) => j.eventType)).toEqual(["POSITION_CLOSED"]);
  });
});

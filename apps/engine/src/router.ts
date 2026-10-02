import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { copierGroups, executionJobs, jobTransitions, masterEvents, routes, type Db } from "@gtc/db";
import { clientIdFor } from "@gtc/shared";
import type { Log } from "./logger";

/**
 * Fans each master event out to one job per active route of the master's groups.
 * Jobs are keyed (event, route) so routing twice is harmless. Ordering key = route + master
 * trade identity, so all jobs for one master trade on one route run strictly in sequence.
 */
export class Router {
  onJobs?: () => void;
  constructor(
    private db: Db,
    private log: Log,
  ) {}

  async routePending(limit = 200): Promise<number> {
    const events = await this.db.select().from(masterEvents).where(isNull(masterEvents.routedAt)).orderBy(asc(masterEvents.seq)).limit(limit);
    if (!events.length) return 0;
    const masterIds = [...new Set(events.map((e) => e.accountId))];
    const groupRows = await this.db.select().from(copierGroups).where(inArray(copierGroups.masterAccountId, masterIds));
    const routeRows = groupRows.length
      ? await this.db.select().from(routes).where(and(inArray(routes.groupId, groupRows.map((g) => g.id)), eq(routes.active, true)))
      : [];
    let created = 0;
    for (const ev of events) {
      const gids = new Set(groupRows.filter((g) => g.masterAccountId === ev.accountId).map((g) => g.id));
      const targets = routeRows.filter((r) => gids.has(r.groupId) && (!ev.targetRouteId || r.id === ev.targetRouteId));
      await this.db.transaction(async (tx) => {
        for (const r of targets) {
          const ins = await tx
            .insert(executionJobs)
            .values({
              masterEventId: ev.id,
              routeId: r.id,
              followerAccountId: r.followerAccountId,
              orderingKey: `${r.id}:${ev.payload.masterKey}`,
              seq: ev.seq,
              eventType: ev.type,
              state: "QUEUED",
              clientId: clientIdFor(`${ev.id}:${r.id}`),
              masterPrice: ev.payload.price ?? null,
              masterTime: ev.platformTime,
              detectedAt: ev.detectedAt,
              queuedAt: new Date(),
            })
            .onConflictDoNothing()
            .returning({ id: executionJobs.id });
          if (ins[0]) {
            await tx.insert(jobTransitions).values([
              { jobId: ins[0].id, fromState: null, toState: "DETECTED", detail: `${ev.type} ${ev.payload.symbol} ${ev.payload.side} ${ev.payload.volume}` },
              { jobId: ins[0].id, fromState: "DETECTED", toState: "QUEUED", detail: `route ${r.id}` },
            ]);
            created++;
          }
        }
        await tx.update(masterEvents).set({ routedAt: new Date() }).where(eq(masterEvents.id, ev.id));
      });
    }
    if (created) {
      this.log.debug("router", `queued ${created} job(s)`);
      this.onJobs?.();
    }
    return created;
  }
}

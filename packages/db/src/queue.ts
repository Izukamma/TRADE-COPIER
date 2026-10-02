import { and, eq, sql } from "drizzle-orm";
import { assertTransition, BLOCKING_STATES, isTerminal, type ExecState } from "@gtc/shared";
import type { Db } from "./client";
import { executionJobs, jobTransitions } from "./schema";

export type Job = typeof executionJobs.$inferSelect;

const CLAIMABLE: ExecState[] = ["QUEUED", "ACCEPTED", "UNKNOWN", "SUBMITTED"];

/**
 * Claims up to `limit` runnable jobs. A job is runnable when it is due, not leased by a live
 * worker, and no earlier job with the same ordering key is still in a blocking state.
 * SUBMITTED jobs are only claimable once their lease expired (crash during submission) — the
 * executor then treats them as UNKNOWN and reconciles before doing anything else.
 */
export async function claimJobs(db: Db, workerId: string, limit: number, leaseMs = 30_000): Promise<Job[]> {
  const blocking = sql.raw(BLOCKING_STATES.map((s) => `'${s}'`).join(","));
  const claimable = sql.raw(CLAIMABLE.map((s) => `'${s}'`).join(","));
  const rows = await db.execute(sql`
    update execution_jobs j
       set locked_by = ${workerId},
           locked_until = now() + (${leaseMs} || ' milliseconds')::interval,
           updated_at = now()
     where j.id in (
       select c.id from execution_jobs c
        where c.state in (${claimable})
          and c.next_attempt_at <= now()
          and (c.locked_until is null or c.locked_until < now())
          and (c.state <> 'SUBMITTED' or c.locked_until is not null)
          and not exists (
            select 1 from execution_jobs p
             where p.ordering_key = c.ordering_key
               and p.seq < c.seq
               and p.state in (${blocking})
          )
        order by c.seq
        limit ${limit}
        for update skip locked
     )
     returning j.id`);
  const ids = (rows as unknown as { id: string }[]).map((r) => r.id);
  if (ids.length === 0) return [];
  const jobs = await db.query.executionJobs.findMany({ where: (t, { inArray }) => inArray(t.id, ids) });
  return jobs.sort((a, b) => a.seq - b.seq);
}

export interface TransitionPatch extends Partial<Omit<Job, "id" | "state">> {}

/** Atomic, validated state transition with an audit row. Optimistic on the current state. */
export async function transitionJob(db: Db, job: Pick<Job, "id" | "state">, to: ExecState, patch: TransitionPatch = {}, detail?: string): Promise<boolean> {
  assertTransition(job.state, to);
  const now = new Date();
  const timestamps: TransitionPatch = {};
  if (to === "QUEUED") timestamps.queuedAt = patch.queuedAt ?? now;
  if (to === "SUBMITTED") timestamps.submittedAt = now;
  if (to === "ACCEPTED") timestamps.acceptedAt = now;
  if (to === "FILLED") timestamps.filledAt = patch.filledAt ?? now;
  if (isTerminal(to)) timestamps.finishedAt = now;
  return db.transaction(async (tx) => {
    const res = await tx
      .update(executionJobs)
      .set({ ...patch, ...timestamps, state: to, updatedAt: now, ...(isTerminal(to) ? { lockedBy: null, lockedUntil: null } : {}) })
      .where(and(eq(executionJobs.id, job.id), eq(executionJobs.state, job.state)))
      .returning({ id: executionJobs.id });
    if (res.length === 0) return false;
    await tx.insert(jobTransitions).values({ jobId: job.id, fromState: job.state, toState: to, detail: detail?.slice(0, 2000) ?? null });
    (job as { state: ExecState }).state = to;
    return true;
  });
}

/** Releases a lease and schedules the next attempt without changing state. */
export async function rescheduleJob(db: Db, jobId: string, delayMs: number, patch: TransitionPatch = {}) {
  await db
    .update(executionJobs)
    .set({ ...patch, lockedBy: null, lockedUntil: null, nextAttemptAt: new Date(Date.now() + delayMs), updatedAt: new Date() })
    .where(eq(executionJobs.id, jobId));
}

/** Exponential backoff with jitter, bounded. */
export function backoffMs(attempt: number, baseMs = 500, maxMs = 30_000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

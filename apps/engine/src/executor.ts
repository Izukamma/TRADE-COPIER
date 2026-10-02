import { and, eq, inArray } from "drizzle-orm";
import {
  backoffMs,
  claimJobs,
  copierGroups,
  copyLinks,
  executionJobs,
  masterEvents,
  rescheduleJob,
  routes,
  symbolMappings,
  transitionJob,
  type Db,
  type Job,
} from "@gtc/db";
import {
  accountRiskSchema,
  clientIdFor,
  COPIER_MAGIC,
  followerSettingsSchema,
  isCopierTag,
  roundTo,
  tagFor,
  type ExecutionCommand,
  type ReconcileResult,
  type SubmitOutcome,
} from "@gtc/shared";
import type { ConnectionManager } from "./accounts";
import type { EngineConfig } from "./config";
import type { Log } from "./logger";
import { isEntry, plan, type LinkView, type PlanContext } from "./planner";
import { raiseAlert, type RiskService } from "./risk";

type LinkRow = typeof copyLinks.$inferSelect;

const SUBMIT_TIMEOUT_MS = 20_000;
const MAX_RETRYABLE_ATTEMPTS = 3;
const MAX_EXIT_WAIT_ATTEMPTS = 60;
const MAX_RECONCILE_ATTEMPTS = 5;
const MAX_FILL_CHECKS = 10;

export interface ExecutorStats {
  processed: number;
  submitted: number;
  filled: number;
  rejected: number;
  skipped: number;
  unknown: number;
  needsAttention: number;
  lastJobAt: number | null;
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(onTimeout()), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Claims jobs from the durable queue and drives them through the execution state machine:
 * QUEUED -> SUBMITTED -> ACCEPTED -> FILLED, with REJECTED, SKIPPED, UNKNOWN -> RECONCILED and
 * NEEDS_ATTENTION. An UNKNOWN submission is always reconciled against platform state before any
 * retry; if that cannot be done conclusively the job is flagged instead of resubmitted.
 */
export class Executor {
  stats: ExecutorStats = { processed: 0, submitted: 0, filled: 0, rejected: 0, skipped: 0, unknown: 0, needsAttention: 0, lastJobAt: null };
  private running = false;

  constructor(
    private db: Db,
    private cfg: EngineConfig,
    private conn: ConnectionManager,
    private risk: RiskService,
    private log: Log,
    private workerId: string,
  ) {}

  /** One pass: claim and process runnable jobs. Returns number processed. */
  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const jobs = await claimJobs(this.db, this.workerId, this.cfg.EXECUTOR_CONCURRENCY, SUBMIT_TIMEOUT_MS + 10_000);
      // Different ordering keys may run concurrently; claimJobs never returns two runnable jobs
      // for the same key at once because later ones are blocked by earlier non-terminal ones.
      await Promise.all(
        jobs.map((j) =>
          this.process(j).catch(async (e) => {
            this.log.error("executor", "job processing failed", { jobId: j.id, err: (e as Error).message });
            await rescheduleJob(this.db, j.id, backoffMs(j.attempts + 1), { reason: `internal error: ${(e as Error).message}`.slice(0, 500) });
          }),
        ),
      );
      this.stats.processed += jobs.length;
      if (jobs.length) this.stats.lastJobAt = Date.now();
      return jobs.length;
    } finally {
      this.running = false;
    }
  }

  async process(job: Job) {
    if (job.state === "SUBMITTED") {
      // Lease expired mid-submission (engine crash/restart): outcome unknown, reconcile first.
      await transitionJob(this.db, job, "UNKNOWN", { lockedUntil: new Date(Date.now() + 30_000) }, "lease expired during submission (restart?)");
      this.stats.unknown++;
      return this.reconcileUnknown(job);
    }
    if (job.state === "UNKNOWN") return this.reconcileUnknown(job);
    if (job.state === "ACCEPTED") return this.confirm(job);
    if (job.state === "QUEUED") return this.planAndSubmit(job);
  }

  /* ---------------------------------------------------------------------------------------- */

  private linkView(l: LinkRow | undefined | null): LinkView | null {
    if (!l) return null;
    return {
      id: l.id,
      status: l.status,
      followerPositionId: l.followerPositionId,
      followerOrderId: l.followerOrderId,
      followerSymbol: l.followerSymbol,
      side: l.side,
      masterVolumeCurrent: l.masterVolumeCurrent,
      followerVolumeCurrent: l.followerVolumeCurrent,
      masterOpenPrice: l.masterOpenPrice,
      followerOpenPrice: l.followerOpenPrice,
    };
  }

  private async findLink(routeId: string, masterKey: string, positionId?: string) {
    const byKey = await this.db.query.copyLinks.findFirst({ where: and(eq(copyLinks.routeId, routeId), eq(copyLinks.masterKey, masterKey)) });
    if (byKey || !positionId) return byKey;
    return this.db.query.copyLinks.findFirst({ where: and(eq(copyLinks.routeId, routeId), eq(copyLinks.masterPositionId, positionId)) });
  }

  private async planAndSubmit(job: Job) {
    const ev = await this.db.query.masterEvents.findFirst({ where: eq(masterEvents.id, job.masterEventId) });
    const route = await this.db.query.routes.findFirst({ where: eq(routes.id, job.routeId) });
    if (!ev || !route) return transitionJob(this.db, job, "SKIPPED", { reason: "event or route deleted" });
    const group = await this.db.query.copierGroups.findFirst({ where: eq(copierGroups.id, route.groupId) });
    const payload = ev.payload;
    const entry = isEntry(payload.type);
    const follower = this.conn.runtimes.get(route.followerAccountId);
    const master = this.conn.runtimes.get(ev.accountId);
    const settings = followerSettingsSchema.parse(route.settings);

    // Follower not reachable: entries are rejected (they would be stale), exits wait and retry.
    if (!follower?.adapter || !follower.connected) {
      const why = `follower ${follower?.row.nickname ?? route.followerAccountId} not connected`;
      if (entry) return this.reject(job, why, true);
      if (job.attempts >= MAX_EXIT_WAIT_ATTEMPTS) {
        await raiseAlert(this.db, { severity: "CRITICAL", code: "EXIT_NOT_COPIED", message: `${payload.type} for ${payload.symbol} could not be copied: ${why}`, accountId: route.followerAccountId, routeId: route.id, jobId: job.id });
        return this.reject(job, `${why}; gave up after ${job.attempts} attempts`, false);
      }
      return rescheduleJob(this.db, job.id, backoffMs(job.attempts + 1, 1000, 15_000), { attempts: job.attempts + 1, reason: `${why}; waiting` });
    }

    const link = await this.findLink(route.id, payload.masterKey, payload.positionId);
    const baseClientId = job.clientId;
    const ownLink = !!link && link.clientId === (job.command?.clientId ?? baseClientId) && (link.status === "OPENING" || link.status === "PENDING_ORDER");
    // A retry after a conclusive "not found" uses a fresh attempt id (so its tag can be told apart).
    const attemptClientId = job.command?.clientId && job.command.clientId !== baseClientId ? job.command.clientId : baseClientId;

    const mapping = await this.db.query.symbolMappings.findFirst({
      where: and(eq(symbolMappings.masterAccountId, ev.accountId), eq(symbolMappings.followerAccountId, route.followerAccountId), eq(symbolMappings.masterSymbol, payload.symbol)),
    });
    const followerSymbol = link?.followerSymbol ?? mapping?.followerSymbol ?? null;
    const followerSpec = followerSymbol ? (follower.specs.get(followerSymbol) ?? null) : null;
    let followerQuote = null;
    let followerQuoteError: string | null = null;
    const needsQuote = entry || payload.type === "POSITION_MODIFIED";
    if (followerSymbol && needsQuote) {
      try {
        followerQuote = await this.conn.quote(route.followerAccountId, followerSymbol, 250);
      } catch (e) {
        followerQuoteError = (e as Error).message;
      }
    }
    const risk = accountRiskSchema.parse(follower.row.riskConfig ?? {});
    const exposure = await this.risk.exposure(route.id, route.followerAccountId);
    const unrelated = followerSymbol ? (follower.snapshot?.positions.filter((p) => p.symbol === followerSymbol && !isCopierTag(p.tag)).length ?? 0) : 0;

    const ctx: PlanContext = {
      now: Date.now(),
      liveTradingEnabled: this.cfg.LIVE_TRADING_ENABLED,
      event: payload,
      eventDetectedAt: ev.detectedAt.getTime(),
      eventSource: ev.source,
      settings,
      pauses: { global: this.risk.globalPause.paused, group: !!group?.entriesPaused, route: route.entriesPaused, account: follower.row.entriesPaused },
      dailyLossBreached: this.risk.dailyLossBreached(route.followerAccountId),
      follower: {
        environment: follower.row.environment,
        liveExecutionArmed: follower.row.liveExecutionArmed,
        capabilities: follower.adapter.capabilities,
        snapshot: follower.snapshot,
        snapshotAgeMs: follower.snapshotAt ? Date.now() - follower.snapshotAt : null,
        risk,
        magic: COPIER_MAGIC,
      },
      master: {
        equity: master?.snapshot?.account.equity ?? master?.row.equity ?? null,
        balance: master?.snapshot?.account.balance ?? master?.row.balance ?? null,
        currency: master?.snapshot?.account.currency ?? master?.row.currency ?? null,
        spec: master?.specs.get(payload.symbol) ?? null,
      },
      mapping: mapping ? { followerSymbol: mapping.followerSymbol, status: mapping.status } : null,
      followerSpec,
      followerQuote,
      followerQuoteError,
      link: ownLink ? null : this.linkView(link),
      exposure,
      unrelatedPositionsOnSymbol: unrelated,
      fx: this.conn.fx(),
      clientId: attemptClientId,
      tag: tagFor(attemptClientId),
    };
    const p = plan(ctx);

    if (p.kind === "SKIP") {
      if (payload.type === "POSITION_INCREASED")
        await raiseAlert(this.db, { severity: "WARNING", code: "SCALE_IN_NOT_COPIED", message: `master scaled into ${payload.symbol} (${payload.previousVolume} -> ${payload.volume}); not copied`, routeId: route.id, jobId: job.id });
      this.stats.skipped++;
      return transitionJob(this.db, job, "SKIPPED", { reason: p.reason, detail: { notes: p.notes ?? [] } }, p.reason);
    }
    if (p.kind === "REJECT") {
      if (link && ownLink) await this.db.update(copyLinks).set({ status: "FAILED", statusDetail: p.reason, updatedAt: new Date() }).where(eq(copyLinks.id, link.id));
      return this.reject(job, p.reason, entry, p.notes);
    }
    if (p.kind === "LINK_ONLY") {
      if (link) await this.db.update(copyLinks).set({ masterPositionId: payload.positionId ?? link.masterPositionId, updatedAt: new Date() }).where(eq(copyLinks.id, link.id));
      return transitionJob(this.db, job, "SKIPPED", { reason: p.reason }, p.reason);
    }

    // SUBMIT. Entries create the link first (unique per route+master trade) so a crash after
    // submission still leaves a durable record pointing at the client id.
    const cmd = p.command;
    if (p.opensLink && !ownLink) {
      const ins = await this.db
        .insert(copyLinks)
        .values({
          routeId: route.id,
          masterAccountId: ev.accountId,
          followerAccountId: route.followerAccountId,
          masterKey: payload.masterKey,
          masterPositionId: payload.positionId ?? null,
          masterOrderId: payload.orderId ?? null,
          clientId: cmd.clientId,
          masterSymbol: payload.symbol,
          followerSymbol: p.opensLink.followerSymbol,
          side: payload.side,
          masterVolumeInitial: payload.volume,
          masterVolumeCurrent: payload.volume,
          followerVolumeInitial: p.opensLink.volume,
          followerVolumeCurrent: 0,
          masterOpenPrice: payload.price ?? null,
          status: p.opensLink.pending ? "PENDING_ORDER" : "OPENING",
        })
        .onConflictDoNothing()
        .returning({ id: copyLinks.id });
      if (!ins[0]) return transitionJob(this.db, job, "SKIPPED", { reason: "duplicate entry suppressed (link exists)" }, "duplicate");
    } else if (p.opensLink && ownLink && link) {
      await this.db.update(copyLinks).set({ clientId: cmd.clientId, followerVolumeInitial: p.opensLink.volume, updatedAt: new Date() }).where(eq(copyLinks.id, link.id));
    }

    const ok = await transitionJob(
      this.db,
      job,
      "SUBMITTED",
      { command: cmd, requestedVolume: cmd.volume ?? null, detail: { notes: p.notes }, lockedUntil: new Date(Date.now() + SUBMIT_TIMEOUT_MS + 10_000) },
      `${cmd.kind} ${cmd.symbol} ${cmd.side ?? ""} ${cmd.volume ?? ""}`.trim(),
    );
    if (!ok) return;
    this.stats.submitted++;
    const submittedAt = Date.now();
    let outcome: SubmitOutcome;
    try {
      outcome = await withTimeout(follower.adapter.submit(cmd), SUBMIT_TIMEOUT_MS, () => ({ status: "UNKNOWN", reason: `no response within ${SUBMIT_TIMEOUT_MS}ms` }) as SubmitOutcome);
    } catch (e) {
      outcome = { status: "UNKNOWN", reason: `adapter threw after submission: ${(e as Error).message}` };
    }
    await this.handleOutcome(job, cmd, outcome, submittedAt, p.referencePrice);
  }

  private async reject(job: Job, reason: string, entry: boolean, notes?: string[]) {
    this.stats.rejected++;
    await transitionJob(this.db, job, "REJECTED", { reason, detail: notes ? { notes } : job.detail }, reason);
    if (entry) {
      await raiseAlert(this.db, { severity: "WARNING", code: "ENTRY_REJECTED", message: reason, accountId: job.followerAccountId, routeId: job.routeId, jobId: job.id });
    } else {
      await raiseAlert(this.db, { severity: "CRITICAL", code: "MANAGEMENT_REJECTED", message: `${job.eventType}: ${reason}`, accountId: job.followerAccountId, routeId: job.routeId, jobId: job.id });
    }
  }

  private async handleOutcome(job: Job, cmd: ExecutionCommand, outcome: SubmitOutcome, submittedAt: number, referencePrice?: number) {
    if (outcome.status === "REJECTED") {
      const entry = cmd.kind === "OPEN_MARKET" || cmd.kind === "PLACE_PENDING";
      if (outcome.retryable && job.attempts + 1 < MAX_RETRYABLE_ATTEMPTS) {
        await transitionJob(this.db, job, "REJECTED", { reason: outcome.reason }, `retryable: ${outcome.reason}`);
        await transitionJob(this.db, job, "QUEUED", { attempts: job.attempts + 1, nextAttemptAt: new Date(Date.now() + backoffMs(job.attempts + 1)), lockedBy: null, lockedUntil: null }, "retry after definite non-execution");
        return;
      }
      await this.failLinkFor(cmd, outcome.reason);
      return this.reject(job, outcome.reason, entry);
    }
    if (outcome.status === "UNKNOWN") {
      this.stats.unknown++;
      await transitionJob(this.db, job, "UNKNOWN", { reason: outcome.reason, nextAttemptAt: new Date(Date.now() + 1500), lockedBy: null, lockedUntil: null }, outcome.reason);
      return;
    }
    // ACCEPTED
    await this.applyAccepted(job, cmd, outcome, submittedAt, referencePrice);
  }

  private async applyAccepted(job: Job, cmd: ExecutionCommand, o: Extract<SubmitOutcome, { status: "ACCEPTED" }> | (ReconcileResult & { status?: "ACCEPTED" }), _submittedAt: number, referencePrice?: number, viaReconcile = false) {
    const link = await this.db.query.copyLinks.findFirst({ where: eq(copyLinks.clientId, cmd.clientId) });
    const now = new Date();
    if (cmd.kind === "OPEN_MARKET") {
      if (o.filled && o.positionId) {
        const fillPrice = o.fillPrice ?? null;
        const filledVolume = o.filledVolume ?? cmd.volume ?? 0;
        const tick = this.conn.runtimes.get(job.followerAccountId)?.specs.get(cmd.symbol)?.tickSize;
        // Positive = worse than the master price for this side.
        const diff = fillPrice !== null && job.masterPrice && tick ? roundTo(((fillPrice - job.masterPrice) / tick) * (cmd.side === "BUY" ? 1 : -1), 2) : null;
        if (link)
          await this.db
            .update(copyLinks)
            .set({ status: "OPEN", followerPositionId: o.positionId, followerOrderId: o.orderId ?? null, followerOpenPrice: fillPrice ?? referencePrice ?? null, followerVolumeInitial: filledVolume, followerVolumeCurrent: filledVolume, openedAt: now, updatedAt: now })
            .where(eq(copyLinks.id, link.id));
        await this.finish(job, viaReconcile ? "RECONCILED" : "FILLED", { followerOrderId: o.orderId ?? null, followerPositionId: o.positionId, filledVolume, fillPrice, priceDiffPoints: diff, filledAt: now }, viaReconcile ? "reconciled: position found" : "filled");
        this.stats.filled++;
        return;
      }
      // Accepted, not yet known to be filled.
      if (job.state !== "ACCEPTED") await transitionJob(this.db, job, "ACCEPTED", { followerOrderId: o.orderId ?? null, nextAttemptAt: new Date(Date.now() + 700), lockedBy: null, lockedUntil: null }, "accepted; awaiting fill confirmation");
      return;
    }
    if (cmd.kind === "PLACE_PENDING") {
      if (link) await this.db.update(copyLinks).set({ status: "PENDING_ORDER", followerOrderId: o.orderId ?? null, updatedAt: now }).where(eq(copyLinks.id, link.id));
      if (job.state === "ACCEPTED" || viaReconcile) return this.finish(job, "RECONCILED", { followerOrderId: o.orderId ?? null }, "pending order confirmed");
      return transitionJob(this.db, job, "ACCEPTED", { followerOrderId: o.orderId ?? null, nextAttemptAt: new Date(Date.now() + 700), lockedBy: null, lockedUntil: null }, "pending order accepted");
    }
    const ev = await this.db.query.masterEvents.findFirst({ where: eq(masterEvents.id, job.masterEventId) });
    const route = await this.db.query.routes.findFirst({ where: eq(routes.id, job.routeId) });
    const mlink = ev && route ? await this.findLink(route.id, ev.payload.masterKey, ev.payload.positionId) : null;
    if (cmd.kind === "CLOSE_POSITION") {
      if (mlink) {
        if (cmd.volume === undefined) {
          await this.db.update(copyLinks).set({ status: "CLOSED", followerVolumeCurrent: 0, masterVolumeCurrent: ev?.payload.volume ?? 0, closedAt: now, updatedAt: now }).where(eq(copyLinks.id, mlink.id));
        } else {
          const closed = o.filledVolume ?? cmd.volume;
          // MT4 gives the remainder a new ticket; follow it so later closes target the right position.
          const remainderId = o.positionId && o.positionId !== cmd.positionId ? o.positionId : mlink.followerPositionId;
          await this.db
            .update(copyLinks)
            .set({ followerPositionId: remainderId, followerVolumeCurrent: roundTo(Math.max(0, mlink.followerVolumeCurrent - closed), 8), masterVolumeCurrent: ev?.payload.volume ?? mlink.masterVolumeCurrent, updatedAt: now })
            .where(eq(copyLinks.id, mlink.id));
        }
      }
      if (o.filled || viaReconcile) return this.finish(job, viaReconcile ? "RECONCILED" : "FILLED", { fillPrice: o.fillPrice ?? null, filledVolume: o.filledVolume ?? cmd.volume ?? null, filledAt: now }, "close executed");
      if (job.state !== "ACCEPTED") return transitionJob(this.db, job, "ACCEPTED", { nextAttemptAt: new Date(Date.now() + 700), lockedBy: null, lockedUntil: null }, "close accepted; confirming");
      return this.finish(job, "RECONCILED", {}, "close confirmed");
    }
    if (cmd.kind === "CANCEL_PENDING" && mlink) {
      await this.db.update(copyLinks).set({ status: "CANCELLED", closedAt: now, updatedAt: now }).where(eq(copyLinks.id, mlink.id));
    }
    // Modifications and cancellations: verify against platform state once.
    if (job.state === "ACCEPTED" || viaReconcile) return this.finish(job, "RECONCILED", {}, "confirmed on platform");
    return transitionJob(this.db, job, "ACCEPTED", { nextAttemptAt: new Date(Date.now() + 700), lockedBy: null, lockedUntil: null }, "accepted; verifying");
  }

  private async finish(job: Job, to: "FILLED" | "RECONCILED", patch: Partial<Job>, detail: string) {
    await transitionJob(this.db, job, to, patch, detail);
  }

  private async failLinkFor(cmd: ExecutionCommand, reason: string) {
    if (cmd.kind !== "OPEN_MARKET" && cmd.kind !== "PLACE_PENDING") return;
    await this.db
      .update(copyLinks)
      .set({ status: "FAILED", statusDetail: reason.slice(0, 500), closedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(copyLinks.clientId, cmd.clientId), inArray(copyLinks.status, ["OPENING", "PENDING_ORDER"])));
  }

  /** ACCEPTED: confirm fills/modifications by reading platform state. */
  private async confirm(job: Job) {
    const cmd = job.command;
    const follower = this.conn.runtimes.get(job.followerAccountId);
    if (!cmd || !follower?.adapter) return rescheduleJob(this.db, job.id, 2000);
    const since = job.submittedAt?.getTime() ?? Date.now() - 60_000;
    let r: ReconcileResult;
    if (cmd.kind === "CLOSE_POSITION" && cmd.volume !== undefined) r = await this.reconcilePartial(job, cmd);
    else r = await follower.adapter.reconcile(cmd, since);
    if (r.found && (cmd.kind !== "OPEN_MARKET" || r.filled)) return this.applyAccepted(job, cmd, { ...r, status: "ACCEPTED" }, since, undefined, false);
    const checks = job.reconcileAttempts + 1;
    if (r.conclusive && !r.found && cmd.kind === "OPEN_MARKET" && checks >= 3) {
      await this.failLinkFor(cmd, r.detail ?? "accepted order did not fill");
      return this.reject(job, `order accepted but not filled: ${r.detail ?? "order no longer active"}`, true);
    }
    if (checks >= MAX_FILL_CHECKS) {
      this.stats.needsAttention++;
      await raiseAlert(this.db, { severity: "CRITICAL", code: "CONFIRMATION_TIMEOUT", message: `${cmd.kind} ${cmd.symbol}: accepted but not confirmed after ${checks} checks (${r.detail ?? ""})`, accountId: job.followerAccountId, routeId: job.routeId, jobId: job.id });
      return transitionJob(this.db, job, "UNKNOWN", { reconcileAttempts: 0, reason: "accepted but unconfirmed", nextAttemptAt: new Date(Date.now() + 5000), lockedBy: null, lockedUntil: null }, "confirmation timed out");
    }
    await rescheduleJob(this.db, job.id, Math.min(5000, 500 * checks), { reconcileAttempts: checks });
  }

  private async reconcilePartial(job: Job, cmd: ExecutionCommand): Promise<ReconcileResult> {
    const follower = this.conn.runtimes.get(job.followerAccountId)!;
    try {
      const snap = await follower.adapter!.getSnapshot();
      const link = await this.db.query.copyLinks.findFirst({ where: and(eq(copyLinks.followerAccountId, job.followerAccountId), eq(copyLinks.followerPositionId, cmd.positionId!)) });
      const pos = snap.positions.find((p) => p.id === cmd.positionId) ?? snap.positions.find((p) => p.replacesId === cmd.positionId);
      if (!pos) return { found: true, conclusive: true, filled: true, detail: "position fully closed" };
      if (pos.id !== cmd.positionId && link) return { found: true, conclusive: true, filled: true, positionId: pos.id, filledVolume: roundTo(link.followerVolumeCurrent - pos.volume, 8) };
      if (!link) return { found: false, conclusive: false, detail: "link missing" };
      // The link volume is updated only after confirmation, so compare against it.
      const expected = roundTo(link.followerVolumeCurrent - (cmd.volume ?? 0), 8);
      if (pos.volume <= expected + 1e-9) return { found: true, conclusive: true, filled: true, filledVolume: roundTo(link.followerVolumeCurrent - pos.volume, 8) };
      return { found: false, conclusive: true, detail: `position volume still ${pos.volume}` };
    } catch (e) {
      return { found: false, conclusive: false, detail: (e as Error).message };
    }
  }

  /** UNKNOWN: find out whether the submission reached the platform before doing anything else. */
  private async reconcileUnknown(job: Job) {
    const cmd = job.command;
    const follower = this.conn.runtimes.get(job.followerAccountId);
    if (!cmd) return this.finish(job, "RECONCILED", {}, "no command was recorded; nothing to reconcile");
    if (!follower?.adapter || !follower.connected) {
      return rescheduleJob(this.db, job.id, backoffMs(job.reconcileAttempts + 1, 2000, 30_000), { reason: "awaiting follower connection to reconcile" });
    }
    const since = job.submittedAt?.getTime() ?? Date.now() - 120_000;
    const r = cmd.kind === "CLOSE_POSITION" && cmd.volume !== undefined ? await this.reconcilePartial(job, cmd) : await follower.adapter.reconcile(cmd, since);
    const attempts = job.reconcileAttempts + 1;
    if (r.found) {
      if (cmd.kind === "OPEN_MARKET" && !r.filled) {
        await transitionJob(this.db, job, "RECONCILED", { reason: "reconciled: order exists, fill pending" }, "order found");
        // Track the fill through the link monitor.
        return;
      }
      return this.applyAccepted(job, cmd, { ...r, status: "ACCEPTED" }, since, undefined, true);
    }
    if (!r.conclusive || attempts < 3) {
      if (attempts >= MAX_RECONCILE_ATTEMPTS) return this.flag(job, cmd, `could not establish outcome: ${r.detail ?? "inconclusive"}`);
      return transitionJob(this.db, job, "UNKNOWN", { reconcileAttempts: attempts, nextAttemptAt: new Date(Date.now() + 1000 * 2 ** attempts), lockedBy: null, lockedUntil: null }, `reconcile ${attempts}: ${r.detail ?? "not found yet"}`);
    }
    // Conclusively not on the platform after several checks.
    const route = await this.db.query.routes.findFirst({ where: eq(routes.id, job.routeId) });
    const settings = route ? followerSettingsSchema.parse(route.settings) : null;
    const ev = await this.db.query.masterEvents.findFirst({ where: eq(masterEvents.id, job.masterEventId) });
    const entry = cmd.kind === "OPEN_MARKET" || cmd.kind === "PLACE_PENDING";
    if (entry) {
      const age = ev ? Date.now() - (ev.payload.openTime || ev.detectedAt.getTime()) : Infinity;
      const retried = (job.detail as { retriedAfterUnknown?: boolean } | null)?.retriedAfterUnknown;
      if (!follower.adapter.capabilities.orderTagging) return this.flag(job, cmd, "order not found, but the platform has no order tags to prove it; not retrying");
      if (retried || !settings || age > settings.maxEntryAgeSeconds * 1000) {
        await this.failLinkFor(cmd, "submission not found on platform");
        return this.flag(job, cmd, retried ? "second submission also unconfirmed" : "entry not found on platform and too old to retry");
      }
      const retryId = clientIdFor(`${job.clientId}:retry1`);
      await this.db.update(copyLinks).set({ clientId: retryId, updatedAt: new Date() }).where(eq(copyLinks.clientId, cmd.clientId));
      return transitionJob(
        this.db,
        job,
        "QUEUED",
        { command: { ...cmd, clientId: retryId, tag: tagFor(retryId) }, detail: { ...(job.detail ?? {}), retriedAfterUnknown: true }, reconcileAttempts: 0, attempts: job.attempts + 1, nextAttemptAt: new Date(), lockedBy: null, lockedUntil: null },
        "conclusively not executed; one retry with a new tag",
      );
    }
    // Management commands are safe to re-plan (the planner re-checks link and follower state).
    if (job.attempts + 1 >= MAX_RETRYABLE_ATTEMPTS) return this.flag(job, cmd, "management command not confirmed after retries");
    return transitionJob(this.db, job, "QUEUED", { reconcileAttempts: 0, attempts: job.attempts + 1, nextAttemptAt: new Date(), lockedBy: null, lockedUntil: null }, "conclusively not executed; re-planning");
  }

  private async flag(job: Job, cmd: ExecutionCommand, reason: string) {
    this.stats.needsAttention++;
    await transitionJob(this.db, job, "NEEDS_ATTENTION", { reason }, reason);
    await raiseAlert(this.db, {
      severity: "CRITICAL",
      code: "NEEDS_ATTENTION",
      message: `${cmd.kind} ${cmd.symbol} (${cmd.tag}): ${reason}. Check the follower account manually.`,
      accountId: job.followerAccountId,
      routeId: job.routeId,
      jobId: job.id,
    });
    this.log.warn("executor", "job flagged for attention", { jobId: job.id, reason });
  }
}

export { executionJobs };

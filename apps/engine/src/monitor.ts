import { and, eq, inArray } from "drizzle-orm";
import { copyLinks, executionJobs, routes, type Db } from "@gtc/db";
import { BLOCKING_STATES, followerSettingsSchema, tagFor } from "@gtc/shared";
import type { ConnectionManager } from "./accounts";
import type { Log } from "./logger";
import { raiseAlert } from "./risk";

/**
 * Compares copier links with the follower's actual state:
 *  - OPENING links whose order was reconciled later get their position attached;
 *  - PENDING_ORDER links whose follower order filled become OPEN, vanished ones CANCELLED;
 *  - OPEN links whose follower position disappeared (manual close, SL/TP, stop-out) become
 *    DIVERGED (or DETACHED per policy) and are never re-opened automatically;
 *  - follower volume reduced outside the copier is recorded and flagged.
 */
export class LinkMonitor {
  constructor(
    private db: Db,
    private conn: ConnectionManager,
    private log: Log,
  ) {}

  async run() {
    const links = await this.db.select().from(copyLinks).where(inArray(copyLinks.status, ["OPENING", "PENDING_ORDER", "OPEN"]));
    if (!links.length) return;
    const keys = [...new Set(links.map((l) => `${l.routeId}:${l.masterKey}`))];
    const busy = new Set(
      (
        await this.db
          .select({ k: executionJobs.orderingKey })
          .from(executionJobs)
          .where(and(inArray(executionJobs.orderingKey, keys), inArray(executionJobs.state, BLOCKING_STATES)))
      ).map((r) => r.k),
    );
    const routeRows = await this.db.select().from(routes).where(inArray(routes.id, [...new Set(links.map((l) => l.routeId))]));
    const policy = new Map(routeRows.map((r) => [r.id, followerSettingsSchema.parse(r.settings).divergencePolicy]));

    for (const l of links) {
      if (busy.has(`${l.routeId}:${l.masterKey}`)) continue; // a job is still working on it
      const rt = this.conn.runtimes.get(l.followerAccountId);
      const snap = rt?.snapshot;
      if (!rt?.connected || !snap || !rt.snapshotAt || rt.snapshotAt < l.updatedAt.getTime() + 500) continue;
      const now = new Date();
      const tag = tagFor(l.clientId);

      if (l.status === "OPENING") {
        const pos = snap.positions.find((p) => p.tag === tag);
        if (pos) {
          await this.db
            .update(copyLinks)
            .set({ status: "OPEN", followerPositionId: pos.id, followerOpenPrice: pos.openPrice, followerVolumeCurrent: pos.volume, followerVolumeInitial: pos.volume, openedAt: now, updatedAt: now })
            .where(eq(copyLinks.id, l.id));
          this.log.info("monitor", "late fill attached to link", { linkId: l.id, positionId: pos.id });
        }
        continue;
      }

      if (l.status === "PENDING_ORDER") {
        if (l.followerOrderId && snap.orders.some((o) => o.id === l.followerOrderId)) continue;
        const pos = snap.positions.find((p) => p.tag === tag || (l.followerOrderId && (p.id === l.followerOrderId || p.orderId === l.followerOrderId)));
        if (pos) {
          await this.db
            .update(copyLinks)
            .set({ status: "OPEN", followerPositionId: pos.id, followerOpenPrice: pos.openPrice, followerVolumeCurrent: pos.volume, openedAt: now, updatedAt: now })
            .where(eq(copyLinks.id, l.id));
        } else {
          await this.db.update(copyLinks).set({ status: "CANCELLED", statusDetail: "follower pending order no longer present", closedAt: now, updatedAt: now }).where(eq(copyLinks.id, l.id));
          await raiseAlert(this.db, { severity: "INFO", code: "PENDING_GONE", message: `follower pending order ${l.followerOrderId} for ${l.followerSymbol} disappeared (filled and closed, expired or cancelled outside the copier)`, accountId: l.followerAccountId, routeId: l.routeId, dedupKey: `pending-gone:${l.id}` });
        }
        continue;
      }

      // OPEN
      const pos = snap.positions.find((p) => p.id === l.followerPositionId);
      if (!pos) {
        const masterSnap = this.conn.runtimes.get(l.masterAccountId)?.snapshot;
        const masterOpen = masterSnap?.positions.some((p) => p.id === l.masterPositionId || p.id === l.masterKey) ?? true;
        if (!masterOpen) {
          await this.db.update(copyLinks).set({ status: "CLOSED", statusDetail: "follower and master both closed", followerVolumeCurrent: 0, closedAt: now, updatedAt: now }).where(eq(copyLinks.id, l.id));
          continue;
        }
        const detach = policy.get(l.routeId) === "FLAG_AND_DETACH";
        await this.db
          .update(copyLinks)
          .set({ status: detach ? "DETACHED" : "DIVERGED", statusDetail: "follower position closed outside the copier while master is open (not re-opened)", followerVolumeCurrent: 0, closedAt: now, updatedAt: now })
          .where(eq(copyLinks.id, l.id));
        await raiseAlert(this.db, {
          severity: "WARNING",
          code: "DIVERGENCE",
          message: `${l.followerSymbol}: follower position ${l.followerPositionId} closed outside the copier (manual, SL/TP or stop-out) while the master is still open. Not re-opened.`,
          accountId: l.followerAccountId,
          routeId: l.routeId,
          dedupKey: `diverged:${l.id}`,
        });
        continue;
      }
      if (pos.volume < l.followerVolumeCurrent - 1e-9) {
        await this.db.update(copyLinks).set({ followerVolumeCurrent: pos.volume, statusDetail: `follower volume reduced outside copier to ${pos.volume}`, updatedAt: now }).where(eq(copyLinks.id, l.id));
        await raiseAlert(this.db, { severity: "WARNING", code: "VOLUME_DIVERGENCE", message: `${l.followerSymbol}: follower volume reduced outside the copier (${l.followerVolumeCurrent} -> ${pos.volume})`, accountId: l.followerAccountId, routeId: l.routeId, dedupKey: `voldiv:${l.id}:${pos.volume}` });
      }
    }
  }
}

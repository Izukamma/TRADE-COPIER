import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { copyLinks, masterEvents, masterSnapshots, type Db } from "@gtc/db";
import { COPIER_MAGIC, isCopierTag, type TradingSnapshot } from "@gtc/shared";
import { diffSnapshots } from "./diff";
import type { Log } from "./logger";

const sig = (s: TradingSnapshot) =>
  JSON.stringify([
    s.positions.map((p) => [p.id, p.side, p.volume, p.sl, p.tp]).sort(),
    s.orders.map((o) => [o.id, o.price, o.volume, o.sl, o.tp]).sort(),
  ]);

/**
 * Turns master snapshots into durable master events. Event insertion and the snapshot/version
 * update happen in one transaction, so a crash can neither lose nor duplicate events.
 * On first observation the current positions become the baseline and are NOT copied.
 */
export class MasterWatcher {
  private lastSig = new Map<string, string>();
  onEvents?: () => void;

  constructor(
    private db: Db,
    private log: Log,
  ) {}

  async onSnapshot(accountId: string, snap: TradingSnapshot, source: "POLL" | "BRIDGE" | "SIMULATION") {
    const s = sig(snap);
    if (this.lastSig.get(accountId) === s) return;

    const stored = await this.db.query.masterSnapshots.findFirst({ where: eq(masterSnapshots.accountId, accountId) });
    if (!stored) {
      await this.db
        .insert(masterSnapshots)
        .values({ accountId, snapshot: snap, baselineIds: snap.positions.map((p) => p.id).concat(snap.orders.map((o) => o.id)), version: 0, aliases: {} })
        .onConflictDoNothing();
      this.lastSig.set(accountId, s);
      this.log.info("watcher", "master baseline captured (existing positions are not copied)", { accountId, positions: snap.positions.length, orders: snap.orders.length });
      return;
    }

    // Trades on this account that the copier itself created (as a follower) are never master trades.
    const linked = await this.db
      .select({ p: copyLinks.followerPositionId, o: copyLinks.followerOrderId })
      .from(copyLinks)
      .where(and(eq(copyLinks.followerAccountId, accountId)));
    const linkedIds = new Set(linked.flatMap((l) => [l.p, l.o]).filter((x): x is string => !!x));
    const exclude = (t: { id: string; tag: string | null; magic?: number | null }) => isCopierTag(t.tag) || linkedIds.has(t.id) || t.magic === COPIER_MAGIC;

    const { events, state } = diffSnapshots(stored.snapshot, snap, { version: stored.version, aliases: stored.aliases }, exclude);
    await this.db.transaction(async (tx) => {
      if (events.length)
        await tx
          .insert(masterEvents)
          .values(
            events.map((e) => ({
              accountId,
              eventKey: e.eventKey,
              type: e.payload.type,
              payload: e.payload,
              source,
              platformTime: e.platformTime ? new Date(e.platformTime) : null,
            })),
          )
          .onConflictDoNothing();
      await tx.update(masterSnapshots).set({ snapshot: snap, version: state.version, aliases: state.aliases, updatedAt: new Date() }).where(eq(masterSnapshots.accountId, accountId));
    });
    this.lastSig.set(accountId, s);
    if (events.length) {
      this.log.info("watcher", `detected ${events.length} master event(s)`, { accountId, types: events.map((e) => e.payload.type) });
      this.onEvents?.();
    }
  }

  /** Forget the baseline for an account (e.g. when it stops being a master). */
  async reset(accountId: string) {
    this.lastSig.delete(accountId);
    await this.db.delete(masterSnapshots).where(eq(masterSnapshots.accountId, accountId));
  }

  /** Ids of follower trades linked on the given accounts (diagnostics). */
  async linkedFollowerIds(accountIds: string[]) {
    if (!accountIds.length) return [];
    return this.db.select().from(copyLinks).where(and(inArray(copyLinks.followerAccountId, accountIds), isNotNull(copyLinks.followerPositionId)));
  }
}

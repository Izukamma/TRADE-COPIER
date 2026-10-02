import type { MasterEventPayload, PendingOrder, Position, TradingSnapshot } from "@gtc/shared";

export interface DetectedEvent {
  eventKey: string;
  payload: MasterEventPayload;
  platformTime: number | null;
}

export interface DiffState {
  /** Monotonic version of the stored master snapshot; part of event keys. */
  version: number;
  /** master position id -> originating master pending order id (for pending copies). */
  aliases: Record<string, string>;
}

const EPS = 1e-9;

const levelsEqual = (a: number | null, b: number | null) => (a ?? 0) === (b ?? 0);

/**
 * Compares two master snapshots and returns the events between them. Pure and deterministic:
 * the same (prev, next, state) always yields the same event keys, so re-detection after a
 * crash is deduplicated by the (account, event_key) unique index.
 *
 * `exclude` filters positions/orders that must never be treated as master trades
 * (copier-tagged trades and positions linked as follower positions on this account).
 */
export function diffSnapshots(
  prev: TradingSnapshot,
  next: TradingSnapshot,
  state: DiffState,
  exclude: (t: { id: string; tag: string | null; magic?: number | null }) => boolean,
): { events: DetectedEvent[]; state: DiffState } {
  const v = state.version + 1;
  const aliases = { ...state.aliases };
  const events: DetectedEvent[] = [];
  const keyOf = (p: Position) => aliases[p.id] ?? p.id;

  const prevPos = new Map(prev.positions.filter((p) => !exclude(p)).map((p) => [p.id, p]));
  const nextPos = new Map(next.positions.filter((p) => !exclude(p)).map((p) => [p.id, p]));
  const prevOrd = new Map(prev.orders.filter((o) => !exclude(o)).map((o) => [o.id, o]));
  const nextOrd = new Map(next.orders.filter((o) => !exclude(o)).map((o) => [o.id, o]));

  const vanishedOrders = [...prevOrd.values()].filter((o) => !nextOrd.has(o.id));
  const filledOrderIds = new Set<string>();

  const posPayload = (p: Position, type: MasterEventPayload["type"], extra: Partial<MasterEventPayload> = {}): MasterEventPayload => ({
    type,
    masterKey: keyOf(p),
    positionId: p.id,
    orderId: aliases[p.id] ?? p.orderId ?? undefined,
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
    ...extra,
  });
  const ordPayload = (o: PendingOrder, type: MasterEventPayload["type"], extra: Partial<MasterEventPayload> = {}): MasterEventPayload => ({
    type,
    masterKey: o.id,
    orderId: o.id,
    symbol: o.symbol,
    side: o.side,
    kind: o.kind,
    volume: o.volume,
    price: o.price,
    sl: o.sl,
    tp: o.tp,
    openTime: o.createdTime,
    tag: o.tag,
    magic: o.magic ?? null,
    ...extra,
  });

  // MT4 partial close: the remainder appears under a new ticket that names the old one.
  // Treat it as a partial close of the original trade and keep the original master key.
  const replaced = new Set<string>();
  for (const p of nextPos.values()) {
    if (prevPos.has(p.id) || !p.replacesId) continue;
    const old = prevPos.get(p.replacesId);
    if (!old || nextPos.has(old.id)) continue;
    replaced.add(old.id);
    aliases[p.id] = keyOf(old);
    delete aliases[old.id];
    if (p.volume < old.volume - EPS)
      events.push({ eventKey: `partial:${old.id}:${p.id}`, payload: posPayload(p, "POSITION_PARTIALLY_CLOSED", { previousVolume: old.volume, masterKey: aliases[p.id] }), platformTime: null });
    if (!levelsEqual(old.sl, p.sl) || !levelsEqual(old.tp, p.tp))
      events.push({ eventKey: `modify:${p.id}:v${v}`, payload: posPayload(p, "POSITION_MODIFIED", { masterKey: aliases[p.id] }), platformTime: null });
  }

  // New positions (and pending fills).
  for (const p of nextPos.values()) {
    if (prevPos.has(p.id) || (p.replacesId && replaced.has(p.replacesId))) continue;
    // A vanished pending order that produced this position: same id/orderId, or same symbol/side/volume.
    const source =
      vanishedOrders.find((o) => !filledOrderIds.has(o.id) && (o.id === p.id || o.id === p.orderId)) ??
      vanishedOrders.find((o) => !filledOrderIds.has(o.id) && o.symbol === p.symbol && o.side === p.side && Math.abs(o.volume - p.volume) < EPS);
    if (source) {
      filledOrderIds.add(source.id);
      aliases[p.id] = source.id;
      events.push({
        eventKey: `fill:${source.id}:${p.id}`,
        payload: posPayload(p, "ORDER_FILLED", { masterKey: source.id, orderId: source.id }),
        platformTime: p.openTime || null,
      });
    } else {
      events.push({ eventKey: `open:${p.id}`, payload: posPayload(p, "POSITION_OPENED"), platformTime: p.openTime || null });
    }
  }

  // Changed positions.
  for (const p of nextPos.values()) {
    const before = prevPos.get(p.id);
    if (!before) continue;
    if (before.side !== p.side) {
      // Netting reversal: close the old exposure, open a new one under a distinct key.
      events.push({ eventKey: `close:${p.id}:v${v}`, payload: posPayload(before, "POSITION_CLOSED", { previousVolume: before.volume, volume: 0 }), platformTime: null });
      const newKey = `${p.id}#r${v}`;
      aliases[p.id] = newKey;
      events.push({ eventKey: `open:${newKey}`, payload: posPayload(p, "POSITION_OPENED", { masterKey: newKey }), platformTime: p.openTime || null });
      continue;
    }
    if (p.volume < before.volume - EPS) {
      events.push({
        eventKey: `partial:${p.id}:v${v}`,
        payload: posPayload(p, "POSITION_PARTIALLY_CLOSED", { previousVolume: before.volume }),
        platformTime: null,
      });
    } else if (p.volume > before.volume + EPS) {
      events.push({ eventKey: `increase:${p.id}:v${v}`, payload: posPayload(p, "POSITION_INCREASED", { previousVolume: before.volume }), platformTime: null });
    }
    if (!levelsEqual(before.sl, p.sl) || !levelsEqual(before.tp, p.tp)) {
      events.push({ eventKey: `modify:${p.id}:v${v}`, payload: posPayload(p, "POSITION_MODIFIED"), platformTime: null });
    }
  }

  // Closed positions.
  for (const p of prevPos.values()) {
    if (nextPos.has(p.id) || replaced.has(p.id)) continue;
    events.push({ eventKey: `close:${p.id}:v${v}`, payload: posPayload(p, "POSITION_CLOSED", { previousVolume: p.volume, volume: 0 }), platformTime: null });
    delete aliases[p.id];
  }

  // Pending orders.
  for (const o of nextOrd.values()) {
    const before = prevOrd.get(o.id);
    if (!before) {
      events.push({ eventKey: `order:${o.id}:placed`, payload: ordPayload(o, "ORDER_PLACED"), platformTime: o.createdTime || null });
    } else if (before.price !== o.price || !levelsEqual(before.sl, o.sl) || !levelsEqual(before.tp, o.tp) || Math.abs(before.volume - o.volume) > EPS) {
      events.push({ eventKey: `order:${o.id}:modify:v${v}`, payload: ordPayload(o, "ORDER_MODIFIED"), platformTime: null });
    }
  }
  for (const o of vanishedOrders) {
    if (filledOrderIds.has(o.id)) continue;
    events.push({ eventKey: `order:${o.id}:cancel`, payload: ordPayload(o, "ORDER_CANCELLED"), platformTime: null });
  }

  return { events, state: { version: v, aliases } };
}

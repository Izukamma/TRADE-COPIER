import {
  computeFollowerVolume,
  entryDeviationPoints,
  floorToStep,
  mapProtectiveLevels,
  roundTo,
  roundToTick,
  validateProtectiveLevels,
  type AccountRiskConfig,
  type Environment,
  type ExecutionCommand,
  type FollowerSettings,
  type FxTable,
  type InstrumentSpec,
  type MasterEventPayload,
  type PlatformCapabilities,
  type Quote,
  type TradingSnapshot,
} from "@gtc/shared";

/**
 * Deterministic execution planning. Given a master event and a full view of the follower,
 * returns exactly one decision. No I/O, no randomness, no model calls: every outcome has a
 * reason string that is stored with the job.
 */

export interface LinkView {
  id: string;
  status: "PENDING_ORDER" | "OPENING" | "OPEN" | "CLOSED" | "CANCELLED" | "DIVERGED" | "DETACHED" | "FAILED";
  followerPositionId: string | null;
  followerOrderId: string | null;
  followerSymbol: string;
  side: "BUY" | "SELL";
  masterVolumeCurrent: number;
  followerVolumeCurrent: number;
  masterOpenPrice: number | null;
  followerOpenPrice: number | null;
}

export interface PlanContext {
  now: number;
  liveTradingEnabled: boolean;
  event: MasterEventPayload;
  eventDetectedAt: number;
  /** EXISTING = explicit copy of positions present at route start (bypasses entry age). */
  eventSource: string;
  settings: FollowerSettings;
  pauses: { global: boolean; group: boolean; route: boolean; account: boolean };
  dailyLossBreached: boolean;
  follower: {
    environment: Environment;
    liveExecutionArmed: boolean;
    capabilities: PlatformCapabilities;
    snapshot: TradingSnapshot | null;
    snapshotAgeMs: number | null;
    risk: AccountRiskConfig;
    magic: number;
  };
  master: { equity: number | null; balance: number | null; currency: string | null; spec: InstrumentSpec | null };
  mapping: { followerSymbol: string; status: string } | null;
  followerSpec: InstrumentSpec | null;
  followerQuote: Quote | null;
  followerQuoteError: string | null;
  link: LinkView | null;
  exposure: { routeLots: number; accountLots: number; routeOpenPositions: number };
  /** Non-copier positions on the follower for the mapped symbol (for netting safety). */
  unrelatedPositionsOnSymbol: number;
  fx: FxTable;
  clientId: string;
  tag: string;
}

export type Plan =
  | {
      kind: "SUBMIT";
      command: ExecutionCommand;
      notes: string[];
      /** For entries: the expected entry price used for deviation/levels. */
      referencePrice?: number;
      /** Set when the command opens exposure (link must be created before submission). */
      opensLink?: { followerSymbol: string; volume: number; pending: boolean };
    }
  | { kind: "SKIP"; reason: string; notes?: string[] }
  | { kind: "REJECT"; reason: string; notes?: string[] }
  /** Nothing to submit but link bookkeeping is needed (e.g. master pending order filled). */
  | { kind: "LINK_ONLY"; reason: string };

const isEntry = (t: MasterEventPayload["type"]) => t === "POSITION_OPENED" || t === "ORDER_PLACED" || t === "ORDER_FILLED";

export function plan(ctx: PlanContext): Plan {
  const e = ctx.event;
  switch (e.type) {
    case "POSITION_OPENED":
      return planEntry(ctx, "MARKET");
    case "ORDER_FILLED":
      if (ctx.link && (ctx.link.status === "PENDING_ORDER" || ctx.link.status === "OPEN"))
        return { kind: "LINK_ONLY", reason: "master pending order filled; follower copy is managed by its own pending order" };
      if (ctx.link) return { kind: "SKIP", reason: `master pending order filled but link is ${ctx.link.status}` };
      return planEntry(ctx, "MARKET");
    case "ORDER_PLACED":
      return planEntry(ctx, "PENDING");
    case "POSITION_INCREASED":
      return { kind: "SKIP", reason: "master scale-in on an existing position is not copied (flagged for review)" };
    case "POSITION_MODIFIED":
      return planModifyPosition(ctx);
    case "POSITION_PARTIALLY_CLOSED":
      return planPartialClose(ctx);
    case "POSITION_CLOSED":
      return planClose(ctx);
    case "ORDER_MODIFIED":
      return planModifyPending(ctx);
    case "ORDER_CANCELLED":
      return planCancel(ctx);
  }
}

/* ------------------------------------------- entries ------------------------------------------- */

function planEntry(ctx: PlanContext, mode: "MARKET" | "PENDING"): Plan {
  const e = ctx.event;
  const s = ctx.settings;
  const f = ctx.follower;
  const notes: string[] = [];

  if (ctx.link) return { kind: "SKIP", reason: `already linked (${ctx.link.status}); duplicate entry suppressed` };

  // Live safety gate.
  if (f.environment === "LIVE" && !(ctx.liveTradingEnabled && f.liveExecutionArmed))
    return { kind: "REJECT", reason: "LIVE follower execution is disabled (requires LIVE_TRADING_ENABLED and an armed account)" };

  // Pauses: entries only.
  const p = ctx.pauses;
  if (p.global || p.group || p.route || p.account)
    return { kind: "SKIP", reason: `entries paused (${Object.entries(p).filter(([, v]) => v).map(([k]) => k).join(", ")})` };
  if (ctx.dailyLossBreached) return { kind: "SKIP", reason: "daily loss limit reached: entries paused" };

  // Filters.
  if (mode === "MARKET" && !s.copyMarketOrders) return { kind: "SKIP", reason: "market-order copying disabled" };
  if (mode === "PENDING" && !s.copyPendingOrders) return { kind: "SKIP", reason: "pending-order copying disabled" };
  if (s.allowedDirections === "BUY_ONLY" && e.side !== "BUY") return { kind: "SKIP", reason: "direction filter: BUY only" };
  if (s.allowedDirections === "SELL_ONLY" && e.side !== "SELL") return { kind: "SKIP", reason: "direction filter: SELL only" };
  if (s.allowedSymbols.length && !s.allowedSymbols.includes(e.symbol)) return { kind: "SKIP", reason: `symbol ${e.symbol} not in allowed list` };
  const magic = e.magic ?? 0;
  if (magic === 0 && !s.sourceFilter.manual) return { kind: "SKIP", reason: "manual master trades are excluded" };
  if (magic !== 0 && !s.sourceFilter.eaMagics.includes(magic)) return { kind: "SKIP", reason: `EA magic ${magic} not selected` };
  if (s.requireStopLoss && !(e.sl && e.sl > 0)) return { kind: "SKIP", reason: "mandatory stop loss: master trade has no SL" };

  // Entry age (explicit copy of existing positions bypasses it).
  if (ctx.eventSource !== "EXISTING") {
    const ref = e.openTime > 0 ? e.openTime : ctx.eventDetectedAt;
    const ageMs = ctx.now - ref;
    if (ageMs > s.maxEntryAgeSeconds * 1000)
      return { kind: "SKIP", reason: `stale entry: ${Math.round(ageMs / 1000)}s old > max ${s.maxEntryAgeSeconds}s` };
  }

  // Mapping + specs.
  if (!ctx.mapping || ctx.mapping.status !== "CONFIRMED") return { kind: "REJECT", reason: `no confirmed symbol mapping for ${e.symbol}` };
  const spec = ctx.followerSpec;
  if (!spec) return { kind: "REJECT", reason: `follower instrument ${ctx.mapping.followerSymbol} has no synchronised specification` };
  if (!spec.tradable) return { kind: "REJECT", reason: `${spec.symbol} is not tradable on the follower` };
  if (mode === "PENDING") {
    const kind = e.kind === "STOP" ? "STOP" : "LIMIT";
    const cap = kind === "LIMIT" ? f.capabilities.pendingLimit : f.capabilities.pendingStop;
    if (!cap || !spec.orderKinds.includes(kind)) return { kind: "REJECT", reason: `follower does not support ${kind} orders (no substitution is made)` };
  } else if (!f.capabilities.marketOrders || !spec.orderKinds.includes("MARKET")) {
    return { kind: "REJECT", reason: "follower does not support market orders" };
  }

  // Account health.
  if (!f.snapshot || f.snapshotAgeMs === null) return { kind: "REJECT", reason: "follower account state unavailable" };
  if (f.snapshotAgeMs > f.risk.staleAccountSeconds * 1000)
    return { kind: "REJECT", reason: `follower account data stale (${Math.round(f.snapshotAgeMs / 1000)}s)` };

  // Netting safety.
  if (f.snapshot.account.accounting === "NETTING") {
    if (!s.nettingExclusiveSymbols)
      return { kind: "REJECT", reason: "follower is a netting account: enable 'netting exclusive symbols' to acknowledge copier-only symbols" };
    if (ctx.unrelatedPositionsOnSymbol > 0)
      return { kind: "REJECT", reason: `netting follower already holds a non-copier ${spec.symbol} position; copier exposure could not be distinguished` };
  } else if (f.snapshot.account.accounting === "UNKNOWN") {
    return { kind: "REJECT", reason: "follower position accounting (hedging/netting) unknown" };
  }

  // Limits.
  if (ctx.exposure.routeOpenPositions >= s.maxOpenPositions) return { kind: "REJECT", reason: `max open positions ${s.maxOpenPositions} reached` };

  // Quote & deviation.
  const q = ctx.followerQuote;
  const quoteFresh = q && ctx.now - q.time <= f.risk.staleQuoteSeconds * 1000;
  if (mode === "MARKET") {
    if (s.maxEntryDeviationPoints !== null) {
      if (!q) return { kind: "REJECT", reason: `follower quote unavailable${ctx.followerQuoteError ? `: ${ctx.followerQuoteError}` : ""}` };
      if (!quoteFresh) return { kind: "REJECT", reason: "follower quote stale" };
      const masterPx = e.price ?? 0;
      if (masterPx > 0) {
        const dev = entryDeviationPoints(e.side, masterPx, q, spec.tickSize);
        notes.push(`entry deviation ${roundTo(dev, 1)} ticks (max ${s.maxEntryDeviationPoints})`);
        if (dev > s.maxEntryDeviationPoints) return { kind: "REJECT", reason: `entry price deviation ${roundTo(dev, 1)} ticks exceeds ${s.maxEntryDeviationPoints}`, notes };
      }
    } else if (s.sizing.mode === "RISK_PERCENT" && !q) {
      return { kind: "REJECT", reason: "risk sizing needs a follower quote" };
    }
  }
  const followerEntry = mode === "PENDING" ? mapPendingPrice(ctx, spec) : q ? (e.side === "BUY" ? q.ask : q.bid) : (e.price ?? 0);
  if (!(followerEntry > 0)) return { kind: "REJECT", reason: "no follower reference price" };

  // Protective levels.
  const levels = mapProtectiveLevels({
    side: e.side,
    policySl: s.copySl,
    policyTp: s.copyTp,
    masterEntry: e.price ?? followerEntry,
    masterSl: e.sl,
    masterTp: e.tp,
    followerEntry,
    followerSpec: spec,
  });
  notes.push(...levels.notes);
  if (s.requireStopLoss && levels.sl === null) return { kind: "REJECT", reason: "mandatory stop loss: SL copy policy produced no stop" };
  const refQuote = mode === "PENDING" ? { bid: followerEntry, ask: followerEntry } : q ?? { bid: followerEntry, ask: followerEntry };
  const lv = validateProtectiveLevels(e.side, levels.sl, levels.tp, refQuote, spec);
  if (!lv.ok) return { kind: "REJECT", reason: `SL/TP invalid on follower: ${lv.reason}`, notes };

  // Sizing.
  if (ctx.master.equity === null || !ctx.master.currency) {
    if (s.sizing.mode === "EQUITY_PROPORTIONAL") return { kind: "REJECT", reason: "master equity unknown" };
  }
  const masterSpec = ctx.master.spec;
  if (!masterSpec && (s.sizing.mode === "MULTIPLIER" || s.sizing.mode === "EQUITY_PROPORTIONAL"))
    return { kind: "REJECT", reason: `master instrument ${e.symbol} specification unavailable` };
  const sz = computeFollowerVolume({
    sizing: s.sizing,
    maxOrderLots: s.maxOrderLots,
    masterVolume: e.volume,
    masterSpec: masterSpec ?? spec,
    followerSpec: spec,
    masterAccount: { balance: ctx.master.balance ?? 0, equity: ctx.master.equity ?? 0, currency: ctx.master.currency ?? f.snapshot.account.currency },
    followerAccount: { balance: f.snapshot.account.balance, equity: f.snapshot.account.equity, currency: f.snapshot.account.currency },
    followerEntryPrice: followerEntry,
    followerStopLoss: levels.sl,
    fx: ctx.fx,
    fxMaxAgeMs: 10 * 60_000,
    now: ctx.now,
  });
  notes.push(...sz.explanation);
  if (!sz.ok) return { kind: "REJECT", reason: `sizing: ${sz.reason}`, notes };

  // Exposure caps (do not round up past them).
  const remainingRoute = roundTo(s.maxExposureLots - ctx.exposure.routeLots, 8);
  const remainingAcct = roundTo(f.risk.maxAccountExposureLots - ctx.exposure.accountLots, 8);
  if (sz.volume > remainingRoute + 1e-12) return { kind: "REJECT", reason: `route exposure cap: ${sz.volume} lots > remaining ${remainingRoute}`, notes };
  if (sz.volume > remainingAcct + 1e-12) return { kind: "REJECT", reason: `account exposure cap: ${sz.volume} lots > remaining ${remainingAcct}`, notes };

  // Margin.
  const fm = f.snapshot.account.freeMargin;
  if (fm !== null) {
    if (spec.marginPerLot) {
      const req = spec.marginPerLot * sz.volume;
      if (fm < req * s.marginSafetyFactor) return { kind: "REJECT", reason: `insufficient margin: free ${roundTo(fm, 2)} < ${roundTo(req, 2)} x ${s.marginSafetyFactor}`, notes };
      if (f.risk.minFreeMarginAfterOrder > 0 && (fm - req) / req < f.risk.minFreeMarginAfterOrder)
        return { kind: "REJECT", reason: "free margin after order below configured minimum", notes };
    } else if (fm <= 0) {
      return { kind: "REJECT", reason: "no free margin", notes };
    } else notes.push("margin requirement not reported; only positive free margin verified");
  }

  const command: ExecutionCommand =
    mode === "MARKET"
      ? { kind: "OPEN_MARKET", clientId: ctx.clientId, tag: ctx.tag, magic: f.magic, symbol: spec.symbol, side: e.side, volume: sz.volume, sl: levels.sl, tp: levels.tp }
      : {
          kind: "PLACE_PENDING",
          clientId: ctx.clientId,
          tag: ctx.tag,
          magic: f.magic,
          symbol: spec.symbol,
          side: e.side,
          volume: sz.volume,
          price: followerEntry,
          pendingKind: e.kind === "STOP" ? "STOP" : "LIMIT",
          sl: levels.sl,
          tp: levels.tp,
        };
  return { kind: "SUBMIT", command, notes, referencePrice: followerEntry, opensLink: { followerSymbol: spec.symbol, volume: sz.volume, pending: mode === "PENDING" } };
}

function mapPendingPrice(ctx: PlanContext, spec: InstrumentSpec): number {
  // Pending prices are copied as absolute prices, rounded onto the follower tick grid.
  // Mappings with a price-basis offset are flagged by mapping validation; such routes should not copy pending orders.
  return roundToTick(ctx.event.price ?? 0, spec.tickSize, spec.digits);
}

/* ------------------------------------------- management ------------------------------------------- */

function requireOpenLink(ctx: PlanContext, what: string): Plan | null {
  const l = ctx.link;
  if (!l) return { kind: "SKIP", reason: `${what}: master trade was not copied on this route` };
  if (l.status === "DETACHED") return { kind: "SKIP", reason: `${what}: link detached after divergence` };
  if (l.status === "DIVERGED") return { kind: "SKIP", reason: `${what}: follower position diverged (manually closed?) — not re-opened` };
  if (l.status !== "OPEN" || !l.followerPositionId) return { kind: "SKIP", reason: `${what}: follower link is ${l.status}` };
  return null;
}

function planModifyPosition(ctx: PlanContext): Plan {
  const s = ctx.settings;
  if (!s.copyModifications) return { kind: "SKIP", reason: "modification copying disabled" };
  const bad = requireOpenLink(ctx, "modify");
  if (bad) return bad;
  const l = ctx.link!;
  if (!ctx.follower.capabilities.modifyPositionSlTp) return { kind: "REJECT", reason: "follower platform cannot modify SL/TP (not supported/verified)" };
  const spec = ctx.followerSpec;
  if (!spec) return { kind: "REJECT", reason: "follower specification unavailable" };
  const e = ctx.event;
  const levels = mapProtectiveLevels({
    side: l.side,
    policySl: s.copySl,
    policyTp: s.copyTp,
    masterEntry: l.masterOpenPrice ?? e.price ?? 0,
    masterSl: e.sl,
    masterTp: e.tp,
    followerEntry: l.followerOpenPrice ?? l.masterOpenPrice ?? e.price ?? 0,
    followerSpec: spec,
  });
  const current = ctx.follower.snapshot?.positions.find((p) => p.id === l.followerPositionId);
  // Levels whose policy is NONE keep the follower's own value.
  const sl = s.copySl === "NONE" ? (current?.sl ?? null) : levels.sl;
  const tp = s.copyTp === "NONE" ? (current?.tp ?? null) : levels.tp;
  if (current && (current.sl ?? null) === sl && (current.tp ?? null) === tp) return { kind: "SKIP", reason: "follower SL/TP already match" };
  if (ctx.settings.requireStopLoss && sl === null) return { kind: "REJECT", reason: "mandatory stop loss: refusing to remove follower SL" };
  if (ctx.followerQuote) {
    const lv = validateProtectiveLevels(l.side, sl, tp, ctx.followerQuote, spec);
    if (!lv.ok) return { kind: "REJECT", reason: `SL/TP invalid on follower: ${lv.reason}` };
  }
  return {
    kind: "SUBMIT",
    notes: levels.notes,
    command: { kind: "MODIFY_POSITION", clientId: ctx.clientId, tag: ctx.tag, symbol: l.followerSymbol, positionId: l.followerPositionId!, side: l.side, sl, tp },
  };
}

export function partialCloseVolume(
  link: Pick<LinkView, "followerVolumeCurrent">,
  masterPrev: number,
  masterNow: number,
  spec: Pick<InstrumentSpec, "volumeStep" | "volumeMin">,
  remainder: FollowerSettings["partialCloseRemainder"],
): { close: number; full: boolean; note: string } {
  const closedFraction = Math.min(1, Math.max(0, (masterPrev - masterNow) / masterPrev));
  const target = link.followerVolumeCurrent * (1 - closedFraction);
  // Keep the remaining follower exposure at or below proportional: round the remainder DOWN,
  // which rounds the closed quantity up within the follower's position.
  let remaining = floorToStep(target, spec.volumeStep);
  let note = `master closed ${roundTo(closedFraction * 100, 2)}%; follower target remaining ${roundTo(target, 6)} -> ${remaining}`;
  // Master still holds part of the position but the follower remainder is below the minimum.
  if (target > 1e-12 && remaining < spec.volumeMin - 1e-12) {
    if (remainder === "KEEP_MIN") {
      remaining = spec.volumeMin;
      note += ` (kept minimum ${spec.volumeMin})`;
    } else {
      remaining = 0;
      note += " (below minimum: closing all)";
    }
  }
  const close = roundTo(link.followerVolumeCurrent - remaining, 8);
  return { close, full: remaining <= 0, note };
}

function planPartialClose(ctx: PlanContext): Plan {
  if (!ctx.settings.copyPartialCloses) return { kind: "SKIP", reason: "partial-close copying disabled" };
  const bad = requireOpenLink(ctx, "partial close");
  if (bad) return bad;
  const l = ctx.link!;
  const spec = ctx.followerSpec;
  if (!spec) return { kind: "REJECT", reason: "follower specification unavailable" };
  const prev = ctx.event.previousVolume ?? l.masterVolumeCurrent;
  const pc = partialCloseVolume(l, prev, ctx.event.volume, spec, ctx.settings.partialCloseRemainder);
  if (pc.close <= 0) return { kind: "SKIP", reason: `partial close rounds to zero on follower (${pc.note})` };
  if (!pc.full && !ctx.follower.capabilities.partialClose) return { kind: "REJECT", reason: "follower platform cannot partially close (not supported/verified)" };
  return {
    kind: "SUBMIT",
    notes: [pc.note],
    command: {
      kind: "CLOSE_POSITION",
      clientId: ctx.clientId,
      tag: ctx.tag,
      symbol: l.followerSymbol,
      side: l.side,
      positionId: l.followerPositionId!,
      volume: pc.full ? undefined : pc.close,
    },
  };
}

function planClose(ctx: PlanContext): Plan {
  // Owner-initiated "close copier positions" always applies, whatever the copy settings.
  if (!ctx.settings.copyFullCloses && ctx.eventSource !== "CONTROL") return { kind: "SKIP", reason: "full-close copying disabled" };
  const l = ctx.link;
  if (l && l.status === "PENDING_ORDER" && l.followerOrderId)
    return {
      kind: "SUBMIT",
      notes: ["master position closed while follower pending order still open: cancelling follower order"],
      command: { kind: "CANCEL_PENDING", clientId: ctx.clientId, tag: ctx.tag, symbol: l.followerSymbol, orderId: l.followerOrderId },
    };
  const bad = requireOpenLink(ctx, "close");
  if (bad) return bad;
  return {
    kind: "SUBMIT",
    notes: [],
    command: { kind: "CLOSE_POSITION", clientId: ctx.clientId, tag: ctx.tag, symbol: l!.followerSymbol, side: l!.side, positionId: l!.followerPositionId! },
  };
}

function planModifyPending(ctx: PlanContext): Plan {
  const s = ctx.settings;
  if (!s.copyModifications) return { kind: "SKIP", reason: "modification copying disabled" };
  const l = ctx.link;
  if (!l || l.status !== "PENDING_ORDER" || !l.followerOrderId) return { kind: "SKIP", reason: `no live follower pending order (${l?.status ?? "not copied"})` };
  if (!ctx.follower.capabilities.modifyPendingOrder) return { kind: "REJECT", reason: "follower platform cannot modify pending orders" };
  const spec = ctx.followerSpec;
  if (!spec) return { kind: "REJECT", reason: "follower specification unavailable" };
  const e = ctx.event;
  const price = mapPendingPrice(ctx, spec);
  const levels = mapProtectiveLevels({ side: l.side, policySl: s.copySl, policyTp: s.copyTp, masterEntry: e.price ?? price, masterSl: e.sl, masterTp: e.tp, followerEntry: price, followerSpec: spec });
  const lv = validateProtectiveLevels(l.side, levels.sl, levels.tp, { bid: price, ask: price }, spec);
  if (!lv.ok) return { kind: "REJECT", reason: `SL/TP invalid on follower: ${lv.reason}` };
  return {
    kind: "SUBMIT",
    notes: levels.notes,
    command: { kind: "MODIFY_PENDING", clientId: ctx.clientId, tag: ctx.tag, symbol: l.followerSymbol, orderId: l.followerOrderId, price, pendingKind: e.kind === "STOP" ? "STOP" : "LIMIT", sl: levels.sl, tp: levels.tp },
  };
}

function planCancel(ctx: PlanContext): Plan {
  if (!ctx.settings.copyCancellations && ctx.eventSource !== "CONTROL") return { kind: "SKIP", reason: "cancellation copying disabled" };
  const l = ctx.link;
  if (!l || l.status !== "PENDING_ORDER" || !l.followerOrderId) return { kind: "SKIP", reason: `no live follower pending order (${l?.status ?? "not copied"})` };
  return { kind: "SUBMIT", notes: [], command: { kind: "CANCEL_PENDING", clientId: ctx.clientId, tag: ctx.tag, symbol: l.followerSymbol, orderId: l.followerOrderId } };
}

export { isEntry };

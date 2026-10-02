/**
 * Route graph validation: prevents copy loops (A->B->A, A->B->C->A), duplicate routes
 * (same master->follower twice) and self-copying.
 */
export interface RouteEdge {
  routeId: string;
  groupId: string;
  masterAccountId: string;
  followerAccountId: string;
  active: boolean;
}

export type RouteCheck = { ok: true } | { ok: false; reason: string };

export function validateNewRoute(existing: RouteEdge[], candidate: Omit<RouteEdge, "routeId">): RouteCheck {
  if (candidate.masterAccountId === candidate.followerAccountId)
    return { ok: false, reason: "an account cannot follow itself" };
  const live = existing.filter((e) => e.active || e.groupId === candidate.groupId);
  if (live.some((e) => e.masterAccountId === candidate.masterAccountId && e.followerAccountId === candidate.followerAccountId))
    return { ok: false, reason: "duplicate route: this follower already copies this master" };
  // Following an account that already follows something is chaining; chains are refused because
  // copier-tagged trades are never re-copied, so a chain would silently do nothing (and risks loops).
  if (live.some((e) => e.followerAccountId === candidate.masterAccountId))
    return { ok: false, reason: "master account is itself a follower in another route (chained copying is not supported)" };
  if (live.some((e) => e.masterAccountId === candidate.followerAccountId))
    return { ok: false, reason: "follower account is a master in another group (would create a chain or loop)" };
  // Generic cycle check (defence in depth).
  const adj = new Map<string, string[]>();
  for (const e of [...live, { ...candidate, routeId: "new" }]) adj.set(e.masterAccountId, [...(adj.get(e.masterAccountId) ?? []), e.followerAccountId]);
  const seen = new Set<string>();
  const stack = new Set<string>();
  const dfs = (n: string): boolean => {
    if (stack.has(n)) return true;
    if (seen.has(n)) return false;
    seen.add(n);
    stack.add(n);
    for (const m of adj.get(n) ?? []) if (dfs(m)) return true;
    stack.delete(n);
    return false;
  };
  for (const n of adj.keys()) if (dfs(n)) return { ok: false, reason: "route would create a copy loop" };
  return { ok: true };
}

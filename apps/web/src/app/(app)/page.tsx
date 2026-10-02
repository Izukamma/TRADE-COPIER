import Link from "next/link";
import { desc, inArray, isNull, sql } from "drizzle-orm";
import { alerts, copierGroups, copyLinks, executionJobs, routes } from "@gtc/db";
import { db } from "@/lib/db";
import { latestHeartbeat, listAccounts } from "@/lib/queries";
import { ago, effectiveStatus, engineAlive, fmt } from "@/lib/status";
import { AutoRefresh } from "@/components/client";
import { Badge, Card, Empty, EnvBadge, Notice, PageHead, Stat, StateBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function Overview() {
  const [hb, accounts, groups, rts, open, recentAlerts, recentJobs, counts] = await Promise.all([
    latestHeartbeat(),
    listAccounts(),
    db().select().from(copierGroups),
    db().select().from(routes),
    db().select().from(copyLinks).where(inArray(copyLinks.status, ["OPEN", "OPENING", "PENDING_ORDER", "DIVERGED"])),
    db().select().from(alerts).where(isNull(alerts.acknowledgedAt)).orderBy(desc(alerts.createdAt)).limit(8),
    db().select().from(executionJobs).orderBy(desc(executionJobs.createdAt)).limit(8),
    db().execute(sql`select state, count(*)::int n from execution_jobs where created_at > now() - interval '24 hours' group by state`),
  ]);
  const alive = engineAlive(hb?.lastBeatAt);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const c = Object.fromEntries((counts as unknown as { state: string; n: number }[]).map((r) => [r.state, r.n]));
  const connected = accounts.filter((a) => effectiveStatus(a, alive).label === "CONNECTED").length;
  const activeRoutes = rts.filter((r) => r.active);
  const errors24 = (c.REJECTED ?? 0) + (c.NEEDS_ATTENTION ?? 0);
  return (
    <>
      <PageHead title="Overview" sub="Engine health, accounts, routes and copied positions. Copying runs in the engine, not in this page.">
        <AutoRefresh />
      </PageHead>
      {!alive && (
        <Notice tone="bad">
          The engine is not reporting a heartbeat{hb ? ` (last ${ago(hb.lastBeatAt)})` : ""}. Nothing is being copied and account statuses below are unknown. Start the engine service.
        </Notice>
      )}
      {accounts.length === 0 && <Notice tone="info">No accounts yet. Add accounts under <Link href="/accounts">Accounts</Link>, or seed a SIMULATION pair with <code>pnpm sim:seed</code>.</Notice>}
      <div className="stats">
        <Stat label="Engine" value={alive ? "Running" : "Offline"} tone={alive ? "ok" : "bad"} hint={hb ? `uptime ${Math.round((hb.stats.uptimeSec ?? 0) / 60)} min` : "never started"} />
        <Stat label="Accounts connected" value={`${connected}/${accounts.filter((a) => a.enabled).length}`} hint="verified by live sync" />
        <Stat label="Active routes" value={activeRoutes.length} hint={`${groups.length} group(s)`} />
        <Stat label="Copied positions" value={open.filter((l) => l.status === "OPEN").length} hint={`${open.filter((l) => l.status === "PENDING_ORDER").length} pending orders`} />
        <Stat label="Queue" value={Object.values(hb?.stats.queue ?? {}).reduce((a, b) => a + b, 0)} hint="jobs in flight" />
        <Stat label="Errors (24h)" value={errors24} tone={errors24 ? "warn" : undefined} hint={`${c.NEEDS_ATTENTION ?? 0} need attention`} />
      </div>
      <div className="grid grid-2">
        <Card title="Accounts" actions={<Link href="/accounts">Manage →</Link>}>
          {accounts.length === 0 ? (
            <Empty>No accounts.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Mode</th>
                    <th>Status</th>
                    <th className="num">Equity</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => {
                    const s = effectiveStatus(a, alive);
                    return (
                      <tr key={a.id}>
                        <td>
                          <Link href={`/accounts/${a.id}`}>{a.nickname}</Link>
                          <div className="faint">{a.platform}</div>
                        </td>
                        <td>
                          <EnvBadge env={a.environment} />
                        </td>
                        <td>
                          <Badge tone={s.tone} title={s.detail ?? a.statusDetail ?? undefined}>
                            {s.label}
                          </Badge>
                          <div className="faint">sync {ago(a.lastSyncAt)}</div>
                        </td>
                        <td className="num">
                          {fmt(a.equity)} {a.currency ?? ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Open alerts" actions={<Link href="/risk">Risk →</Link>}>
          {recentAlerts.length === 0 ? (
            <Empty>No unacknowledged alerts.</Empty>
          ) : (
            <ul className="checks">
              {recentAlerts.map((a) => (
                <li key={a.id}>
                  <Badge tone={a.severity === "CRITICAL" ? "bad" : a.severity === "WARNING" ? "warn" : "info"}>{a.code}</Badge> <span>{a.message}</span> <span className="faint">{ago(a.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <div className="grid grid-2">
        <Card title="Copied positions" actions={<Link href="/history">History →</Link>}>
          {open.length === 0 ? (
            <Empty>No copier-managed positions.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Follower</th>
                    <th>Symbol</th>
                    <th>Side</th>
                    <th className="num">Lots</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {open.map((l) => (
                    <tr key={l.id}>
                      <td>{byId.get(l.followerAccountId)?.nickname}</td>
                      <td>
                        {l.masterSymbol} → {l.followerSymbol}
                      </td>
                      <td>{l.side}</td>
                      <td className="num">{l.followerVolumeCurrent}</td>
                      <td>
                        <Badge tone={l.status === "OPEN" ? "ok" : l.status === "DIVERGED" ? "warn" : "info"}>{l.status}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Recent executions" actions={<Link href="/activity">Live activity →</Link>}>
          {recentJobs.length === 0 ? (
            <Empty>No executions yet.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <tbody>
                  {recentJobs.map((j) => (
                    <tr key={j.id}>
                      <td className="nowrap">{j.eventType.replace(/_/g, " ").toLowerCase()}</td>
                      <td>{byId.get(j.followerAccountId)?.nickname}</td>
                      <td>
                        <StateBadge state={j.state} />
                      </td>
                      <td className="faint">{j.reason?.slice(0, 80)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

import { desc, eq } from "drizzle-orm";
import { auditLog, connectionEvents, controlCommands, engineLogs, executionJobs } from "@gtc/db";
import { redact } from "@gtc/shared";
import { db } from "@/lib/db";
import { latestHeartbeat, listAccounts } from "@/lib/queries";
import { ago, engineAlive } from "@/lib/status";
import { requestControl } from "@/actions/accounts";
import { ActionForm, AutoRefresh } from "@/components/client";
import { Badge, Card, Empty, PageHead, Stat } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function DiagnosticsPage() {
  const [hb, accounts, logs, events, cmds, attention, audits] = await Promise.all([
    latestHeartbeat(),
    listAccounts(),
    db().select().from(engineLogs).orderBy(desc(engineLogs.at)).limit(80),
    db().select().from(connectionEvents).orderBy(desc(connectionEvents.at)).limit(40),
    db().select().from(controlCommands).orderBy(desc(controlCommands.createdAt)).limit(25),
    db().select().from(executionJobs).where(eq(executionJobs.state, "NEEDS_ATTENTION")).orderBy(desc(executionJobs.createdAt)).limit(50),
    db().select().from(auditLog).orderBy(desc(auditLog.at)).limit(30),
  ]);
  const alive = engineAlive(hb?.lastBeatAt);
  const names = new Map(accounts.map((a) => [a.id, a.nickname]));
  const ex = hb?.stats.executor ?? {};
  return (
    <>
      <PageHead title="Diagnostics" sub="Real heartbeat, adapter health, rate limits, reconnects and redacted logs.">
        <AutoRefresh everyMs={3000} />
      </PageHead>
      <div className="stats">
        <Stat label="Heartbeat" value={hb ? ago(hb.lastBeatAt) : "never"} tone={alive ? "ok" : "bad"} hint={hb ? `instance ${hb.instanceId} · v${hb.version}` : undefined} />
        <Stat label="Uptime" value={hb ? `${Math.round((hb.stats.uptimeSec ?? 0) / 60)} min` : "—"} hint={hb ? `${hb.stats.memoryMb} MB RSS` : undefined} />
        <Stat label="Jobs processed" value={ex.processed ?? 0} hint={`${ex.filled ?? 0} filled · ${ex.rejected ?? 0} rejected · ${ex.skipped ?? 0} skipped`} />
        <Stat label="Unknown outcomes" value={ex.unknown ?? 0} hint={`${ex.needsAttention ?? 0} flagged`} tone={(ex.needsAttention ?? 0) > 0 ? "warn" : undefined} />
        <Stat label="Live execution" value={hb?.liveTradingEnabled ? "ENABLED" : "disabled"} tone={hb?.liveTradingEnabled ? "bad" : undefined} hint="engine LIVE_TRADING_ENABLED" />
      </div>
      <Card title="Adapters">
        {!hb?.stats.accounts?.length ? (
          <Empty>No adapter data (engine offline or no enabled accounts).</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Detection</th>
                  <th className="num">Snapshot age</th>
                  <th className="num">Avg latency</th>
                  <th className="num">Requests</th>
                  <th className="num">Reconnects</th>
                  <th className="num">Token refresh</th>
                  <th className="num">Rate-limited</th>
                  <th>Rate limits (used/limit)</th>
                  <th>Last error</th>
                </tr>
              </thead>
              <tbody>
                {hb.stats.accounts.map((a) => (
                  <tr key={a.id}>
                    <td>
                      {a.nickname} <span className="faint">{a.platform}</span>
                    </td>
                    <td>{a.isMaster ? "master" : "follower"}</td>
                    <td>
                      <Badge tone={a.connected ? "ok" : "bad"}>{a.status}</Badge>
                    </td>
                    <td className="faint">{a.health ? `${a.health.detection.mode} ~${a.health.detection.intervalMs}ms` : "—"}</td>
                    <td className="num">{a.snapshotAgeMs !== null ? `${(a.snapshotAgeMs / 1000).toFixed(1)}s` : "—"}</td>
                    <td className="num">{a.health?.avgLatencyMs ?? "—"}</td>
                    <td className="num">{a.health?.requests ?? "—"}</td>
                    <td className="num">{a.health?.reconnects ?? "—"}</td>
                    <td className="num">{a.health?.tokenRefreshes ?? "—"}</td>
                    <td className="num">{a.health?.rateLimited ?? "—"}</td>
                    <td className="faint">{a.health?.rateLimits.map((r) => `${r.name} ${r.used}/${r.limit} per ${r.windowMs / 1000}s`).join(" · ") || "—"}</td>
                    <td className="faint">{a.health?.lastError ? `${redact(a.health.lastError)} (${a.health.lastErrorAt ? ago(new Date(a.health.lastErrorAt)) : ""})` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title={`Needs attention (${attention.length})`}>
        {attention.length === 0 ? (
          <Empty>No flagged executions.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <tbody>
                {attention.map((j) => (
                  <tr key={j.id}>
                    <td className="faint nowrap">{ago(j.createdAt)}</td>
                    <td>{names.get(j.followerAccountId)}</td>
                    <td className="mono">
                      {j.command?.kind} {j.command?.symbol} {j.command?.tag}
                    </td>
                    <td>{j.reason}</td>
                    <td>
                      <ActionForm action={requestControl} submit="Mark resolved" inline>
                        <input type="hidden" name="kind" value="RESOLVE_JOB" />
                        <input type="hidden" name="jobId" value={j.id} />
                        <input name="note" placeholder="what you verified" maxLength={200} />
                      </ActionForm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="grid grid-2">
        <Card title="Engine requests">
          {cmds.length === 0 ? (
            <Empty>None.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <tbody>
                  {cmds.map((c) => (
                    <tr key={c.id}>
                      <td className="faint nowrap">{ago(c.createdAt)}</td>
                      <td className="mono">{c.kind}</td>
                      <td>
                        <Badge tone={c.status === "DONE" ? "ok" : c.status === "FAILED" ? "bad" : "info"}>{c.status}</Badge>
                      </td>
                      <td className="faint mono break">{c.result ? JSON.stringify(redact(c.result)).slice(0, 300) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Connection events">
          {events.length === 0 ? (
            <Empty>None.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <tbody>
                  {events.map((e) => (
                    <tr key={e.id}>
                      <td className="faint nowrap">{ago(e.at)}</td>
                      <td>{names.get(e.accountId)}</td>
                      <td>
                        <Badge tone="info">{e.kind}</Badge>
                      </td>
                      <td className="faint">{e.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
      <Card title="Engine log (redacted)">
        {logs.length === 0 ? (
          <Empty>No log entries.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id}>
                    <td className="faint nowrap mono">{l.at.toISOString().slice(11, 23)}</td>
                    <td>
                      <Badge tone={l.level === "error" ? "bad" : l.level === "warn" ? "warn" : "muted"}>{l.level}</Badge>
                    </td>
                    <td className="mono">{l.component}</td>
                    <td>
                      {redact(l.message)} {l.context && <span className="faint mono break">{JSON.stringify(redact(l.context)).slice(0, 240)}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Audit log">
        <div className="table-wrap">
          <table>
            <tbody>
              {audits.map((a) => (
                <tr key={a.id}>
                  <td className="faint nowrap">{ago(a.at)}</td>
                  <td className="mono">{a.actor.slice(0, 24)}</td>
                  <td className="mono">{a.action}</td>
                  <td className="faint">{a.ip}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

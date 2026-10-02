import { desc, inArray } from "drizzle-orm";
import { executionJobs, masterEvents } from "@gtc/db";
import { db } from "@/lib/db";
import { listAccounts } from "@/lib/queries";
import { ago, fmt, ms } from "@/lib/status";
import { AutoRefresh } from "@/components/client";
import { Badge, Card, Empty, EnvBadge, PageHead, StateBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function ActivityPage() {
  const [events, accounts] = await Promise.all([db().select().from(masterEvents).orderBy(desc(masterEvents.seq)).limit(60), listAccounts()]);
  const jobs = events.length ? await db().select().from(executionJobs).where(inArray(executionJobs.masterEventId, events.map((e) => e.id))) : [];
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return (
    <>
      <PageHead title="Live Activity" sub="Master events and each follower's independent result. Delays are measured, not promised.">
        <AutoRefresh everyMs={2000} />
      </PageHead>
      {events.length === 0 ? (
        <Empty>No master events yet. Events appear when a master account with an active route changes positions or orders.</Empty>
      ) : (
        events.map((e) => {
          const p = e.payload;
          const m = byId.get(e.accountId);
          const detectDelay = e.platformTime ? e.detectedAt.getTime() - e.platformTime.getTime() : null;
          const js = jobs.filter((j) => j.masterEventId === e.id);
          return (
            <Card
              key={e.id}
              title={
                <>
                  <Badge tone="info">{e.type.replace(/_/g, " ")}</Badge> <span className="mono">{p.symbol}</span> {p.side} {p.volume}
                  {p.previousVolume !== undefined && <span className="faint"> (was {p.previousVolume})</span>} {p.price ? <span className="faint">@ {p.price}</span> : null}
                </>
              }
              actions={
                <span className="faint">
                  {m?.nickname} {m && <EnvBadge env={m.environment} />} · {e.source} · {ago(e.detectedAt)}
                </span>
              }
            >
              <p className="faint" style={{ marginTop: -6 }}>
                SL {p.sl ?? "—"} · TP {p.tp ?? "—"} · master key <span className="mono">{p.masterKey}</span>
                {detectDelay !== null && detectDelay >= 0 && ` · detection delay ${detectDelay} ms (platform clock → engine)`}
              </p>
              {js.length === 0 ? (
                <p className="faint">{e.routedAt ? "No active routes for this master." : "Routing…"}</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Follower</th>
                        <th>State</th>
                        <th>Command</th>
                        <th className="num">Lots</th>
                        <th className="num">Fill</th>
                        <th className="num">Δ ticks</th>
                        <th className="num">Detect→submit</th>
                        <th className="num">Submit→confirm</th>
                        <th>Reason / notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {js.map((j) => {
                        const f = byId.get(j.followerAccountId);
                        const notes = (j.detail as { notes?: string[] } | null)?.notes ?? [];
                        return (
                          <tr key={j.id}>
                            <td>
                              {f?.nickname} {f && <EnvBadge env={f.environment} />}
                            </td>
                            <td>
                              <StateBadge state={j.state} />
                              {j.attempts > 0 && <div className="faint">attempts {j.attempts + 1}</div>}
                            </td>
                            <td className="mono">{j.command ? `${j.command.kind} ${j.command.symbol}` : "—"}</td>
                            <td className="num">
                              {j.requestedVolume ?? "—"}
                              {j.filledVolume !== null && j.filledVolume !== j.requestedVolume ? ` → ${j.filledVolume}` : ""}
                            </td>
                            <td className="num">{fmt(j.fillPrice, 5)}</td>
                            <td className="num">{j.priceDiffPoints ?? "—"}</td>
                            <td className="num">{ms(j.detectedAt, j.submittedAt)}</td>
                            <td className="num">{ms(j.submittedAt, j.filledAt ?? j.acceptedAt)}</td>
                            <td>
                              {j.reason && <div>{j.reason}</div>}
                              {notes.length > 0 && (
                                <details>
                                  <summary>calculation</summary>
                                  <ul className="faint">
                                    {notes.map((n, i) => (
                                      <li key={i}>{n}</li>
                                    ))}
                                  </ul>
                                </details>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          );
        })
      )}
    </>
  );
}

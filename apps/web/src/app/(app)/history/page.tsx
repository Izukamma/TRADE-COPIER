import { desc } from "drizzle-orm";
import { copyLinks, executionJobs } from "@gtc/db";
import { db } from "@/lib/db";
import { listAccounts } from "@/lib/queries";
import { fmt, ms } from "@/lib/status";
import { Badge, Card, Empty, PageHead } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const [links, accounts, entries] = await Promise.all([
    db().select().from(copyLinks).orderBy(desc(copyLinks.createdAt)).limit(300),
    listAccounts(),
    db().select().from(executionJobs).orderBy(desc(executionJobs.createdAt)).limit(2000),
  ]);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const entryByClient = new Map(entries.filter((j) => j.command && (j.command.kind === "OPEN_MARKET" || j.command.kind === "PLACE_PENDING")).map((j) => [j.command!.clientId, j]));
  return (
    <>
      <PageHead title="Trade History" sub="Each master trade linked to its follower trade, with sizes, timestamps and measured price differences.">
        <a className="btn btn-ghost btn-sm" href="/api/history/export">
          Export CSV
        </a>
      </PageHead>
      <Card>
        {links.length === 0 ? (
          <Empty>No copied trades yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Opened</th>
                  <th>Master → Follower</th>
                  <th>Symbol</th>
                  <th>Side</th>
                  <th className="num">Master lots</th>
                  <th className="num">Follower lots</th>
                  <th className="num">Master px</th>
                  <th className="num">Follower px</th>
                  <th className="num">Δ ticks</th>
                  <th className="num">Detect→fill</th>
                  <th>Status</th>
                  <th>Closed</th>
                </tr>
              </thead>
              <tbody>
                {links.map((l) => {
                  const j = entryByClient.get(l.clientId);
                  return (
                    <tr key={l.id}>
                      <td className="nowrap">{(l.openedAt ?? l.createdAt).toISOString().replace("T", " ").slice(0, 19)}</td>
                      <td>
                        {byId.get(l.masterAccountId)?.nickname} → {byId.get(l.followerAccountId)?.nickname}
                      </td>
                      <td className="mono">
                        {l.masterSymbol} → {l.followerSymbol}
                      </td>
                      <td>{l.side}</td>
                      <td className="num">
                        {l.masterVolumeInitial}
                        {l.masterVolumeCurrent !== l.masterVolumeInitial && <span className="faint"> / {l.masterVolumeCurrent}</span>}
                      </td>
                      <td className="num">
                        {l.followerVolumeInitial}
                        {l.followerVolumeCurrent !== l.followerVolumeInitial && <span className="faint"> / {l.followerVolumeCurrent}</span>}
                      </td>
                      <td className="num">{fmt(l.masterOpenPrice, 5)}</td>
                      <td className="num">{fmt(l.followerOpenPrice, 5)}</td>
                      <td className="num">{j?.priceDiffPoints ?? "—"}</td>
                      <td className="num">{ms(j?.detectedAt, j?.filledAt)}</td>
                      <td>
                        <Badge tone={l.status === "OPEN" ? "ok" : l.status === "CLOSED" ? "muted" : l.status === "FAILED" || l.status === "DIVERGED" ? "warn" : "info"} title={l.statusDetail ?? undefined}>
                          {l.status}
                        </Badge>
                      </td>
                      <td className="nowrap faint">{l.closedAt?.toISOString().replace("T", " ").slice(0, 19) ?? ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

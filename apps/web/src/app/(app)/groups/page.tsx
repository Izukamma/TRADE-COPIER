import Link from "next/link";
import { copierGroups, routes } from "@gtc/db";
import { db } from "@/lib/db";
import { listAccounts } from "@/lib/queries";
import { createGroup } from "@/actions/groups";
import { ActionForm } from "@/components/client";
import { Badge, Card, Empty, EnvBadge, PageHead } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function GroupsPage() {
  const [groups, rts, accounts] = await Promise.all([db().select().from(copierGroups), db().select().from(routes), listAccounts()]);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return (
    <>
      <PageHead title="Copier Groups" sub="Each group has one master and any number of followers. Any platform can be either. Loops, chains and duplicate routes are refused." />
      <Card title="Groups">
        {groups.length === 0 ? (
          <Empty>No groups yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Group</th>
                  <th>Master</th>
                  <th>Followers</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const m = byId.get(g.masterAccountId);
                  const fr = rts.filter((r) => r.groupId === g.id);
                  return (
                    <tr key={g.id}>
                      <td>
                        <Link href={`/groups/${g.id}`}>{g.name}</Link>
                      </td>
                      <td>
                        {m?.nickname} <span className="faint">{m?.platform}</span> {m && <EnvBadge env={m.environment} />}
                      </td>
                      <td>
                        {fr.map((r) => (
                          <div key={r.id}>
                            {byId.get(r.followerAccountId)?.nickname} <span className="faint">{byId.get(r.followerAccountId)?.platform}</span> {r.active ? <Badge tone="ok">ACTIVE</Badge> : <Badge tone="muted">INACTIVE</Badge>} {r.entriesPaused && <Badge tone="warn">PAUSED</Badge>}
                          </div>
                        ))}
                      </td>
                      <td>{g.entriesPaused ? <Badge tone="warn">ENTRIES PAUSED</Badge> : <Badge tone="info">OPEN</Badge>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Create group">
        <ActionForm action={createGroup} submit="Create group">
          <div className="form-row">
            <label>
              Name
              <input name="name" required maxLength={80} />
            </label>
            <label>
              Master account
              <select name="masterAccountId" required>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.nickname} ({a.platform}, {a.environment})
                  </option>
                ))}
              </select>
            </label>
          </div>
        </ActionForm>
      </Card>
    </>
  );
}

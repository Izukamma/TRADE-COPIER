import { desc, isNull } from "drizzle-orm";
import { alerts, copierGroups, routes } from "@gtc/db";
import { accountRiskSchema } from "@gtc/shared";
import { db } from "@/lib/db";
import { latestHeartbeat, listAccounts, setting } from "@/lib/queries";
import { ago, fmt } from "@/lib/status";
import { setPause } from "@/actions/groups";
import { ackAlert, closeCopierPositions } from "@/actions/risk";
import { ActionForm, AutoRefresh } from "@/components/client";
import { Badge, Card, Empty, EnvBadge, Notice, PageHead } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function RiskPage() {
  const [accounts, hb, pause, groups, rts, open] = await Promise.all([
    listAccounts(),
    latestHeartbeat(),
    setting<{ paused: boolean; reason?: string; at?: string }>("pause.global"),
    db().select().from(copierGroups),
    db().select().from(routes),
    db().select().from(alerts).where(isNull(alerts.acknowledgedAt)).orderBy(desc(alerts.createdAt)).limit(100),
  ]);
  const daily = new Map((hb?.stats.accounts ?? []).map((a) => [a.id, a.dailyLoss]));
  const paused = !!pause?.paused;
  return (
    <>
      <PageHead title="Risk Controls" sub="Pauses stop new entries only — exits, partial closes and SL/TP management continue. The copier follows explicit settings; it never generates signals.">
        <AutoRefresh everyMs={5000} />
      </PageHead>
      <Notice tone="info">These controls do not guarantee compliance with any prop firm&apos;s rules. Firms compute daily loss and drawdown with their own baselines and timing.</Notice>
      <div className="grid grid-2">
        <Card title="Global entry pause">
          <p>{paused ? <Badge tone="warn">ENTRIES PAUSED</Badge> : <Badge tone="ok">ENTRIES ALLOWED</Badge>} {pause?.reason && <span className="dim">{pause.reason}</span>}</p>
          <ActionForm action={setPause} submit={paused ? "Resume all entries" : "Pause all new entries"} danger={!paused}>
            <input type="hidden" name="scope" value="GLOBAL" />
            <input type="hidden" name="value" value={String(!paused)} />
            {!paused && <input name="reason" placeholder="reason (optional)" maxLength={200} />}
          </ActionForm>
        </Card>
        <Card title="Close copier-managed positions">
          <p className="dim">Closes only positions the copier opened (linked trades). Unrelated follower trades are never touched. Entries in the chosen scope are paused first.</p>
          <ActionForm action={closeCopierPositions} submit="Close copier positions" danger confirmPhrase="CLOSE COPIER POSITIONS">
            <div className="form-row">
              <label>
                Scope
                <select name="scope" defaultValue="GLOBAL">
                  <option value="GLOBAL">All routes</option>
                  <option value="GROUP">One group</option>
                  <option value="ACCOUNT">One follower account</option>
                </select>
              </label>
              <label>
                Target (group or account)
                <select name="id">
                  <option value="">—</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      group: {g.name}
                    </option>
                  ))}
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      account: {a.nickname}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </ActionForm>
        </Card>
      </div>
      <Card title="Accounts">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Entries</th>
                <th>Daily loss rule</th>
                <th className="num">Baseline</th>
                <th className="num">Loss / limit</th>
                <th>Exposure cap</th>
                <th>Stale thresholds</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const r = accountRiskSchema.parse(a.riskConfig ?? {});
                const d = daily.get(a.id);
                return (
                  <tr key={a.id}>
                    <td>
                      {a.nickname} <EnvBadge env={a.environment} />
                    </td>
                    <td>
                      <ActionForm action={setPause} submit={a.entriesPaused ? "Resume" : "Pause"} inline>
                        <input type="hidden" name="scope" value="ACCOUNT" />
                        <input type="hidden" name="id" value={a.id} />
                        <input type="hidden" name="value" value={String(!a.entriesPaused)} />
                      </ActionForm>
                    </td>
                    <td className="dim">
                      {r.dailyLoss.enabled
                        ? `${r.dailyLoss.limitValue}${r.dailyLoss.limitType === "PERCENT" ? "%" : ` ${a.currency ?? ""}`} on ${r.dailyLoss.basis.toLowerCase()}${r.dailyLoss.basis === "BALANCE" ? (r.dailyLoss.includeFloating ? " + floating" : " (closed only)") : ""}, reset ${r.dailyLoss.resetTime} ${r.dailyLoss.resetTimezone}, baseline ${r.dailyLoss.baseline.toLowerCase().replace(/_/g, " ")}, then ${r.dailyLoss.onLimit.toLowerCase().replace(/_/g, " ")}`
                        : "off"}
                    </td>
                    <td className="num">
                      {d ? fmt(d.baseline) : "—"}
                      {d?.late && <div><Badge tone="warn">LATE BASELINE</Badge></div>}
                    </td>
                    <td className="num">
                      {d ? (
                        <>
                          {fmt(d.loss)} / {fmt(d.limit)} {d.breached && <Badge tone="bad">LIMIT</Badge>}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{r.maxAccountExposureLots} lots</td>
                    <td className="faint">
                      account {r.staleAccountSeconds}s · quote {r.staleQuoteSeconds}s
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="faint">Edit per-account limits on each account page. Route limits (order size, exposure, positions, mandatory SL) are in Copier Groups. Routes paused: {rts.filter((r) => r.entriesPaused).length}; groups paused: {groups.filter((g) => g.entriesPaused).length}.</p>
      </Card>
      <Card
        title={`Unacknowledged alerts (${open.length})`}
        actions={
          open.length > 0 && (
            <ActionForm action={ackAlert} submit="Acknowledge all" inline>
              <input type="hidden" name="id" value="ALL" />
            </ActionForm>
          )
        }
      >
        {open.length === 0 ? (
          <Empty>None.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <tbody>
                {open.map((a) => (
                  <tr key={a.id}>
                    <td className="nowrap faint">{ago(a.createdAt)}</td>
                    <td>
                      <Badge tone={a.severity === "CRITICAL" ? "bad" : a.severity === "WARNING" ? "warn" : "info"}>{a.code}</Badge>
                    </td>
                    <td>{a.message}</td>
                    <td>
                      <ActionForm action={ackAlert} submit="Ack" inline>
                        <input type="hidden" name="id" value={a.id} />
                      </ActionForm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

import Link from "next/link";
import { latestHeartbeat, listAccounts } from "@/lib/queries";
import { ago, effectiveStatus, engineAlive, fmt } from "@/lib/status";
import { createAccount } from "@/actions/accounts";
import { ActionForm, AutoRefresh } from "@/components/client";
import { Badge, Card, Empty, EnvBadge, PageHead } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function AccountsPage() {
  const [accounts, hb] = await Promise.all([listAccounts(), latestHeartbeat()]);
  const alive = engineAlive(hb?.lastBeatAt);
  return (
    <>
      <PageHead title="Accounts" sub="Status is reported by the engine after authenticated calls succeed. Saving an account does not connect it.">
        <AutoRefresh everyMs={5000} />
      </PageHead>
      <Card title="All accounts">
        {accounts.length === 0 ? (
          <Empty>No accounts yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Nickname</th>
                  <th>Platform</th>
                  <th>Mode</th>
                  <th>Class</th>
                  <th>Broker / firm</th>
                  <th>Account</th>
                  <th className="num">Balance</th>
                  <th className="num">Equity</th>
                  <th className="num">Free margin</th>
                  <th>Status</th>
                  <th>Last sync</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => {
                  const s = effectiveStatus(a, alive);
                  return (
                    <tr key={a.id}>
                      <td>
                        <Link href={`/accounts/${a.id}`}>{a.nickname}</Link>
                      </td>
                      <td>{a.platform}</td>
                      <td>
                        <EnvBadge env={a.environment} />
                      </td>
                      <td>{a.accountClass.toLowerCase()}</td>
                      <td>{a.brokerName}</td>
                      <td className="mono">{a.externalAccountId}</td>
                      <td className="num">{fmt(a.balance)}</td>
                      <td className="num">
                        {fmt(a.equity)} {a.currency}
                      </td>
                      <td className="num">{fmt(a.freeMargin)}</td>
                      <td>
                        <Badge tone={s.tone} title={s.detail ?? a.statusDetail ?? undefined}>
                          {s.label}
                        </Badge>
                        {a.entriesPaused && <Badge tone="warn">PAUSED</Badge>}
                      </td>
                      <td className="faint">{ago(a.lastSyncAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Add account">
        <ActionForm action={createAccount} submit="Create account record">
          <div className="form-row">
            <label>
              Nickname
              <input name="nickname" required maxLength={80} />
            </label>
            <label>
              Platform
              <select name="platform" defaultValue="TRADELOCKER">
                <option value="MT4">MT4 (EA bridge)</option>
                <option value="MT5">MT5 (EA bridge)</option>
                <option value="TRADELOCKER">TradeLocker (API)</option>
                <option value="MATCHTRADER">Match-Trader (Platform API)</option>
              </select>
            </label>
            <label>
              Mode
              <select name="environment" defaultValue="DEMO">
                <option value="SIMULATION">SIMULATION (no broker)</option>
                <option value="DEMO">DEMO ACCOUNT (real platform)</option>
                <option value="LIVE">LIVE ACCOUNT</option>
              </select>
            </label>
            <label>
              Classification
              <select name="accountClass" defaultValue="PERSONAL">
                <option value="PERSONAL">Personal</option>
                <option value="EVALUATION">Evaluation</option>
                <option value="FUNDED">Funded</option>
              </select>
            </label>
          </div>
          <div className="form-row">
            <label>
              Broker or prop firm
              <input name="brokerName" required maxLength={120} />
            </label>
            <label>
              Account identifier (login / account id)
              <input name="externalAccountId" required maxLength={64} />
            </label>
            <label>
              Server / brand / system UUID
              <input name="server" maxLength={200} placeholder="TradeLocker server · Match-Trader system UUID · MT server · SIM-ALPHA/SIM-BETA" />
            </label>
            <label>
              API base URL (TradeLocker / Match-Trader)
              <input name="apiBaseUrl" type="url" placeholder="https://demo.tradelocker.com" />
            </label>
          </div>
          <p className="faint">Passwords are entered on the account page after creation, stored encrypted on the server and never displayed again.</p>
        </ActionForm>
      </Card>
    </>
  );
}

import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { connectionEvents, deviceTokens, instruments } from "@gtc/db";
import { accountRiskSchema } from "@gtc/shared";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { getAccount, hasCredentials, latestHeartbeat } from "@/lib/queries";
import { ago, effectiveStatus, engineAlive, fmt } from "@/lib/status";
import { armLive, clearCredentials, deleteAccount, issueDeviceToken, requestControl, revokeDeviceToken, setAccountFlags, setCredentials, updateAccountRisk } from "@/actions/accounts";
import { ActionForm, AutoRefresh } from "@/components/client";
import { Badge, Card, Empty, EnvBadge, Notice, PageHead } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function AccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const a = await getAccount(id);
  if (!a) notFound();
  const [hb, creds, tokens, specs, events] = await Promise.all([
    latestHeartbeat(),
    hasCredentials(id),
    db().select({ tokenId: deviceTokens.tokenId, label: deviceTokens.label, createdAt: deviceTokens.createdAt, lastUsedAt: deviceTokens.lastUsedAt, lastIp: deviceTokens.lastIp, revokedAt: deviceTokens.revokedAt }).from(deviceTokens).where(eq(deviceTokens.accountId, id)).orderBy(desc(deviceTokens.createdAt)),
    db().select().from(instruments).where(eq(instruments.accountId, id)).orderBy(instruments.symbol),
    db().select().from(connectionEvents).where(eq(connectionEvents.accountId, id)).orderBy(desc(connectionEvents.at)).limit(15),
  ]);
  const alive = engineAlive(hb?.lastBeatAt);
  const s = effectiveStatus(a, alive);
  const live = hb?.stats.accounts?.find((x) => x.id === id);
  const risk = accountRiskSchema.parse(a.riskConfig ?? {});
  const dl = risk.dailyLoss;
  const isMt = a.platform === "MT4" || a.platform === "MT5";
  const caps = a.capabilities;
  const hidden = <input type="hidden" name="id" value={a.id} />;
  return (
    <>
      <PageHead
        title={a.nickname}
        sub={
          <>
            {a.platform} · {a.brokerName} · <span className="mono">{a.externalAccountId}</span> {a.server && <>· {a.server}</>}
          </>
        }
      >
        <EnvBadge env={a.environment} />
        <Badge tone={s.tone} title={s.detail}>
          {s.label}
        </Badge>
        <AutoRefresh everyMs={5000} />
      </PageHead>
      {a.statusDetail && s.label !== "CONNECTED" && <Notice tone="warn">{a.statusDetail}</Notice>}
      {a.environment === "LIVE" && (
        <Notice tone="bad">
          LIVE ACCOUNT. Follower orders require both the engine flag LIVE_TRADING_ENABLED=true and arming this account. Currently: engine {hb?.liveTradingEnabled ? "ENABLED" : "disabled"}, account {a.liveExecutionArmed ? "ARMED" : "not armed"}.
        </Notice>
      )}
      <div className="grid grid-2">
        <Card title="Account state">
          <dl className="kv">
            <dt>Balance</dt>
            <dd>
              {fmt(a.balance)} {a.currency}
            </dd>
            <dt>Equity</dt>
            <dd>
              {fmt(a.equity)} {a.currency}
            </dd>
            <dt>Free margin</dt>
            <dd>{fmt(a.freeMargin)}</dd>
            <dt>Margin used</dt>
            <dd>{fmt(a.marginUsed)}</dd>
            <dt>Position accounting</dt>
            <dd>{a.accounting}</dd>
            <dt>Last successful sync</dt>
            <dd>{a.lastSyncAt ? `${a.lastSyncAt.toISOString()} (${ago(a.lastSyncAt)})` : "never"}</dd>
            <dt>Detection</dt>
            <dd>{live?.health ? `${live.health.detection.mode} · ~${live.health.detection.intervalMs} ms interval${live.health.avgLatencyMs !== null ? ` · ${live.health.avgLatencyMs} ms avg request` : ""}` : "—"}</dd>
          </dl>
          <div className="form-foot" style={{ marginTop: 12 }}>
            <ActionForm action={requestControl} submit="Test connection" inline>
              <input type="hidden" name="kind" value="TEST_CONNECTION" />
              <input type="hidden" name="accountId" value={a.id} />
            </ActionForm>
            <ActionForm action={requestControl} submit="Sync instruments" inline>
              <input type="hidden" name="kind" value="SYNC_INSTRUMENTS" />
              <input type="hidden" name="accountId" value={a.id} />
              <input name="symbols" placeholder="symbols (optional, comma-separated)" />
            </ActionForm>
          </div>
        </Card>
        <Card title="Platform capabilities">
          {!caps ? (
            <Empty>Reported after the engine connects.</Empty>
          ) : (
            <>
              <p>
                <Badge tone={caps.integrationStatus === "VERIFIED_DEMO" ? "ok" : caps.integrationStatus === "SIMULATED" ? "sim" : "warn"}>{caps.integrationStatus.replace(/_/g, " ")}</Badge>
              </p>
              <ul className="checks">
                {(
                  [
                    ["Master", caps.canBeMaster],
                    ["Follower", caps.canBeFollower],
                    ["Market orders", caps.marketOrders],
                    ["Limit orders", caps.pendingLimit],
                    ["Stop orders", caps.pendingStop],
                    ["Modify SL/TP", caps.modifyPositionSlTp],
                    ["Modify pending", caps.modifyPendingOrder],
                    ["Partial close", caps.partialClose],
                    ["Order tagging", caps.orderTagging],
                  ] as const
                ).map(([k, v]) => (
                  <li key={k}>
                    <Badge tone={v ? "ok" : "muted"}>{v ? "YES" : "NO"}</Badge> {k}
                  </li>
                ))}
              </ul>
              <ul className="dim">
                {caps.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </div>

      {a.environment !== "SIMULATION" && !isMt && (
        <Card title="API credentials">
          <p className="dim">
            Stored: <Badge tone={creds ? "ok" : "muted"}>{creds ? "ENCRYPTED ON SERVER" : "NOT SET"}</Badge> — values are write-only and never shown again.
          </p>
          <ActionForm action={setCredentials} submit={creds ? "Replace credentials" : "Save credentials"}>
            {hidden}
            <div className="form-row">
              <label>
                Login / email
                <input name="login" autoComplete="off" required />
              </label>
              <label>
                Password
                <input name="password" type="password" autoComplete="new-password" required />
              </label>
              {a.platform === "MATCHTRADER" && (
                <label>
                  Broker id
                  <input name="brokerId" autoComplete="off" required />
                </label>
              )}
            </div>
          </ActionForm>
          {creds && (
            <ActionForm action={clearCredentials} submit="Remove credentials" danger inline>
              {hidden}
            </ActionForm>
          )}
        </Card>
      )}

      {isMt && a.environment !== "SIMULATION" && (
        <Card title="Bridge device tokens">
          <p className="dim">
            The MetaTrader login stays inside the terminal. The EA authenticates to the engine with a scoped, revocable token bound to login <span className="mono">{a.externalAccountId}</span>. Bridge URL: <code>{env().PUBLIC_BRIDGE_URL ?? "set PUBLIC_BRIDGE_URL"}</code>
          </p>
          {tokens.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Token id</th>
                    <th>Label</th>
                    <th>Created</th>
                    <th>Last used</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {tokens.map((t) => (
                    <tr key={t.tokenId}>
                      <td className="mono">{t.tokenId}</td>
                      <td>{t.label}</td>
                      <td>{ago(t.createdAt)}</td>
                      <td>
                        {ago(t.lastUsedAt)} {t.lastIp && <span className="faint">{t.lastIp}</span>}
                      </td>
                      <td>{t.revokedAt ? <Badge tone="muted">REVOKED</Badge> : <Badge tone="ok">ACTIVE</Badge>}</td>
                      <td>
                        {!t.revokedAt && (
                          <ActionForm action={revokeDeviceToken} submit="Revoke" danger inline>
                            <input type="hidden" name="tokenId" value={t.tokenId} />
                          </ActionForm>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <ActionForm action={issueDeviceToken} submit="Issue new token" inline>
            {hidden}
            <input name="label" placeholder="label, e.g. VPS-1 MT5" maxLength={60} />
          </ActionForm>
        </Card>
      )}

      <Card title="Risk controls for this account">
        <ActionForm action={updateAccountRisk} submit="Save risk settings">
          {hidden}
          <fieldset>
            <legend>Daily loss limit</legend>
            <label className="check">
              <input type="checkbox" name="dl_enabled" defaultChecked={dl.enabled} /> Enabled
            </label>
            <div className="form-row">
              <label>
                Reset timezone (IANA)
                <input name="dl_tz" defaultValue={dl.resetTimezone} />
              </label>
              <label>
                Reset time (HH:MM)
                <input name="dl_time" defaultValue={dl.resetTime} pattern="[0-2][0-9]:[0-5][0-9]" />
              </label>
              <label>
                Basis
                <select name="dl_basis" defaultValue={dl.basis}>
                  <option value="EQUITY">Equity</option>
                  <option value="BALANCE">Balance</option>
                </select>
              </label>
              <label>
                Baseline at reset
                <select name="dl_baseline" defaultValue={dl.baseline}>
                  <option value="HIGHER_OF_BALANCE_EQUITY">Higher of balance/equity</option>
                  <option value="START_BALANCE">Start-of-day balance</option>
                  <option value="START_EQUITY">Start-of-day equity</option>
                </select>
              </label>
            </div>
            <div className="form-row">
              <label className="check">
                <input type="checkbox" name="dl_floating" defaultChecked={dl.includeFloating} /> Count floating P&amp;L (balance basis)
              </label>
              <label>
                Limit type
                <select name="dl_type" defaultValue={dl.limitType}>
                  <option value="PERCENT">% of baseline</option>
                  <option value="AMOUNT">Amount (account currency)</option>
                </select>
              </label>
              <label>
                Limit value
                <input name="dl_value" type="number" step="any" min="0" defaultValue={dl.limitValue} />
              </label>
              <label>
                When reached
                <select name="dl_on" defaultValue={dl.onLimit}>
                  <option value="PAUSE_ENTRIES">Pause new entries</option>
                  <option value="PAUSE_ENTRIES_AND_CLOSE_COPIER_POSITIONS">Pause entries and close copier positions</option>
                </select>
              </label>
            </div>
          </fieldset>
          <div className="form-row">
            <label>
              Max copier exposure on account (lots)
              <input name="maxAccountExposureLots" type="number" step="any" defaultValue={risk.maxAccountExposureLots} />
            </label>
            <label>
              Min free-margin ratio after order
              <input name="minFreeMarginAfterOrder" type="number" step="any" defaultValue={risk.minFreeMarginAfterOrder} />
            </label>
            <label>
              Stale account data (s)
              <input name="staleAccountSeconds" type="number" defaultValue={risk.staleAccountSeconds} />
            </label>
            <label>
              Stale quote (s)
              <input name="staleQuoteSeconds" type="number" defaultValue={risk.staleQuoteSeconds} />
            </label>
          </div>
          <p className="faint">These are copier-side controls. They do not guarantee compliance with any prop firm&apos;s rules, which may compute daily loss differently.</p>
        </ActionForm>
      </Card>

      <div className="grid grid-2">
        <Card title="Controls">
          <div className="form-foot">
            <ActionForm action={setAccountFlags} submit={a.entriesPaused ? "Resume entries" : "Pause new entries"} inline>
              {hidden}
              <input type="hidden" name="flag" value="entriesPaused" />
              <input type="hidden" name="value" value={String(!a.entriesPaused)} />
            </ActionForm>
            <ActionForm action={setAccountFlags} submit={a.enabled ? "Disable account" : "Enable account"} inline danger={a.enabled}>
              {hidden}
              <input type="hidden" name="flag" value="enabled" />
              <input type="hidden" name="value" value={String(!a.enabled)} />
            </ActionForm>
          </div>
          {a.environment === "LIVE" &&
            (a.liveExecutionArmed ? (
              <ActionForm action={armLive} submit="Disarm live execution" danger>
                {hidden}
                <input type="hidden" name="value" value="false" />
              </ActionForm>
            ) : (
              <ActionForm action={armLive} submit="Arm live execution" danger confirmPhrase={`ARM ${a.externalAccountId}`}>
                {hidden}
                <input type="hidden" name="value" value="true" />
              </ActionForm>
            ))}
          <details style={{ marginTop: 12 }}>
            <summary>Delete account</summary>
            <ActionForm action={deleteAccount} submit="Delete account record" danger confirmPhrase={`DELETE ${a.nickname}`}>
              {hidden}
            </ActionForm>
          </details>
        </Card>
        <Card title="Connection events">
          {events.length === 0 ? (
            <Empty>None yet.</Empty>
          ) : (
            <ul className="checks">
              {events.map((e) => (
                <li key={e.id}>
                  <span className="faint">{ago(e.at)}</span> <Badge tone={e.kind === "CONNECTED" || e.kind === "CONNECT" ? "ok" : e.kind.includes("FAIL") || e.kind === "DISCONNECT" || e.kind === "DISCONNECTED" ? "bad" : "info"}>{e.kind}</Badge> <span className="dim">{e.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title={`Instrument specifications (${specs.length})`}>
        {specs.length === 0 ? (
          <Empty>No specifications synchronised. API platforms fetch details only for mapped symbols.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th className="num">Contract</th>
                  <th className="num">Tick size</th>
                  <th className="num">Tick value</th>
                  <th className="num">Digits</th>
                  <th className="num">Min / step / max</th>
                  <th className="num">Stops dist.</th>
                  <th className="num">Bid / ask</th>
                  <th>Source</th>
                  <th>Gaps</th>
                </tr>
              </thead>
              <tbody>
                {specs.map((r) => (
                  <tr key={r.symbol}>
                    <td className="mono">{r.symbol}</td>
                    <td className="num">{r.spec.contractSize ?? "—"}</td>
                    <td className="num">{r.spec.tickSize}</td>
                    <td className="num">
                      {r.spec.tickValue ?? "—"} {r.spec.tickValueCurrency ?? ""}
                    </td>
                    <td className="num">{r.spec.digits}</td>
                    <td className="num">
                      {r.spec.volumeMin} / {r.spec.volumeStep} / {r.spec.volumeMax}
                    </td>
                    <td className="num">{r.spec.stopsDistance}</td>
                    <td className="num">
                      {r.bid ?? "—"} / {r.ask ?? "—"}
                    </td>
                    <td>
                      <Badge tone={r.spec.source === "MANUAL" ? "warn" : "info"}>{r.spec.source ?? "PLATFORM"}</Badge>
                    </td>
                    <td className="faint">{r.spec.missingFields.join(", ")}</td>
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

import { eq } from "drizzle-orm";
import { appSettings, tradingAccounts } from "@gtc/db";
import type { SimState } from "@gtc/adapters";
import { db } from "@/lib/db";
import { simAction, simFaults } from "@/actions/sim";
import { ActionForm, AutoRefresh } from "@/components/client";
import { Badge, Card, Empty, Notice, PageHead } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function SimulatorPage() {
  const sims = await db().select({ id: tradingAccounts.id, nickname: tradingAccounts.nickname, server: tradingAccounts.server }).from(tradingAccounts).where(eq(tradingAccounts.environment, "SIMULATION"));
  const states = new Map<string, SimState>();
  for (const s of sims) {
    const r = await db().query.appSettings.findFirst({ where: eq(appSettings.key, `sim:${s.id}`) });
    if (r) states.set(s.id, r.value as SimState);
  }
  return (
    <>
      <PageHead title="Simulator" sub="SIMULATION mode only. Trades here go to an in-process simulated broker inside the engine; nothing reaches a real platform.">
        <AutoRefresh everyMs={2000} />
      </PageHead>
      <Notice tone="sim">
        <Badge tone="sim">SIMULATION</Badge> Simulated prices are a random walk and simulated fills prove only the copier&apos;s logic, not real-platform behaviour. A DEMO ACCOUNT uses real platform connectivity; this does not.
      </Notice>
      {sims.length === 0 && <Empty>No SIMULATION accounts. Create one on the Accounts page (mode SIMULATION, server SIM-ALPHA or SIM-BETA) or run <code>pnpm sim:seed</code>.</Empty>}
      {sims.map((s) => {
        const st = states.get(s.id);
        return (
          <Card key={s.id} title={<>{s.nickname} <span className="faint">{s.server}</span> {st && <span className="faint">balance {st.balance.toFixed(2)} {st.currency} · {st.accounting}</span>}</>}>
            {!st ? (
              <Empty>The engine has not loaded this simulator yet.</Empty>
            ) : (
              <>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Ticket</th>
                        <th>Symbol</th>
                        <th>Side</th>
                        <th className="num">Lots</th>
                        <th className="num">Open</th>
                        <th className="num">SL</th>
                        <th className="num">TP</th>
                        <th>Tag</th>
                      </tr>
                    </thead>
                    <tbody>
                      {st.positions.map((p) => (
                        <tr key={p.id}>
                          <td className="mono">{p.id}</td>
                          <td>{p.symbol}</td>
                          <td>{p.side}</td>
                          <td className="num">{p.volume}</td>
                          <td className="num">{p.openPrice}</td>
                          <td className="num">{p.sl ?? "—"}</td>
                          <td className="num">{p.tp ?? "—"}</td>
                          <td className="mono faint">{p.tag ?? "manual"}</td>
                        </tr>
                      ))}
                      {st.orders.map((o) => (
                        <tr key={o.id}>
                          <td className="mono">{o.id}</td>
                          <td>{o.symbol}</td>
                          <td>
                            {o.side} {o.kind}
                          </td>
                          <td className="num">{o.volume}</td>
                          <td className="num">@ {o.price}</td>
                          <td className="num">{o.sl ?? "—"}</td>
                          <td className="num">{o.tp ?? "—"}</td>
                          <td className="mono faint">{o.tag ?? "manual"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="faint">Prices: {Object.entries(st.prices).map(([k, v]) => `${k} ${v.mid.toFixed(k.includes("USD") && v.mid < 10 ? 5 : 2)}`).join(" · ")}</p>
                <div className="grid grid-2">
                  <ActionForm action={simAction} submit="Open market trade">
                    <input type="hidden" name="accountId" value={s.id} />
                    <input type="hidden" name="action" value="OPEN" />
                    <div className="form-row">
                      <select name="symbol">{Object.keys(st.prices).map((k) => <option key={k}>{k}</option>)}</select>
                      <select name="side">
                        <option>BUY</option>
                        <option>SELL</option>
                      </select>
                      <input name="volume" type="number" step="any" defaultValue="1" />
                      <input name="sl" type="number" step="any" placeholder="SL" />
                      <input name="tp" type="number" step="any" placeholder="TP" />
                      <input name="magic" type="number" placeholder="magic (EA)" />
                    </div>
                  </ActionForm>
                  <ActionForm action={simAction} submit="Place pending order">
                    <input type="hidden" name="accountId" value={s.id} />
                    <input type="hidden" name="action" value="PENDING" />
                    <div className="form-row">
                      <select name="symbol">{Object.keys(st.prices).map((k) => <option key={k}>{k}</option>)}</select>
                      <select name="side">
                        <option>BUY</option>
                        <option>SELL</option>
                      </select>
                      <select name="kind">
                        <option>LIMIT</option>
                        <option>STOP</option>
                      </select>
                      <input name="volume" type="number" step="any" defaultValue="1" />
                      <input name="price" type="number" step="any" placeholder="price" required />
                    </div>
                  </ActionForm>
                  <ActionForm action={simAction} submit="Modify SL/TP">
                    <input type="hidden" name="accountId" value={s.id} />
                    <input type="hidden" name="action" value="MODIFY" />
                    <div className="form-row">
                      <input name="positionId" placeholder="ticket" required />
                      <input name="sl" type="number" step="any" placeholder="SL" />
                      <input name="tp" type="number" step="any" placeholder="TP" />
                    </div>
                  </ActionForm>
                  <ActionForm action={simAction} submit="Close (blank volume = full)">
                    <input type="hidden" name="accountId" value={s.id} />
                    <input type="hidden" name="action" value="CLOSE" />
                    <div className="form-row">
                      <input name="positionId" placeholder="ticket" required />
                      <input name="volume" type="number" step="any" placeholder="partial volume" />
                    </div>
                  </ActionForm>
                  <ActionForm action={simAction} submit="Cancel pending">
                    <input type="hidden" name="accountId" value={s.id} />
                    <input type="hidden" name="action" value="CANCEL" />
                    <input name="orderId" placeholder="order ticket" required />
                  </ActionForm>
                  <ActionForm action={simAction} submit="Set price">
                    <input type="hidden" name="accountId" value={s.id} />
                    <input type="hidden" name="action" value="SET_PRICE" />
                    <div className="form-row">
                      <select name="symbol">{Object.keys(st.prices).map((k) => <option key={k}>{k}</option>)}</select>
                      <input name="mid" type="number" step="any" placeholder="mid price" required />
                    </div>
                  </ActionForm>
                </div>
                <details>
                  <summary>Fault injection (test ambiguous timeouts, rejections, disconnects)</summary>
                  <ActionForm action={simFaults} submit="Apply faults">
                    <input type="hidden" name="accountId" value={s.id} />
                    <div className="form-row">
                      <label>
                        Reject rate (0–1)
                        <input name="rejectRate" type="number" step="0.05" min="0" max="1" defaultValue={st.faults.rejectRate} />
                      </label>
                      <label>
                        Lost-response rate (0–1)
                        <input name="lostResponseRate" type="number" step="0.05" min="0" max="1" defaultValue={st.faults.lostResponseRate} />
                      </label>
                      <label>
                        Not-sent rate (0–1)
                        <input name="notSentRate" type="number" step="0.05" min="0" max="1" defaultValue={st.faults.notSentRate} />
                      </label>
                      <label>
                        Latency (ms)
                        <input name="latencyMs" type="number" min="0" defaultValue={st.faults.latencyMs} />
                      </label>
                    </div>
                  </ActionForm>
                </details>
              </>
            )}
          </Card>
        );
      })}
    </>
  );
}

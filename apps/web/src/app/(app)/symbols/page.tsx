import { and, eq } from "drizzle-orm";
import { instruments, symbolMappings } from "@gtc/db";
import type { InstrumentSpec } from "@gtc/shared";
import { db } from "@/lib/db";
import { listAccounts, setting } from "@/lib/queries";
import { addMapping, disableMapping, saveFxRates, saveSpecOverride, suggest, validateOrConfirm } from "@/actions/symbols";
import { ActionForm } from "@/components/client";
import { Badge, Card, Empty, Notice, PageHead } from "@/components/ui";

export const dynamic = "force-dynamic";

const specLine = (s: InstrumentSpec | undefined) =>
  s ? `contract ${s.contractSize ?? "?"} · tick ${s.tickSize} = ${s.tickValue ?? "?"} ${s.tickValueCurrency ?? ""} · ${s.digits}dp · vol ${s.volumeMin}/${s.volumeStep}/${s.volumeMax}${s.stopsDistance ? ` · stops ${s.stopsDistance}` : ""}${s.source === "MANUAL" ? " · MANUAL" : ""}` : "not synchronised";

export default async function SymbolsPage({ searchParams }: { searchParams: Promise<{ master?: string; follower?: string }> }) {
  const sp = await searchParams;
  const accounts = await listAccounts();
  const master = accounts.find((a) => a.id === sp.master);
  const follower = accounts.find((a) => a.id === sp.follower);
  const fxRates = (await setting<{ base: string; quote: string; rate: number }[]>("fx.manual")) ?? [];
  let rows: (typeof symbolMappings.$inferSelect)[] = [];
  let mSpecs = new Map<string, InstrumentSpec>();
  let fSpecs = new Map<string, InstrumentSpec>();
  if (master && follower) {
    rows = await db().select().from(symbolMappings).where(and(eq(symbolMappings.masterAccountId, master.id), eq(symbolMappings.followerAccountId, follower.id))).orderBy(symbolMappings.masterSymbol);
    mSpecs = new Map((await db().select().from(instruments).where(eq(instruments.accountId, master.id))).map((r) => [r.symbol, r.spec]));
    fSpecs = new Map((await db().select().from(instruments).where(eq(instruments.accountId, follower.id))).map((r) => [r.symbol, r.spec]));
  }
  return (
    <>
      <PageHead title="Symbol Mapping" sub="Explicit master → follower mappings. Suggestions are never active until confirmed; confirmation is refused while validation errors exist." />
      <Card title="Account pair">
        <form className="form-inline" method="get">
          <select name="master" defaultValue={master?.id}>
            <option value="">Master…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.nickname} ({a.platform}, {a.environment})
              </option>
            ))}
          </select>
          <span>→</span>
          <select name="follower" defaultValue={follower?.id}>
            <option value="">Follower…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.nickname} ({a.platform}, {a.environment})
              </option>
            ))}
          </select>
          <button className="btn">Show</button>
        </form>
      </Card>
      {master && follower ? (
        <>
          <Notice tone="info">
            Never assume US30, DJ30, WS30 or another Dow CFD share contract size, tick value or price basis. Check each line below; use DISTANCE_FROM_ENTRY SL/TP when prices are offset.
          </Notice>
          <Card
            title={`${master.nickname} → ${follower.nickname}`}
            actions={
              <ActionForm action={suggest} submit="Suggest mappings" inline>
                <input type="hidden" name="masterAccountId" value={master.id} />
                <input type="hidden" name="followerAccountId" value={follower.id} />
              </ActionForm>
            }
          >
            {rows.length === 0 ? (
              <Empty>No mappings yet.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Master</th>
                      <th>Follower</th>
                      <th>Status</th>
                      <th>Validation</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((m) => (
                      <tr key={m.id}>
                        <td>
                          <div className="mono">{m.masterSymbol}</div>
                          <div className="faint">{specLine(mSpecs.get(m.masterSymbol))}</div>
                        </td>
                        <td>
                          <div className="mono">{m.followerSymbol}</div>
                          <div className="faint">{specLine(fSpecs.get(m.followerSymbol))}</div>
                        </td>
                        <td>
                          <Badge tone={m.status === "CONFIRMED" ? "ok" : m.status === "DISABLED" ? "muted" : "warn"}>{m.status}</Badge>
                        </td>
                        <td>
                          <ul className="checks">
                            {m.checks.map((c, i) => (
                              <li key={i}>
                                <Badge tone={c.severity === "error" ? "bad" : c.severity === "warning" ? "warn" : c.severity === "ok" ? "ok" : "info"}>{c.severity}</Badge> <span className="dim">{c.message}</span>
                              </li>
                            ))}
                          </ul>
                        </td>
                        <td className="nowrap">
                          <ActionForm action={validateOrConfirm} submit="Validate" inline>
                            <input type="hidden" name="id" value={m.id} />
                            <input type="hidden" name="confirm" value="false" />
                          </ActionForm>
                          {m.status !== "CONFIRMED" && (
                            <ActionForm action={validateOrConfirm} submit="Confirm" inline>
                              <input type="hidden" name="id" value={m.id} />
                              <input type="hidden" name="confirm" value="true" />
                            </ActionForm>
                          )}
                          {m.status !== "DISABLED" && (
                            <ActionForm action={disableMapping} submit="Disable" inline danger>
                              <input type="hidden" name="id" value={m.id} />
                            </ActionForm>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <div className="grid grid-2">
            <Card title="Add or change a mapping">
              <ActionForm action={addMapping} submit="Save mapping">
                <input type="hidden" name="masterAccountId" value={master.id} />
                <input type="hidden" name="followerAccountId" value={follower.id} />
                <div className="form-row">
                  <label>
                    Master symbol
                    <input name="masterSymbol" required placeholder="US30" />
                  </label>
                  <label>
                    Follower symbol
                    <input name="followerSymbol" required placeholder="DJ30.cash" />
                  </label>
                </div>
              </ActionForm>
            </Card>
            <Card title="Manual instrument specification">
              <p className="faint">For platforms that do not report a field (e.g. tick value). Copy values from the broker&apos;s contract specification; they are labelled MANUAL.</p>
              <ActionForm action={saveSpecOverride} submit="Save specification">
                <div className="form-row">
                  <label>
                    Account
                    <select name="accountId">
                      <option value={master.id}>{master.nickname}</option>
                      <option value={follower.id}>{follower.nickname}</option>
                    </select>
                  </label>
                  <label>
                    Symbol
                    <input name="symbol" required />
                  </label>
                  <label>
                    Digits
                    <input name="digits" type="number" required />
                  </label>
                  <label>
                    Tick size
                    <input name="tickSize" type="number" step="any" required />
                  </label>
                  <label>
                    Tick value (per lot)
                    <input name="tickValue" type="number" step="any" required />
                  </label>
                  <label>
                    Tick value currency
                    <input name="tickValueCurrency" required pattern="[A-Z]{3}" placeholder="USD" />
                  </label>
                  <label>
                    Contract size
                    <input name="contractSize" type="number" step="any" required />
                  </label>
                  <label>
                    Volume min
                    <input name="volumeMin" type="number" step="any" required />
                  </label>
                  <label>
                    Volume step
                    <input name="volumeStep" type="number" step="any" required />
                  </label>
                  <label>
                    Volume max
                    <input name="volumeMax" type="number" step="any" required />
                  </label>
                  <label>
                    Min stop distance (price)
                    <input name="stopsDistance" type="number" step="any" defaultValue="0" />
                  </label>
                </div>
              </ActionForm>
            </Card>
          </div>
        </>
      ) : (
        <Empty>Choose a master and follower account.</Empty>
      )}
      <Card title="Manual FX rates (fallback)">
        <p className="faint">Used only when no fresh currency-pair quote is available from a connected account. One per line, e.g. <code>GBPUSD=1.2650</code>.</p>
        <ActionForm action={saveFxRates} submit="Save FX rates">
          <textarea name="rates" rows={4} defaultValue={fxRates.map((r) => `${r.base}${r.quote}=${r.rate}`).join("\n")} />
        </ActionForm>
      </Card>
    </>
  );
}

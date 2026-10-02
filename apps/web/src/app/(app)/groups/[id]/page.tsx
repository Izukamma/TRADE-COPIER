import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { copierGroups, copyLinks, routes, symbolMappings } from "@gtc/db";
import { followerSettingsSchema, type FollowerSettings } from "@gtc/shared";
import { db } from "@/lib/db";
import { listAccounts } from "@/lib/queries";
import { requestControl } from "@/actions/accounts";
import { addFollower, deleteGroup, deleteRoute, previewSizing, saveRouteSettings, setPause, setRouteActive } from "@/actions/groups";
import { closeCopierPositions } from "@/actions/risk";
import { ActionForm } from "@/components/client";
import { PreviewForm } from "@/components/preview";
import { Badge, Card, Empty, EnvBadge, Notice, PageHead } from "@/components/ui";

export const dynamic = "force-dynamic";

function SettingsForm({ id, s }: { id: string; s: FollowerSettings }) {
  const z = s.sizing;
  return (
    <ActionForm action={saveRouteSettings} submit="Save follower settings">
      <input type="hidden" name="id" value={id} />
      <fieldset>
        <legend>Sizing</legend>
        <div className="form-row">
          <label>
            Mode
            <select name="sizingMode" defaultValue={z.mode}>
              <option value="FIXED">Fixed lot size</option>
              <option value="MULTIPLIER">Master lot multiplier</option>
              <option value="EQUITY_PROPORTIONAL">Equity-proportional</option>
              <option value="RISK_PERCENT">% risk to stop loss</option>
            </select>
          </label>
          <label>
            Fixed lots
            <input name="lots" type="number" step="any" defaultValue={z.mode === "FIXED" ? z.lots : 0.01} />
          </label>
          <label>
            Multiplier
            <input name="multiplier" type="number" step="any" defaultValue={z.mode === "MULTIPLIER" ? z.multiplier : 1} />
          </label>
          <label>
            Equity factor
            <input name="factor" type="number" step="any" defaultValue={z.mode === "EQUITY_PROPORTIONAL" ? z.factor : 1} />
          </label>
          <label>
            Risk % per trade
            <input name="riskPercent" type="number" step="any" defaultValue={z.mode === "RISK_PERCENT" ? z.riskPercent : 0.5} />
          </label>
          <label>
            Risk basis
            <select name="riskBasis" defaultValue={z.mode === "RISK_PERCENT" ? z.basis : "EQUITY"}>
              <option value="EQUITY">Equity</option>
              <option value="BALANCE">Balance</option>
            </select>
          </label>
        </div>
        <label className="check">
          <input type="checkbox" name="normalizeContracts" defaultChecked={z.mode === "MULTIPLIER" ? z.normalizeContracts : true} /> Normalise multiplier by contract specifications and currency (recommended — equal lots are not equal exposure)
        </label>
      </fieldset>
      <fieldset>
        <legend>Limits</legend>
        <div className="form-row">
          <label>
            Max order size (lots)
            <input name="maxOrderLots" type="number" step="any" defaultValue={s.maxOrderLots} />
          </label>
          <label>
            Max copied exposure (lots)
            <input name="maxExposureLots" type="number" step="any" defaultValue={s.maxExposureLots} />
          </label>
          <label>
            Max open positions
            <input name="maxOpenPositions" type="number" defaultValue={s.maxOpenPositions} />
          </label>
          <label>
            Max entry age (s)
            <input name="maxEntryAgeSeconds" type="number" defaultValue={s.maxEntryAgeSeconds} />
          </label>
          <label>
            Max entry deviation (follower ticks; empty = off)
            <input name="maxEntryDeviationPoints" type="number" step="any" defaultValue={s.maxEntryDeviationPoints ?? ""} />
          </label>
          <label>
            Margin safety factor
            <input name="marginSafetyFactor" type="number" step="any" defaultValue={s.marginSafetyFactor} />
          </label>
        </div>
      </fieldset>
      <fieldset>
        <legend>What to copy</legend>
        <div className="form-row">
          <label>
            Allowed master symbols (empty = all confirmed)
            <input name="allowedSymbols" defaultValue={s.allowedSymbols.join(", ")} />
          </label>
          <label>
            Directions
            <select name="allowedDirections" defaultValue={s.allowedDirections}>
              <option value="BOTH">Buy and sell</option>
              <option value="BUY_ONLY">Buy only</option>
              <option value="SELL_ONLY">Sell only</option>
            </select>
          </label>
          <label>
            EA magic numbers to copy (MT only)
            <input name="eaMagics" defaultValue={s.sourceFilter.eaMagics.join(", ")} placeholder="e.g. 12345, 67890" />
          </label>
          <label>
            SL copy policy
            <select name="copySl" defaultValue={s.copySl}>
              <option value="ABSOLUTE_PRICE">Absolute price</option>
              <option value="DISTANCE_FROM_ENTRY">Distance from entry</option>
              <option value="NONE">Do not copy</option>
            </select>
          </label>
          <label>
            TP copy policy
            <select name="copyTp" defaultValue={s.copyTp}>
              <option value="ABSOLUTE_PRICE">Absolute price</option>
              <option value="DISTANCE_FROM_ENTRY">Distance from entry</option>
              <option value="NONE">Do not copy</option>
            </select>
          </label>
          <label>
            Partial close remainder below minimum
            <select name="partialCloseRemainder" defaultValue={s.partialCloseRemainder}>
              <option value="CLOSE_ALL">Close all (less exposure)</option>
              <option value="KEEP_MIN">Keep minimum volume</option>
            </select>
          </label>
          <label>
            Follower closed outside copier
            <select name="divergencePolicy" defaultValue={s.divergencePolicy}>
              <option value="FLAG_ONLY">Flag only (never re-open)</option>
              <option value="FLAG_AND_DETACH">Flag and detach link</option>
            </select>
          </label>
        </div>
        <div className="form-row">
          {(
            [
              ["copyManual", s.sourceFilter.manual, "Copy manual master trades"],
              ["copyMarketOrders", s.copyMarketOrders, "Market orders"],
              ["copyPendingOrders", s.copyPendingOrders, "Pending orders"],
              ["copyModifications", s.copyModifications, "SL/TP & order modifications"],
              ["copyCancellations", s.copyCancellations, "Pending cancellations"],
              ["copyPartialCloses", s.copyPartialCloses, "Partial closes"],
              ["copyFullCloses", s.copyFullCloses, "Full closes"],
              ["requireStopLoss", s.requireStopLoss, "Mandatory stop loss"],
              ["copyExistingOnStart", s.copyExistingOnStart, "Copy existing master positions on activation"],
              ["nettingExclusiveSymbols", s.nettingExclusiveSymbols, "Netting follower: mapped symbols are copier-only"],
            ] as const
          ).map(([n, v, l]) => (
            <label className="check" key={n}>
              <input type="checkbox" name={n} defaultChecked={v} /> {l}
            </label>
          ))}
        </div>
      </fieldset>
    </ActionForm>
  );
}

export default async function GroupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const g = await db().query.copierGroups.findFirst({ where: eq(copierGroups.id, id) });
  if (!g) notFound();
  const [rts, accounts] = await Promise.all([db().select().from(routes).where(eq(routes.groupId, id)), listAccounts()]);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const master = byId.get(g.masterAccountId)!;
  const followerIds = rts.map((r) => r.followerAccountId);
  const maps = followerIds.length ? await db().select().from(symbolMappings).where(and(eq(symbolMappings.masterAccountId, g.masterAccountId), inArray(symbolMappings.followerAccountId, followerIds))) : [];
  const openLinks = rts.length ? await db().select().from(copyLinks).where(and(inArray(copyLinks.routeId, rts.map((r) => r.id)), inArray(copyLinks.status, ["OPEN", "PENDING_ORDER"]))) : [];
  const candidates = accounts.filter((a) => a.id !== g.masterAccountId && !followerIds.includes(a.id));
  return (
    <>
      <PageHead
        title={g.name}
        sub={
          <>
            Master: <Link href={`/accounts/${master.id}`}>{master.nickname}</Link> · {master.platform} <EnvBadge env={master.environment} />
          </>
        }
      >
        <ActionForm action={setPause} submit={g.entriesPaused ? "Resume group entries" : "Pause group entries"} inline>
          <input type="hidden" name="scope" value="GROUP" />
          <input type="hidden" name="id" value={g.id} />
          <input type="hidden" name="value" value={String(!g.entriesPaused)} />
        </ActionForm>
      </PageHead>
      {g.entriesPaused && <Notice tone="warn">New entries are paused for this group. Exits and protective-order changes continue.</Notice>}
      {rts.length === 0 && <Empty>No followers yet.</Empty>}
      {rts.map((r) => {
        const f = byId.get(r.followerAccountId)!;
        const s = followerSettingsSchema.parse(r.settings);
        const rm = maps.filter((m) => m.followerAccountId === r.followerAccountId);
        const confirmed = rm.filter((m) => m.status === "CONFIRMED");
        const previewed = r.previewedVersion === r.settingsVersion;
        const links = openLinks.filter((l) => l.routeId === r.id);
        return (
          <Card
            key={r.id}
            title={
              <>
                → <Link href={`/accounts/${f.id}`}>{f.nickname}</Link> <span className="faint">{f.platform}</span> <EnvBadge env={f.environment} /> {r.active ? <Badge tone="ok">ACTIVE</Badge> : <Badge tone="muted">INACTIVE</Badge>} {r.entriesPaused && <Badge tone="warn">ENTRIES PAUSED</Badge>}
              </>
            }
            actions={
              <>
                <ActionForm action={setPause} submit={r.entriesPaused ? "Resume entries" : "Pause entries"} inline>
                  <input type="hidden" name="scope" value="ROUTE" />
                  <input type="hidden" name="id" value={r.id} />
                  <input type="hidden" name="value" value={String(!r.entriesPaused)} />
                </ActionForm>
                <ActionForm action={setRouteActive} submit={r.active ? "Deactivate" : "Activate"} inline danger={r.active}>
                  <input type="hidden" name="id" value={r.id} />
                  <input type="hidden" name="value" value={String(!r.active)} />
                </ActionForm>
              </>
            }
          >
            <p className="dim">
              Mappings: {confirmed.length} confirmed / {rm.length} total (<Link href={`/symbols?master=${g.masterAccountId}&follower=${f.id}`}>manage</Link>) · Sizing preview: {previewed ? <Badge tone="ok">CURRENT</Badge> : <Badge tone="warn">REQUIRED</Badge>} · Open copier positions: {links.length}
            </p>
            {f.environment === "LIVE" && <Notice tone="bad">LIVE follower. Execution additionally needs the engine LIVE flag and an armed account.</Notice>}
            <details open={!r.active}>
              <summary>Follower settings</summary>
              <SettingsForm id={r.id} s={s} />
            </details>
            <details>
              <summary>Sizing preview</summary>
              <PreviewForm action={previewSizing} routeId={r.id} />
            </details>
            <details>
              <summary>Positions &amp; removal</summary>
              <div className="grid grid-2">
                <ActionForm action={requestControl} submit="Copy existing master positions now" confirmPhrase="COPY EXISTING">
                  <input type="hidden" name="kind" value="COPY_EXISTING" />
                  <input type="hidden" name="routeId" value={r.id} />
                  <p className="faint">Explicit option: copies positions already open on the master, bypassing the entry-age check (price deviation still applies).</p>
                </ActionForm>
                <ActionForm action={closeCopierPositions} submit="Close this route's copier positions" danger confirmPhrase="CLOSE COPIER POSITIONS">
                  <input type="hidden" name="scope" value="ROUTE" />
                  <input type="hidden" name="id" value={r.id} />
                  <p className="faint">Closes only positions opened by the copier on this route and pauses its entries.</p>
                </ActionForm>
              </div>
              {!r.active && (
                <ActionForm action={deleteRoute} submit="Remove follower from group" danger inline>
                  <input type="hidden" name="id" value={r.id} />
                </ActionForm>
              )}
            </details>
          </Card>
        );
      })}
      <Card title="Add follower">
        {candidates.length === 0 ? (
          <Empty>No other accounts available.</Empty>
        ) : (
          <ActionForm action={addFollower} submit="Add follower" inline>
            <input type="hidden" name="groupId" value={g.id} />
            <select name="followerAccountId">
              {candidates.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.nickname} ({a.platform}, {a.environment})
                </option>
              ))}
            </select>
          </ActionForm>
        )}
      </Card>
      <details>
        <summary>Delete group</summary>
        <ActionForm action={deleteGroup} submit="Delete group" danger inline>
          <input type="hidden" name="id" value={g.id} />
        </ActionForm>
      </details>
    </>
  );
}

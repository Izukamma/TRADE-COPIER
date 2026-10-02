import { requireOwnerPage } from "@/lib/authz";
import { latestHeartbeat, listAccounts, setting } from "@/lib/queries";
import { engineAlive, ago } from "@/lib/status";
import { Nav } from "@/components/client";
import { Badge } from "@/components/ui";
import { SignOut } from "./signout";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const owner = await requireOwnerPage();
  const [hb, accounts, pause] = await Promise.all([latestHeartbeat(), listAccounts(), setting<{ paused: boolean; reason?: string }>("pause.global")]);
  const alive = engineAlive(hb?.lastBeatAt);
  const envs = new Set(accounts.filter((a) => a.enabled).map((a) => a.environment));
  return (
    <div className="shell">
      <Nav />
      <main className="main">
        <div className="topbar">
          {alive ? <Badge tone="ok">ENGINE RUNNING</Badge> : <Badge tone="bad" title={hb ? `last heartbeat ${ago(hb.lastBeatAt)}` : "no heartbeat ever"}>ENGINE OFFLINE</Badge>}
          {hb && <span className="faint">heartbeat {ago(hb.lastBeatAt)}</span>}
          {pause?.paused ? <Badge tone="warn">ENTRIES PAUSED (GLOBAL)</Badge> : null}
          {hb?.liveTradingEnabled ? <Badge tone="live">LIVE TRADING ENABLED IN ENGINE</Badge> : <Badge tone="muted">live execution disabled</Badge>}
          {envs.has("SIMULATION") && <Badge tone="sim">SIMULATION</Badge>}
          {envs.has("DEMO") && <Badge tone="demo">DEMO ACCOUNT</Badge>}
          {envs.has("LIVE") && <Badge tone="live">LIVE ACCOUNT</Badge>}
          <span className="spacer" />
          <span className="faint">{owner.email}</span>
          <SignOut />
        </div>
        {children}
      </main>
    </div>
  );
}

import { env } from "@/lib/env";
import { Badge, Card, PageHead } from "@/components/ui";

export const dynamic = "force-dynamic";

/** Condensed setup guide. The full versions live in docs/ in the repository. */
export default function SetupPage() {
  const bridge = env().PUBLIC_BRIDGE_URL ?? "https://copier.example.com";
  return (
    <>
      <PageHead title="Setup Guide" sub="Deployment and platform installation. Full documents: docs/DEPLOYMENT.md, docs/WINDOWS_VPS.md, docs/BRIDGE_PROTOCOL.md, docs/platforms/*.md" />
      <div className="prose">
        <Card title="1 · Server (Docker Compose)">
          <ol>
            <li>Copy <code>.env.example</code> to <code>.env</code>, run <code>pnpm keys:generate</code> and paste the generated values. Keep <code>.env</code> out of version control; the encryption key must never live in the database.</li>
            <li>Set <code>OWNER_EMAIL</code>, <code>BETTER_AUTH_URL</code> (public HTTPS URL), <code>PUBLIC_BRIDGE_URL</code> and your domain in <code>deploy/Caddyfile</code>.</li>
            <li><code>docker compose up -d --build</code> starts PostgreSQL, the engine (runs migrations) and the dashboard behind Caddy (automatic HTTPS).</li>
            <li>Create the single owner: <code>docker compose exec -w /app/apps/web engine /app/node_modules/.bin/tsx scripts/create-owner.ts</code> (prompts for the password; never paste it into chat or tickets).</li>
            <li>Sign in, then enable two-factor under Settings.</li>
          </ol>
          <p>
            Live execution is <Badge tone="muted">disabled</Badge> by default. It needs <code>LIVE_TRADING_ENABLED=true</code> on the engine <em>and</em> arming each LIVE follower account with a typed confirmation.
          </p>
        </Card>
        <Card title="2 · TradeLocker (official REST API)">
          <ol>
            <li>Add an account: platform TradeLocker, mode DEMO, base URL <code>https://demo.tradelocker.com</code> (or <code>https://live.tradelocker.com</code>), server = the TradeLocker server/brand name shown at login, account identifier = the account id (or accNum).</li>
            <li>On the account page enter the TradeLocker email and password once; they are encrypted with your server key.</li>
            <li>Test connection, then sync instruments for the symbols you will map.</li>
          </ol>
          <p>Detection is by polling (default 1000 ms; the official Streams API needs a developer API key). Rate limits are read from <code>/trade/config</code>.</p>
        </Card>
        <Card title="3 · Match-Trader (Platform API)">
          <ol>
            <li>Add an account: platform Match-Trader, base URL = your broker&apos;s platform URL (HTTPS), server = the system UUID, account identifier = tradingAccountId.</li>
            <li>Enter email, password and broker id on the account page.</li>
            <li>Paths not available in the documentation we could access (symbols, quotes, partial close, pending orders) are disabled until you configure them from the official docs (<code>MATCHTRADER_PATH_*</code>). Edit/close bodies need <code>MATCHTRADER_ENABLE_UNVERIFIED_BODIES=true</code> (DEMO only) until verified.</li>
            <li>Enter instrument specifications manually under Symbol Mapping if the symbols endpoint is not configured.</li>
          </ol>
        </Card>
        <Card title="4 · MT4 / MT5 (Expert Advisor bridge on a Windows PC/VPS)">
          <ol>
            <li>Create the account record (platform MT4/MT5, account identifier = terminal login). Issue a device token on its page — it is shown once.</li>
            <li>Copy <code>bridges/mql5/GabrielCopierBridge.mq5</code> (or <code>bridges/mql4/GabrielCopierBridge.mq4</code>) into the terminal&apos;s <code>MQL5/Experts</code> (<code>MQL4/Experts</code>) folder and compile it in MetaEditor.</li>
            <li>Tools → Options → Expert Advisors: enable <em>Allow algorithmic trading</em> and add <code>{bridge}</code> to <em>Allow WebRequest for listed URL</em>.</li>
            <li>Attach the EA to one chart, paste the device token into <code>InpDeviceToken</code> and the bridge URL into <code>InpBridgeUrl</code>. Keep the terminal logged in and running 24/5.</li>
            <li>The account switches from AWAITING BRIDGE to CONNECTED only after signed syncs arrive.</li>
          </ol>
          <p>The EA source is provided but has not been compiled or run in the development environment; verify on a demo terminal first.</p>
        </Card>
        <Card title="5 · First route (demo-to-demo)">
          <ol>
            <li>Create a copier group with the master; add the follower (starts inactive).</li>
            <li>Map symbols explicitly (Symbol Mapping), validate and confirm each — US30, NAS100 and SPX500 differ between brokers.</li>
            <li>Choose sizing and limits, preview sizing, then activate. Existing master positions are not copied unless you opt in.</li>
            <li>Watch Live Activity for each event and each follower result.</li>
          </ol>
        </Card>
      </div>
    </>
  );
}

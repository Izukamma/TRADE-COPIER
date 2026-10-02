/**
 * End-to-end UI check (SIMULATION only): drives the real dashboard + engine with a browser.
 * Creates two simulation accounts, a group, a mapping, settings, preview, activation, then
 * opens a simulated master trade and waits for the follower copy to appear in Trade History.
 *
 * Requires: dashboard on BASE_URL, engine running, owner credentials in env.
 *   OWNER_EMAIL=... OWNER_PASSWORD_FILE=/path/to/file BASE_URL=http://localhost:3000 node scripts/e2e/ui-simulation-flow.mjs
 * Never point this at a deployment with DEMO/LIVE accounts you care about; it only creates SIMULATION records.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const email = process.env.OWNER_EMAIL;
const password = readFileSync(process.env.OWNER_PASSWORD_FILE, "utf8").trim();
const shots = process.env.SHOTS_DIR;
const tag = Date.now().toString(36);
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const p = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const step = (s) => console.log(`• ${s}`);
const expectMsg = async (form, re) => {
  const msg = form.locator(".msg-ok, .msg-bad");
  await msg.waitFor({ timeout: 20000 });
  const t = await msg.textContent();
  if (!re.test(t)) throw new Error(`unexpected message: ${t}`);
  return t;
};

await p.goto(`${BASE}/login`);
await p.fill("input[name=email]", email);
await p.fill("input[name=password]", password);
await p.click("button");
await p.waitForURL(`${BASE}/`);
step("signed in");

async function createAccount(nick, platform, server, ext) {
  await p.goto(`${BASE}/accounts`);
  const f = p.locator("form", { has: p.locator("input[name=nickname]") });
  await f.locator("input[name=nickname]").fill(nick);
  await f.locator("select[name=platform]").selectOption(platform);
  await f.locator("select[name=environment]").selectOption("SIMULATION");
  await f.locator("input[name=brokerName]").fill("Simulator");
  await f.locator("input[name=externalAccountId]").fill(ext);
  await f.locator("input[name=server]").fill(server);
  await f.locator("button[type=submit]").click();
  await expectMsg(f, /created/);
}
await createAccount(`UI master ${tag}`, "MT4", "SIM-ALPHA", `UIM-${tag}`);
await createAccount(`UI follower ${tag}`, "MATCHTRADER", "SIM-BETA", `UIF-${tag}`);
step("created two SIMULATION accounts");

await p.goto(`${BASE}/groups`);
let f = p.locator("form", { has: p.locator("select[name=masterAccountId]") });
await f.locator("input[name=name]").fill(`UI group ${tag}`);
await f.locator("select[name=masterAccountId]").selectOption({ label: `UI master ${tag} (MT4, SIMULATION)` });
await f.locator("button[type=submit]").click();
await expectMsg(f, /Group created/);
await p.goto(`${BASE}/groups`);
await p.click(`text=UI group ${tag}`);
await p.waitForURL(/\/groups\/[0-9a-f-]{36}$/);
const groupUrl = p.url();
f = p.locator("form", { has: p.locator("select[name=followerAccountId]") });
await f.locator("select[name=followerAccountId]").selectOption({ label: `UI follower ${tag} (MATCHTRADER, SIMULATION)` });
await f.locator("button[type=submit]").click();
await expectMsg(f, /Follower added/);
step("group + follower created (inactive)");

// Activation must be refused before preview/mappings.
await p.goto(groupUrl);
f = p.locator("form", { has: p.locator("button", { hasText: /^Activate$/ }) });
await f.locator("button[type=submit]").click();
await expectMsg(f, /Preview sizing|Confirm at least one/);
step("activation refused without preview (as designed)");

// Wait for engine to connect and sync instruments, then map symbols.
const ids = await p.evaluate(() => [...document.querySelectorAll('a[href^="/accounts/"]')].map((a) => a.getAttribute("href").split("/")[2]));
const [masterId, followerId] = [ids[0], ids[1]];
await p.goto(`${BASE}/symbols?master=${masterId}&follower=${followerId}`);
f = p.locator("form", { has: p.locator("input[name=masterSymbol]") });
await f.locator("input[name=masterSymbol]").fill("US30");
await f.locator("input[name=followerSymbol]").fill("DJ30.cash");
await f.locator("button[type=submit]").click();
await expectMsg(f, /SUGGESTED/);
let confirmed = false;
for (let i = 0; i < 20 && !confirmed; i++) {
  await p.goto(`${BASE}/symbols?master=${masterId}&follower=${followerId}`);
  const row = p.locator("tr", { hasText: "DJ30.cash" });
  if (/CONFIRMED/.test((await row.first().textContent()) ?? "")) {
    confirmed = true;
    break;
  }
  await row.first().locator("form", { has: p.locator("button", { hasText: /^Confirm$/ }) }).locator("button[type=submit]").click();
  await p.waitForTimeout(2000);
}
if (!confirmed) throw new Error("could not confirm mapping (specs not synced?)");
step("mapping US30 -> DJ30.cash validated and confirmed");
if (shots) await p.screenshot({ path: `${shots}/symbols-confirmed.png` });

await p.goto(groupUrl);
f = p.locator("form", { has: p.locator("select[name=sizingMode]") });
await f.locator("select[name=sizingMode]").selectOption("FIXED");
await f.locator("input[name=lots]").fill("0.3");
await f.locator("input[name=maxEntryDeviationPoints]").fill("");
await f.locator("button[type=submit]").click();
await expectMsg(f, /Saved/);
await p.goto(groupUrl);
await p.click("summary:has-text('Sizing preview')");
f = p.locator("form", { has: p.locator("input[name=masterVolume]") });
await f.locator("button").click();
await expectMsg(f, /Preview/);
const previewText = await f.locator("table").textContent();
if (!/0\.3 lots/.test(previewText)) throw new Error(`preview did not show 0.3 lots: ${previewText}`);
step("preview: " + previewText.replace(/\s+/g, " ").slice(0, 120));
if (shots) await p.screenshot({ path: `${shots}/group-preview.png` });
await p.goto(groupUrl);
f = p.locator("form", { has: p.locator("button", { hasText: /^Activate$/ }) });
await f.locator("button[type=submit]").click();
await expectMsg(f, /Activated/);
step("route activated");

// Give the engine a moment to take the master baseline, then trade on the simulated master.
await p.waitForTimeout(4000);
await p.goto(`${BASE}/simulator`);
const card = p.locator(".card", { hasText: `UI master ${tag}` });
f = card.locator("form", { has: p.locator("input[value=OPEN]") });
await f.locator("select[name=symbol]").selectOption("US30");
await f.locator("input[name=volume]").fill("1");
await f.locator("button[type=submit]").click();
await expectMsg(f, /sent to engine/);
step("opened 1 lot US30 on simulated master");

let ok = false;
for (let i = 0; i < 30 && !ok; i++) {
  await p.waitForTimeout(1000);
  await p.goto(`${BASE}/history`);
  const row = p.locator("tr", { hasText: `UI follower ${tag}` });
  ok = (await row.count()) > 0 && /OPEN/.test(await row.first().textContent());
}
if (!ok) throw new Error("follower copy did not appear");
step("follower copy OPEN in Trade History (DJ30.cash 0.3 lots)");
if (shots) await p.screenshot({ path: `${shots}/history-after-e2e.png` });
await browser.close();
console.log("E2E SIMULATION FLOW PASSED");

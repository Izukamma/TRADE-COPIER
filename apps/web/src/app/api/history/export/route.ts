import { desc } from "drizzle-orm";
import { copyLinks, tradingAccounts } from "@gtc/db";
import { db } from "@/lib/db";
import { audit, requireOwner } from "@/lib/authz";

export const dynamic = "force-dynamic";

const csv = (v: unknown) => {
  const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV export of copied trades. Contains no credentials or tokens. Owner only. */
export async function GET() {
  let owner;
  try {
    owner = await requireOwner();
  } catch {
    return new Response("unauthorized", { status: 401 });
  }
  const accounts = await db().select({ id: tradingAccounts.id, nickname: tradingAccounts.nickname }).from(tradingAccounts);
  const names = new Map(accounts.map((a) => [a.id, a.nickname]));
  const rows = await db().select().from(copyLinks).orderBy(desc(copyLinks.createdAt)).limit(10_000);
  const header = ["created_at", "opened_at", "closed_at", "master", "follower", "master_symbol", "follower_symbol", "side", "master_volume_initial", "follower_volume_initial", "master_open_price", "follower_open_price", "status", "status_detail"];
  const lines = [header.join(",")];
  for (const l of rows)
    lines.push([l.createdAt, l.openedAt, l.closedAt, names.get(l.masterAccountId), names.get(l.followerAccountId), l.masterSymbol, l.followerSymbol, l.side, l.masterVolumeInitial, l.followerVolumeInitial, l.masterOpenPrice, l.followerOpenPrice, l.status, l.statusDetail].map(csv).join(","));
  await audit(owner, "history.export", null, { rows: rows.length });
  return new Response(lines.join("\n"), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="gtc-history-${new Date().toISOString().slice(0, 10)}.csv"`, "cache-control": "no-store" } });
}

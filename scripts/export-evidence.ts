import { writeFileSync } from "node:fs";
import { and, eq, gte, inArray } from "drizzle-orm";
import { connectionEvents, copierGroups, copyLinks, createDb, executionJobs, jobTransitions, masterEvents, routes, tradingAccounts } from "@gtc/db";
import { redact } from "@gtc/shared";

/**
 * Exports a redacted, timestamped evidence bundle for one route (demo validation records).
 * Contains events, jobs with state transitions and timings, copy links and connection events.
 * Never includes credentials, session tokens or device-token secrets.
 *
 *   pnpm evidence -- --route <routeId> --since 2026-10-03T08:00:00Z --out evidence/demo-route.json
 */
const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const routeId = arg("route");
  if (!routeId) throw new Error("--route is required");
  const since = new Date(arg("since") ?? Date.now() - 86_400_000);
  const out = arg("out") ?? `evidence/route-${routeId.slice(0, 8)}-${Date.now()}.json`;
  const { db, close } = createDb();
  const route = (await db.select().from(routes).where(eq(routes.id, routeId)))[0];
  if (!route) throw new Error("route not found");
  const group = (await db.select().from(copierGroups).where(eq(copierGroups.id, route.groupId)))[0]!;
  const accountCols = { id: tradingAccounts.id, nickname: tradingAccounts.nickname, platform: tradingAccounts.platform, environment: tradingAccounts.environment, brokerName: tradingAccounts.brokerName, externalAccountId: tradingAccounts.externalAccountId, currency: tradingAccounts.currency, capabilities: tradingAccounts.capabilities };
  const accounts = await db.select(accountCols).from(tradingAccounts).where(inArray(tradingAccounts.id, [group.masterAccountId, route.followerAccountId]));
  const jobs = await db.select().from(executionJobs).where(and(eq(executionJobs.routeId, routeId), gte(executionJobs.createdAt, since)));
  const events = jobs.length ? await db.select().from(masterEvents).where(inArray(masterEvents.id, [...new Set(jobs.map((j) => j.masterEventId))])) : [];
  const transitions = jobs.length ? await db.select().from(jobTransitions).where(inArray(jobTransitions.jobId, jobs.map((j) => j.id))) : [];
  const links = await db.select().from(copyLinks).where(and(eq(copyLinks.routeId, routeId), gte(copyLinks.createdAt, since)));
  const conn = await db.select().from(connectionEvents).where(and(inArray(connectionEvents.accountId, accounts.map((a) => a.id)), gte(connectionEvents.at, since)));
  const bundle = redact({
    generatedAt: new Date().toISOString(),
    since: since.toISOString(),
    route: { id: route.id, settings: route.settings, active: route.active },
    accounts,
    events: events.sort((a, b) => a.seq - b.seq),
    jobs: jobs
      .sort((a, b) => a.seq - b.seq)
      .map((j) => ({
        ...j,
        transitions: transitions.filter((t) => t.jobId === j.id).sort((a, b) => a.id - b.id),
        timingsMs: {
          detectToSubmit: j.detectedAt && j.submittedAt ? j.submittedAt.getTime() - j.detectedAt.getTime() : null,
          submitToAccept: j.submittedAt && j.acceptedAt ? j.acceptedAt.getTime() - j.submittedAt.getTime() : null,
          submitToFill: j.submittedAt && j.filledAt ? j.filledAt.getTime() - j.submittedAt.getTime() : null,
        },
      })),
    links,
    connectionEvents: conn,
  });
  writeFileSync(out, JSON.stringify(bundle, null, 2));
  console.log(`wrote ${out}: ${events.length} events, ${jobs.length} jobs, ${links.length} links`);
  await close();
}
main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});

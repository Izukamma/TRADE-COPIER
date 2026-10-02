"use server";
import { eq } from "drizzle-orm";
import { controlCommands, tradingAccounts } from "@gtc/db";
import { ownerAction } from "@/lib/authz";
import { db } from "@/lib/db";

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};

async function requireSim(id: string) {
  const a = await db().query.tradingAccounts.findFirst({ where: eq(tradingAccounts.id, id) });
  if (!a || a.environment !== "SIMULATION") throw new Error("simulator controls only work on SIMULATION accounts");
}

/** Manual trades on a SIMULATED master (or follower) — never reaches a broker. */
export const simAction = ownerAction("sim.action", async (o, f) => {
  const accountId = str(f, "accountId")!;
  await requireSim(accountId);
  const payload: Record<string, unknown> = { accountId };
  for (const k of ["action", "symbol", "side", "volume", "sl", "tp", "price", "kind", "positionId", "orderId", "mid", "amount", "magic"]) if (str(f, k) !== undefined) payload[k] = str(f, k);
  await db().insert(controlCommands).values({ kind: "SIM_ACTION", payload, requestedBy: `owner:${o.userId}` });
  return { ok: true, message: `Simulator ${payload.action} sent to engine.` };
});

export const simFaults = ownerAction("sim.faults", async (o, f) => {
  const accountId = str(f, "accountId")!;
  await requireSim(accountId);
  const faults = { rejectRate: Number(str(f, "rejectRate") ?? 0), lostResponseRate: Number(str(f, "lostResponseRate") ?? 0), notSentRate: Number(str(f, "notSentRate") ?? 0), latencyMs: Number(str(f, "latencyMs") ?? 0) };
  await db().insert(controlCommands).values({ kind: "SIM_FAULTS", payload: { accountId, faults }, requestedBy: `owner:${o.userId}` });
  return { ok: true, message: "Fault injection updated." };
});

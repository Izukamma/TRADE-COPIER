"use server";
import { eq, isNull } from "drizzle-orm";
import { alerts, controlCommands } from "@gtc/db";
import { ownerAction } from "@/lib/authz";
import { db } from "@/lib/db";

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};

/** Separate, confirmed action. Closes only copier-managed positions; unrelated trades are untouched. */
export const closeCopierPositions = ownerAction("risk.close_copier_positions", async (o, f) => {
  const scope = str(f, "scope");
  const id = str(f, "id");
  if (!scope || !["GLOBAL", "GROUP", "ROUTE", "ACCOUNT"].includes(scope)) return { ok: false, message: "invalid scope" };
  if (scope !== "GLOBAL" && !id) return { ok: false, message: "missing target" };
  if (str(f, "confirm") !== "CLOSE COPIER POSITIONS") return { ok: false, message: "Confirmation phrase did not match." };
  await db().insert(controlCommands).values({ kind: "CLOSE_COPIER_POSITIONS", payload: { scope, id }, requestedBy: `owner:${o.userId}` });
  return { ok: true, message: "Close requested. Entries in this scope are paused; watch Live Activity for each follower result." };
});

export const ackAlert = ownerAction("alert.ack", async (_o, f) => {
  const id = str(f, "id");
  if (id === "ALL") await db().update(alerts).set({ acknowledgedAt: new Date() }).where(isNull(alerts.acknowledgedAt));
  else if (id) await db().update(alerts).set({ acknowledgedAt: new Date() }).where(eq(alerts.id, id));
  return { ok: true, message: "Acknowledged." };
});

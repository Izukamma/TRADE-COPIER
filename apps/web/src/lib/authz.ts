import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auditLog } from "@gtc/db";
import { redact } from "@gtc/shared";
import { auth } from "./auth";
import { db } from "./db";
import { env } from "./env";

export interface Owner {
  userId: string;
  email: string;
  ip: string | null;
}

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
  }
}

/** Pure check, unit-tested: a session is the owner only if its email matches OWNER_EMAIL. */
export function isOwnerSession(s: { user?: { email?: string | null; id?: string } | null } | null | undefined, ownerEmail: string): boolean {
  const email = s?.user?.email?.trim().toLowerCase();
  return !!email && !!s?.user?.id && email === ownerEmail.trim().toLowerCase();
}

async function currentOwner(): Promise<Owner | null> {
  const h = await headers();
  const s = await auth().api.getSession({ headers: h });
  if (!isOwnerSession(s, env().OWNER_EMAIL)) return null;
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null;
  return { userId: s!.user.id, email: s!.user.email, ip };
}

/** For pages: redirects to /login when not the owner. */
export async function requireOwnerPage(): Promise<Owner> {
  const o = await currentOwner();
  if (!o) redirect("/login");
  return o;
}

/** For server actions and route handlers: throws (never trusts client-side state). */
export async function requireOwner(): Promise<Owner> {
  const o = await currentOwner();
  if (!o) throw new UnauthorizedError();
  return o;
}

export async function audit(owner: Owner, action: string, target: string | null, detail?: Record<string, unknown>) {
  await db()
    .insert(auditLog)
    .values({ actor: `owner:${owner.userId}`, action, target, detail: detail ? redact(detail) : null, ip: owner.ip });
}

export type ActionState = { ok: boolean; message: string; data?: Record<string, unknown> } | null;

/**
 * Wraps a server action: owner authorization, error capture (no stack traces or secrets leak
 * to the client) and an audit record for every successful mutation.
 */
export function ownerAction(name: string, fn: (owner: Owner, form: FormData) => Promise<ActionState>) {
  return async (_prev: ActionState, form: FormData): Promise<ActionState> => {
    let owner: Owner;
    try {
      owner = await requireOwner();
    } catch {
      return { ok: false, message: "Not authorized." };
    }
    try {
      const r = await fn(owner, form);
      if (r?.ok) await audit(owner, name, (form.get("id") as string | null) ?? null, { fields: [...form.keys()].filter((k) => !k.startsWith("$")) });
      return r;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "failed";
      return { ok: false, message: redact(msg).slice(0, 300) };
    }
  };
}

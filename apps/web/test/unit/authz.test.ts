import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Authorization tests with mocked session/DB (no real auth server). They prove that every
 * server action wrapped by ownerAction() is refused unless the session belongs to OWNER_EMAIL.
 */
const session = { current: null as null | { user: { id: string; email: string } } };
const inserted: unknown[] = [];

vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "203.0.113.5" }) }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));
vi.mock("@/lib/auth", () => ({ auth: () => ({ api: { getSession: async () => session.current } }) }));
vi.mock("@/lib/db", () => ({ db: () => ({ insert: () => ({ values: async (v: unknown) => { inserted.push(v); } }) }) }));
vi.mock("@/lib/env", () => ({ env: () => ({ OWNER_EMAIL: "Owner@Example.com" }) }));

const { isOwnerSession, ownerAction, requireOwner, requireOwnerPage } = await import("@/lib/authz");

beforeEach(() => {
  session.current = null;
  inserted.length = 0;
});

describe("owner-only authorization", () => {
  it("matches the owner email case-insensitively and requires a user id", () => {
    expect(isOwnerSession({ user: { id: "u", email: "owner@example.com" } }, "Owner@Example.com")).toBe(true);
    expect(isOwnerSession({ user: { id: "u", email: "someone@else.com" } }, "owner@example.com")).toBe(false);
    expect(isOwnerSession({ user: { email: "owner@example.com" } }, "owner@example.com")).toBe(false);
    expect(isOwnerSession(null, "owner@example.com")).toBe(false);
  });

  it("server actions refuse requests without an owner session and never run the handler", async () => {
    const handler = vi.fn(async () => ({ ok: true, message: "done" }));
    const action = ownerAction("test.action", handler);
    expect(await action(null, new FormData())).toEqual({ ok: false, message: "Not authorized." });
    session.current = { user: { id: "x", email: "intruder@example.com" } };
    expect(await action(null, new FormData())).toEqual({ ok: false, message: "Not authorized." });
    expect(handler).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it("runs for the owner and writes an audit record with the client IP", async () => {
    session.current = { user: { id: "owner-1", email: "owner@example.com" } };
    const action = ownerAction("test.action", async () => ({ ok: true, message: "done" }));
    const fd = new FormData();
    fd.set("id", "abc");
    fd.set("password", "should-not-be-logged");
    expect(await action(null, fd)).toEqual({ ok: true, message: "done" });
    expect(inserted[0]).toMatchObject({ actor: "owner:owner-1", action: "test.action", target: "abc", ip: "203.0.113.5" });
    expect(JSON.stringify(inserted[0])).not.toContain("should-not-be-logged");
  });

  it("does not leak secrets from thrown errors", async () => {
    session.current = { user: { id: "owner-1", email: "owner@example.com" } };
    const action = ownerAction("test.fail", async () => {
      throw new Error('upstream said {"password":"hunter2hunter2"} Bearer abc.def.ghi');
    });
    const r = await action(null, new FormData());
    expect(r?.ok).toBe(false);
    expect(r?.message).not.toContain("hunter2");
    expect(r?.message).not.toContain("abc.def.ghi");
  });

  it("requireOwner throws and requireOwnerPage redirects for non-owners", async () => {
    await expect(requireOwner()).rejects.toThrow("unauthorized");
    await expect(requireOwnerPage()).rejects.toThrow("REDIRECT:/login");
    session.current = { user: { id: "o", email: "owner@example.com" } };
    await expect(requireOwner()).resolves.toMatchObject({ userId: "o" });
  });
});

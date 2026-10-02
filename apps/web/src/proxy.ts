import { NextResponse, type NextRequest } from "next/server";

/**
 * Coarse gate only: requests without a session cookie are redirected to /login before any
 * rendering. This is NOT the authorization check — every page, server action and route
 * handler verifies the owner session server-side (src/lib/authz.ts).
 */
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/login") || pathname.startsWith("/api/auth") || pathname.startsWith("/_next") || pathname === "/favicon.ico") return NextResponse.next();
  const hasSession = req.cookies.getAll().some((c) => c.name.endsWith("gtc.session_token"));
  if (!hasSession) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };

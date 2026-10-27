// API gatekeeper. Every /api/* request must carry a valid signed session
// cookie (tf_session) or Bearer token — except the auth endpoints themselves.
// Pages are not redirected: the single / page renders a lock screen until
// authenticated, and all data flows through these protected APIs.
//
// If TUBEFORGE_AUTH_SECRET is not set, the gate stays open (local dev mode).
// SETUP.md documents how to set it; the packaged app ships with one generated.

import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  getAuthSecret,
  verifyToken,
} from "@/lib/tubeforge/auth-token";

// Endpoints reachable without a session. /api/auth/token is deliberately NOT
// here — creating an API token requires an authenticated session.
const PUBLIC_API = new Set<string>([
  "/api/auth/status",
  "/api/auth/setup",
  "/api/auth/login",
  "/api/auth/logout",
]);

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function middleware(req: NextRequest) {
  const secret = getAuthSecret();
  const { pathname } = req.nextUrl;

  // No secret configured → local dev mode, gate open (documented).
  if (!secret) return NextResponse.next();

  if (!pathname.startsWith("/api/")) return NextResponse.next();
  if (PUBLIC_API.has(pathname)) return NextResponse.next();

  const bearer = req.headers.get("authorization");
  const token =
    bearer?.startsWith("Bearer ") ? bearer.slice(7).trim() : req.cookies.get(SESSION_COOKIE)?.value;

  const payload = await verifyToken(token, secret);
  if (!payload) {
    return NextResponse.json(
      { error: "Authentication required — sign in to use TubeForge" },
      { status: 401 }
    );
  }

  // CSRF guard for cookie-authenticated mutations: if an Origin is present it
  // must match this host (Bearer-token clients like curl/scripts send none).
  if (payload.s === "session" && MUTATING.has(req.method)) {
    const origin = req.headers.get("origin");
    if (origin) {
      try {
        if (new URL(origin).host !== req.headers.get("host"))
          return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
      } catch {
        return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
      }
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};

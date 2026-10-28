// API gatekeeper — OPT-IN. The studio is open by default; protection only
// activates after the owner enables it (Settings → Studio access), which
// writes Setting "auth.enabled" and mirrors it to the db/auth.lock flag file
// that this middleware hot-checks (no DB access per request).
//
// While active, every /api/* request must carry a valid signed session
// cookie (tf_session) or Bearer token — except the auth endpoints themselves.
// Pages are not redirected: the single / page renders a lock screen until
// authenticated, and all data flows through these protected APIs.
// If TUBEFORGE_AUTH_SECRET is unset, the gate stays open (documented dev mode).

import fs from "node:fs";
import path from "node:path";
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

const LOCK_FLAG = path.join(process.cwd(), "db", "auth.lock");

// existsSync is a microsecond-scale syscall — check it live on every API
// request so toggling the lock in Settings takes effect on the very next call.
function lockFlagActive(): boolean {
  try {
    return fs.existsSync(LOCK_FLAG);
  } catch {
    return false;
  }
}

export async function middleware(req: NextRequest) {
  const secret = getAuthSecret();
  const { pathname } = req.nextUrl;

  // Opt-in model: gate closed (open app) unless the owner enabled the lock
  // AND a signing secret exists. Removing the secret or the flag file
  // instantly re-opens the studio (documented recovery path).
  if (!secret || !lockFlagActive()) return NextResponse.next();

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
  runtime: "nodejs", // needs fs for the opt-in flag check (stable in Next 16)
  matcher: ["/api/:path*"],
};

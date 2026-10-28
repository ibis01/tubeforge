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
//
// PRODUCTION FAIL-SAFE: an intentionally-open studio is fine for localhost
// development, but a production server (NODE_ENV=production) must never serve
// studio data with the gate disabled — a stray 0.0.0.0 bind would expose
// every API to the network. In production without an active gate only the
// auth bootstrap endpoints stay reachable (status / setup / login / logout /
// lock — enabling the lock is password-checked on a configured studio), and
// every other API answers 503 until the lock is enabled or the deployment
// explicitly opts out with TUBEFORGE_REQUIRE_LOCK=0. Recovery paths:
//   bun run auth:reset               (unlock from the server)
//   bun run auth:enable <password>   (lock from the server, headless)

import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  getAuthSecret,
  verifyToken,
} from "@/lib/tubeforge/auth-token";
import {
  READ_LIMIT,
  WRITE_LIMIT,
  clientIpFrom,
  hitBucket,
} from "@/lib/tubeforge/rate-limit";

// Endpoints reachable without a session. /api/auth/token is deliberately NOT
// here — creating an API token requires an authenticated session.
const PUBLIC_API = new Set<string>([
  "/api/auth/status",
  "/api/auth/setup",
  "/api/auth/login",
  "/api/auth/logout",
]);

// Superset reachable during a production fail-safe window (gate disabled).
// /api/auth/lock enable is password-protected on a configured studio and its
// disable is a no-op while the gate is already off, so this never widens the
// attack surface beyond the first-come setup race that /api/auth/setup has
// always had on a fresh install.
const PROD_BOOTSTRAP_API = new Set<string>([...PUBLIC_API, "/api/auth/lock"]);

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

// Warn once per process, not once per request.
let warnedOpenGate = false;
function warnProductionOpenGate(): void {
  if (warnedOpenGate) return;
  warnedOpenGate = true;
  console.warn(
    "[TubeForge] SECURITY: production server with the studio lock DISABLED — " +
      "all data APIs return 503 until the lock is enabled " +
      "(Settings → Studio access, or `bun run auth:enable <password>`). " +
      "Deployments that intentionally run open can set TUBEFORGE_REQUIRE_LOCK=0."
  );
}

export async function middleware(req: NextRequest) {
  const secret = getAuthSecret();
  const { pathname } = req.nextUrl;
  const gateActive = Boolean(secret) && lockFlagActive();
  const isProd = process.env.NODE_ENV === "production";

  if (!pathname.startsWith("/api/")) {
    if (isProd && !gateActive && process.env.TUBEFORGE_REQUIRE_LOCK !== "0")
      warnProductionOpenGate();
    return NextResponse.next();
  }

  // Coarse per-IP rate limit — runs BEFORE auth so unauthenticated floods
  // are shed at the door (auth adds its own login lockout; budget.ts caps
  // provider spend). Reads 600/min, writes 90/min per IP — generous for a
  // human-driven studio, hostile to runaway loops and scripted abuse.
  // TUBEFORGE_RATE_READ / TUBEFORGE_RATE_WRITE = 0 disables a tier.
  if (req.method !== "OPTIONS") {
    const write = req.method !== "GET" && req.method !== "HEAD";
    const hit = hitBucket(
      `${write ? "w" : "r"}:${clientIpFrom(req.headers)}`,
      write ? WRITE_LIMIT : READ_LIMIT
    );
    if (!hit.ok)
      return NextResponse.json(
        { error: "Too many requests — slow down and try again shortly" },
        { status: 429, headers: { "Retry-After": String(hit.retryAfterSec) } }
      );
  }

  // PRODUCTION FAIL-SAFE — opt-out explicitly with TUBEFORGE_REQUIRE_LOCK=0.
  if (
    isProd &&
    !gateActive &&
    process.env.TUBEFORGE_REQUIRE_LOCK !== "0"
  ) {
    warnProductionOpenGate();
    if (!PROD_BOOTSTRAP_API.has(pathname))
      return NextResponse.json(
        {
          error:
            "Studio lock is disabled — enable Studio access (Settings → Studio access) to use TubeForge in production",
        },
        { status: 503 }
      );
    return NextResponse.next();
  }

  // Opt-in model: gate closed (open app) unless the owner enabled the lock
  // AND a signing secret exists. Removing the secret or the flag file
  // instantly re-opens the studio (documented recovery path).
  if (!gateActive) return NextResponse.next();
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

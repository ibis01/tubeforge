// API gatekeeper — Stage 2 DEFAULT-DENY (ARCHITECTURE.md §6.3).
//
// The opt-in lock is gone: every /api/* request now requires a valid signed
// token (session cookie or Bearer), except a small public allow-list of the
// auth bootstrap endpoints. Pages are not redirected — the single / page
// renders the register/sign-in gate until a session exists.
//
// The middleware only verifies the token's SIGNATURE + expiry (edge-safe, no
// DB). Session revocation is enforced by requireUser() at the route level,
// which resolves the Session row the cookie's jti points at.
//
// Production fail-safe: without TUBEFORGE_AUTH_SECRET a production server
// refuses to serve any non-auth endpoint (503). Local development without a
// secret warns once and stays open (npm run setup provisions one).

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

// Reachable without a token. /api/auth/token is deliberately NOT here —
// minting an API token requires an authenticated session. /api/auth/status
// answers for signed-out browsers (it resolves nothing sensitive).
const PUBLIC_API = new Set<string>([
  "/api/auth/status",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/register",
  "/api/auth/verify-email",
  "/api/auth/reset-password",
  // OAuth redirect target — Google hits it with ?code&state and NO session
  // cookie; the route authenticates via the signed state token instead.
  "/api/youtube/callback",
  // Stage 7 (T-7.5) — Stripe webhook. Stripe POSTs server-to-server with no
  // session cookie; the `stripe-signature` HMAC (verified in the route
  // against TUBEFORGE_STRIPE_WEBHOOK_SECRET) is the auth. The middleware's
  // per-IP rate limit still applies (Stripe retries on 429 — fine).
  "/api/billing/webhook",
]);

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Warn once per process, not once per request.
let warnedOpenGate = false;
function warnNoSecret(): void {
  if (warnedOpenGate) return;
  warnedOpenGate = true;
  console.warn(
    "[TubeForge] SECURITY: TUBEFORGE_AUTH_SECRET is not set — every API answers 503 " +
      "(add it to .env — see .env.example; npm run setup provisions one)."
  );
}

export async function middleware(req: NextRequest) {
  const secret = getAuthSecret();
  const { pathname } = req.nextUrl;
  const isProd = process.env.NODE_ENV === "production";

  if (!pathname.startsWith("/api/")) return NextResponse.next();

  // Coarse per-IP rate limit — runs BEFORE auth so unauthenticated floods
  // are shed at the door (login adds its own lockout; budget.ts caps provider
  // spend). Reads 600/min, writes 90/min per IP — generous for a human-driven
  // studio, hostile to runaway loops and scripted abuse.
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

  if (PUBLIC_API.has(pathname)) return NextResponse.next();

  // PRODUCTION FAIL-SAFE — no secret, no data.
  if (!secret) {
    if (isProd || process.env.TUBEFORGE_REQUIRE_AUTH !== "0") {
      warnNoSecret();
      return NextResponse.json(
        { error: "TUBEFORGE_AUTH_SECRET is not configured — sign-in is unavailable" },
        { status: 503 }
      );
    }
  }

  const bearer = req.headers.get("authorization");
  const token =
    bearer?.startsWith("Bearer ") ? bearer.slice(7).trim() : req.cookies.get(SESSION_COOKIE)?.value;

  const payload = await verifyToken(token, secret);
  if (!payload || payload.s === "state") {
    return NextResponse.json(
      { error: "Authentication required — sign in to use TubeForge" },
      { status: 401 }
    );
  }

  // CSRF guard for cookie-authenticated mutations: if an Origin is present it
  // must match a trusted origin. Trust is decided in this order:
  //   1. TUBEFORGE_ALLOWED_ORIGINS — explicit allow-list (comma-separated,
  //      host only or full origin), for deployments behind a proxy that
  //      rewrites the Host header (preview environments, load balancers).
  //   2. The request's own Host header (direct connections, no proxy).
  // A Bearer-token client (curl/scripts) sends no Origin and is allowed by
  // default; the cookie-session case is the only one this guard polices.
  if (payload.s === "session" && MUTATING.has(req.method)) {
    const origin = req.headers.get("origin");
    if (origin) {
      let ok = false;
      try {
        const originHost = new URL(origin).host;
        const allowed = (process.env.TUBEFORGE_ALLOWED_ORIGINS ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (allowed.length > 0) {
          ok = allowed.some((entry) => {
            try {
              // entries may be "host:port" or a full "https://…/"; compare
              // both as a host and as an origin URL for convenience.
              if (entry.includes("://")) return new URL(entry).host === originHost;
              return entry === originHost;
            } catch {
              return entry === originHost;
            }
          });
        } else if (originHost === req.headers.get("host")) {
          ok = true;
        }
      } catch {
        ok = false;
      }
      if (!ok)
        return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
    }
  }

  return NextResponse.next();
}

// Runtime: Node.js (Next 16 compiles ALL middleware/proxy to Node — the
// functions-config-manifest pins "/_middleware": {"runtime": "nodejs"} with
// or without an explicit config). Node middleware on Vercel REQUIRES Fluid
// Compute, which vercel.json ("fluid": true) now enables for this project —
// before that, every /api/* invocation died with a bare 500 while pages
// still rendered (pages don't match this matcher), so the breakage was
// invisible until registration was attempted. The middleware itself stays
// WebCrypto-only (see auth-token.ts "Edge-safe token utilities") and must
// never import node:* APIs regardless.
export const config = {
  matcher: ["/api/:path*"],
};

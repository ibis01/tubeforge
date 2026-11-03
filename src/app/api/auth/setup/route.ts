import { NextRequest, NextResponse } from "next/server";
import {
  isAuthConfigured,
  setPassword,
  createSessionToken,
  sessionCookie,
} from "@/lib/tubeforge/auth";
import { getAuthSecret } from "@/lib/tubeforge/auth-token";

/**
 * POST — first-run: create the access password and sign in.
 * Only works while no password is configured (403 afterwards) so a remote
 * attacker can never (re)claim an already-locked instance.
 *
 * Stage 1 hardening (task T-1.8, closes the audit's first-come race, risk
 * R-CRIT-3): when TUBEFORGE_OWNER_TOKEN is set in .env, the very first
 * claim MUST present that token in the `x-owner-token` header — a fresh
 * install can no longer be claimed by whoever hits the endpoint first.
 * Unset (local dev), the route behaves exactly as before.
 */
export async function POST(req: NextRequest) {
  if (await isAuthConfigured())
    return NextResponse.json(
      { error: "A password is already set — sign in instead" },
      { status: 403 }
    );

  const secret = getAuthSecret();
  if (!secret)
    return NextResponse.json(
      { error: "Auth is disabled: set TUBEFORGE_AUTH_SECRET in .env first" },
      { status: 500 }
    );

  const ownerToken = process.env.TUBEFORGE_OWNER_TOKEN;
  if (ownerToken && req.headers.get("x-owner-token") !== ownerToken)
    return NextResponse.json(
      { error: "Owner token required for first-time setup — set x-owner-token to TUBEFORGE_OWNER_TOKEN" },
      { status: 403 }
    );

  const body = (await req.json().catch(() => ({}))) as { password?: string };
  const password = body.password ?? "";
  if (password.length < 8)
    return NextResponse.json(
      { error: "Choose a password with at least 8 characters" },
      { status: 400 }
    );

  await setPassword(password);

  const token = await createSessionToken();
  if (!token)
    return NextResponse.json({ error: "Failed to create session" }, { status: 500 });

  const res = NextResponse.json({ ok: true, authenticated: true });
  res.cookies.set(sessionCookie(token));
  return res;
}

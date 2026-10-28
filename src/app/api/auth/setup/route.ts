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

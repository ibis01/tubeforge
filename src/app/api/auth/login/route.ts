import { NextRequest, NextResponse } from "next/server";
import {
  isAuthConfigured,
  checkPassword,
  createSessionToken,
  sessionCookie,
  checkLoginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
  clientIp,
} from "@/lib/tubeforge/auth";

/** POST — sign in with the access password (sets the HttpOnly session cookie). */
export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers);

  const { allowed, retryAfterSec } = checkLoginAllowed(ip);
  if (!allowed)
    return NextResponse.json(
      { error: `Too many attempts — try again in ${Math.ceil(retryAfterSec / 60)} min` },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );

  if (!(await isAuthConfigured()))
    return NextResponse.json(
      { error: "No password is set up yet — create one first" },
      { status: 400 }
    );

  const body = (await req.json().catch(() => ({}))) as { password?: string };
  const password = body.password ?? "";
  if (!password || !(await checkPassword(password))) {
    recordLoginFailure(ip);
    return NextResponse.json({ error: "Wrong password" }, { status: 401 });
  }

  recordLoginSuccess(ip);
  const token = await createSessionToken();
  if (!token)
    return NextResponse.json({ error: "Failed to create session" }, { status: 500 });

  const res = NextResponse.json({ ok: true, authenticated: true });
  res.cookies.set(sessionCookie(token));
  return res;
}

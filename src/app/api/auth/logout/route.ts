import { NextRequest, NextResponse } from "next/server";
import {
  clearedSessionCookie,
  revokeSessionById,
} from "@/lib/tubeforge/tenant";
import { SESSION_COOKIE, getAuthSecret, verifyToken } from "@/lib/tubeforge/auth-token";

/**
 * POST — sign out: revokes the server-side Session row (a stolen cookie dies
 * instantly) and clears the browser cookie.
 */
export async function POST(req: NextRequest) {
  const secret = getAuthSecret();
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (secret && token) {
    const payload = await verifyToken(token, secret);
    if (payload?.s === "session" && payload.jti) {
      await revokeSessionById(payload.jti).catch(() => {});
    }
  }
  const res = NextResponse.json({ ok: true, authenticated: false });
  res.cookies.set(clearedSessionCookie());
  return res;
}

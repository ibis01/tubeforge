import { NextResponse } from "next/server";
import { isAuthConfigured, isAuthEnabled } from "@/lib/tubeforge/auth";
import { getAuthSecret, verifyToken, SESSION_COOKIE } from "@/lib/tubeforge/auth-token";
import type { NextRequest } from "next/server";

/** GET — lock state: protection on/off, is a password set up, is this browser signed in. */
export async function GET(req: NextRequest) {
  const configured = await isAuthConfigured().catch(() => false);
  const gateEnabled = await isAuthEnabled().catch(() => false);
  const secret = getAuthSecret();
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const payload = await verifyToken(token, secret);
  return NextResponse.json({
    configured,
    authenticated: Boolean(gateEnabled && payload?.s === "session"),
    gateEnabled,
  });
}

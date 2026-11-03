import { NextRequest, NextResponse } from "next/server";
import {
  isAuthConfigured,
  setAuthEnabled,
  setPassword,
  checkPassword,
  createSessionToken,
  sessionCookie,
} from "@/lib/tubeforge/auth";
import { getAuthSecret } from "@/lib/tubeforge/auth-token";

/**
 * POST — owner control for password protection (Settings → Studio access).
 *   { enabled: true,  password }  first time: creates the password; afterwards
 *                                 requires the existing one (a stranger on the
 *                                 network cannot claim an already-configured
 *                                 studio). The calling browser is signed in —
 *                                 you can never lock yourself out of the tab
 *                                 you enabled it from.
 *   { enabled: false, clearPassword? } turn the lock off (middleware already
 *                                 requires a live session while it is on).
 *                                 clearPassword also forgets the stored hash.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    enabled?: boolean;
    password?: string;
    clearPassword?: boolean;
  };
  const enable = body.enabled === true;

  if (enable) {
    const secret = getAuthSecret();
    if (!secret)
      return NextResponse.json(
        { error: "Auth secret missing — TUBEFORGE_AUTH_SECRET must be set in .env to enable the lock" },
        { status: 500 }
      );

    const alreadyConfigured = await isAuthConfigured();
    const password = body.password ?? "";

    if (alreadyConfigured) {
      // re-enabling: prove ownership with the existing password
      if (!password)
        return NextResponse.json(
          { error: "Enter your current access password to turn the lock back on" },
          { status: 400 }
        );
      if (!(await checkPassword(password)))
        return NextResponse.json({ error: "Wrong password" }, { status: 401 });
    } else {
      if (password.length < 8)
        return NextResponse.json(
          { error: "Choose a password with at least 8 characters" },
          { status: 400 }
        );
      await setPassword(password);
    }

    try {
      await setAuthEnabled(true);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Failed to enable the lock" },
        { status: 500 }
      );
    }

    // always hand the enabling browser a fresh session
    const token = await createSessionToken();
    const res = NextResponse.json({ ok: true, gateEnabled: true });
    if (token) res.cookies.set(sessionCookie(token));
    return res;
  }

  // disable — while the gate is on, middleware already required a live session
  await setAuthEnabled(false).catch(() => {});
  if (body.clearPassword) {
    const { db } = await import("@/lib/db");
    await db.setting.deleteMany({ where: { key: "auth.password" } }).catch(() => {});
  }
  return NextResponse.json({ ok: true, gateEnabled: false });
}

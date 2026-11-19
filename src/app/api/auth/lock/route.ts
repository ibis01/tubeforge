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
import { requireUser, sessionIdFromRequest } from "@/lib/tubeforge/tenant";

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
  // P2-1 (external security review) — the lock toggle is a BROWSER action
  // (Settings → Studio access; the only UI caller is security-card.tsx). A
  // 90-day API bearer must never flip the studio's global lock — the same
  // session-only law the token registry enforces (a leaked bearer must not
  // be able to change who can get in).
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!(await sessionIdFromRequest(req)))
    return NextResponse.json(
      { error: "Studio access is managed from a signed-in browser session only" },
      { status: 403 }
    );

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

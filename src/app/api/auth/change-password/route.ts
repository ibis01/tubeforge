import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { rawDatabase as rawDb } from "@/lib/tubeforge/tenant-db";
import {
  MIN_PASSWORD_LEN,
  checkLoginAllowed,
  clientIp,
  createSessionRecord,
  createSessionToken,
  hashPassword,
  recordLoginFailure,
  recordLoginSuccess,
  requireUser,
  sessionIdFromRequest,
  sessionCookie,
  verifyPassword,
} from "@/lib/tubeforge/tenant";

// POST /api/auth/change-password — rotate the account password from the
// studio (S16). The security card has promised "you can change it later from
// here" since Stage 2; until now the only paths were the emailed reset link
// (which kills EVERY session, including the browser that used it) or the
// offline owner script. This route is the in-app middle path:
//
//   { currentPassword, newPassword }
//
//   · the caller must be SIGNED IN — and on a browser session, not an API
//     bearer: a leaked 90-day script token must never be able to rotate the
//     password and lock the owner out (403 for those callers).
//   · the current password is PROVEN first. A wrong guess is a login-shaped
//     brute-force attempt, so it rides the same per-IP limiter as /login
//     (429 after 5 failures / 10 min) — and a success clears the window.
//   · the new password must differ (a change that changes nothing is a 400).
//   · the rotation revokes EVERY live session of the user — including the
//     acting one — then re-signs the acting browser on a FRESH session row +
//     cookie. Other devices (and any stolen cookie) are dead; the tab that
//     made the change never even blinks. Any outstanding reset link dies too
//     (the owner just proved the current password; stale links are void).
//
// Not in the middleware PUBLIC_API list: the gate (when on) screens callers
// before requireUser ever runs.

const bodySchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(MIN_PASSWORD_LEN).max(200),
});

export async function POST(req: NextRequest) {
  // The current-password proof is a login attempt wearing a different coat —
  // the limiter runs BEFORE anything else, exactly like /login.
  const ip = clientIp(req.headers);
  const { allowed, retryAfterSec } = checkLoginAllowed(ip);
  if (!allowed)
    return NextResponse.json(
      { error: `Too many attempts — try again in ${Math.ceil(retryAfterSec / 60)} min` },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );

  const auth = await requireUser(req);
  if (!auth.ok)
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope for this handler

  // Only a browser session may rotate the password — the sid tells the route
  // which session it is rotating FROM (API bearers and state markers are null).
  const sid = await sessionIdFromRequest(req);
  if (!sid)
    return NextResponse.json(
      { error: "Password changes need a browser session — API tokens cannot rotate the password" },
      { status: 403 }
    );

  try {
    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success)
      return NextResponse.json(
        {
          error:
            parsed.error.issues[0]?.path[0] === "newPassword" && parsed.error.issues[0].code === "too_small"
              ? `The new password needs at least ${MIN_PASSWORD_LEN} characters`
              : "Send the current password and the new password",
        },
        { status: 400 }
      );

    const { currentPassword, newPassword } = parsed.data;
    const user = await rawDb.user.findUnique({ where: { id: auth.ctx.userId } });
    if (!user)
      return NextResponse.json({ error: "Account not found" }, { status: 404 });

    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      recordLoginFailure(ip); // a wrong current password burns the IP window like a failed login
      return NextResponse.json({ error: "The current password is wrong" }, { status: 401 });
    }

    if (currentPassword === newPassword)
      return NextResponse.json(
        { error: "The new password is the same as the current one — pick something different" },
        { status: 400 }
      );

    // The rotation: new hash, stale reset links void, every live session
    // revoked (the acting one included — it gets a fresh row below).
    const { count } = await rawDb.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await rawDb.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(newPassword),
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
      },
    });

    // Re-sign the acting browser: a FRESH session row + cookie, so the tab
    // that rotated the password stays signed in while everything else falls.
    const session = await createSessionRecord({
      userId: user.id,
      organizationId: auth.ctx.organizationId,
      userAgent: req.headers.get("user-agent"),
    });
    const token = await createSessionToken(user.id, session.id);
    if (!token) return NextResponse.json({ error: "Failed to create session" }, { status: 500 });

    recordLoginSuccess(ip); // the proof succeeded — clear the IP's failure window

    const res = NextResponse.json({
      ok: true,
      revokedSessions: count, // includes the rotated acting session
    });
    res.cookies.set(sessionCookie(token));
    return res;
  } catch {
    return NextResponse.json({ error: "Password change failed — try again" }, { status: 400 });
  }
}

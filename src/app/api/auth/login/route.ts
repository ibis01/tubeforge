import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { rawDatabase as rawDb } from "@/lib/tubeforge/tenant-db";
import {
  createSessionRecord,
  createSessionToken,
  sessionCookie,
  sweepExpiredSessions,
  verifyPassword,
  clientIp,
} from "@/lib/tubeforge/tenant";
import {
  checkLoginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
} from "@/lib/tubeforge/auth-throttle";

const bodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
});

/** POST — sign in with email + password (sets the HttpOnly session cookie). */
export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers);
  const { allowed, retryAfterSec } = await checkLoginAllowed(ip);
  if (!allowed)
    return NextResponse.json(
      { error: `Too many attempts — try again in ${Math.ceil(retryAfterSec / 60)} min` },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );

  try {
    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success)
      return NextResponse.json({ error: "Enter your email and password" }, { status: 400 });

    const { email, password } = parsed.data;
    const user = await rawDb.user.findUnique({ where: { email } });
    const ok = user ? await verifyPassword(password, user.passwordHash) : false;
    if (!user || !ok) {
      await recordLoginFailure(ip);
      return NextResponse.json({ error: "Wrong email or password" }, { status: 401 });
    }

    await recordLoginSuccess(ip);
    await sweepExpiredSessions().catch(() => {});

    const membership = await rawDb.membership.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
    });
    if (!membership)
      return NextResponse.json(
        { error: "This account has no workspace — contact support" },
        { status: 409 }
      );

    const session = await createSessionRecord({
      userId: user.id,
      organizationId: membership.organizationId,
      userAgent: req.headers.get("user-agent"),
    });
    const token = await createSessionToken(user.id, session.id);
    if (!token) return NextResponse.json({ error: "Failed to create session" }, { status: 500 });

    const res = NextResponse.json({
      ok: true,
      authenticated: true,
      user: { id: user.id, email: user.email, name: user.name },
      organization: { id: membership.organizationId, role: membership.role },
    });
    res.cookies.set(sessionCookie(token));
    return res;
  } catch {
    return NextResponse.json({ error: "Sign-in failed — try again" }, { status: 400 });
  }
}

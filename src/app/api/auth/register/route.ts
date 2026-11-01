// POST /api/auth/register — Stage 2 user registration.
//
// Creates the account + a personal organization (owner membership), runs the
// legacy claim when this is the FIRST user on a pre-Stage-2 install (the
// claimer must prove the old studio password when one was configured), issues
// a session cookie, and returns a verification link.
//
// Email delivery: TUBEFORGE_EMAIL_MODE=console (default) logs + returns the
// link so single-owner installs and the sandbox work without SMTP; the SMTP
// adapter lands in Stage 3 (see ROADMAP Stage 2 deviations).

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { rawDatabase as rawDb } from "@/lib/tubeforge/tenant-db";
import {
  MIN_PASSWORD_LEN,
  createSessionRecord,
  createSessionToken,
  hashPassword,
  sessionCookie,
  sweepExpiredSessions,
} from "@/lib/tubeforge/tenant";
import { randomToken, sha256Hex } from "@/lib/tubeforge/crypto";
import {
  checkLegacyPassword,
  claimLegacyForOwner,
  pendingLegacyRows,
} from "@/lib/tubeforge/claim";
import { getAuthSecret } from "@/lib/tubeforge/auth-token";

const bodySchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(MIN_PASSWORD_LEN).max(200),
  legacyPassword: z.string().max(200).optional(),
});

const VERIFY_TTL_H = 24;

function slugBase(email: string): string {
  return (
    email.split("@")[0]?.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 24) ||
    "studio"
  );
}

export async function POST(req: NextRequest) {
  try {
    const secret = getAuthSecret();
    if (!secret)
      return NextResponse.json(
        { error: "TUBEFORGE_AUTH_SECRET is not configured — registration is unavailable" },
        { status: 503 }
      );

    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Enter a valid name, email and a password of at least 8 characters" },
        { status: 400 }
      );
    }
    const { name, email, password, legacyPassword } = parsed.data;

    const existing = await rawDb.user.findUnique({ where: { email } });
    if (existing)
      return NextResponse.json({ error: "This email is already registered — sign in instead" }, { status: 409 });

    const userCount = await rawDb.user.count();

    // ---- first-user claim gate (R-CRIT-2 / D-27 successor) ----
    const legacy = await pendingLegacyRows();
    const firstUserClaims = userCount === 0 && legacy.total > 0;
    if (firstUserClaims && legacy.hasPassword) {
      const ok = await checkLegacyPassword(legacyPassword);
      if (!ok) {
        return NextResponse.json(
          {
            error:
              legacyPassword
                ? "That is not the studio's current access password"
                : "This studio is being upgraded from a locked single-user install — the first account must also prove the CURRENT access password",
            legacyClaimRequired: true,
          },
          { status: 403 }
        );
      }
    }

    // ---- create user + personal organization + owner membership ----
    const passwordHash = await hashPassword(password);
    const verifyToken = randomToken();
    const orgName = `${name || email.split("@")[0]}'s Studio`;

    const created = await rawDb.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          passwordHash,
          name: name ?? null,
          emailVerifyTokenHash: sha256Hex(verifyToken),
          emailVerifyExpiresAt: new Date(Date.now() + VERIFY_TTL_H * 3600_000),
        },
      });

      // unique slug: base + short random suffix, retried on collision
      let organization;
      for (let attempt = 0; attempt < 4; attempt++) {
        const slug = `${slugBase(email)}-${Math.random().toString(36).slice(2, 6)}`;
        try {
          organization = await tx.organization.create({ data: { name: orgName, slug } });
          break;
        } catch {
          /* unique collision — retry */
        }
      }
      if (!organization) throw new Error("Could not allocate an organization slug");

      await tx.membership.create({
        data: { userId: user.id, organizationId: organization.id, role: "owner" },
      });

      return { user, organization };
    });

    const orgId = created.organization.id;

    // ---- legacy claim (first user only) ----
    let claimSummary: Awaited<ReturnType<typeof claimLegacyForOwner>> | null = null;
    if (firstUserClaims) {
      claimSummary = await claimLegacyForOwner(created.user.id);
    }

    // ---- session ----
    await sweepExpiredSessions().catch(() => {});
    const session = await createSessionRecord({
      userId: created.user.id,
      organizationId: orgId,
      userAgent: req.headers.get("user-agent"),
    });
    const token = await createSessionToken(created.user.id, session.id);
    if (!token) throw new Error("Could not sign the session token");

    const verifyUrl = new URL("/api/auth/verify-email", req.nextUrl.origin);
    verifyUrl.searchParams.set("token", verifyToken);

    if (process.env.TUBEFORGE_EMAIL_MODE !== "smtp") {
      console.log(`[auth] email verification link for ${email}: ${verifyUrl.toString()}`);
    }

    const res = NextResponse.json(
      {
        user: { id: created.user.id, email, name: name ?? null },
        organization: { id: orgId, name: orgName },
        claim: claimSummary,
        verification: {
          required: true,
          // Console mode hands the link straight back (no SMTP until Stage 3).
          url: process.env.TUBEFORGE_EMAIL_MODE === "smtp" ? undefined : verifyUrl.toString(),
          expiresHours: VERIFY_TTL_H,
        },
      },
      { status: 201 }
    );
    res.cookies.set(sessionCookie(token));
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Registration failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

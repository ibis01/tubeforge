// POST /api/auth/reset-password — two-step password recovery.
//
//   { email }                    -> issues a one-time reset token (24h); the
//                                   link is logged + returned in console mode
//                                   (no SMTP until Stage 3).
//   { token, password }           -> sets the new password and revokes every
//                                   active session of that user.
//
// Only the SHA-256 hash of the token is stored. Requesting a reset for an
// unknown email answers 200 with no link — account enumeration stays blind.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { rawDatabase as rawDb } from "@/lib/tubeforge/tenant-db";
import { MIN_PASSWORD_LEN, hashPassword } from "@/lib/tubeforge/tenant";
import { randomToken, sha256Hex } from "@/lib/tubeforge/crypto";

const RESET_TTL_H = 24;

const requestSchema = z.object({ email: z.string().trim().toLowerCase().email() });
const confirmSchema = z.object({
  token: z.string().min(10).max(200),
  password: z.string().min(MIN_PASSWORD_LEN).max(200),
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // ---- step 1: request ----
    const request = requestSchema.safeParse(body);
    if (request.success && !("token" in body)) {
      const user = await rawDb.user.findUnique({ where: { email: request.data.email } });
      // Unknown email: identical response shape, no link — enumeration stays blind.
      if (!user) return NextResponse.json({ ok: true });

      const token = randomToken();
      await rawDb.user.update({
        where: { id: user.id },
        data: {
          passwordResetTokenHash: sha256Hex(token),
          passwordResetExpiresAt: new Date(Date.now() + RESET_TTL_H * 3600_000),
        },
      });

      const url = new URL("/api/auth/reset-password", req.nextUrl.origin);
      url.searchParams.set("token", token);
      if (process.env.TUBEFORGE_EMAIL_MODE !== "smtp") {
        console.log(`[auth] password reset link for ${user.email}: ${url.toString()}`);
      }
      return NextResponse.json({
        ok: true,
        reset: {
          url: process.env.TUBEFORGE_EMAIL_MODE === "smtp" ? undefined : url.toString(),
          expiresHours: RESET_TTL_H,
        },
      });
    }

    // ---- step 2: confirm ----
    const confirm = confirmSchema.safeParse(body);
    if (!confirm.success) {
      return NextResponse.json(
        { error: "Send { email } to request a reset, or { token, password } to confirm one" },
        { status: 400 }
      );
    }

    const user = await rawDb.user.findUnique({
      where: { passwordResetTokenHash: sha256Hex(confirm.data.token) },
    });
    if (!user || !user.passwordResetExpiresAt || user.passwordResetExpiresAt.getTime() < Date.now()) {
      return NextResponse.json(
        { error: "This reset link is invalid or has expired — request a new one" },
        { status: 400 }
      );
    }

    await rawDb.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(confirm.data.password),
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
      },
    });

    // A password change kills every live session for that user.
    await rawDb.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return NextResponse.json({ ok: true, email: user.email });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Reset failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

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
import { requestLog } from "@/lib/tubeforge/log";
import { sendMail, linkInResponse } from "@/lib/tubeforge/email";

const RESET_TTL_H = 24;

const requestSchema = z.object({ email: z.string().trim().toLowerCase().email() });
const confirmSchema = z.object({
  token: z.string().min(10).max(200),
  password: z.string().min(MIN_PASSWORD_LEN).max(200),
});

/**
 * GET ?token=… — the EMAILED link's landing (S18). A reset link points HERE;
 * before S18 clicking it met a 405 (the route was POST-only) — the link was
 * dead on arrival in a browser. Now it 302s into the studio with the token
 * on the query string (/?reset=…), where the AuthGate picks it up and opens
 * the set-new-password form pre-filled. The token itself is validated only
 * at the confirm POST — this handler just carries it (a bad token lands on
 * the form and dies there with a clear error, no information leak).
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token || token.length < 10 || token.length > 200)
    return NextResponse.json(
      { error: "This reset link is malformed — request a new one from the sign-in screen" },
      { status: 400 }
    );
  // S28 — a RELATIVE Location (the verify-email law): behind the preview
  // proxy the internal origin is unreachable from the browser, and a
  // relative location resolves against whatever origin served the link.
  return new NextResponse(null, {
    status: 307,
    headers: { location: `/?reset=${encodeURIComponent(token)}` },
  });
}

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
      // Stage 3 (T-3.9): smtp mode delivers the link for real; console logs
      // it and returns it (single-owner installs need no relay).
      try {
        await sendMail({
          to: user.email,
          subject: "Reset your TubeForge password",
          text: [
            "A password reset was requested for your TubeForge account.",
            "",
            "Set a new password:",
            url.toString(),
            "",
            `This link expires in ${RESET_TTL_H} hours. If this wasn't you, ignore this message — your password stays unchanged.`,
          ].join("\n"),
        });
      } catch (err) {
        requestLog(req, { mod: "auth:reset-password" }).warn("reset mail delivery failed (non-fatal)", { err: err instanceof Error ? err.message : err });
      }
      return NextResponse.json({
        ok: true,
        reset: {
          // S28 — relative on the wire (the register law): the gate extracts
          // the token from it and renders it against the page's own origin.
          url: linkInResponse()
            ? `/api/auth/reset-password?token=${encodeURIComponent(token)}`
            : undefined,
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

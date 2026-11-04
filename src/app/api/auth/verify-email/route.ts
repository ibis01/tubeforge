// /api/auth/verify-email — confirm an account's email address.
//
// GET  ?token=… — consumes a verification token. Only the SHA-256 hash is
//                 stored; the raw token lives in the link alone. Since S21
//                 the answer is a LANDING, not raw JSON: a human clicking
//                 the emailed link lands in the studio with /?verified=ok
//                 (or /?verified=expired / missing) — the same treatment
//                 S18 gave the reset link. API callers that fetch the URL
//                 (the gate's console-mode auto-verify) still succeed: the
//                 redirect resolves to the studio page, a plain 200.
// POST          — the resend. The route's own error used to promise "sign
//                 in and request a new one" with nothing to request FROM;
//                 a signed-in unverified user can now mint a fresh 24h link
//                 (any outstanding link is voided — one live token at a
//                 time). Session-only, like every account-level action: a
//                 bearer may call ordinary APIs but never manages the
//                 account (the same law S16 set for password rotation and
//                 S20 set for the keyring).

import { NextRequest, NextResponse } from "next/server";
import { rawDatabase as rawDb } from "@/lib/tubeforge/tenant-db";
import { randomToken, sha256Hex } from "@/lib/tubeforge/crypto";
import { requireUser, sessionIdFromRequest } from "@/lib/tubeforge/tenant";
import { sendMail, linkInResponse } from "@/lib/tubeforge/email";

const VERIFY_TTL_H = 24;

function landing(req: NextRequest, outcome: "ok" | "expired" | "missing") {
  const url = new URL("/", req.nextUrl.origin);
  url.searchParams.set("verified", outcome);
  return NextResponse.redirect(url, 307);
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token) return landing(req, "missing");

  const user = await rawDb.user.findUnique({
    where: { emailVerifyTokenHash: sha256Hex(token) },
  });

  if (!user || !user.emailVerifyExpiresAt || user.emailVerifyExpiresAt.getTime() < Date.now()) {
    return landing(req, "expired");
  }

  await rawDb.user.update({
    where: { id: user.id },
    data: {
      emailVerifiedAt: new Date(),
      emailVerifyTokenHash: null,
      emailVerifyExpiresAt: null,
    },
  });

  return landing(req, "ok");
}

export async function POST(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  // Account management is a browser-session affair — bearers stay blind.
  const sid = await sessionIdFromRequest(req);
  if (!sid)
    return NextResponse.json(
      { error: "Email verification is managed from a signed-in browser session only" },
      { status: 403 }
    );

  const user = await rawDb.user.findUnique({ where: { id: auth.ctx.userId } });
  if (!user) return NextResponse.json({ error: "Account not found" }, { status: 404 });
  if (user.emailVerifiedAt)
    return NextResponse.json(
      { error: "This email is already confirmed" },
      { status: 400 }
    );

  const verifyToken = randomToken();
  const expiresAt = new Date(Date.now() + VERIFY_TTL_H * 3600_000);
  await rawDb.user.update({
    where: { id: user.id },
    data: { emailVerifyTokenHash: sha256Hex(verifyToken), emailVerifyExpiresAt: expiresAt },
  });

  const verifyUrl = new URL("/api/auth/verify-email", req.nextUrl.origin);
  verifyUrl.searchParams.set("token", verifyToken);

  try {
    await sendMail({
      to: user.email,
      subject: "Confirm your TubeForge email",
      text: [
        "Confirm your email address for TubeForge:",
        verifyUrl.toString(),
        "",
        `This link expires in ${VERIFY_TTL_H} hours. It replaces any earlier link.`,
      ].join("\n"),
    });
  } catch (err) {
    console.warn("[auth] verification mail delivery failed (non-fatal):", err instanceof Error ? err.message : err);
  }

  return NextResponse.json({
    ok: true,
    // Console mode hands the link straight back (the register pattern); smtp
    // sent it for real.
    verification: {
      url: linkInResponse() ? verifyUrl.toString() : undefined,
      expiresHours: VERIFY_TTL_H,
    },
  });
}

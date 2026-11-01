// GET /api/auth/verify-email?token=… — consumes a verification token.
// Only the SHA-256 hash is stored; the raw token lives in the link alone.

import { NextRequest, NextResponse } from "next/server";
import { rawDatabase as rawDb } from "@/lib/tubeforge/tenant-db";
import { sha256Hex } from "@/lib/tubeforge/crypto";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token)
    return NextResponse.json({ error: "Verification token missing" }, { status: 400 });

  const user = await rawDb.user.findUnique({
    where: { emailVerifyTokenHash: sha256Hex(token) },
  });

  if (!user || !user.emailVerifyExpiresAt || user.emailVerifyExpiresAt.getTime() < Date.now()) {
    return NextResponse.json(
      { error: "This verification link is invalid or has expired — sign in and request a new one" },
      { status: 400 }
    );
  }

  await rawDb.user.update({
    where: { id: user.id },
    data: {
      emailVerifiedAt: new Date(),
      emailVerifyTokenHash: null,
      emailVerifyExpiresAt: null,
    },
  });

  return NextResponse.json({ ok: true, email: user.email });
}

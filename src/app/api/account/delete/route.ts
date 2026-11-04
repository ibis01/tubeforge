// POST /api/account/delete — GDPR account deletion.
//
// Deletes the caller's ENTIRE personal organization (every video, channel,
// character, research session, schedule slot, voice profile, music track, job
// and activity row cascades from it), their sessions, settings, YouTube
// connection, provider credentials, the uploads/<videoId>/ trees — and
// finally the user + membership rows themselves. Irreversible; requires
// { confirm: "DELETE" } so a stray click can never wipe a studio.

import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { db, rawDatabase as rawDb } from "@/lib/tubeforge/tenant-db";
import { requireUser, sessionIdFromRequest, clearedSessionCookie } from "@/lib/tubeforge/tenant";

export async function POST(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures
  const { userId, organizationId } = auth.ctx;

  // Account management is a browser-session affair — the S16/S20/S21 law,
  // applied to the most destructive account action there is: a leaked
  // bearer must never be one POST away from wiping the studio.
  const sid = await sessionIdFromRequest(req);
  if (!sid)
    return NextResponse.json(
      { error: "Account deletion is managed from a signed-in browser session only" },
      { status: 403 }
    );

  let confirm = "";
  try {
    ({ confirm = "" } = (await req.json()) as { confirm?: string });
  } catch {
    /* empty body */
  }
  if (confirm !== "DELETE")
    return NextResponse.json(
      { error: 'Send { "confirm": "DELETE" } to permanently delete this account and all of its data.' },
      { status: 400 }
    );

  // 1) Collect this org's video ids so their uploads trees can be removed.
  const videos = await db.video.findMany({ select: { id: true } });

  // 2) Drop the organization — every content row cascades from it.
  await rawDb.organization.delete({ where: { id: organizationId } }).catch(() => {});
  // (user + membership + sessions + settings + credentials cascade from the
  //  organization/user rows; explicit deletes below make that deterministic
  //  even on providers with deferred FK enforcement.)
  await rawDb.session.deleteMany({ where: { userId } });
  await rawDb.userSetting.deleteMany({ where: { userId } });
  await rawDb.youTubeAccount.deleteMany({ where: { userId } });
  await rawDb.providerCredential.deleteMany({ where: { userId } });
  await rawDb.membership.deleteMany({ where: { userId } });
  await rawDb.user.delete({ where: { id: userId } }).catch(() => {});

  // 3) Remove the media trees (best-effort, same as video DELETE).
  for (const v of videos) {
    try {
      const dir = path.join(process.cwd(), "uploads", v.id);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* non-fatal */
    }
  }

  const res = NextResponse.json({ ok: true, deleted: true });
  res.cookies.set(clearedSessionCookie());
  return res;
}

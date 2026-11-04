// GET /api/account/export — GDPR data export: everything the caller's
// organization owns, as one JSON bundle (rows only; binary artifacts under
// uploads/<id>/ are listed by path, not inlined).

import { NextRequest, NextResponse } from "next/server";
import { db, rawDatabase as rawDb } from "@/lib/tubeforge/tenant-db";
import { requireUser, sessionIdFromRequest } from "@/lib/tubeforge/tenant";

export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures
  const { userId, organizationId } = auth.ctx;

  // The bundle carries the account's shape (settings, credential presence,
  // everything) — a privacy surface, so the S16/S20/S21 law applies: signed
  // browser sessions only. A leaked bearer must not read the whole studio.
  const sid = await sessionIdFromRequest(req);
  if (!sid)
    return NextResponse.json(
      { error: "Data export is managed from a signed-in browser session only" },
      { status: 403 }
    );

  const user = await rawDb.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      name: true,
      emailVerifiedAt: true,
      createdAt: true,
      memberships: { select: { role: true, organization: { select: { name: true, slug: true } } } },
    },
  });

  const [
    videos,
    channels,
    characters,
    research,
    slots,
    voiceProfiles,
    musicTracks,
    jobs,
    activities,
    userSettings,
    youtubeAccounts,
    providerCredentials,
  ] = await Promise.all([
    db.video.findMany({ select: { id: true, topic: true, status: true, createdAt: true, youtubeUrl: true } }),
    db.channel.findMany(),
    db.character.findMany(),
    db.researchSession.findMany(),
    db.scheduleSlot.findMany(),
    db.voiceProfile.findMany({ select: { id: true, name: true, provider: true, createdAt: true } }),
    db.musicTrack.findMany({ select: { id: true, name: true, licenseType: true, createdAt: true } }),
    db.job.findMany({ select: { id: true, kind: true, status: true, startedAt: true } }),
    db.activity.findMany({ take: 500 }),
    rawDb.userSetting.findMany({ where: { userId }, select: { key: true, value: true } }),
    // Secrets are exported as presence markers, never plaintext.
    rawDb.youTubeAccount.findMany({ where: { userId }, select: { channelId: true, channelTitle: true, createdAt: true } }),
    rawDb.providerCredential.findMany({ where: { userId }, select: { capability: true, provider: true, baseUrl: true } }),
  ]);

  return NextResponse.json(
    {
      exportedAt: new Date().toISOString(),
      organization: { id: organizationId },
      account: user,
      data: {
        videos,
        channels,
        characters,
        research,
        slots,
        voiceProfiles,
        musicTracks,
        jobs,
        activities,
        settings: userSettings,
        youtube: youtubeAccounts,
        providerCredentials,
      },
      note: "Binary artifacts (renders, voiceovers, art) live under uploads/<videoId>/ on the server; contact the operator for a full archive.",
    },
    { headers: { "Content-Disposition": 'attachment; filename="tubeforge-export.json"' } }
  );
}

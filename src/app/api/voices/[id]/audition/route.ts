// GET /api/voices/[id]/audition — the clone-time preview WAV cached on the
// VoiceProfile row (what the voice sounded like when it was created).
// The ▶ buttons in pickers use /api/settings/voices/preview instead (fresh
// TTS) — this route backs the "hear the clone" replay in the clone panel.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { getAuditionWav } from "@/lib/tubeforge/voice-clone";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  // Scoped ownership check FIRST — the cached sample travels on the
  // VoiceProfile row, so prove the row belongs to the caller's organization
  // before serving its audio.
  const profile = await db.voiceProfile.findUnique({ where: { id } });
  if (!profile)
    return NextResponse.json(
      { error: "No audition audio cached for this voice" },
      { status: 404 }
    );
  const wav = await getAuditionWav(id);
  if (!wav)
    return NextResponse.json(
      { error: "No audition audio cached for this voice" },
      { status: 404 }
    );
  return new NextResponse(new Uint8Array(wav), {
    headers: {
      "Content-Type": "audio/wav",
      "Cache-Control": "no-store",
    },
  });
}

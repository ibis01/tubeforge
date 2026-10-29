// GET /api/voices/[id]/audition — the clone-time preview WAV cached on the
// VoiceProfile row (what the voice sounded like when it was created).
// The ▶ buttons in pickers use /api/settings/voices/preview instead (fresh
// TTS) — this route backs the "hear the clone" replay in the clone panel.

import { NextRequest, NextResponse } from "next/server";
import { getAuditionWav } from "@/lib/tubeforge/voice-clone";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
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

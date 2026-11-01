// GET /api/voices — the cloned-voice library (VoiceProfile rows).
// Appended to every voice picker when the active TTS provider can speak them.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/tubeforge/tenant";
import { listVoiceProfiles } from "@/lib/tubeforge/voice-clone";

export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const profiles = await listVoiceProfiles();
  return NextResponse.json({
    voices: profiles.map((p) => ({ id: p.id, label: p.label })),
    profiles: profiles.map((p) => p.dto),
  });
}

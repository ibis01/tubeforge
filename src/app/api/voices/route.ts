// GET /api/voices — the cloned-voice library (VoiceProfile rows).
// Appended to every voice picker when the active TTS provider can speak them.

import { NextResponse } from "next/server";
import { listVoiceProfiles } from "@/lib/tubeforge/voice-clone";

export async function GET() {
  const profiles = await listVoiceProfiles();
  return NextResponse.json({
    voices: profiles.map((p) => ({ id: p.id, label: p.label })),
    profiles: profiles.map((p) => p.dto),
  });
}

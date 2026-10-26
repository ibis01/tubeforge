// POST /api/settings/voices/preview — "hear it before you pick it".
//
// Body: { voice: "jam" | "alloy" | … }  (id from the ACTIVE tts provider catalog)
// 200: the short preview WAV (Content-Type: audio/wav) — cached per
//      provider/model/voice, so repeat clicks are free.
// 400: unknown voice / provider not configured.
//
// Drives the ▶ buttons inside every voice picker.

import { NextRequest, NextResponse } from "next/server";
import { getVoicePreview, resolvePreviewVoice } from "@/lib/tubeforge/voice-preview";

export async function POST(req: NextRequest) {
  let body: { voice?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON: { voice }" }, { status: 400 });
  }

  const voice = typeof body.voice === "string" ? body.voice.trim() : "";
  if (!voice) {
    return NextResponse.json({ error: "Pick a voice to preview" }, { status: 400 });
  }

  const { known, config } = await resolvePreviewVoice(voice);
  if (!known) {
    return NextResponse.json(
      { error: `Voice "${voice}" is not in the active provider's catalog` },
      { status: 400 }
    );
  }
  if (config.provider !== "zai" && !config.apiKey?.trim()) {
    return NextResponse.json(
      { error: `No API key set for the ${config.provider} voiceover provider (Settings → AI Providers)` },
      { status: 400 }
    );
  }

  try {
    const wav = await getVoicePreview(voice);
    return new NextResponse(new Uint8Array(wav), {
      headers: {
        "Content-Type": "audio/wav",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Preview failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

// POST /api/voices/clone — "mimic a voice when uploaded".
//
// Multipart form:
//   file        (File)  the 3-30s voice sample   ─┐ one of the two
//   url         (text)  direct http(s) audio link ─┘
//   name        (text)  optional display name (defaults to the file name)
//   sampleText  (text)  optional transcript of the sample — improves fidelity
//   auditionText(text)  what the clone-time preview should say
//
// 200 → { ok, profile } — the new voice is immediately usable in every voice
// picker (id = voice_clone_…) and speaks via glm-tts.
// 400/409/502 → { error } with a human-readable reason.

import { NextRequest, NextResponse } from "next/server";
import { getCapability } from "@/lib/tubeforge/providers/settings";
import { cloneVoice, isCloneProvider } from "@/lib/tubeforge/voice-clone";
import { errorText } from "@/lib/tubeforge/redact";

export async function POST(req: NextRequest) {
  // Fail fast with a pointed message when the provider isn't set up — better
  // than a 500 from deep inside the clone flow.
  const config = await getCapability("tts");
  if (!isCloneProvider(config.provider)) {
    return NextResponse.json(
      {
        error:
          "Voice cloning needs a clone-capable voiceover provider — Settings → AI Providers → Voiceover → pick “Zhipu GLM-TTS (voice cloning)” (bigmodel.cn key) or “My Machine (self-hosted)” (free, runs on your PC)",
      },
      { status: 409 }
    );
  }
  if (config.provider === "zhipu" && !config.apiKey?.trim()) {
    return NextResponse.json(
      {
        error:
          "Add your bigmodel.cn API key under Settings → AI Providers → Voiceover first (Zhipu GLM-TTS)",
      },
      { status: 409 }
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected a multipart form with a 'file' (or 'url') field" },
      { status: 400 }
    );
  }

  const file = form.get("file");
  const url = form.get("url");
  const name = typeof form.get("name") === "string" ? String(form.get("name")) : "";
  const sampleText =
    typeof form.get("sampleText") === "string" ? String(form.get("sampleText")) : "";
  const auditionText =
    typeof form.get("auditionText") === "string" ? String(form.get("auditionText")) : "";

  if (!(file instanceof File) && typeof url !== "string")
    return NextResponse.json(
      { error: "Attach the voice sample as 'file', or pass a direct audio link as 'url'" },
      { status: 400 }
    );

  try {
    const result = await cloneVoice({
      source:
        file instanceof File && file.size > 0
          ? {
              kind: "upload",
              buffer: Buffer.from(await file.arrayBuffer()),
              filename: file.name || "uploaded sample",
            }
          : { kind: "url", url: String(url ?? "").trim() },
      name,
      sampleText,
      auditionText,
      provider: config.provider,
    });
    return NextResponse.json({
      ok: true,
      profile: result.profile,
      audition: result.auditionWav
        ? { available: true, bytes: result.auditionWav.length }
        : { available: false },
    });
  } catch (err) {
    const message = errorText(err, "Voice cloning failed");
    const status = /needs an API key|Add your bigmodel/.test(message)
      ? 409
      : /too small|no audio|Could not read|not a valid|exceeds|enormous|only .*s/.test(message)
        ? 400
        : 502;
    return NextResponse.json({ error: message }, { status });
  }
}

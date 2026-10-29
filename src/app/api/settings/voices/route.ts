// Voice catalog for the ACTIVE voiceover provider — drives every voice picker
// so a video saved with a Z.ai voice keeps working after switching providers.
// Cloned voices (VoiceProfile rows) are appended when the active provider can
// actually speak them (Zhipu GLM-TTS) — otherwise they'd render dead options.

import { NextResponse } from "next/server";
import { getCapability } from "@/lib/tubeforge/providers/settings";
import { voiceCatalog } from "@/lib/tubeforge/providers/tts";
import { providerMeta } from "@/lib/tubeforge/providers/registry";
import { isCloneProvider, listVoiceProfiles } from "@/lib/tubeforge/voice-clone";

export async function GET() {
  const config = await getCapability("tts");
  const model =
    config.provider === "openai"
      ? config.model?.trim() || "tts-1"
      : config.model?.trim();
  const voices = voiceCatalog(config.provider, model);

  // Cloned voices only speak on the provider that created them.
  const cloneable = isCloneProvider(config.provider);
  const cloned = cloneable ? await listVoiceProfiles(config.provider) : [];

  const meta = providerMeta("tts", config.provider);
  return NextResponse.json({
    provider: config.provider,
    model,
    voices: [...voices, ...cloned.map((c) => ({ id: c.id, label: c.label }))],
    canClone: cloneable,
    note: meta?.note ?? "",
  });
}

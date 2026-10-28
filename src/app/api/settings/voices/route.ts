// Voice catalog for the ACTIVE voiceover provider — drives every voice picker
// so a video saved with a Z.ai voice keeps working after switching providers.

import { NextResponse } from "next/server";
import { getCapability } from "@/lib/tubeforge/providers/settings";
import { voiceCatalog } from "@/lib/tubeforge/providers/tts";
import { providerMeta } from "@/lib/tubeforge/providers/registry";

export async function GET() {
  const config = await getCapability("tts");
  const model =
    config.provider === "openai"
      ? config.model?.trim() || "tts-1"
      : config.model?.trim();
  const voices = voiceCatalog(config.provider, model);
  const meta = providerMeta("tts", config.provider);
  return NextResponse.json({
    provider: config.provider,
    model,
    voices,
    note: meta?.note ?? "",
  });
}

// Voiceover adapter — text-to-speech per the tts capability setting.
//
//   zai    → bundled Z.ai SDK (7 studio voices, returns WAV)
//   openai → POST {baseUrl}/audio/speech (tts-1 / tts-1-hd / gpt-4o-mini-tts,
//            response_format "wav" so downstream WAV merging keeps working)
//
// Voices are sanitized to the provider's catalog so a video saved with a Z.ai
// voice keeps working after switching to OpenAI (falls back to "alloy").

import { getZAI } from "../ai";
import { getCapability, type CapabilityConfig } from "./settings";
import { providerMeta, OPENAI_VOICES, type ProviderId } from "./registry";
import { VOICES } from "../types";
import { joinUrl, providerFetch } from "./http";

export interface TtsRequest {
  input: string;
  voice: string;
  speed: number;
}

/** The voice catalog for a provider (drives UI pickers + sanitization). */
export function voiceCatalog(provider: ProviderId, model = "") {
  if (provider === "openai") {
    // No model stored → adapter defaults to tts-1, which only knows the
    // classic six voices.
    const effective = model.trim() || "tts-1";
    const classicOnly = /^tts-1(-hd)?$/.test(effective);
    const list = classicOnly
      ? OPENAI_VOICES.filter((v) => v.classic)
      : [...OPENAI_VOICES];
    return list.map((v) => ({ id: v.id, label: v.label }));
  }
  return VOICES.map((v) => ({ id: v.id, label: v.label }));
}

/** Map any stored voice onto the provider's catalog. */
export function sanitizeVoice(provider: ProviderId, voice: string, model = ""): string {
  const catalog = voiceCatalog(provider, model);
  return catalog.some((v) => v.id === voice) ? voice : catalog[0].id;
}

/** Synthesize speech; always returns WAV bytes. */
export async function ttsSynthesize(
  req: TtsRequest,
  overrides?: Partial<CapabilityConfig>
): Promise<Buffer> {
  const config = await getCapability("tts", overrides);

  if (config.provider === "openai") {
    return openaiTts(req, config);
  }
  return zaiTts(req, config);
}

// ---------- Z.ai (SDK — unchanged legacy shape) ----------

async function zaiTts(req: TtsRequest, config: CapabilityConfig): Promise<Buffer> {
  const zai = await getZAI();
  const voice = sanitizeVoice("zai", req.voice);
  const response = await zai.audio.tts.create({
    input: req.input,
    voice,
    speed: req.speed,
    response_format: "wav",
    stream: false,
  });
  const buffer = Buffer.from(new Uint8Array(await response.arrayBuffer()));
  if (buffer.length < 44) throw new Error("TTS returned empty audio");
  return buffer;
}

// ---------- OpenAI-compatible ----------

async function openaiTts(req: TtsRequest, config: CapabilityConfig): Promise<Buffer> {
  const meta = providerMeta("tts", "openai")!;
  const baseUrl = config.baseUrl?.trim() || meta.defaultBaseUrl;
  const model = config.model?.trim() || "tts-1";
  const key = config.apiKey?.trim();
  if (!key) throw new Error("OpenAI-compatible TTS needs an API key (Settings → AI Providers)");

  const voice = sanitizeVoice("openai", req.voice, model);
  const speed = Math.min(4, Math.max(0.25, req.speed || 1)); // OpenAI range

  const response = await providerFetch(
    "OpenAI-compatible TTS",
    joinUrl(baseUrl, "audio/speech"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        voice,
        input: req.input,
        speed,
        response_format: "wav",
      }),
    }
  );
  const buffer = Buffer.from(new Uint8Array(await response.arrayBuffer()));
  if (buffer.length < 44) throw new Error("TTS returned empty audio");
  return buffer;
}

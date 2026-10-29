// Voiceover adapter — text-to-speech per the tts capability setting.
//
//   zai    → bundled Z.ai SDK (7 studio voices, returns WAV)
//   zhipu  → Zhipu GLM-TTS (open.bigmodel.cn): same 7 studio voices PLUS
//            cloned voice ids created by voice-clone.ts (voice_clone_…)
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
import { getSampleWavByVoiceId } from "../voice-clone";

export interface TtsRequest {
  input: string;
  voice: string;
  speed: number;
}

/** Cloned voice ids come from the Zhipu GLM-TTS-Clone API and always start
 *  with this prefix (e.g. voice_clone_20240315_143052_001). They are valid
 *  `voice` values for POST /audio/speech on the SAME account/key. */
export const CLONED_VOICE_PREFIX = "voice_clone_";

/** Is this id a cloned voice (not a stock studio voice)? Sync, shape-based —
 *  adapters that need DB certainty follow up with listVoiceProfiles(). */
export function isClonedVoiceId(voice: string): boolean {
  return voice.startsWith(CLONED_VOICE_PREFIX);
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
  // zai + zhipu share the same 7 studio voices; zhipu additionally accepts
  // cloned ids (appended to the catalog by the API layer, which can hit the DB).
  return VOICES.map((v) => ({ id: v.id, label: v.label }));
}

/** Map any stored voice onto the provider's catalog.
 *  Cloned voice ids are preserved for providers that can speak them
 *  (zhipu, selfhost) — switching to a provider that cannot falls back to the
 *  catalog's first entry, exactly like a zai-only voice switching to OpenAI. */
export function sanitizeVoice(
  provider: ProviderId,
  voice: string,
  model = "",
): string {
  if ((provider === "zhipu" || provider === "selfhost") && isClonedVoiceId(voice))
    return voice;
  const catalog = voiceCatalog(provider, model);
  return catalog.some((v) => v.id === voice) ? voice : catalog[0].id;
}

/** Synthesize speech; always returns WAV bytes. */
export async function ttsSynthesize(
  req: TtsRequest,
  overrides?: Partial<CapabilityConfig>,
): Promise<Buffer> {
  const config = await getCapability("tts", overrides);

  if (config.provider === "openai") {
    return openaiTts(req, config);
  }
  if (config.provider === "zhipu") {
    return zhipuTts(req, config);
  }
  if (config.provider === "selfhost") {
    return selfhostTts(req, config);
  }
  return zaiTts(req, config);
}

// ---------- Z.ai (SDK — unchanged legacy shape) ----------

async function zaiTts(
  req: TtsRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
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

// ---------- Zhipu GLM-TTS (open.bigmodel.cn — stock + cloned voices) ----------

async function zhipuTts(
  req: TtsRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const meta = providerMeta("tts", "zhipu");
  const baseUrl =
    config.baseUrl?.trim() ||
    meta?.defaultBaseUrl ||
    "https://open.bigmodel.cn/api/paas/v4";
  const model = config.model?.trim() || "glm-tts";
  const key = config.apiKey?.trim();

  if (!key) {
    throw new Error(
      "Zhipu GLM-TTS needs an API key from bigmodel.cn (Settings → AI Providers → Voiceover)",
    );
  }

  const voice = sanitizeVoice("zhipu", req.voice, model);
  // GLM-TTS speed range is [0.5, 2] — same clamp as the SDK path.
  const speed = Math.min(2, Math.max(0.5, req.speed || 1));

  const response = await providerFetch(
    "Zhipu GLM-TTS",
    joinUrl(baseUrl, "audio/speech"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        input: req.input,
        voice,
        speed,
        response_format: "wav",
      }),
    },
  );
  const buffer = Buffer.from(new Uint8Array(await response.arrayBuffer()));
  if (buffer.length < 44) throw new Error("TTS returned empty audio");
  return buffer;
}

// ---------- Self-hosted (voice_server.py — Chatterbox on the user's PC) ----------

async function selfhostTts(
  req: TtsRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const meta = providerMeta("tts", "selfhost");
  const baseUrl =
    config.baseUrl?.trim() ||
    meta?.defaultBaseUrl ||
    "http://localhost:8931";
  const key = config.apiKey?.trim();

  // Cloned voices ride on their stored sample; stock studio voices fall back
  // to the server's built-in default voice (empty `voice` field).
  const voice = req.voice?.trim() || "";
  let sampleB64: string | null = null;
  if (isClonedVoiceId(voice)) {
    sampleB64 = await getSampleWavByVoiceId(voice);
    if (!sampleB64)
      throw new Error(
        "That cloned voice's sample is missing — re-clone it (its row predates self-hosted cloning)",
      );
  }

  let response;
  try {
    response = await providerFetch(
      "Self-hosted voice server",
      joinUrl(baseUrl, "tts"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { "X-Voice-Key": key } : {}),
        },
        body: JSON.stringify({
          text: req.input,
          voice: sampleB64 ?? "",
          speed: req.speed,
        }),
      },
    );
  } catch (err) {
    throw new Error(
      `Your voice server at ${baseUrl} is unreachable — is it running (and the cloudflared tunnel up)? (${(err as Error).message})`,
    );
  }
  const buffer = Buffer.from(new Uint8Array(await response.arrayBuffer()));
  if (buffer.length < 44)
    throw new Error(
      `Your voice server returned no audio (HTTP ${response.status}) — check its console window for errors`,
    );
  return buffer;
}

// ---------- OpenAI-compatible (OpenAI / TTSFM / etc) ----------

async function openaiTts(
  req: TtsRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const meta = providerMeta("tts", config.provider);
  const baseUrl =
    config.baseUrl?.trim() ||
    meta?.defaultBaseUrl ||
    "https://api.openai.com/v1";
  const model = config.model?.trim() || "tts-1";
  const key = config.apiKey?.trim();

  // FIX: Skip the API key check if the provider is local (like TTSFM) or explicitly requires no key
  const isLocal =
    baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1");
  const requiresKey = meta?.requiresKey !== false && !isLocal;

  if (!key && requiresKey) {
    throw new Error(
      "OpenAI-compatible TTS needs an API key (Settings → AI Providers)",
    );
  }

  const voice = sanitizeVoice("openai", req.voice, model);
  const speed = Math.min(4, Math.max(0.25, req.speed || 1)); // OpenAI range

  // FIX: Only send the Authorization header if we actually have a key
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }

  const response = await providerFetch(
    "OpenAI-compatible TTS",
    joinUrl(baseUrl, "audio/speech"),
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        voice,
        input: req.input,
        speed,
        response_format: "wav",
      }),
    },
  );
  const buffer = Buffer.from(new Uint8Array(await response.arrayBuffer()));
  if (buffer.length < 44) throw new Error("TTS returned empty audio");
  return buffer;
}

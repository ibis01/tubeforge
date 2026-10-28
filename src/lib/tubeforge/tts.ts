// Provider-agnostic TTS layer — the voiceover stage.
//
//   provider "zai"        → z-ai-web-dev-sdk (default, .z-ai-config gateway)
//   provider "openai"     → any OpenAI-compatible POST {baseUrl}/audio/speech
//                           (OpenAI tts-1/tts-1-hd, Groq PlayAI TTS, …)
//   provider "elevenlabs" → ElevenLabs v1 text-to-speech (raw pcm_24000, wrapped
//                           into a canonical WAV header here)
//
// Config lives in the Setting table (ttsProvider/ttsBaseUrl/ttsApiKey/ttsModel/
// ttsVoice), cached briefly like the LLM settings. Half-configured custom
// providers fail safe to the Z.ai gateway. Every provider returns the same
// artifact the pipeline expects: a 24kHz 16-bit mono WAV buffer per chunk, so
// mergeWavs + the whole render line stay untouched.
//
// NOTE: `speed` only applies to the Z.ai and OpenAI-compatible providers —
// ElevenLabs ignores it (their API paces naturally). The Narrator voice picker
// on the Create view selects Z.ai voices; custom providers use the voice
// configured here (OpenAI: alloy/echo/fable/onyx/nova/shimmer, ElevenLabs:
// a Voice ID from your dashboard).

import ZAI from "z-ai-web-dev-sdk";
import { db } from "@/lib/db";
import { pcmToWav } from "./wav";

export type TtsProvider = "zai" | "openai" | "elevenlabs";

export interface TtsSettings {
  provider: TtsProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
}

export const TTS_DEFAULTS = {
  openai: { baseUrl: "https://api.openai.com/v1", model: "tts-1", voice: "alloy" },
  elevenlabs: { baseUrl: "https://api.elevenlabs.io", model: "eleven_multilingual_v2", voice: "" },
} as const;

const SETTING_KEYS = ["ttsProvider", "ttsBaseUrl", "ttsApiKey", "ttsModel", "ttsVoice"];

const g = globalThis as typeof globalThis & {
  __tfTTS?: { cache: { at: number; cfg: TtsSettings } | null };
};
const ttsGlobal = (g.__tfTTS ??= { cache: null });

/** Call after saving TTS settings so new chunks pick them up instantly. */
export function invalidateTtsSettings() {
  ttsGlobal.cache = null;
}

/** Raw saved settings (may be an incomplete custom config). Cached ~8s. */
async function readTtsSettings(): Promise<TtsSettings> {
  const now = Date.now();
  if (ttsGlobal.cache && now - ttsGlobal.cache.at < 8_000) return ttsGlobal.cache.cfg;

  const cfg: TtsSettings = { provider: "zai", baseUrl: "", apiKey: "", model: "", voice: "" };
  try {
    const rows = await db.setting.findMany({ where: { key: { in: SETTING_KEYS } } });
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const p = map.get("ttsProvider");
    cfg.provider = p === "openai" || p === "elevenlabs" ? p : "zai";
    cfg.baseUrl = (map.get("ttsBaseUrl") ?? "").trim().replace(/\/+$/, "");
    cfg.apiKey = (map.get("ttsApiKey") ?? "").trim();
    cfg.model = (map.get("ttsModel") ?? "").trim();
    cfg.voice = (map.get("ttsVoice") ?? "").trim();
  } catch (err) {
    console.warn("[tts] settings read failed, defaulting to Z.ai:", err);
  }

  ttsGlobal.cache = { at: now, cfg };
  return cfg;
}

/** Effective settings — a custom provider only applies when fully configured. */
async function effectiveSettings(): Promise<TtsSettings> {
  const s = await readTtsSettings();
  const needsKey = s.provider !== "zai";
  const needsVoice = s.provider === "elevenlabs"; // voice id is part of the URL
  const ok = (!needsKey || s.apiKey) && (!needsVoice || s.voice);
  if (s.provider !== "zai" && ok) return s;
  if (s.provider !== "zai")
    console.warn("[tts] custom TTS selected but config incomplete — using Z.ai gateway");
  return { ...s, provider: "zai" };
}

let zaiClient: Awaited<ReturnType<typeof ZAI.create>> | null = null;
async function getZai() {
  zaiClient ??= await ZAI.create();
  return zaiClient;
}

/** Whether the Z.ai gateway (from .z-ai-config) is usable — shown in Settings. */
export async function zaiConfigured(): Promise<boolean> {
  try {
    await getZai();
    return true;
  } catch {
    return false;
  }
}

// ---------- Transports (each returns a 24kHz mono s16le WAV buffer) ----------

async function speakZai(text: string, s: TtsSettings, voice: string, speed: number): Promise<Buffer> {
  const zai = await getZai();
  const response = await zai.audio.tts.create({
    input: text,
    voice,
    speed,
    response_format: "wav",
    stream: false,
  });
  const buffer = Buffer.from(new Uint8Array(await response.arrayBuffer()));
  if (buffer.length < 44) throw new Error("Z.ai TTS returned empty audio");
  return buffer;
}

async function speakOpenai(text: string, s: TtsSettings, speed: number): Promise<Buffer> {
  const res = await fetch(`${s.baseUrl}/audio/speech`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${s.apiKey}`,
    },
    body: JSON.stringify({
      model: s.model || TTS_DEFAULTS.openai.model,
      input: text,
      voice: s.voice || TTS_DEFAULTS.openai.voice,
      response_format: "wav",
      speed: Math.min(4, Math.max(0.25, speed || 1)),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok)
    throw new Error(
      `TTS API request failed with status ${res.status}: ${(await res.text()).slice(0, 300)}`
    );
  const buffer = Buffer.from(new Uint8Array(await res.arrayBuffer()));
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF")
    throw new Error(
      "Custom TTS did not return WAV audio — pick a provider/endpoint that supports response_format=wav"
    );
  return buffer;
}

async function speakElevenlabs(text: string, s: TtsSettings): Promise<Buffer> {
  const voice = s.voice;
  if (!voice) throw new Error("ElevenLabs Voice ID is missing (Settings → Voice engine)");
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=pcm_24000`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": s.apiKey,
        Accept: "audio/*",
      },
      body: JSON.stringify({
        text,
        model_id: s.model || TTS_DEFAULTS.elevenlabs.model,
      }),
      signal: AbortSignal.timeout(120_000),
    }
  );
  if (!res.ok)
    throw new Error(
      `ElevenLabs request failed with status ${res.status}: ${(await res.text()).slice(0, 300)}`
    );
  const pcm = Buffer.from(new Uint8Array(await res.arrayBuffer()));
  if (pcm.length === 0) throw new Error("ElevenLabs returned empty audio");
  return pcmToWav(pcm, 24000, 1, 16);
}

/**
 * One TTS chunk → 24kHz mono 16-bit WAV buffer.
 * Drop-in replacement for the zai.audio.tts.create call at every stage.
 * `voice`/`speed` are the Z.ai picks and are ignored by custom providers
 * (they use the voice configured in Settings → Voice engine).
 */
export async function synthesizeSpeechChunk(
  text: string,
  opts: { voice: string; speed: number }
): Promise<Buffer> {
  const s = await effectiveSettings();
  if (s.provider === "openai") return speakOpenai(text, s, opts.speed);
  if (s.provider === "elevenlabs") return speakElevenlabs(text, s);
  return speakZai(text, s, opts.voice, opts.speed);
}

/** Which provider is actually in effect right now (after fail-safe checks). */
export async function effectiveTtsProvider(): Promise<TtsProvider> {
  return (await effectiveSettings()).provider;
}

/**
 * Tiny round-trip used by Settings → Voice engine → "Test voice".
 * `override` merges over saved settings so a key can be tested before saving.
 */
export async function testTts(
  override?: Partial<TtsSettings>
): Promise<{ provider: TtsProvider; voice: string; durationSec: number }> {
  const saved = await readTtsSettings();
  const s: TtsSettings = {
    provider: override?.provider ?? saved.provider,
    baseUrl: (override?.baseUrl ?? saved.baseUrl).trim().replace(/\/+$/, ""),
    apiKey: (override?.apiKey ?? saved.apiKey).trim(),
    model: (override?.model ?? saved.model).trim(),
    voice: (override?.voice ?? saved.voice).trim(),
  };

  if (s.provider === "openai" && !s.apiKey) throw new Error("API key is missing");
  if (s.provider === "elevenlabs" && !s.apiKey) throw new Error("ElevenLabs API key is missing");
  if (s.provider === "elevenlabs" && !s.voice)
    throw new Error("ElevenLabs Voice ID is missing (find it in your ElevenLabs dashboard)");
  if (s.provider === "zai" && !(await zaiConfigured()))
    throw new Error("Z.ai gateway not configured — create .z-ai-config (see LOCAL-SETUP.md §4)");

  const buffer = await (s.provider === "openai"
    ? speakOpenai("Testing TubeForge voice output.", s, 1)
    : s.provider === "elevenlabs"
      ? speakElevenlabs("Testing TubeForge voice output.", s)
      : speakZai("Testing TubeForge voice output.", s, saved.voice || "kazi", 1));

  const bytesPerSec = (24000 * 1 * 16) / 8;
  const durationSec = Math.max(0, (buffer.length - 44) / bytesPerSec);
  return { provider: s.provider, voice: s.voice || saved.voice, durationSec };
}

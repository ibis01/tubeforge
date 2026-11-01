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

import { zaiClientFor } from "../zai-client";
import { getCapability, getProviderCredential, type CapabilityConfig } from "./settings";
import { providerMeta, OPENAI_VOICES, type ProviderId } from "./registry";
import { VOICES } from "../types";
import { joinUrl, providerFetch, ProviderHttpError } from "./http";
import { getSampleWavByVoiceId, voiceProfileProvider } from "../voice-clone";
import { applyPronunciations, loadPronunciations } from "../pronounce";

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
  let config = await getCapability("tts", overrides);

  // T-4.11 — the acting user's pronunciation overrides, applied at the ONE
  // synthesis choke point so every flow inherits them (full-script voiceover,
  // per-scene story narration, clones, ▶ previews). Fail-open: a settings
  // hiccup renders the narration without substitutions, never breaks it.
  let request = req;
  const pron = await loadPronunciations();
  if (pron.length) {
    request = { ...req, input: applyPronunciations(req.input, pron) };
  }

  // Cloned-voice routing: a clone is owned by the provider that created it
  // (zhipu or selfhost) — even if the active TTS provider is something else
  // (zai, openai). When the requested voice is a stored clone, route to the
  // owning provider using its saved credentials. This lets a user clone
  // inline from the video dialog and immediately synthesize the voiceover,
  // without first flipping Settings → Voiceover.
  if (isClonedVoiceId(request.voice)) {
    const ownerProvider = await voiceProfileProvider(request.voice);
    if (ownerProvider && ownerProvider !== config.provider) {
      const cred = await getProviderCredential("tts", ownerProvider);
      if (cred?.apiKey?.trim() || cred?.baseUrl?.trim()) {
        config = {
          ...config,
          provider: ownerProvider,
          apiKey: cred.apiKey ?? "",
          baseUrl: cred.baseUrl ?? "",
          model: config.model, // selfhost ignores; zhipu uses glm-tts
        };
      }
      // If the owning provider has no saved creds, fall through to the
      // active provider — the synthesis call will then surface a clear
      // "configure the self-hosted server URL+key" error from selfhostTts,
      // or fall back to a stock voice on the active provider.
    }
  }

  if (config.provider === "openai") {
    return openaiTts(request, config);
  }
  if (config.provider === "zhipu") {
    return zhipuTts(request, config);
  }
  if (config.provider === "selfhost") {
    return selfhostTts(request, config);
  }
  return zaiTts(request, config);
}

// ---------- Z.ai (SDK — unchanged legacy shape) ----------

async function zaiTts(
  req: TtsRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const zai = await zaiClientFor("tts");
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
    // providerFetch turns every non-2xx into ProviderHttpError — a 503 cold
    // start is WORTH ONE RETRY (the Oracle VM loads the ~1.5 GB model for
    // 2-5 minutes after a reboot; narration jobs queued behind that boot
    // should survive it instead of failing the whole render).
    if (err instanceof ProviderHttpError && err.status === 503) {
      await new Promise((r) => setTimeout(r, 4_000));
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
      } catch (retryErr) {
        throw selfhostError(retryErr, baseUrl);
      }
    } else {
      throw selfhostError(err, baseUrl);
    }
  }
  const buffer = Buffer.from(new Uint8Array(await response.arrayBuffer()));
  if (buffer.length < 44)
    throw new Error(
      `Your voice server returned no audio (HTTP ${response.status}) — check its console (PC) or Logs tab (HF Space) for errors`,
    );
  return buffer;
}

/** Readable errors for self-hosted voice server failures — the server
 *  answers with a JSON {detail} (FastAPI), so surface it verbatim:
 *  a 401 means the X-Voice-Key doesn't match the server's --key, a 503
 *  means the model is still loading after a cold start. */
function selfhostError(err: unknown, baseUrl: string): Error {
  if (err instanceof ProviderHttpError) {
    if (err.status === 401)
      return new Error(
        `Your voice server rejected the API key (HTTP 401) — the key in Settings must equal the --key value the server was started with`,
      );
    if (err.status === 503)
      return new Error(
        `Your voice server is still loading its model (HTTP 503) — give it 2-5 minutes after a cold start, then retry`,
      );
    return new Error(`Your voice server at ${baseUrl} answered ${err.message}`);
  }
  return new Error(
    `Your voice server at ${baseUrl} didn't respond — if it's a sleeping free-tier server give it a minute and retry; if it's your PC, check the server (and cloudflared tunnel) are running. (${(err as Error).message})`,
  );
}

// ---------- Self-hosted health probe (Settings → "Test" without a synthesis) ----------

export interface VoiceServerHealth {
  ok?: boolean;
  model?: string;
  device?: string;
  warm?: boolean;
  busy?: boolean;
}

/** Human line for a voice_server.py /health payload — pure, unit-pinned.
 *  "Chatterbox (English) · cpu · model loaded · 230 ms" reads at a glance;
 *  a cold start says so instead of failing mysteriously. */
export function describeVoiceHealth(h: VoiceServerHealth): string {
  const model =
    h.model === "chatterbox-multilingual"
      ? "Chatterbox Multilingual (23 languages)"
      : h.model
        ? "Chatterbox (English)"
        : "Voice server";
  const bits = [model];
  if (h.device) bits.push(h.device);
  bits.push(h.warm ? "model loaded" : "model still loading — retry in a few minutes");
  if (h.busy) bits.push("busy synthesizing");
  return bits.join(" · ");
}

/** GET {baseUrl}/health on the configured self-hosted server — never
 *  synthesizes, 6s timeout, network failures become `up: false` with a
 *  readable reason. Used by the Settings test button so the user can confirm
 *  the Oracle VM (or laptop) is reachable before wiring it in. */
export async function probeSelfhostHealth(
  overrides?: Partial<CapabilityConfig>,
): Promise<{ up: boolean; detail: string; latencyMs: number; health?: VoiceServerHealth }> {
  const cfg = await getCapability("tts", overrides);
  if (cfg.provider !== "selfhost")
    throw new Error("The health probe only applies to the self-hosted provider");
  const baseUrl =
    cfg.baseUrl?.trim() ||
    providerMeta("tts", "selfhost")?.defaultBaseUrl ||
    "http://localhost:8931";
  const key = cfg.apiKey?.trim();
  const started = Date.now();
  try {
    const res = await providerFetch(
      "Self-hosted voice server",
      joinUrl(baseUrl, "health"),
      { method: "GET", headers: key ? { "X-Voice-Key": key } : {} },
      { timeoutMs: 6_000 },
    );
    const health = (await res.json()) as VoiceServerHealth;
    return {
      up: true,
      detail: describeVoiceHealth(health),
      latencyMs: Date.now() - started,
      health,
    };
  } catch (err) {
    return {
      up: false,
      detail: selfhostError(err, baseUrl).message,
      latencyMs: Date.now() - started,
    };
  }
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

// Voiceover adapter — text-to-speech per the tts capability setting.
//
//   zai     → bundled Z.ai SDK (7 studio voices, returns WAV)
//   zhipu   → Zhipu GLM-TTS (open.bigmodel.cn): same 7 studio voices PLUS
//             cloned voice ids created by voice-clone.ts (voice_clone_…)
//   heygen  → HeyGen Voice (api.heygen.com/v3, free tier)
//   openai  → POST {baseUrl}/audio/speech (tts-1 / tts-1-hd / gpt-4o-mini-tts,
//             response_format "wav" so downstream WAV merging keeps working)
//   gemini  → POST {baseUrl}/models/{model}:generateContent (responseModalities: ["AUDIO"])
//   cartesia → POST {baseUrl}/tts/bytes (X-API-Key + Cartesia-Version headers)
//   deepgram → POST {baseUrl}/speak?model={model} (Authorization: Token)
//   playht   → POST {baseUrl}/tts/stream (X-USER-ID + Authorization)
//   elevenlabs → S159 — POST {baseUrl}/text-to-speech/{voiceId} (xi-api-key;
//             pcm_44100 wrapped into WAV via pcmToWav). Voice ids resolve
//             against the ACCOUNT's live list — the Cartesia law, mirrored.
//   voicestudio → S121 — the USER-MANAGED VoiceStudio server's OpenAI-
//             compatible API: POST {baseUrl}/v1/audio/speech.

import { zaiClientFor } from "../zai-client";
import {
  getCapability,
  getProviderCredential,
  type CapabilityConfig,
} from "./settings";
import { providerMeta, OPENAI_VOICES, type ProviderId } from "./registry";
import { VOICES } from "../types";
import { joinUrl, providerFetch, ProviderHttpError } from "./http";
import { pcmToWav } from "../wav";
import {
  getSampleWavByVoiceId,
  voiceProfileProvider,
  voiceProfileRemoteVoiceId,
} from "../voice-clone";
import { applyPronunciations, loadPronunciations } from "../pronounce";
import { selfhostEndpoint, sharedVoiceServer } from "../shared-voice";

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

// ---------- Cartesia voice resolution (the 404 fix) ----------

/** Cartesia voices are UUIDs. Anything else ("jam", "tongtong", a clone id…
 *  — voices saved under another provider) is NOT speakable by Cartesia and
 *  would answer HTTP 404 "Voice not found". */
export function isCartesiaVoiceId(voice: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    voice ?? "",
  );
}

/** The static last-resort catalog — used only when the LIVE account list is
 *  unreachable AND the requested voice is not a UUID. The live list is the
 *  truth; this is the safety net.
 *
 *  S149 — the archived-library incident: this list used to carry TEN ids
 *  (Clive, Parker, Bright Female, Barbershop Man, Wise Woman, Friendly Man,
 *  Calm Female, Soft Female, Narrator, Deep Male) copied from an OLD public-
 *  library snapshot. Cartesia has since ARCHIVED the sonic-era public voices
 *  (voices.list grew an include_archived flag) and relaunched the library for
 *  sonic-3 with "Name — descriptor" labels. Archived ids are absent from
 *  GET /voices and answer POST /tts/bytes with 404 "voice not found" — so
 *  production could pick eight pickers entries that were GUARANTEED to fail
 *  ("only Parker and Clive work"). The catalog now carries ONLY ids verified
 *  against a live account + the current library; never re-add an unverified
 *  UUID — the safety net must not contain lies. */
const CARTESIA_STATIC_VOICES = [
  { id: "b24f41fd-00a3-4cd8-992a-a0c9f13f3ef1", label: "Clive — Measured Expert" },
  { id: "30894953-bcce-41fe-892c-15ce19c843ff", label: "Parker — Supportive Pal" },
];

/** In-memory cache for the live voice list — keyed by baseUrl + key
 *  fingerprint so switching accounts never serves the wrong account's
 *  voices. 5-minute TTL: new custom voices appear within a settings
 *  coffee break, without hammering GET /voices on every synthesis. */
let cartesiaVoiceCache: {
  key: string;
  at: number;
  voices: { id: string; label: string }[];
} | null = null;
const CARTESIA_VOICE_TTL_MS = 5 * 60 * 1000;

function cartesiaCacheKey(config: {
  baseUrl?: string;
  apiKey?: string;
}): string {
  const fp = config.apiKey
    ? config.apiKey.slice(-6)
    : "";
  return `${config.baseUrl?.trim() || "-"}|${fp}`;
}

/** GET {baseUrl}/voices — the ACCOUNT's real voices (public + the user's
 *  custom clones). Never throws: on any failure it returns [] so callers
 *  fall back to the static catalog instead of breaking synthesis. */
export async function listCartesiaVoices(
  config: CapabilityConfig,
  opts?: { refresh?: boolean },
): Promise<{ id: string; label: string }[]> {
  const key = config.apiKey?.trim();
  if (!key) return [];

  const cacheKey = cartesiaCacheKey(config);
  if (!opts?.refresh && cartesiaVoiceCache && cartesiaVoiceCache.key === cacheKey) {
    if (Date.now() - cartesiaVoiceCache.at < CARTESIA_VOICE_TTL_MS) {
      return cartesiaVoiceCache.voices;
    }
  }

  const baseUrl =
    config.baseUrl?.trim() ||
    providerMeta("tts", "cartesia")?.defaultBaseUrl ||
    "https://api.cartesia.ai";
  try {
    const res = await providerFetch(
      "Cartesia voices",
      joinUrl(baseUrl, "voices"),
      {
        method: "GET",
        headers: {
          "X-API-Key": key,
          "Cartesia-Version": CARTESIA_VERSION,
        },
      },
      { capability: "tts" },
    );
    const data = (await res.json()) as
      | { voices?: unknown[] }
      | unknown[]
      | { data?: unknown[] };
    const rows: unknown[] = Array.isArray(data)
      ? data
      : ((data as { voices?: unknown[] }).voices ??
        (data as { data?: unknown[] }).data ??
        []);
    const voices = rows
      .map((r) => r as { id?: string; name?: string })
      .filter((r) => typeof r.id === "string" && r.id)
      .map((r) => ({ id: r.id as string, label: (r.name as string) || (r.id as string) }));
    cartesiaVoiceCache = { key: cacheKey, at: Date.now(), voices };
    return voices;
  } catch {
    return [];
  }
}

/** Resolve the voice to send to Cartesia — THE LIVE-LIST LAW (S149):
 *  1. A UUID the account's live list KNOWS (picked from any picker) →
 *     verbatim — the happy path is untouched.
 *  2. A UUID the live list does NOT know (an archived-library id saved on an
 *     old video, a deleted custom voice) → the FIRST live voice. Shipping the
 *     unknown id verbatim is a guaranteed 404 that fails the whole voiceover
 *     job after six retry rounds; landing on a real account voice produces
 *     audio instead. The substitution only fires when the list is REACHABLE
 *     and the id is verifiably absent — never on a network hiccup.
 *  3. Anything else (a Z.ai voice name, a clone id, an empty string — the
 *     Settings Test button) → the FIRST voice of the account's live list, so
 *     the synthesis lands on a REAL existing voice.
 *  4. Live list unreachable → the static catalog's first entry (for non-UUID
 *     requests; a UUID rides verbatim — Cartesia's readable 404 stays the
 *     honest outcome when we cannot verify anything). */
export async function resolveCartesiaVoiceId(
  voice: string,
  config: CapabilityConfig,
): Promise<string> {
  const requested = voice?.trim() ?? "";
  if (isCartesiaVoiceId(requested)) {
    const live = await listCartesiaVoices(config);
    if (!live.length) return requested; // unreachable list — cannot verify, ride verbatim
    return live.some((v) => v.id === requested) ? requested : live[0].id;
  }
  const live = await listCartesiaVoices(config);
  if (live.length) return live[0].id;
  return CARTESIA_STATIC_VOICES[0].id;
}

// ---------- S159 — the wired voice catalogs (the Cartesia law, mirrored) ----------
//
// A provider with many voice ids ships THREE layers, exactly like Cartesia:
//   1. a STATIC catalog in code — known-good ids, the offline shape fallback;
//   2. a LIVE account list overlaid in the voices route (when the provider
//      has a listing endpoint AND a saved key) — the pickers' one truth;
//   3. synthesis-time resolution — a foreign/stale voice lands on a REAL
//      voice of the account instead of a guaranteed error.

/** Gemini TTS prebuilt voices — Google's documented 30-name set. These ids
 *  are STABLE names (not account UUIDs), so the static catalog is the one
 *  truth; there is no listing endpoint to overlay. Puck rides first: it is
 *  the adapter's historical default, so the fallback voice is unchanged. */
export const GEMINI_VOICES = [
  { id: "Puck", label: "Puck — upbeat" },
  { id: "Zephyr", label: "Zephyr — bright" },
  { id: "Charon", label: "Charon — informative" },
  { id: "Kore", label: "Kore — firm" },
  { id: "Fenrir", label: "Fenrir — excitable" },
  { id: "Leda", label: "Leda — youthful" },
  { id: "Orus", label: "Orus — firm" },
  { id: "Aoede", label: "Aoede — breezy" },
  { id: "Callirrhoe", label: "Callirrhoe — easy-going" },
  { id: "Autonoe", label: "Autonoe — bright" },
  { id: "Enceladus", label: "Enceladus — breathy" },
  { id: "Iapetus", label: "Iapetus — clear" },
  { id: "Umbriel", label: "Umbriel — easy-going" },
  { id: "Algieba", label: "Algieba — smooth" },
  { id: "Despina", label: "Despina — smooth" },
  { id: "Erinome", label: "Erinome — clear" },
  { id: "Algenib", label: "Algenib — gravelly" },
  { id: "Rasalgethi", label: "Rasalgethi — informative" },
  { id: "Laomedeia", label: "Laomedeia — upbeat" },
  { id: "Achernar", label: "Achernar — soft" },
  { id: "Alnilam", label: "Alnilam — firm" },
  { id: "Schedar", label: "Schedar — even" },
  { id: "Gacrux", label: "Gacrux — mature" },
  { id: "Pulcherrima", label: "Pulcherrima — forward" },
  { id: "Achird", label: "Achird — friendly" },
  { id: "Zubenelgenubi", label: "Zubenelgenubi — casual" },
  { id: "Vindemiatrix", label: "Vindemiatrix — gentle" },
  { id: "Sadachbia", label: "Sadachbia — lively" },
  { id: "Sadaltager", label: "Sadaltager — knowledgeable" },
  { id: "Sulafat", label: "Sulafat — warm" },
] as const;

/** Deepgram Aura-2 voices. Deepgram's speak API takes the VOICE as the
 *  `model` parameter (aura-2-{name}-en) — voice and model are ONE value,
 *  so the catalog ids are the model ids and the adapter maps a picked
 *  voice onto the speak model directly. */
export const DEEPGRAM_VOICES = [
  { id: "aura-2-thalia-en", label: "Thalia — warm female (recommended)" },
  { id: "aura-2-asteria-en", label: "Asteria — expressive female" },
  { id: "aura-2-orpheus-en", label: "Orpheus — deep male" },
  { id: "aura-2-arcas-en", label: "Arcas — casual male" },
  { id: "aura-2-perseus-en", label: "Perseus — earnest male" },
  { id: "aura-2-angus-en", label: "Angus — firm male" },
  { id: "aura-2-orion-en", label: "Orion — authoritative male" },
  { id: "aura-2-helios-en", label: "Helios — bright male" },
  { id: "aura-2-hera-en", label: "Hera — assured female" },
  { id: "aura-2-zeus-en", label: "Zeus — commanding male" },
  { id: "aura-2-persephone-en", label: "Persephone — emotional female" },
] as const;

/** PlayHT's documented default pre-made voice. PlayHT's full library is
 *  account-shaped and served LIVE (GET /voices); the static catalog keeps
 *  the offline fallback honest — a real, documented voice id. */
export const PLAYHT_STATIC_VOICES = [
  { id: "larry", label: "Larry — documented default (recommended)" },
] as const;

/** ElevenLabs' classic pre-made library — the stable public ids the docs
 *  and every integration tutorial reference. Custom/clone voices ride the
 *  LIVE list (GET /v1/voices) overlaid in the voices route; a stale id is
 *  self-healed at synthesis (the 404 ladder below). Rachel rides first:
 *  the docs' primary example voice, so the fallback is a real voice. */
export const ELEVEN_STATIC_VOICES = [
  { id: "21m00Tcm4TlvDq8ikWAM", label: "Rachel — calm narration (recommended)" },
  { id: "29vD33N1CtxCmqQRPOHJ", label: "Drew — grounded male" },
  { id: "2EiwWnXFnvU5JabPnv8n", label: "Clyde — war veteran male" },
  { id: "5Q0t7uMcjvnagumLfvZi", label: "Paul — authoritative male" },
  { id: "AZnzlk1XvdvUeBnXmlld", label: "Domi — strong female" },
  { id: "CYw3k2KsWGVVaze69DH", label: "Dave — conversational male" },
  { id: "EXAVITQu4vr4xnSDxMaL", label: "Sarah — soft female" },
  { id: "ErXwobaYiX0SgX7sRDaX", label: "Antoni — well-rounded male" },
  { id: "GBv7mTt0atIp3Cy8C4jk", label: "Thomas — calm male" },
  { id: "IKne3meq5aSn9JBey2G4", label: "Charlie — hypersonic male" },
  { id: "JBFqcADxSsP6w2AMdoHi", label: "George — warm narration male" },
  { id: "MF3mGyEYCl7XYWbV9V6O", label: "Elli — emotional female" },
  { id: "N2lVS1w4EtoT3dr4eOWO", label: "Callum — intense male" },
  { id: "ODq5zmih8GrVes37Dizd", label: "Patrick — gravelly male" },
  { id: "SOYHLrjzK2X1ezoL6HAb", label: "Harry — anxious male" },
  { id: "pqHfZKP75CvOlQylNhV4", label: "Bill — documentary male" },
  { id: "cgSgspJ2msm6clMCkdW9", label: "Jessica — expressive female" },
  { id: "bVMeCyTHy58xNoL34h8p", label: "Chris — casual male" },
  { id: "nPczCjzI2devNBz1zQrb", label: "Brian — deep narration male" },
  { id: "pFZP5JQG7iQjIQuC4Bku", label: "Lily — British female" },
] as const;

/** ElevenLabs voice ids are 20-char base62 strings (their premade library
 *  and every cloned voice). Anything else ("jam", a Z.ai name, a clone id)
 *  is NOT speakable by ElevenLabs and resolves at synthesis time. */
export function isElevenlabsVoiceId(voice: string): boolean {
  return /^[A-Za-z0-9]{20}$/.test(voice ?? "");
}

/** PlayHT clone voices ride s3:// URIs — account-owned, pass verbatim. */
export function isPlayhtCloneVoiceId(voice: string): boolean {
  return (voice ?? "").startsWith("s3://");
}

/** Kokoro-82M's own sample set (hexgrad/Kokoro-82M, Apache-2.0). The
 *  zai-fallthrough would serve studio-voice ids the local kokoro-fastapi
 *  server has never heard of — Kokoro owns its catalog, like every other
 *  provider here. */
export const KOKORO_VOICES = [
  { id: "af_heart", label: "Heart — warm female (recommended)" },
  { id: "af_bella", label: "Bella — expressive female" },
  { id: "af_nicole", label: "Nicole — soft female" },
  { id: "af_sky", label: "Sky — bright female" },
  { id: "af_sarah", label: "Sarah — steady female" },
  { id: "am_adam", label: "Adam — grounded male" },
  { id: "am_michael", label: "Michael — steady male" },
  { id: "am_echo", label: "Echo — resonant male" },
  { id: "am_eric", label: "Eric — conversational male" },
  { id: "bf_emma", label: "Emma — British female" },
  { id: "bf_isabella", label: "Isabella — British female" },
  { id: "bm_george", label: "George — British male" },
  { id: "bm_lewis", label: "Lewis — British male" },
] as const;

/** In-memory caches for the live voice lists — keyed by credential
 *  fingerprint so switching accounts never serves the wrong account's
 *  voices. 5-minute TTL (the Cartesia cache's law). */
const LIVE_VOICE_TTL_MS = 5 * 60 * 1000;
let elevenVoiceCache: {
  key: string;
  at: number;
  voices: { id: string; label: string }[];
} | null = null;
let playhtVoiceCache: {
  key: string;
  at: number;
  voices: { id: string; label: string }[];
} | null = null;

function liveCacheKey(config: { baseUrl?: string; apiKey?: string }): string {
  const fp = config.apiKey ? config.apiKey.slice(-6) : "";
  return `${config.baseUrl?.trim() ?? ""}|${fp}`;
}

function dedupeLive(voices: { id: string; label: string }[]): {
  id: string;
  label: string;
}[] {
  const seen = new Set<string>();
  const out: { id: string; label: string }[] = [];
  for (const v of voices) {
    if (v.id && !seen.has(v.id)) {
      seen.add(v.id);
      out.push({ id: v.id, label: v.label || v.id });
    }
  }
  return out;
}

/** GET {baseUrl}/v1/voices — the ElevenLabs ACCOUNT's real voices (the
 *  premade library plus every cloned/custom voice). Fails open as []
 *  exactly like the Cartesia probe: an unreachable list degrades to the
 *  static catalog, never to an error. */
export async function listElevenlabsVoices(
  config: CapabilityConfig,
  opts?: { refresh?: boolean }
): Promise<{ id: string; label: string }[]> {
  const key = config.apiKey?.trim();
  if (!key) return [];
  const cacheKey = liveCacheKey(config);
  if (
    !opts?.refresh &&
    elevenVoiceCache &&
    elevenVoiceCache.key === cacheKey &&
    Date.now() - elevenVoiceCache.at < LIVE_VOICE_TTL_MS
  ) {
    return elevenVoiceCache.voices;
  }
  const meta = providerMeta("tts", "elevenlabs");
  const baseUrl =
    config.baseUrl?.trim() || meta?.defaultBaseUrl || "https://api.elevenlabs.io/v1";
  try {
    const res = await providerFetch(
      "ElevenLabs voices",
      joinUrl(baseUrl, "voices"),
      { method: "GET", headers: { "xi-api-key": key } },
      { capability: "tts" },
    );
    const data = (await res.json()) as { voices?: unknown[] } | unknown[];
    const rows: unknown[] = Array.isArray(data)
      ? data
      : ((data as { voices?: unknown[] }).voices ?? []);
    const voices = dedupeLive(
      rows
        .map((r) => r as { voice_id?: string; name?: string })
        .filter((r) => typeof r.voice_id === "string" && r.voice_id)
        .map((r) => ({
          id: r.voice_id as string,
          label: (r.name as string) || (r.voice_id as string),
        }))
    );
    elevenVoiceCache = { key: cacheKey, at: Date.now(), voices };
    return voices;
  } catch {
    return [];
  }
}

/** GET {baseUrl}/voices — the PlayHT ACCOUNT's real voices (pre-made
 *  library plus clones). Same fail-open contract as the Cartesia probe. */
export async function listPlayhtVoices(
  config: CapabilityConfig,
  opts?: { refresh?: boolean }
): Promise<{ id: string; label: string }[]> {
  const rawKey = config.apiKey?.trim();
  if (!rawKey || !rawKey.includes(":")) return [];
  const cacheKey = liveCacheKey(config);
  if (
    !opts?.refresh &&
    playhtVoiceCache &&
    playhtVoiceCache.key === cacheKey &&
    Date.now() - playhtVoiceCache.at < LIVE_VOICE_TTL_MS
  ) {
    return playhtVoiceCache.voices;
  }
  const meta = providerMeta("tts", "playht");
  const baseUrl =
    config.baseUrl?.trim() || meta?.defaultBaseUrl || "https://api.play.ht/api/v2";
  const idx = rawKey.indexOf(":");
  const userId = rawKey.slice(0, idx).trim();
  const apiKey = rawKey.slice(idx + 1).trim();
  try {
    const res = await providerFetch(
      "PlayHT voices",
      joinUrl(baseUrl, "voices"),
      {
        method: "GET",
        headers: { "X-USER-ID": userId, Authorization: `Bearer ${apiKey}` },
      },
      { capability: "tts" },
    );
    const data = (await res.json()) as unknown;
    // The list endpoint returns an array of voice objects (id + name).
    const rows: unknown[] = Array.isArray(data)
      ? data
      : ((data as { voices?: unknown[] }).voices ?? []);
    const voices = dedupeLive(
      rows
        .map((r) => r as { id?: string; name?: string })
        .filter((r) => typeof r.id === "string" && r.id)
        .map((r) => ({ id: r.id as string, label: (r.name as string) || (r.id as string) }))
    );
    playhtVoiceCache = { key: cacheKey, at: Date.now(), voices };
    return voices;
  } catch {
    return [];
  }
}

/** Resolve the voice to send to ElevenLabs — THE LIVE-LIST LAW (S159, the
 *  S149 Cartesia shape mirrored):
 *  1. A 20-char id the account's live list KNOWS → verbatim.
 *  2. A 20-char id the live list does NOT know (a deleted custom voice on
 *     an old video) → the FIRST live voice — audio instead of a guaranteed
 *     404 (the adapter's self-heal ladder catches list-staleness too).
 *  3. Anything else (a Z.ai voice name, a clone id, an empty string) → the
 *     first live voice, else the static catalog's first entry.
 *  4. Live list unreachable → static-catalog ids ride verbatim (they are
 *     the premade library; Cartesia's readable-404 honesty for the rest). */
export async function resolveElevenlabsVoiceId(
  voice: string,
  config: CapabilityConfig
): Promise<string> {
  const requested = voice?.trim() ?? "";
  const catalogIds: string[] = ELEVEN_STATIC_VOICES.map((v) => v.id);
  const live = await listElevenlabsVoices(config);
  if (isElevenlabsVoiceId(requested)) {
    if (!live.length) return requested; // cannot verify — ride verbatim
    return live.some((v) => v.id === requested)
      ? requested
      : live[0].id;
  }
  if (!requested || !catalogIds.includes(requested)) {
    if (live.length) return live[0].id;
    return ELEVEN_STATIC_VOICES[0].id;
  }
  return requested; // a known premade id — verbatim (offline-safe)
}

/** Resolve the voice to send to PlayHT — the same law:
 *  s3:// clone URIs and live-list ids ride verbatim; static-catalog ids
 *  ride verbatim offline; a foreign/stale voice lands on the first live
 *  voice, else the documented default. */
export async function resolvePlayhtVoiceId(
  voice: string,
  config: CapabilityConfig
): Promise<string> {
  const requested = voice?.trim() ?? "";
  if (isPlayhtCloneVoiceId(requested)) return requested;
  const catalogIds: string[] = PLAYHT_STATIC_VOICES.map((v) => v.id);
  const live = await listPlayhtVoices(config);
  if (requested && (live.some((v) => v.id === requested) || catalogIds.includes(requested))) {
    return requested;
  }
  if (live.length) return live[0].id;
  return PLAYHT_STATIC_VOICES[0].id;
}

/** The voice catalog for a provider (drives UI pickers + sanitization). */
export function voiceCatalog(provider: ProviderId, model = "") {
  if (provider === "openai") {
    // No model stored → adapter defaults to gpt-4o-mini-tts (the tts-1 pair it
    // replaced is retired Jan 6, 2027). The classic six voices work on every
    // model; the extended set unlocks on non-tts-1 models (classicOnly below).
    const effective = model.trim() || "gpt-4o-mini-tts";
    const classicOnly = /^tts-1(-hd)?$/.test(effective);
    const list = classicOnly
      ? OPENAI_VOICES.filter((v) => v.classic)
      : [...OPENAI_VOICES];
    return list.map((v) => ({ id: v.id, label: v.label }));
  }
  if (provider === "voicestudio") {
    // S121 — the ALIAS catalog: the server owns the real catalog (its
    // /v1/audio/voices answers ids + names); TubeForge serves the OpenAI
    // voice aliases the audited speech schema accepts, so pickers offer
    // honest values without a live probe. Any other id still passes through
    // verbatim (sanitizeVoice below never rewrites a voicestudio voice).
    return OPENAI_VOICES.map((v) => ({ id: v.id, label: v.label }));
  }
  if (provider === "cartesia") {
    // Static fallback catalog — the live account list overlays it in the
    // voices route (the one truth for pickers). UUIDs pass through
    // sanitizeVoice verbatim, so any account voice picked in the UI rides
    // to Cartesia untouched.
    return CARTESIA_STATIC_VOICES.map((v) => ({ ...v }));
  }
  if (provider === "gemini") {
    // S159 — the prebuilt-voice catalog: Google's documented 30-name set.
    // The old fallthrough served the Z.ai studio voices — ids Gemini has
    // never heard of — so every saved voice silently collapsed to the
    // adapter's hardcoded Puck.
    return GEMINI_VOICES.map((v) => ({ ...v }));
  }
  if (provider === "deepgram") {
    // S159 — Aura-2 voices. Voice and model are ONE value in Deepgram's
    // speak API; the adapter maps a catalog voice onto the speak model.
    return DEEPGRAM_VOICES.map((v) => ({ ...v }));
  }
  if (provider === "playht") {
    // S159 — static fallback + the LIVE account list overlays it in the
    // voices route (PlayHT's library is account-shaped).
    return PLAYHT_STATIC_VOICES.map((v) => ({ ...v }));
  }
  if (provider === "elevenlabs") {
    // S159 — the premade library + the LIVE account list (clones/custom
    // voices) overlaid in the voices route; synthesis resolves through
    // resolveElevenlabsVoiceId (the Cartesia law).
    return ELEVEN_STATIC_VOICES.map((v) => ({ ...v }));
  }
  if (provider === "kokoro") {
    // Kokoro's own catalog — never the zai fallthrough.
    return KOKORO_VOICES.map((v) => ({ ...v }));
  }
  // zai + zhipu share the same 7 studio voices; zhipu additionally accepts
  // cloned ids (appended to the catalog by the API layer, which can hit the DB).
  return VOICES.map((v) => ({ id: v.id, label: v.label }));
}

/** Map any stored voice onto the provider's catalog.
 *  Cloned voice ids are preserved for providers that can speak them
 *  (zhipu, selfhost) — switching to a provider that cannot falls back to the
 *  catalog's first entry, exactly like a zai-only voice switching to OpenAI.
 *  Cartesia: UUID-shaped ids are the account's own voices (served live by the
 *  voices route) and pass through verbatim; anything else maps to the static
 *  fallback — the ADAPTER additionally upgrades that fallback to the
 *  account's live first voice at synthesis time. */
export function sanitizeVoice(
  provider: ProviderId,
  voice: string,
  model = "",
): string {
  if (
    (provider === "zhipu" || provider === "selfhost") &&
    isClonedVoiceId(voice)
  )
    return voice;
  if (provider === "voicestudio") return voice; // verbatim — the server owns the catalog
  if (provider === "cartesia" && isCartesiaVoiceId(voice)) return voice;
  // S159 — Gemini voice names canonicalize case-insensitively (a hand-typed
  // "aoede" still lands on the catalog's exact "Aoede" the API expects).
  if (provider === "gemini" && voice) {
    const canonical = GEMINI_VOICES.find(
      (v) => v.id.toLowerCase() === voice.trim().toLowerCase(),
    );
    if (canonical) return canonical.id;
  }
  // S159 — account-owned ids pass through verbatim; the live-list check
  // happens at synthesis (resolveElevenlabsVoiceId / resolvePlayhtVoiceId),
  // never here — this function is sync and must not guess.
  if (provider === "elevenlabs" && isElevenlabsVoiceId(voice)) return voice;
  if (provider === "playht" && isPlayhtCloneVoiceId(voice)) return voice;
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
  // without first flipping Settings → Voiceover. Self-hosted clones also
  // fall back to the OPERATOR's shared voice server (TUBEFORGE_SHARED_VOICE_*)
  // when the user hasn't configured their own.
  if (isClonedVoiceId(request.voice)) {
    const ownerProvider = await voiceProfileProvider(request.voice);
    if (ownerProvider && ownerProvider !== config.provider) {
      const cred = await getProviderCredential("tts", ownerProvider);
      const shared = ownerProvider === "selfhost" ? sharedVoiceServer() : null;
      if (cred?.apiKey?.trim() || cred?.baseUrl?.trim() || shared) {
        config = {
          ...config,
          provider: ownerProvider,
          apiKey: cred?.apiKey ?? shared?.apiKey ?? "",
          baseUrl: cred?.baseUrl ?? shared?.baseUrl ?? "",
          model: config.model, // selfhost ignores; zhipu uses glm-tts
        };
      }
      // If the owning provider has no saved creds AND no shared server, fall
      // through to the active provider — the synthesis call will then surface
      // a clear "configure the self-hosted server URL+key" error, or fall
      // back to a stock voice on the active provider.
    }
    // S121 — a VoiceStudio clone speaks its SERVER-registered profile id (the
    // row's remoteVoiceId), never the local voice_clone_vs_… alias.
    if (ownerProvider === "voicestudio") {
      const remote = await voiceProfileRemoteVoiceId(request.voice);
      if (remote) request = { ...request, voice: remote };
    }
  }

  if (config.provider === "openai") {
    return openaiTts(request, config);
  }
  if (config.provider === "voicestudio") {
    return voicestudioTts(request, config);
  }
  if (config.provider === "zhipu") {
    return zhipuTts(request, config);
  }
  if (config.provider === "selfhost") {
    return selfhostTts(request, config);
  }
  if (config.provider === "heygen") {
    return heygenTts(request, config);
  }
  if (config.provider === "gemini") {
    return geminiTts(request, config);
  }
  if (config.provider === "cartesia") {
    return cartesiaTts(request, config);
  }
  if (config.provider === "deepgram") {
    return deepgramTts(request, config);
  }
  if (config.provider === "playht") {
    return playhtTts(request, config);
  }
  if (config.provider === "elevenlabs") {
    return elevenlabsTts(request, config);
  }
  // Kokoro (local kokoro-fastapi) speaks the OpenAI /audio/speech shape —
  // it rides the SAME adapter as OpenAI TTS; its registry meta supplies
  // localhost:8880/v1 and requiresKey:false, and the adapter's local-host
  // key skip covers loopback. Without this case it fell to zaiTts (the
  // Z.ai SDK), a wire protocol the local server cannot answer.
  if (config.provider === "kokoro") {
    return openaiTts(request, config);
  }
  return zaiTts(request, config);
}

// ---------- Z.ai (SDK — unchanged legacy shape) ----------

async function zaiTts(
  req: TtsRequest,
  _config: CapabilityConfig,
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

// ---------- HeyGen Voice (api.heygen.com/v3 — free tier) ----------

/** HeyGen's public voice IDs are 32-char hex strings. Nadine is a widely
 *  known English one that ships with the free tier; callers can override
 *  via req.voice (which the UI would populate from a voice list). */
const HEYGEN_DEFAULT_VOICE = "83548de556df48ba8c09c42a57c51d85";

/** Exported for the S95 pin suite — called with a caller-built config so
 *  the pins run with no DB and no tenant context, exactly like the
 *  S37 zaiVideoViaClient seam. */
export async function heygenTts(
  req: TtsRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const baseUrl = config.baseUrl?.trim() || "https://api.heygen.com";
  const key = config.apiKey?.trim();
  if (!key) {
    throw new Error(
      "HeyGen Voice needs an API key from platform.heygen.com/api-keys (Settings → AI Providers → Voiceover)",
    );
  }

  // HeyGen's free model is `heygen-voice-1-turbo-free`; the voice id defaults
  // to Nadine but honours a caller-supplied id when it looks like a HeyGen
  // voice (32-char hex). Otherwise fall back to the well-known default so a
  // Z.ai voice name like "jam" doesn't get sent to HeyGen as-is.
  const model = config.model?.trim() || "heygen-voice-1-turbo-free";
  const looksLikeHeyGenVoice = /^[a-f0-9]{32}$/i.test(req.voice ?? "");
  const voiceId = looksLikeHeyGenVoice ? req.voice : HEYGEN_DEFAULT_VOICE;

  const response = await providerFetch(
    "HeyGen TTS",
    joinUrl(baseUrl, "v3/models/audio/tts"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
      },
      body: JSON.stringify({
        language: "en",
        text: req.input,
        voice_id: voiceId,
        model,
      }),
    },
  );

  // Two possible response shapes:
  //   1) Binary audio — the response body IS the WAV/MP3.
  //   2) JSON envelope — { audio_url: "https://..." } or { data: { audio_url } }
  // Handle both: sniff the content-type, then either follow the URL or
  // buffer the binary directly.
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const payload = (await response.json()) as Record<string, unknown>;
    const nested = (payload.data as { audio_url?: string } | undefined)
      ?.audio_url;
    const url =
      (payload.audio_url as string | undefined) ??
      nested ??
      (payload.url as string | undefined);
    if (!url) {
      throw new Error(
        `HeyGen TTS returned JSON without audio_url — raw: ${JSON.stringify(payload).slice(0, 300)}`,
      );
    }
    const audioRes = await providerFetch("HeyGen audio download", url, {});
    const buffer = Buffer.from(new Uint8Array(await audioRes.arrayBuffer()));
    if (buffer.length < 44) throw new Error("HeyGen TTS returned empty audio");
    return buffer;
  }

  const buffer = Buffer.from(new Uint8Array(await response.arrayBuffer()));
  if (buffer.length < 44) throw new Error("HeyGen TTS returned empty audio");
  return buffer;
}

// ---------- Gemini TTS (Google AI Studio) ----------

async function geminiTts(
  req: TtsRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const meta = providerMeta("tts", "gemini");
  const baseUrl =
    config.baseUrl?.trim() ||
    meta?.defaultBaseUrl ||
    "https://generativelanguage.googleapis.com/v1beta";
  const model = config.model?.trim() || "gemini-3.8-flash-tts";
  const key = config.apiKey?.trim();

  if (!key) {
    throw new Error(
      "Gemini TTS needs an API key from aistudio.google.com (Settings → AI Providers)",
    );
  }

  // Gemini requires the key as a query parameter, not a Bearer header.
  const url = `${baseUrl}/models/${model}:generateContent?key=${key}`;

  // S159 — the voice is HONORED: the catalog's prebuilt names are the legal
  // values (a Z.ai name like "jam" canonicalizes to the default Puck, not a
  // silent hardcoded voice). The old code hardcoded Puck and ignored the
  // picker entirely.
  const voiceName = sanitizeVoice("gemini", req.voice);

  const response = await providerFetch("Gemini TTS", url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: req.input }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName,
            },
          },
        },
      },
    }),
  });

  const data = await response.json();
  const audioB64 = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

  if (!audioB64) {
    throw new Error(
      `Gemini TTS returned no audio data — raw response: ${JSON.stringify(data).slice(0, 300)}`,
    );
  }

  // Gemini returns base64-encoded audio (often WAV/L16).
  const buffer = Buffer.from(audioB64, "base64");

  if (buffer.length < 44) {
    throw new Error("Gemini TTS returned empty or invalid audio");
  }

  return buffer;
}

// ---------- Cartesia (Sonic) ----------

/** The Cartesia-Version header — one table, one truth (the same value rides
 *  both the voices listing and the synthesis call). */
export const CARTESIA_VERSION = "2025-04-16";

/** Exported for the S149 pin suite — called with a caller-built config so
 *  the pins run with no DB and no tenant context, exactly like heygenTts. */
export async function cartesiaTts(
  req: TtsRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const meta = providerMeta("tts", "cartesia");
  const baseUrl =
    config.baseUrl?.trim() || meta?.defaultBaseUrl || "https://api.cartesia.ai";
  const model = config.model?.trim() || "sonic-3.6";
  const key = config.apiKey?.trim();
  if (!key) {
    throw new Error(
      "Cartesia needs an API key from play.cartesia.ai/console (Settings → AI Providers)",
    );
  }

  // THE 404 FIX — resolve the voice against the ACCOUNT's real voices:
  // UUID ids (picked from the live list in any picker) ride verbatim; a
  // foreign voice name ("jam"), a clone id, or an empty string (the Settings
  // Test button) resolves to the account's first live voice — never a stale
  // hard-coded UUID.
  const voiceId = await resolveCartesiaVoiceId(req.voice, config);

  // S149 — the self-heal: a 404 "not found" after a verbatim resolve means
  // the cached live list (5-min TTL) served an id the account no longer has
  // (archived-library ids, a just-deleted custom voice). Refresh the list
  // and retry ONCE on the refreshed first voice — audio instead of a dead
  // end. Any other status, or an empty refreshed list, rethrows the original
  // readable Cartesia error untouched.
  try {
    return await cartesiaTtsCall(baseUrl, key, model, voiceId, req.input);
  } catch (err) {
    const httpErr = err as ProviderHttpError;
    if (
      !(httpErr instanceof ProviderHttpError) ||
      httpErr.status !== 404 ||
      !/not found/i.test(httpErr.message)
    ) {
      throw err;
    }
    const refreshed = await listCartesiaVoices(config, { refresh: true });
    if (!refreshed.length || refreshed[0].id === voiceId) throw err;
    return cartesiaTtsCall(baseUrl, key, model, refreshed[0].id, req.input);
  }
}

async function cartesiaTtsCall(
  baseUrl: string,
  key: string,
  model: string,
  voiceId: string,
  transcript: string,
): Promise<Buffer> {
  const response = await providerFetch(
    "Cartesia TTS",
    joinUrl(baseUrl, "tts/bytes"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": key,
        "Cartesia-Version": CARTESIA_VERSION,
      },
      body: JSON.stringify({
        model_id: model,
        transcript,
        voice: {
          mode: "id",
          id: voiceId,
        },
        output_format: {
          container: "wav",
          encoding: "pcm_s16le",
          sample_rate: 44100,
        },
      }),
    },
  );

  const buffer = Buffer.from(new Uint8Array(await response.arrayBuffer()));
  if (buffer.length < 44) throw new Error("Cartesia TTS returned empty audio");
  return buffer;
}

// ---------- Deepgram (Aura) ----------

async function deepgramTts(
  req: TtsRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const meta = providerMeta("tts", "deepgram");
  const baseUrl =
    config.baseUrl?.trim() ||
    meta?.defaultBaseUrl ||
    "https://api.deepgram.com/v1";
  const key = config.apiKey?.trim();
  if (!key) {
    throw new Error(
      "Deepgram needs an API key from console.deepgram.com (Settings → AI Providers)",
    );
  }

  // S159 — voice and model are ONE value in Deepgram's speak API: a voice
  // picked from the catalog (any aura id) IS the speak model. A voice saved
  // under another provider ("jam", a clone id) is not an aura id and falls
  // back to the saved/default model — never a foreign id on the wire.
  const catalog: string[] = DEEPGRAM_VOICES.map((v) => v.id);
  const requestedVoice = req.voice?.trim() ?? "";
  const model =
    catalog.includes(requestedVoice)
      ? requestedVoice
      : config.model?.trim() || "aura-2-thalia-en";

  const url = `${joinUrl(baseUrl, "speak")}?model=${encodeURIComponent(model)}`;

  const response = await providerFetch("Deepgram TTS", url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Token ${key}`, // Note: Token, not Bearer
    },
    body: JSON.stringify({ text: req.input }),
  });

  const buffer = Buffer.from(new Uint8Array(await response.arrayBuffer()));
  if (buffer.length < 44) throw new Error("Deepgram TTS returned empty audio");
  return buffer;
}

// ---------- PlayHT ----------

async function playhtTts(
  req: TtsRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const meta = providerMeta("tts", "playht");
  const baseUrl =
    config.baseUrl?.trim() ||
    meta?.defaultBaseUrl ||
    "https://api.play.ht/api/v2";
  const model = config.model?.trim() || "Play3.0-mini";
  const rawKey = config.apiKey?.trim();
  if (!rawKey) {
    throw new Error(
      "PlayHT needs a userId:apiKey pair in the API key field (Settings → AI Providers)",
    );
  }

  // PlayHT requires BOTH X-USER-ID and Authorization headers.
  // We expect the key to be formatted as "userId:apiKey".
  const idx = rawKey.indexOf(":");
  if (idx === -1) {
    throw new Error(
      "PlayHT credentials must be formatted as 'userId:apiKey' (get both from play.ht/studio/api-access)",
    );
  }
  const userId = rawKey.slice(0, idx).trim();
  const apiKey = rawKey.slice(idx + 1).trim();

  // S159 — THE LIVE-LIST LAW (resolvePlayhtVoiceId): s3:// clone URIs and
  // live-list ids ride verbatim; a foreign voice ("jam" — a Z.ai name saved
  // under another provider) lands on the account's first live voice, else
  // the documented default. The old code sent req.voice verbatim — a stale
  // or foreign id was a guaranteed error.
  const voiceId = await resolvePlayhtVoiceId(req.voice, config);

  const response = await providerFetch(
    "PlayHT TTS",
    joinUrl(baseUrl, "tts/stream"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-USER-ID": userId,
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        text: req.input,
        voice: voiceId,
        voice_engine: model,
        output_format: "wav",
      }),
    },
  );

  const buffer = Buffer.from(new Uint8Array(await response.arrayBuffer()));
  if (buffer.length < 44) throw new Error("PlayHT TTS returned empty audio");
  return buffer;
}

// ---------- ElevenLabs (S159 — the Cartesia law, mirrored) ----------

/** Exported for the S159 pin suite — called with a caller-built config so
 *  the pins run with no DB and no tenant context, exactly like heygenTts
 *  and cartesiaTts. */
export async function elevenlabsTts(
  req: TtsRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const meta = providerMeta("tts", "elevenlabs");
  const baseUrl =
    config.baseUrl?.trim() ||
    meta?.defaultBaseUrl ||
    "https://api.elevenlabs.io/v1";
  const model = config.model?.trim() || "eleven_multilingual_v2";
  const key = config.apiKey?.trim();
  if (!key) {
    throw new Error(
      "ElevenLabs needs an API key from elevenlabs.io/app/settings/api-keys (Settings → AI Providers)",
    );
  }

  // THE LIVE-LIST LAW (S159 — resolveElevenlabsVoiceId): a 20-char id the
  // account knows rides verbatim; a foreign voice ("jam", a Z.ai name, a
  // clone id) lands on a REAL account voice — never a guaranteed 404.
  const voiceId = await resolveElevenlabsVoiceId(req.voice, config);

  // S159 — the self-heal (the Cartesia ladder, mirrored): a 404 after a
  // verbatim resolve means the cached live list (5-min TTL) served an id
  // the account no longer has (a just-deleted clone, a retired premade).
  // Refresh the list and retry ONCE on the refreshed first voice. Any other
  // status, or an empty refreshed list, rethrows the original error.
  try {
    return await elevenlabsTtsCall(baseUrl, key, model, voiceId, req.input);
  } catch (err) {
    const httpErr = err as ProviderHttpError;
    if (
      !(httpErr instanceof ProviderHttpError) ||
      httpErr.status !== 404
    ) {
      throw err;
    }
    const refreshed = await listElevenlabsVoices(config, { refresh: true });
    if (!refreshed.length || refreshed[0].id === voiceId) throw err;
    return elevenlabsTtsCall(baseUrl, key, model, refreshed[0].id, req.input);
  }
}

async function elevenlabsTtsCall(
  baseUrl: string,
  key: string,
  model: string,
  voiceId: string,
  transcript: string,
): Promise<Buffer> {
  // pcm_44100 (s16le mono) wrapped into a canonical WAV container — the
  // downstream pipeline measures narration with WAV header math
  // (wavDurationSec), so the adapter contract stays "always WAV bytes".
  const response = await providerFetch(
    "ElevenLabs TTS",
    `${joinUrl(baseUrl, `text-to-speech/${voiceId}`)}?output_format=pcm_44100`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "audio/wav",
        "xi-api-key": key,
      },
      body: JSON.stringify({
        text: transcript,
        model_id: model,
      }),
    },
    { capability: "tts" },
  );
  const pcm = Buffer.from(new Uint8Array(await response.arrayBuffer()));
  if (pcm.length < 1000)
    throw new Error("ElevenLabs TTS returned empty audio");
  return pcmToWav(pcm, 44100, 1, 16);
}

// ---------- VoiceStudio (the user's own server — S121) ----------

/** S121 — the VoiceStudio lane: the user's own server, OpenAI-compatible
 *  speech (audited schema: model = the engine id, input ≤4096, voice id/name/
 *  alias, speed 0.25–4.0, response_format wav). Loopback servers run keyless;
 *  a saved key rides Bearer for remote deployments. The engine-license law
 *  (omnivoice can never bill by silence) is enforced in model-license-policy
 *  at the PRICING layer — the adapter speaks whatever the user's server runs.
 *  Exported for the S121 pin suite — called with a caller-built config so
 *  the pins run with no DB and no tenant context. */
export async function voicestudioTts(
  req: TtsRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const meta = providerMeta("tts", "voicestudio");
  const baseUrl =
    config.baseUrl?.trim() || meta?.defaultBaseUrl || "http://127.0.0.1:3900";
  const key = config.apiKey?.trim();
  const model = config.model?.trim() || "voxcpm2"; // the permissive recommended lane
  const voice = req.voice; // VERBATIM — ids, names and aliases all answer

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (key) headers.Authorization = `Bearer ${key}`;

  const response = await providerFetch(
    "VoiceStudio TTS",
    joinUrl(baseUrl, "v1/audio/speech"),
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        input: req.input.slice(0, 4096), // the audited input cap
        voice,
        speed: Math.min(4, Math.max(0.25, req.speed || 1)), // the audited speed range
        response_format: "wav", // downstream WAV merging depends on it
      }),
    },
    { capability: "tts" },
  );
  const buffer = Buffer.from(new Uint8Array(await response.arrayBuffer()));
  if (buffer.length < 44)
    throw new Error("VoiceStudio TTS returned empty audio");
  return buffer;
}

// ---------- Self-hosted (voice_server.py — Chatterbox on the user's PC) ----------

async function selfhostTts(
  req: TtsRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  // The user's own server wins; the platform-shared voice server
  // (operator-configured env) is the fallback; the conventional local
  // default applies when the user explicitly picked this provider.
  const ep = selfhostEndpoint(config.baseUrl, config.apiKey) ?? {
    baseUrl:
      providerMeta("tts", "selfhost")?.defaultBaseUrl ||
      "http://localhost:8931",
    apiKey: "",
    shared: false,
  };
  const baseUrl = ep.baseUrl;
  const key = ep.apiKey;

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

  const callServer = () =>
    providerFetch(
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
      // The tts capability timeout (180s default, TUBEFORGE_TIMEOUT_TTS
      // override) — CPU-bound self-hosted synthesis legitimately runs long.
      { capability: "tts" },
    );

  let response;
  try {
    response = await callServer();
  } catch (err) {
    // providerFetch turns every non-2xx into ProviderHttpError — a 503 cold
    // start is worth WAITING FOR (the model loads 10-60 s after a boot;
    // narration jobs queued behind that boot should survive it instead of
    // failing the whole render). Poll every 6 s for up to ~66 s.
    if (err instanceof ProviderHttpError && err.status === 503) {
      for (let attempt = 0; attempt < 11; attempt++) {
        await new Promise((r) => setTimeout(r, attempt === 0 ? 4_000 : 6_000));
        try {
          response = await callServer();
          break;
        } catch (retryErr) {
          if (
            !(retryErr instanceof ProviderHttpError) ||
            retryErr.status !== 503
          ) {
            throw selfhostError(retryErr, baseUrl);
          }
        }
      }
      if (!response) throw selfhostError(err, baseUrl);
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
 *  "Chatterbox Turbo (fast) · cpu · model loaded · 230 ms" reads at a glance;
 *  a cold start says so instead of failing mysteriously. */
export function describeVoiceHealth(h: VoiceServerHealth): string {
  const model =
    h.model === "chatterbox-multilingual"
      ? "Chatterbox Multilingual (23 languages)"
      : h.model === "chatterbox-turbo"
        ? "Chatterbox Turbo (fast, low-RAM)"
        : h.model
          ? "Chatterbox (English)"
          : "Voice server";
  const bits = [model];
  if (h.device) bits.push(h.device);
  bits.push(
    h.warm ? "model loaded" : "model still loading — retry in a few minutes",
  );
  if (h.busy) bits.push("busy synthesizing");
  return bits.join(" · ");
}

/** GET {baseUrl}/health on the configured self-hosted server — never
 *  synthesizes, 6s timeout, network failures become `up: false` with a
 *  readable reason. Used by the Settings test button so the user can confirm
 *  the Oracle VM (or laptop) is reachable before wiring it in. Falls back to
 *  the operator's shared voice server when the user hasn't configured one. */
export async function probeSelfhostHealth(
  overrides?: Partial<CapabilityConfig>,
): Promise<{
  up: boolean;
  detail: string;
  latencyMs: number;
  health?: VoiceServerHealth;
  shared: boolean;
}> {
  const cfg = await getCapability("tts", overrides);
  if (cfg.provider !== "selfhost")
    throw new Error(
      "The health probe only applies to the self-hosted provider",
    );
  const ep = selfhostEndpoint(cfg.baseUrl, cfg.apiKey) ?? {
    baseUrl:
      providerMeta("tts", "selfhost")?.defaultBaseUrl ||
      "http://localhost:8931",
    apiKey: "",
    shared: false,
  };
  const baseUrl = ep.baseUrl;
  const key = ep.apiKey;
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
      shared: ep.shared,
    };
  } catch (err) {
    return {
      up: false,
      detail: selfhostError(err, baseUrl).message,
      latencyMs: Date.now() - started,
      shared: ep.shared,
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
  const model =
    config.model?.trim() ||
    meta?.models[0]?.id ||
    "gpt-4o-mini-tts";
  const key = config.apiKey?.trim();

  // Skip the API key check if the provider is local (like TTSFM) or
  // explicitly requires no key.
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

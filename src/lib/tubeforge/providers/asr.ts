// Speech-to-text adapter — follows the ASR capability setting.
//
// S121 — transcription is its own capability (ai.asr), which FOLLOWS the tts
// capability until an ai.asr row is saved (providers/settings.ts) — the
// historical transcription-rode-TTS behavior IS the default.
//
//   zai         → bundled SDK asr (file_base64) — no word timestamps
//   openai      → POST {baseUrl}/audio/transcriptions (whisper-1, multipart)
//   voicestudio → POST {baseUrl}/v1/audio/transcriptions — the USER-MANAGED
//                 VoiceStudio server's OpenAI-compatible API. The AGPL app is
//                 never bundled; TubeForge talks the wire only. Its verified
//                 headline win: response_format=verbose_json +
//                 timestamp_granularities[]=word → words:[{word,start,end}]
//                 (whisperx wav2vec2 forced alignment, ±10-30 ms).
//
// Used by the optional "verify narration" feature, the smart-captions ladder
// and the whiteboard anchors. Input is always a WAV buffer (the caller
// pre-chunks to ≤25 s). Error-shape mapping + the word support table are
// pure and unit-pinned (fixture tests, no live service in CI).

import { zaiClientFor } from "../zai-client";
import { getCapability, type CapabilityConfig } from "./settings";
import { providerMetaRequired } from "./registry";
import { joinUrl, providerFetchJson, ProviderHttpError, timeoutFor } from "./http";

// ---------------------------------------------------------------------------
// The word support table — which ASR providers can answer the detailed pass.
// Pure data, unit-pinned: a provider absent from this table never makes the
// detailed wire call (null → the ladder degrades, nothing breaks).
// ---------------------------------------------------------------------------

export const ASR_WORD_TIMESTAMP_SUPPORT: Readonly<Record<string, boolean>> =
  Object.freeze({
    voicestudio: true, // verbose_json + timestamp_granularities[]=word (verified)
    openai: true, // whisper-1 verbose_json word granularity
    zai: false, // the bundled SDK answers text only
  });

export function asrSupportsWordTimestamps(provider: string): boolean {
  return ASR_WORD_TIMESTAMP_SUPPORT[provider] === true;
}

// ---------------------------------------------------------------------------
// The detailed pass — words.
// ---------------------------------------------------------------------------

export interface AsrWord {
  word: string;
  start: number; // seconds
  end: number;
}

export interface AsrDetailed {
  text: string;
  /** Word spans when the server emitted them, null when it answered without
   *  word granularity (e.g. a moonshine engine) — both are honest ladder
   *  signals, never a failure. */
  words: AsrWord[] | null;
  provider: string;
}

/** Thrown when the configured provider cannot serve word timestamps — the
 *  alignment ladder's typed signal (caught, degraded, never surfaced as a
 *  render failure). */
export class AsrWordsUnsupportedError extends Error {
  constructor(provider: string) {
    super(`ASR provider "${provider}" does not support word-level timestamps`);
    this.name = "AsrWordsUnsupportedError";
  }
}

/**
 * The exact wire form the detailed pass sends — exported pure so the fixture
 * tests pin it (the fields ARE the contract with both servers):
 *   file                       the chunk WAV
 *   model                      the configured model
 *   response_format            verbose_json
 *   timestamp_granularities[]  word
 */
export function buildAsrDetailedForm(
  wavBuffer: Buffer,
  model: string,
): FormData {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wavBuffer)], { type: "audio/wav" }), "chunk.wav");
  form.append("model", model);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  return form;
}

/**
 * Parse a verbose_json payload into text + words. Tolerant of both observed
 * shapes: words at the top level AND words nested per segment (OpenAI nests
 * them under segments[].words[] when timestamp_granularities=word is set;
 * VoiceStudio emits a flat words[]). PARITY LAW with VoiceStudio's own
 * _openai_words: an entry without BOTH finite start/end or without a string
 * word is SKIPPED, never guessed into a span.
 */
export function parseVerboseJsonWords(payload: unknown): { text: string; words: AsrWord[] } {
  const obj = (payload ?? {}) as Record<string, unknown>;
  const text = typeof obj.text === "string" ? obj.text : "";

  const rawWords: unknown[] = [];
  if (Array.isArray(obj.words)) rawWords.push(...obj.words);
  if (Array.isArray(obj.segments)) {
    for (const seg of obj.segments) {
      const segWords = (seg as Record<string, unknown> | null)?.words;
      if (Array.isArray(segWords)) rawWords.push(...segWords);
    }
  }

  const words: AsrWord[] = [];
  for (const raw of rawWords) {
    if (!raw || typeof raw !== "object") continue; // untimed junk → skip
    const w = raw as Record<string, unknown>;
    const word = typeof w.word === "string" ? w.word : null;
    const start = typeof w.start === "number" ? w.start : Number.NaN;
    const end = typeof w.end === "number" ? w.end : Number.NaN;
    if (!word || !Number.isFinite(start) || !Number.isFinite(end)) continue; // the untimed-token skip
    if (end < start) continue; // a backwards span is a server bug — skip, never propagate
    words.push({ word, start, end });
  }
  return { text, words };
}

// ---------------------------------------------------------------------------
// Error-shape mapping — pure, unit-pinned. Both servers answer OpenAI-shaped
// errors {"error":{message,type,param,code}}; the readable messages name the
// fix, and every documented status class maps exactly once.
// ---------------------------------------------------------------------------

export function asrErrorText(provider: string, status: number, body: string): string {
  // OpenAI-shaped body first — the server's own message is the best signal.
  let detail = body.slice(0, 200);
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string };
    if (parsed?.error) {
      const msg =
        typeof parsed.error === "string" ? parsed.error : parsed.error.message;
      if (typeof msg === "string" && msg.trim()) detail = msg.trim().slice(0, 200);
    }
  } catch {
    /* plain-text body — keep the slice */
  }
  if (status === 400)
    return `${provider} refused the transcription request (HTTP 400): ${detail} — the chunk may be malformed or the model may not support word timestamps`;
  if (status === 401)
    return `${provider} rejected the API key (HTTP 401) — check Settings → AI Providers → Transcription`;
  if (status === 403)
    return `${provider} denied the request (HTTP 403): ${detail} — on VoiceStudio this is usually an unaccepted model license; accept it on the server once`;
  if (status === 429)
    return `${provider} is rate limiting (HTTP 429) — the ladder retries with backoff; if it persists, pace the renders`;
  if (status === 503)
    return `${provider} is still loading its model (HTTP 503): ${detail} — the ladder retries; give the server a minute after a cold start`;
  return `${provider} transcription failed (HTTP ${status}): ${detail}`;
}

/** The 503 retry ladder — a cold-starting server is worth WAITING for, and
 *  the decision is pure so the pins hold it without a live service. */
export function shouldRetryAsr(status: number, attempt: number): boolean {
  return status === 503 && attempt < 3;
}

export const ASR_RETRY_DELAY_MS = 2_000;

// ---------------------------------------------------------------------------
// The adapters.
// ---------------------------------------------------------------------------

/** Which endpoint shape a provider's transcription route uses. */
function transcriptionUrl(provider: string, baseUrl: string): string {
  // VoiceStudio pins its OpenAI-compatible API under /v1 (audited:
  // POST /v1/audio/transcriptions); OpenAI-compatible bases already carry /v1.
  return provider === "voicestudio"
    ? joinUrl(baseUrl, "v1/audio/transcriptions")
    : joinUrl(baseUrl, "audio/transcriptions");
}

async function voicestudioAsr(
  wavBuffer: Buffer,
  config: CapabilityConfig,
  detailed: boolean,
): Promise<{ text: string; words: AsrWord[] | null }> {
  const meta = providerMetaRequired("asr", "voicestudio");
  const baseUrl = config.baseUrl?.trim() || meta.defaultBaseUrl;
  const model = config.model?.trim() || "whisperx";
  // Loopback servers run KEYLESS (audited auth law); a saved key still rides
  // Bearer for remote deployments.
  const key = config.apiKey?.trim();
  const headers: Record<string, string> = {};
  if (key) headers.Authorization = `Bearer ${key}`;

  let attempt = 0;
  // The 503 retry ladder — cold starts load the model 10-60 s.
  for (;;) {
    attempt += 1;
    try {
      const data = detailed
        ? await providerFetchJson<unknown>(
            "VoiceStudio ASR",
            transcriptionUrl("voicestudio", baseUrl),
            { method: "POST", headers, body: buildAsrDetailedForm(wavBuffer, model) },
            { capability: "asr" },
          )
        : await (async () => {
            const plain = new FormData();
            plain.append("file", new Blob([new Uint8Array(wavBuffer)], { type: "audio/wav" }), "chunk.wav");
            plain.append("model", model);
            plain.append("response_format", "json");
            return providerFetchJson<{ text?: string }>(
              "VoiceStudio ASR",
              transcriptionUrl("voicestudio", baseUrl),
              { method: "POST", headers, body: plain },
              { capability: "asr" },
            );
          })();
      if (!detailed) {
        const text = ((data as { text?: string }).text ?? "").trim();
        return { text, words: null };
      }
      const parsed = parseVerboseJsonWords(data);
      const text = parsed.text.trim();
      if (!text) throw new Error("ASR returned an empty transcript");
      return { text, words: parsed.words.length > 0 ? parsed.words : null };
    } catch (err) {
      if (err instanceof ProviderHttpError && shouldRetryAsr(err.status, attempt)) {
        await new Promise((r) => setTimeout(r, ASR_RETRY_DELAY_MS));
        continue;
      }
      if (err instanceof ProviderHttpError)
        throw new Error(asrErrorText("VoiceStudio", err.status, extractBody(err)));
      throw err;
    }
  }
}

function extractBody(err: ProviderHttpError): string {
  // ProviderHttpError embeds the redacted body in its message after the
  // prefix — hand the mapping the raw slice it stored.
  const marker = "): ";
  const idx = err.message.indexOf(marker);
  return idx >= 0 ? err.message.slice(idx + marker.length) : err.message;
}

async function openaiAsr(
  wavBuffer: Buffer,
  config: CapabilityConfig,
  detailed: boolean,
): Promise<{ text: string; words: AsrWord[] | null }> {
  const meta = providerMetaRequired("asr", "openai");
  const baseUrl = config.baseUrl?.trim() || meta.defaultBaseUrl;
  const key = config.apiKey?.trim();
  if (!key) throw new Error("OpenAI-compatible transcription needs an API key");

  const model = config.model?.trim() || "whisper-1";
  try {
    const data = await providerFetchJson<unknown>(
      "OpenAI-compatible ASR",
      transcriptionUrl("openai", baseUrl),
      {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: buildAsrDetailedForm(wavBuffer, model),
      },
      { capability: "asr" },
    );
    if (!detailed) {
      const text = ((data as { text?: string }).text ?? "").trim();
      if (!text) throw new Error("ASR returned an empty transcript");
      return { text, words: null };
    }
    const parsed = parseVerboseJsonWords(data);
    const text = parsed.text.trim();
    if (!text) throw new Error("ASR returned an empty transcript");
    return { text, words: parsed.words.length > 0 ? parsed.words : null };
  } catch (err) {
    if (err instanceof ProviderHttpError)
      throw new Error(asrErrorText("OpenAI-compatible", err.status, extractBody(err)));
    throw err;
  }
}

async function zaiAsr(wavBuffer: Buffer): Promise<{ text: string; words: AsrWord[] | null }> {
  const zai = await zaiClientFor("asr");
  const response = await zai.audio.asr.create({
    file_base64: wavBuffer.toString("base64"),
  });
  const text = (response.text ?? "").trim();
  if (!text) throw new Error("ASR returned an empty transcript");
  return { text, words: null };
}

// ---------------------------------------------------------------------------
// The public seam.
// ---------------------------------------------------------------------------

/**
 * One transcription pass over a ≤25 s WAV chunk. When `detailed` is true the
 * caller wants WORD TIMESTAMPS: unsupported providers throw the typed
 * AsrWordsUnsupportedError (the ladder's signal — caught upstream and
 * degraded to the silence ladder, never surfaced as a render failure), and
 * supported providers answer {text, words} (words null when the server
 * honestly answered without word granularity).
 */
async function asrPass(
  wavBuffer: Buffer,
  detailed: boolean,
  overrides?: Partial<CapabilityConfig>
): Promise<{ text: string; words: AsrWord[] | null }> {
  const config = await getCapability("asr", overrides);
  const provider = config.provider;

  if (detailed && !asrSupportsWordTimestamps(provider)) {
    throw new AsrWordsUnsupportedError(provider);
  }

  if (provider === "voicestudio") {
    return voicestudioAsr(wavBuffer, config, detailed);
  }
  if (provider === "openai") {
    return openaiAsr(wavBuffer, config, detailed);
  }
  return zaiAsr(wavBuffer);
}

/** Plain-text transcription (the historical seam — narration checks). */
export async function asrTranscribe(
  wavBuffer: Buffer,
  overrides?: Partial<CapabilityConfig>
): Promise<string> {
  const { text } = await asrPass(wavBuffer, false, overrides);
  return text;
}

/**
 * The detailed pass — text + per-WORD timestamps (the S121 measured rung's
 * source). Null is NEVER returned: unsupported providers throw the typed
 * signal so the ladder can degrade deliberately; supported providers answer
 * or throw a mapped, readable error.
 */
export async function asrTranscribeDetailed(
  wavBuffer: Buffer,
  overrides?: Partial<CapabilityConfig>
): Promise<{ text: string; words: AsrWord[]; provider: string }> {
  const { text, words } = await asrPass(wavBuffer, true, overrides);
  const provider = (await getCapability("asr", overrides)).provider;
  return { text, words: words ?? [], provider };
}

/** The asr capability's wire timeout (the timeout matrix's own row — the
 *  timeout+retry law's half; the retry ladder is shouldRetryAsr above). */
export function asrTimeoutMs(): number {
  return timeoutFor("asr");
}

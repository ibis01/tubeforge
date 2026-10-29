// Voice preview — let users HEAR a voice before committing to it.
//
// Generates (once) and caches a short WAV sample per
// (provider, model, voice) so auditioning 7 voices costs 7 TTS calls
// per provider/model FOREVER, not per click. Memory cache makes repeat
// auditions instant; the disk cache (uploads/_voicepreviews) survives
// dev-server restarts.

import { createHash } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { getCapability } from "./providers/settings";
import { sanitizeVoice, ttsSynthesize, voiceCatalog, isClonedVoiceId } from "./providers/tts";
import { aiCall } from "./budget";
import { listVoiceProfiles } from "./voice-clone";

export const VOICE_PREVIEW_TEXT =
  "Hi! Quick voice preview. If you pick me, this is exactly how I'll narrate your next video — clear, confident, and easy to follow.";
const UPLOAD_ROOT = path.join(process.cwd(), "uploads");
const PREVIEW_DIR = path.join(UPLOAD_ROOT, "_voicepreviews");
const MEMORY_MAX = 32;

const memoryCache = new Map<string, Buffer>();

/** Cache key — everything that can change what the sample sounds like:
 *  provider + endpoint + key fingerprint + model + voice. Switching any of
 *  them regenerates instead of serving a stale sample. */
function cacheKey(config: { provider: string; model: string; baseUrl?: string; apiKey?: string }, voice: string) {
  const keyFp = config.apiKey ? createHash("sha1").update(config.apiKey).digest("hex").slice(0, 8) : "-";
  const base = config.baseUrl?.trim() || "-";
  return `${config.provider}|${base}|${keyFp}|${config.model}|${voice}`;
}

function diskPath(key: string) {
  const hash = createHash("sha1").update(key).digest("hex");
  return path.join(PREVIEW_DIR, `${hash}.wav`);
}

/** Audition-able catalog check: does the ACTIVE tts provider know this voice?
 *  Cloned ids count as known when the active provider is zhipu AND the
 *  profile still exists (DB lookup) — a deleted clone previews as unknown
 *  instead of mysteriously falling back to the default voice. */
export async function resolvePreviewVoice(voice: string) {
  const config = await getCapability("tts");
  const model = config.provider === "openai" ? config.model.trim() || "tts-1" : config.model.trim();
  const catalog = voiceCatalog(config.provider, model);
  let known = catalog.some((v) => v.id === voice);
  if (!known && (config.provider === "zhipu" || config.provider === "selfhost") && isClonedVoiceId(voice)) {
    const clones = await listVoiceProfiles(config.provider);
    known = clones.some((c) => c.id === voice);
  }
  return {
    config,
    model,
    known,
    voice: known ? voice : sanitizeVoice(config.provider, voice, model),
  };
}

/** Get (or synthesize+cache) the preview WAV for a voice of the ACTIVE provider. */
export async function getVoicePreview(voice: string): Promise<Buffer> {
  const { config, model, voice: safe } = await resolvePreviewVoice(voice);
  const key = cacheKey({ ...config, model }, safe);

  const hot = memoryCache.get(key);
  if (hot) return hot;

  const disk = diskPath(key);
  try {
    const cached = await readFile(disk);
    touchMemory(key, cached);
    return cached;
  } catch {
    /* not on disk yet */
  }

  // Same budget/pacing/429 handling as every other TTS call in the pipeline —
  // previews ride out rate-limit storms instead of erroring on the first click.
  const buffer = await aiCall("tts", `voice-preview(${safe})`, () =>
    ttsSynthesize({ input: VOICE_PREVIEW_TEXT, voice: safe, speed: 1 }, config)
  );

  touchMemory(key, buffer);
  try {
    await mkdir(PREVIEW_DIR, { recursive: true });
    await writeFile(disk, buffer);
  } catch {
    /* cache write is best-effort */
  }
  return buffer;
}

function touchMemory(key: string, buffer: Buffer) {
  if (memoryCache.has(key)) memoryCache.delete(key);
  memoryCache.set(key, buffer);
  if (memoryCache.size > MEMORY_MAX) {
    const oldest = memoryCache.keys().next().value as string;
    memoryCache.delete(oldest);
  }
}

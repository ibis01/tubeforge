// Voice cloning — "mimic a voice when uploaded".
//
// Turns a short (3-30s) recording of ANY speaker into a reusable TTS voice
// via the Zhipu GLM-TTS-Clone API (open.bigmodel.cn), so narration comes out
// in that person's timbre, pacing and speaking habits.
//
//   POST /files            (multipart, purpose "voice-clone-input") → file_id
//   POST /voice/clone      (model glm-tts-clone, file_id, voice_name) → voice id
//   → the id (voice_clone_…) becomes a valid `voice` value for glm-tts
//     (see providers/tts.ts zhipuTts), stored as a VoiceProfile row.
//
// The sample is validated (real audio stream, sane duration) and normalized
// to mono 24 kHz PCM-16 WAV before upload — the smallest shape the clone
// API accepts with zero quality surprises. Everything runs in a temp dir so
// the flow works on serverless read-only filesystems too.
//
// Consent note: cloning a voice you don't own or have permission to use is on
// the uploader — the UI states this next to the upload button.

import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { getCapability } from "./providers/settings";
import { providerMeta } from "./providers/registry";
import { joinUrl, providerFetch, providerFetchJson } from "./providers/http";
import { safeFetch } from "./net-guard";
import { errorText } from "./redact";

const execFileAsync = promisify(execFile);

/** Zhipu clone API limits (documented): sample ≤ 10 MB, 3-30s recommended. */
export const MAX_SAMPLE_BYTES = 10 * 1024 * 1024;
export const MIN_SAMPLE_SEC = 2; // slightly below the recommended 3s — be kind
export const MAX_SAMPLE_SEC = 30; // longer samples are TRIMMED to the first 30s

/** Audition WAV cached on the profile row (base64) — capped to keep rows lean. */
const MAX_AUDITION_BYTES = 2 * 1024 * 1024;

export interface VoiceProfileDTO {
  id: string;
  name: string;
  provider: string;
  providerVoiceId: string;
  sourceLabel: string | null;
  durationSec: number | null;
  hasAudition: boolean;
  createdAt: string;
}

export function toVoiceProfileDTO(row: {
  id: string;
  name: string;
  provider: string;
  providerVoiceId: string;
  sourceLabel: string | null;
  durationSec: number | null;
  auditionWav: string | null;
  createdAt: Date;
}): VoiceProfileDTO {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    providerVoiceId: row.providerVoiceId,
    sourceLabel: row.sourceLabel,
    durationSec: row.durationSec,
    hasAudition: Boolean(row.auditionWav),
    createdAt: row.createdAt.toISOString(),
  };
}

/** All cloned voices (newest first) — appended to voice pickers. */
export async function listVoiceProfiles(): Promise<
  { id: string; label: string; dto: VoiceProfileDTO }[]
> {
  try {
    const rows = await db.voiceProfile.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row) => ({
      id: row.providerVoiceId, // the value the TTS call needs
      label: `Clone · ${row.name}`,
      dto: toVoiceProfileDTO(row),
    }));
  } catch {
    return []; // DB hiccup must not break the voice picker
  }
}

// ───────────────────────── validation helpers ─────────────────────────

/** Display names: keep them short and free of control chars / newlines. */
export function cleanCloneName(raw: string, fallbackSource: string): string {
  const cleaned = raw
    .replace(/[\r\n\t\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  if (cleaned) return cleaned;
  const fromFile = fallbackSource
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return fromFile || `Voice ${new Date().toISOString().slice(0, 10)}`;
}

const BLOCKED_HOST_RE =
  /^(localhost|.+\.local|.+\.localhost|.+\.internal|.+\.lan|metadata\.google\.internal)$/i;

/** Same URL policy as voice.ts imports — public http(s) hosts only. */
export function isValidSampleUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!host || BLOCKED_HOST_RE.test(host)) return false;
    // net-guard's isPrivateHostname is checked at connection time by safeFetch.
    return true;
  } catch {
    return false;
  }
}

// ───────────────────────── audio staging ─────────────────────────

interface AudioProbe {
  duration: number;
  hasAudio: boolean;
}

async function probeAudio(filePath: string): Promise<AudioProbe> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "stream=codec_type",
      "-show_entries", "format=duration",
      "-of", "json",
      filePath,
    ],
    { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }
  );
  const parsed = JSON.parse(stdout.toString()) as {
    streams?: { codec_type?: string }[];
    format?: { duration?: string };
  };
  const duration = Number(parsed.format?.duration ?? 0);
  return {
    duration: Number.isFinite(duration) ? duration : 0,
    hasAudio: Boolean((parsed.streams ?? []).some((s) => s.codec_type === "audio")),
  };
}

/**
 * Validate + normalize a voice sample: mono 24 kHz PCM-16 WAV, trimmed to the
 * first MAX_SAMPLE_SEC. Returns the processed bytes and the measured duration.
 */
export async function prepareSample(
  raw: Buffer,
  stageExt: string,
): Promise<{ wav: Buffer; durationSec: number }> {
  if (raw.length < 1000) throw new Error("That file is too small to contain a voice");
  if (raw.length > 200 * 1024 * 1024)
    throw new Error("That file is enormous — trim it to the 3-30 seconds you want cloned");

  const dir = path.join(os.tmpdir(), `tubeforge-clone-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  const ext = /^\.[a-z0-9]{1,5}$/i.test(stageExt) ? stageExt : ".bin";
  const staged = path.join(dir, `sample${ext}`);
  // NEVER the same path as `staged` — a .wav source would make ffmpeg read and
  // write one file ("Error opening output file: Invalid argument").
  const out = path.join(dir, "processed.wav");
  try {
    fs.writeFileSync(staged, raw);

    let probe: AudioProbe;
    try {
      probe = await probeAudio(staged);
    } catch {
      throw new Error("Could not read that file as audio — is it really an mp3/wav/m4a?");
    }
    if (!probe.hasAudio) throw new Error("That file has no audio track");
    if (probe.duration < MIN_SAMPLE_SEC)
      throw new Error(
        `The clip is only ${probe.duration.toFixed(1)}s — a voice clone needs at least ${MIN_SAMPLE_SEC}s`
      );

    // Normalize + cap length in one pass (first MAX_SAMPLE_SEC of the clip).
    try {
      await execFileAsync(
        "ffmpeg",
        [
          "-y",
          "-i", staged,
          "-vn",
          "-ac", "1",
          "-ar", "24000",
          "-c:a", "pcm_s16le",
          "-map", "a:0",
          "-t", String(MAX_SAMPLE_SEC),
          out,
        ],
        { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }
      );
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      throw new Error(
        `ffmpeg could not process the sample: ${(e.stderr ?? e.message ?? "").split("\n").slice(-3).join(" ").slice(0, 250)}`
      );
    }

    const wav = fs.readFileSync(out);
    if (wav.length < 44) throw new Error("Audio processing produced an empty file");
    if (wav.length > MAX_SAMPLE_BYTES)
      throw new Error(
        `The processed sample is ${(wav.length / 1024 / 1024).toFixed(1)} MB — the clone API accepts at most 10 MB; use a shorter clip`
      );

    const finalProbe = await probeAudio(out);
    return { wav, durationSec: Number(finalProbe.duration.toFixed(1)) || probe.duration };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ───────────────────────── Zhipu platform calls ─────────────────────────

async function zhipuConfig() {
  const config = await getCapability("tts");
  if (config.provider !== "zhipu") {
    // The clone API key lives in the zhipu TTS capability — clone buttons are
    // only shown when zhipu is active, so this is defense in depth.
    throw new Error(
      "Voice cloning uses the Zhipu GLM-TTS provider — switch Voiceover to it in Settings → AI Providers first"
    );
  }
  const key = config.apiKey?.trim();
  if (!key)
    throw new Error(
      "Add your bigmodel.cn API key under Settings → AI Providers → Voiceover (Zhipu GLM-TTS) first"
    );
  const meta = providerMeta("tts", "zhipu");
  const baseUrl =
    config.baseUrl?.trim() || meta?.defaultBaseUrl || "https://open.bigmodel.cn/api/paas/v4";
  return { baseUrl, key };
}

/** Download a sample from the public internet (SSRF-guarded like voice.ts). */
async function downloadSample(url: string): Promise<{ buffer: Buffer; filename: string }> {
  const res = await safeFetch(url, {
    timeoutMs: 120_000,
    maxBytes: 200 * 1024 * 1024,
    headers: { "User-Agent": "TubeForge/1.0 (+voice-clone)" },
  });
  if (!res.ok)
    throw new Error(`The site answered ${res.status} ${res.statusText} — check the link`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error("The link returned an empty file");
  let filename = "sample";
  try {
    filename = decodeURIComponent(new URL(res.url || url).pathname.split("/").filter(Boolean).pop() || "sample");
  } catch {
    /* keep default */
  }
  return { buffer, filename: filename.slice(0, 80) };
}

export interface CloneResult {
  profile: VoiceProfileDTO;
  auditionWav: Buffer | null;
}

/**
 * Clone a voice from an uploaded file or a direct audio URL.
 * Throws readable errors — routes surface them straight to the UI.
 */
export async function cloneVoice(opts: {
  source: { kind: "upload"; buffer: Buffer; filename: string } | { kind: "url"; url: string };
  name?: string;
  sampleText?: string; // optional transcript of the sample (improves fidelity)
  auditionText?: string; // what the clone-time preview says
}): Promise<CloneResult> {
  const { baseUrl, key } = await zhipuConfig();

  // 1) Obtain + prepare the sample.
  let raw: Buffer;
  let sourceLabel: string;
  if (opts.source.kind === "upload") {
    raw = opts.source.buffer;
    sourceLabel = opts.source.filename.slice(0, 80) || "uploaded sample";
  } else {
    if (!isValidSampleUrl(opts.source.url))
      throw new Error("That is not a valid http(s) audio link");
    const dl = await downloadSample(opts.source.url);
    raw = dl.buffer;
    sourceLabel = dl.filename;
  }

  const extMatch = /\.[a-z0-9]{1,5}$/i.exec(sourceLabel);
  const { wav, durationSec } = await prepareSample(raw, extMatch?.[0] ?? ".bin");
  const name = cleanCloneName(opts.name ?? "", sourceLabel);

  const authHeaders = { Authorization: `Bearer ${key}` };

  // 2) Upload the sample → file_id (purpose "voice-clone-input").
  const form = new FormData();
  form.append("purpose", "voice-clone-input");
  form.append("file", new Blob([new Uint8Array(wav)]), `${name.replace(/[^\w-]+/g, "_").slice(0, 30) || "sample"}.wav`);

  const upload = await providerFetchJson<{ id?: string; error?: { message?: string } }>(
    "Zhipu voice-clone upload",
    joinUrl(baseUrl, "files"),
    { method: "POST", headers: authHeaders, body: form }
  );
  const fileId = upload.id;
  if (!fileId)
    throw new Error(
      `The clone API did not return a file id${upload.error?.message ? ` (${upload.error.message})` : ""}`
    );

  // 3) Clone → voice id.
  const auditionText = (opts.auditionText ?? "").trim() ||
    `Hi! This is ${name}. If you pick me, this is exactly how I will narrate your videos.`;
  const clone = await providerFetchJson<{
    voice?: string;
    file_id?: string; // purpose "voice-clone-output" — the audition audio
    error?: { message?: string };
  }>("Zhipu GLM-TTS-Clone", joinUrl(baseUrl, "voice/clone"), {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "glm-tts-clone",
      voice_name: `tf_${name.replace(/[^\w\u4e00-\u9fa5-]+/g, "_").slice(0, 30)}_${Date.now().toString(36)}`,
      input: auditionText.slice(0, 500),
      file_id: fileId,
      ...(opts.sampleText?.trim() ? { text: opts.sampleText.trim().slice(0, 1000) } : {}),
      request_id: randomUUID(),
    }),
  });
  const voiceId = clone.voice;
  if (!voiceId || !voiceId.startsWith("voice_clone_"))
    throw new Error(
      `The clone API did not return a voice id${clone.error?.message ? ` (${clone.error.message})` : ""}`
    );

  // 4) Best-effort: fetch the audition WAV it generated (small, cached on the row).
  let auditionWav: Buffer | null = null;
  if (clone.file_id) {
    try {
      const res = await providerFetch(
        "Zhipu voice-clone audition",
        joinUrl(baseUrl, "files", clone.file_id, "content"),
        { method: "GET", headers: authHeaders }
      );
      const buf = Buffer.from(new Uint8Array(await res.arrayBuffer()));
      if (buf.length > 44 && buf.length <= MAX_AUDITION_BYTES) auditionWav = buf;
    } catch {
      /* audition is a bonus — the profile works without it */
    }
  }

  // 5) Persist the profile.
  const row = await db.voiceProfile.create({
    data: {
      name,
      provider: "zhipu",
      providerVoiceId: voiceId,
      sourceLabel,
      durationSec,
      auditionWav: auditionWav ? auditionWav.toString("base64") : null,
    },
  });

  return { profile: toVoiceProfileDTO(row), auditionWav };
}

/** Delete a cloned voice locally + best-effort on the platform. */
export async function deleteVoiceProfile(id: string): Promise<boolean> {
  const row = await db.voiceProfile.findUnique({ where: { id } });
  if (!row) return false;

  // Platform-side delete is best-effort: a 4xx there (wrong key, already gone)
  // must not block removing the local profile.
  if (row.provider === "zhipu") {
    try {
      const { baseUrl, key } = await zhipuConfig();
      await providerFetchJson("Zhipu voice delete", joinUrl(baseUrl, "voice/delete"), {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ voice: row.providerVoiceId, request_id: randomUUID() }),
      });
    } catch (err) {
      console.warn(`voice-clone: platform delete failed for ${row.providerVoiceId}: ${errorText(err, "unknown")}`);
    }
  }

  await db.voiceProfile.delete({ where: { id } });
  return true;
}

/** Fetch the cached audition WAV for a profile (clone-time preview). */
export async function getAuditionWav(id: string): Promise<Buffer | null> {
  const row = await db.voiceProfile.findUnique({ where: { id } });
  if (!row?.auditionWav) return null;
  try {
    return Buffer.from(row.auditionWav, "base64");
  } catch {
    return null;
  }
}

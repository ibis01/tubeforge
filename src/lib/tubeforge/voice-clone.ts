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
import { log } from "./log";

// S57/T-57.2 — the module's logger (the old voice-clone: prefixes became bindings).
const vcLog = log.child({ mod: "voice-clone" });
import { db } from "./tenant-db";
import { currentCtx, withCtx, type TenantCtx } from "./tenant";
import { getProviderCredential } from "./providers/settings";
import { providerMeta } from "./providers/registry";
import { joinUrl, providerFetch, providerFetchJson } from "./providers/http";
import { safeFetch } from "./net-guard";
import { errorText } from "./redact";
import { selfhostEndpoint, sharedVoiceServer } from "./shared-voice";

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
  /** S121 consent ledger — has the uploader recorded a basis claim? */
  hasConsent: boolean;
  consentBasis: string | null;
  createdAt: string;
}

/** Providers that can clone a voice from an uploaded sample.
 *  zhipu       — the sample goes to the Zhipu GLM-TTS-Clone platform
 *  selfhost    — the (normalized) sample is stored on the VoiceProfile row and
 *                re-sent to the user's voice_server.py on every synthesis
 *  voicestudio — S121 — the sample registers with the user's VoiceStudio
 *                server (ref_audio → an 8-hex profile id stored on the row as
 *                remoteVoiceId); the sample is ALSO kept locally so the row
 *                stays speakable after re-cloning/re-registration. */
export const CLONE_PROVIDERS = ["zhipu", "selfhost", "voicestudio"] as const;
export type CloneProvider = (typeof CLONE_PROVIDERS)[number];

export function isCloneProvider(provider: string): provider is CloneProvider {
  return (CLONE_PROVIDERS as readonly string[]).includes(provider);
}

/** S121 — the consent vocabulary a clone MUST carry (the VoiceStudio-verified
 *  model, adopted as TubeForge policy: a clone record states WHOSE voice it
 *  is and on what basis the uploader claims the right to clone it). The
 *  vocabulary is CLOSED — anything else is refused by name. */
export const CONSENT_BASES = ["own_voice", "speaker_permission"] as const;
export type ConsentBasis = (typeof CONSENT_BASES)[number];

export function isConsentBasis(v: string): v is ConsentBasis {
  return (CONSENT_BASES as readonly string[]).includes(v);
}

/**
 * Pick the clone-capable provider to use for a fresh clone, regardless of
 * which TTS provider is currently "active". Order of preference:
 *   1. selfhost — the user's OWN server (saved URL): free Chatterbox, no
 *      network call at clone time (the sample is stored on the row).
 *   2. zhipu   — if it has a saved bigmodel.cn key (the clone API needs it).
 *   3. the operator's shared voice server (TUBEFORGE_SHARED_VOICE_URL) —
 *      self-hosted deployments and sandboxes can run ONE Chatterbox server
 *      for all their users; cloning and synthesis work with zero per-user
 *      setup.
 *   4. selfhost unconditionally — even with no server configured the clone
 *      succeeds (sample stored); the server URL+key can be supplied later
 *      at voiceover generation.
 *
 * Returns the chosen provider and a one-line status the UI can show inline.
 */
export async function pickCloneProvider(): Promise<{
  provider: CloneProvider;
  /** "ready" — fully configured, "needs-setup" — clone works but synth will
   *  fail until URL/key are supplied, "zhipu-ready" / "voicestudio-ready" —
   *  the respective platform/server is configured. */
  status: "ready" | "needs-setup" | "zhipu-ready" | "voicestudio-ready";
  /** Human-readable reason for the status, surfaced in the UI. */
  hint: string;
}> {
  // Prefer the user's own selfhost server — the clone itself needs no
  // server, and synthesis uses their saved credentials.
  const selfhostCred = await getProviderCredential("tts", "selfhost");
  if (selfhostCred?.baseUrl?.trim()) {
    return {
      provider: "selfhost",
      status: "ready",
      hint: "Clones speak through your self-hosted Chatterbox server.",
    };
  }
  // Zhipu with a saved key can clone + synthesize immediately.
  const zhipuCred = await getProviderCredential("tts", "zhipu");
  if (zhipuCred?.apiKey?.trim()) {
    return {
      provider: "zhipu",
      status: "zhipu-ready",
      hint: "Clones use your Zhipu GLM-TTS account.",
    };
  }
  // S121 — a configured VoiceStudio server can register the sample (ref_audio
  // → an 8-hex profile id) and speak every registered voice.
  const vsCred = await getProviderCredential("tts", "voicestudio");
  if (vsCred?.baseUrl?.trim() || vsCred?.apiKey?.trim()) {
    return {
      provider: "voicestudio",
      status: "voicestudio-ready",
      hint: "Clones register with your VoiceStudio server.",
    };
  }
  // The operator's shared voice server: clone + synthesize work with zero
  // per-user setup (sandbox / self-hosted deployments).
  if (sharedVoiceServer()) {
    return {
      provider: "selfhost",
      status: "ready",
      hint: "Clones speak through this platform's shared voice server.",
    };
  }
  // Nothing configured yet — default to selfhost; the clone succeeds (sample
  // stored locally), and the user supplies the server URL+key before synth.
  return {
    provider: "selfhost",
    status: "needs-setup",
    hint:
      "The clone is saved now — paste your self-hosted server URL + key to synthesize, " +
      "or add a Zhipu GLM-TTS key.",
  };
}

/** The server-registered voice id for a cloned voice (S121 — VoiceStudio
 *  rows carry the server's own 8-hex profile id in remoteVoiceId; zhipu rows
 *  speak their providerVoiceId directly). Null when the row predates the
 *  field or the voice isn't a stored clone. */
export async function voiceProfileRemoteVoiceId(voiceId: string): Promise<string | null> {
  try {
    const row = await db.voiceProfile.findFirst({
      where: { providerVoiceId: voiceId },
      select: { provider: true, remoteVoiceId: true },
    });
    if (!row || row.provider !== "voicestudio") return null;
    return row.remoteVoiceId ?? null;
  } catch {
    return null;
  }
}

/**
 * Look up the provider that owns a cloned voice id (the VoiceProfile row's
 * `provider`). Used by ttsSynthesize to route a cloned-voice request to the
 * right backend even when the active TTS provider isn't that provider — so a
 * user with active Z.ai can still synthesize a self-host clone without first
 * flipping Settings.
 *
 * Returns null when the voice id isn't a stored clone (stock studio voice,
 * unknown id, or DB hiccup).
 */
export async function voiceProfileProvider(
  voiceId: string,
): Promise<CloneProvider | null> {
  try {
    const row = await db.voiceProfile.findFirst({
      where: { providerVoiceId: voiceId },
      select: { provider: true },
    });
    if (!row || !isCloneProvider(row.provider)) return null;
    return row.provider;
  } catch {
    return null;
  }
}

export function toVoiceProfileDTO(row: {
  id: string;
  name: string;
  provider: string;
  providerVoiceId: string;
  sourceLabel: string | null;
  durationSec: number | null;
  auditionWav: string | null;
  consentText?: string | null;
  consentBasis?: string | null;
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
    // S121 consent ledger — the recorded basis claim (null = not recorded;
    // legacy rows keep null and the ledger grows as users fill it in).
    hasConsent: Boolean(row.consentText),
    consentBasis: row.consentBasis ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** All cloned voices (newest first) — appended to voice pickers.
 *  Pass a provider to scope to the profiles it can actually speak. */
export async function listVoiceProfiles(
  provider?: string,
): Promise<
  { id: string; label: string; dto: VoiceProfileDTO }[]
> {
  try {
    const rows = await db.voiceProfile.findMany({
      where: { isActive: true, ...(provider ? { provider } : {}) },
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
  // The active TTS provider may not be zhipu — clones can be requested inline
  // from the video dialog while the active voiceover is Z.ai. Read the saved
  // zhipu credential directly instead of requiring the active provider.
  const cred = await getProviderCredential("tts", "zhipu");
  const key = cred?.apiKey?.trim();
  if (!key)
    throw new Error(
      "Add your bigmodel.cn API key under Settings → AI Providers → Voiceover (Zhipu GLM-TTS) first"
    );
  const meta = providerMeta("tts", "zhipu");
  const baseUrl =
    cred?.baseUrl?.trim() || meta?.defaultBaseUrl || "https://open.bigmodel.cn/api/paas/v4";
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
  /** true when the audition is being synthesized in the BACKGROUND (self-
   *  hosted clones on CPU-bound voice servers) — the UI polls
   *  GET /api/voices/{id}/audition until it lands instead of blocking. */
  auditionPending?: boolean;
}

/** What the clone-time preview says. Kept SHORT on purpose: the preview is
 *  synthesized on the user's voice server, and on a CPU-only box every extra
 *  second of speech costs ~5-8s of wall time. (~4s of audio.) */
function defaultAuditionLine(name: string): string {
  return `Hi, I'm ${name} — your new narrator.`;
}

/** Profiles whose background audition is currently synthesizing — dedups
 *  duplicate schedules (and survives dev hot reloads via globalThis). */
function auditionInFlight(): Set<string> {
  const g = globalThis as typeof globalThis & { __tfCloneAuditions?: Set<string> };
  g.__tfCloneAuditions ??= new Set<string>();
  return g.__tfCloneAuditions;
}

/**
 * Synthesize + cache a profile's clone-time audition WITHOUT blocking the
 * clone response. Fire-and-forget: the caller already answered 200; this
 * runs detached, tenant-scoped (withCtx — the row update goes to the right
 * organization), and deduped. Failures are logged and dropped — a profile
 * without a cached preview still works everywhere (the pickers' ▶ preview
 * synthesizes fresh TTS on demand).
 *
 * The generous 10-minute timeout is deliberate: CPU-bound synthesis
 * legitimately runs minutes on small machines, and requests queue behind
 * whatever already holds the server's single-model lock.
 */
function scheduleBackgroundAudition(opts: {
  profileId: string;
  sampleB64: string;
  text: string;
  baseUrl: string;
  apiKey: string;
  ctx: TenantCtx;
}): void {
  const inFlight = auditionInFlight();
  if (inFlight.has(opts.profileId)) return;
  inFlight.add(opts.profileId);
  const startedAt = Date.now();
  void withCtx(opts.ctx, async () => {
    try {
      const res = await providerFetch(
        "Self-hosted voice server",
        joinUrl(opts.baseUrl, "tts"),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(opts.apiKey ? { "X-Voice-Key": opts.apiKey } : {}),
          },
          body: JSON.stringify({ text: opts.text, voice: opts.sampleB64, speed: 1 }),
        },
        { timeoutMs: 600_000 },
      );
      const buf = Buffer.from(new Uint8Array(await res.arrayBuffer()));
      if (buf.length > 44 && buf.length <= MAX_AUDITION_BYTES) {
        await db.voiceProfile.update({
          where: { id: opts.profileId },
          data: { auditionWav: buf.toString("base64") },
        });
        vcLog.info(
          "background audition ready",
          { profileId: opts.profileId, elapsedSec: Number(((Date.now() - startedAt) / 1000).toFixed(1)) }
        );
      }
    } catch (err) {
      vcLog.warn(
        "background audition failed",
        { profileId: opts.profileId, err: errorText(err, "unknown") }
      );
    } finally {
      inFlight.delete(opts.profileId);
    }
  }).catch(() => {
    /* never reject an already-answered request's background task */
  });
}

/**
 * Clone a voice from an uploaded file or a direct audio URL.
 * Throws readable errors — routes surface them straight to the UI.
 * S121: opts.consent records WHOSE voice this is and the basis of the
 * uploader's claim (the consent ledger — fail-open: an absent consent stays
 * null, cloning is never blocked by it).
 */
export async function cloneVoice(opts: {
  source: { kind: "upload"; buffer: Buffer; filename: string } | { kind: "url"; url: string };
  name?: string;
  sampleText?: string; // optional transcript of the sample (improves fidelity)
  auditionText?: string; // what the clone-time preview says
  provider: CloneProvider; // which clone pipeline to use
  consent?: { text: string; basis: string }; // S121 consent ledger
}): Promise<CloneResult> {
  if (opts.provider === "selfhost") return cloneVoiceSelfhost(opts);
  if (opts.provider === "voicestudio") return cloneVoiceVoicestudio(opts);
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
  const auditionText = (opts.auditionText ?? "").trim() || defaultAuditionLine(name);
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

  // 5) Persist the profile — S121: the consent ledger rides every clone.
  const cloneCtx = currentCtx();
  if (!cloneCtx) throw new Error("Voice cloning requires a signed-in user");
  const row = await db.voiceProfile.create({
    data: {
      organizationId: cloneCtx.organizationId,
      name,
      provider: "zhipu",
      providerVoiceId: voiceId,
      sourceLabel,
      durationSec,
      auditionWav: auditionWav ? auditionWav.toString("base64") : null,
      // S121 consent ledger — every clone records WHOSE voice it is and the
      // uploader's basis claim (fail-open: an absent consent stays null).
      ...(opts.consent
        ? {
            consentText: opts.consent.text.slice(0, 2000),
            consentBasis: opts.consent.basis,
            consentRecordedAt: new Date(),
          }
        : {}),
    },
  });

  return { profile: toVoiceProfileDTO(row), auditionWav };
}

/**
 * Can this cloned voice actually SPEAK right now? True when its owning
 * provider has working credentials: a selfhost row needs the user's server
 * URL or the operator's shared voice server; a zhipu row needs the key.
 * Drives the ▶ preview gate so a clone that can't synthesize shows a clear
 * error instead of silently falling back to a stock voice.
 */
export async function cloneSynthesisAvailable(voiceId: string): Promise<boolean> {
  try {
    const row = await db.voiceProfile.findFirst({
      where: { providerVoiceId: voiceId, isActive: true },
      select: { provider: true },
    });
    if (!row || !isCloneProvider(row.provider)) return false;
    if (row.provider === "selfhost") {
      const cred = await getProviderCredential("tts", "selfhost");
      return Boolean(cred?.baseUrl?.trim() || sharedVoiceServer());
    }
    if (row.provider === "voicestudio") {
      // S121 — speakable when the server is configured (its registration id
      // rides the row; the speech call carries the server's own voice id).
      const cred = await getProviderCredential("tts", "voicestudio");
      return Boolean(cred?.baseUrl?.trim() || cred?.apiKey?.trim());
    }
    const zhipu = await getProviderCredential("tts", "zhipu");
    return Boolean(zhipu?.apiKey?.trim());
  } catch {
    return false;
  }
}

/**
 * S121 — the VoiceStudio clone path: the normalized sample registers with
 * the user's server (the audited voice-profiles API: ref_audio upload → an
 * 8-hex profile id) and the row stores that id in remoteVoiceId. The sample
 * is ALSO kept locally (sampleWav) so the row survives server re-registration
 * and can be re-registered later. The clone FAILS READABLY when no server is
 * configured — unlike selfhost, there is no "clone now, configure later":
 * registration IS the clone. Best-effort background audition skipped (the
 * server's own voice page previews it). The consent ledger rides here too.
 */
async function cloneVoiceVoicestudio(opts: {
  source: { kind: "upload"; buffer: Buffer; filename: string } | { kind: "url"; url: string };
  name?: string;
  sampleText?: string;
  consent?: { text: string; basis: string };
}): Promise<CloneResult> {
  const cred = await getProviderCredential("tts", "voicestudio");
  const meta = providerMeta("tts", "voicestudio");
  const baseUrl = cred?.baseUrl?.trim() || meta?.defaultBaseUrl || "http://127.0.0.1:3900";
  const key = cred?.apiKey?.trim();
  if (!cred?.baseUrl?.trim() && !key)
    throw new Error(
      "VoiceStudio cloning needs your server — paste its URL (+ key for remote hosts) under Settings → AI Providers → Voiceover"
    );

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

  const cloneCtx = currentCtx();
  if (!cloneCtx) throw new Error("Voice cloning requires a signed-in user");

  // Register with the server: multipart ref_audio → the audited voice
  // profile id (8-hex). A refusal here surfaces the server's own message.
  const headers: Record<string, string> = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const form = new FormData();
  form.append("ref_audio", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "reference.wav");
  form.append("name", name.slice(0, 60));
  const register = await providerFetchJson<{ id?: string; detail?: string }>(
    "VoiceStudio voice registration",
    joinUrl(baseUrl, "profiles"),
    { method: "POST", headers, body: form },
    { capability: "tts" },
  );
  const remoteVoiceId = register.id?.trim() || null;
  if (!remoteVoiceId)
    throw new Error(
      `VoiceStudio did not return a profile id${register.detail ? ` (${register.detail.slice(0, 160)})` : ""}`
    );

  const row = await db.voiceProfile.create({
    data: {
      organizationId: cloneCtx.organizationId,
      name,
      provider: "voicestudio",
      providerVoiceId: `voice_clone_vs_${Date.now().toString(36)}${randomUUID().slice(0, 6)}`,
      sourceLabel,
      durationSec,
      sampleWav: wav.toString("base64"),
      auditionWav: null,
      // S121 — the server's 8-hex profile id: the voice value spoken on the
      // wire (voicestudioTts passes the server's voice ids verbatim).
      remoteVoiceId,
      ...(opts.consent
        ? {
            consentText: opts.consent.text.slice(0, 2000),
            consentBasis: opts.consent.basis,
            consentRecordedAt: new Date(),
          }
        : {}),
    },
  });
  return { profile: toVoiceProfileDTO(row), auditionWav: null, auditionPending: false };
}

/**
 * Self-hosted "clone": there is no platform call — validate + normalize the
 * sample exactly like the Zhipu path (mono 24 kHz PCM-16 WAV, ≤30 s), store it
 * base64 on the row, and mint a voice_clone_… id. Every synthesis then POSTs
 * the sample to the user's voice_server.py (Chatterbox), which speaks in that
 * voice. Voice samples never leave the user's machine beyond their own server.
 *
 * The profile is created IMMEDIATELY — cloning itself is instant. The
 * clone-time audition (so the user hears the voice speak the moment the clone
 * lands) is synthesized in the BACKGROUND when a voice server is reachable:
 * CPU-bound Chatterbox can take minutes under load, and blocking the clone
 * response on it was the #1 source of "cloning is slow". The UI polls
 * GET /api/voices/{id}/audition and swaps the preview in when it arrives.
 */
async function cloneVoiceSelfhost(opts: {
  source: { kind: "upload"; buffer: Buffer; filename: string } | { kind: "url"; url: string };
  name?: string;
  auditionText?: string;
  consent?: { text: string; basis: string }; // S121 consent ledger
}): Promise<CloneResult> {
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

  const cloneCtx = currentCtx();
  if (!cloneCtx) throw new Error("Voice cloning requires a signed-in user");
  const row = await db.voiceProfile.create({
    data: {
      organizationId: cloneCtx.organizationId,
      name,
      provider: "selfhost",
      providerVoiceId: `voice_clone_sh_${Date.now().toString(36)}${randomUUID().slice(0, 6)}`,
      sourceLabel,
      durationSec,
      sampleWav: wav.toString("base64"),
      auditionWav: null,
      // S121 consent ledger — same law as every clone path.
      ...(opts.consent
        ? {
            consentText: opts.consent.text.slice(0, 2000),
            consentBasis: opts.consent.basis,
            consentRecordedAt: new Date(),
          }
        : {}),
    },
  });

  // Best-effort clone-time audition, now in the background: if a voice
  // server is reachable (the user's own or the operator's shared one), have
  // the clone speak a short line so the profile carries a playable preview.
  // No server → nothing to synthesize with; the profile works regardless.
  const cred = await getProviderCredential("tts", "selfhost");
  const ep = selfhostEndpoint(cred?.baseUrl, cred?.apiKey);
  if (ep) {
    scheduleBackgroundAudition({
      profileId: row.id,
      sampleB64: wav.toString("base64"),
      text:
        (opts.auditionText ?? "").trim().slice(0, 180) || defaultAuditionLine(name),
      baseUrl: ep.baseUrl,
      apiKey: ep.apiKey,
      ctx: cloneCtx,
    });
    return { profile: toVoiceProfileDTO(row), auditionWav: null, auditionPending: true };
  }
  return { profile: toVoiceProfileDTO(row), auditionWav: null, auditionPending: false };
}

/** The stored sample (base64) for a cloned voice — self-hosted synthesis
 *  sends it to the user's voice server on every call. */
export async function getSampleWavByVoiceId(voiceId: string): Promise<string | null> {
  try {
    const row = await db.voiceProfile.findFirst({
      where: { providerVoiceId: voiceId },
      select: { sampleWav: true },
    });
    return row?.sampleWav ?? null;
  } catch {
    return null;
  }
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
      vcLog.warn("platform delete failed", { providerVoiceId: row.providerVoiceId, err: errorText(err, "unknown") });
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

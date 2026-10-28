// Background-music library & mixing engine.
//
// Design goals (from the product spec):
//   1. A real, metadata-backed library — every track carries its license record
//      (type, source, commercial-use, attribution, evidence, Content ID notes)
//      so a monetized upload can always prove its soundtrack is safe.
//   2. TubeForge-original beds are SYNTHESIZED in-app from pure oscillators —
//      zero third-party samples, zero Content ID risk, fully loopable.
//   3. Users can upload their OWN licensed tracks (YouTube Audio Library,
//      CC, commercial licenses) with full attribution metadata.
//   4. Auto mood-matching: the video's niche maps to mood tags; the engine
//      picks the best active track (longest match, prefers loop-free fits).
//   5. The mix (loop, trim, volume, fades, ducking, loudnorm) is pure FFmpeg —
//      the original voiceover WAV and the track file stay separate assets, so
//      changing the soundtrack never regenerates the narration.
//
// The render pipeline falls back to the inline per-niche drone (render.ts
// MUSIC_PROFILES) when no active track matches — the beat never drops.

import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { db } from "@/lib/db";
import type { MusicTrack } from "@prisma/client";

const execFileAsync = promisify(execFile);

async function getSetting(key: string): Promise<string | null> {
  const row = await db.setting.findUnique({ where: { key } });
  return row?.value ?? null;
}

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");
export const MUSIC_DIR = path.join(UPLOAD_ROOT, "_music");
export const MAX_TRACK_BYTES = 60 * 1024 * 1024; // 60 MB upload cap
const TRACK_DURATION_SEC = 60; // original beds — loops seamlessly via 1/60-quantized cycles

// ---------------------------------------------------------------------------
// Settings (Setting-table keys, applied when a video has no override)
// ---------------------------------------------------------------------------

export interface MusicSettings {
  enabled: boolean; // music on/off by default
  mode: "auto" | "manual"; // auto = mood-match by niche; manual = fixed track
  trackId: string | null; // used when mode === "manual"
  volume: number; // 0..1 slider (mapped onto the bed gain)
  fadeInSec: number;
  fadeOutSec: number;
}

const DEFAULT_SETTINGS: MusicSettings = {
  enabled: true,
  mode: "auto",
  trackId: null,
  volume: 0.5,
  fadeInSec: 1.5,
  fadeOutSec: 2.5,
};

export async function getMusicSettings(): Promise<MusicSettings> {
  const [enabled, mode, trackId, volume, fadeIn, fadeOut] = await Promise.all([
    getSetting("music.enabled"),
    getSetting("music.mode"),
    getSetting("music.trackId"),
    getSetting("music.volume"),
    getSetting("music.fadeInSec"),
    getSetting("music.fadeOutSec"),
  ]);
  return {
    enabled: enabled === null ? DEFAULT_SETTINGS.enabled : enabled === "true",
    mode: mode === "manual" ? "manual" : "auto",
    trackId: trackId || null,
    volume: Number.isFinite(Number(volume)) && volume !== null ? Number(volume) : DEFAULT_SETTINGS.volume,
    fadeInSec: Number.isFinite(Number(fadeIn)) && fadeIn !== null ? Number(fadeIn) : DEFAULT_SETTINGS.fadeInSec,
    fadeOutSec: Number.isFinite(Number(fadeOut)) && fadeOut !== null ? Number(fadeOut) : DEFAULT_SETTINGS.fadeOutSec,
  };
}

// ---------------------------------------------------------------------------
// DTO + helpers
// ---------------------------------------------------------------------------

export interface MusicTrackDTO {
  id: string;
  name: string;
  moods: string[];
  genre: string | null;
  durationSec: number;
  fileSizeBytes: number;
  isOriginal: boolean;
  license: {
    type: string;
    sourceUrl: string | null;
    commercialUse: boolean;
    attributionRequired: boolean;
    attributionText: string | null;
    licenseEvidence: string | null;
    downloadedAt: string;
    contentIdNotes: string | null;
  };
  isActive: boolean;
  previewUrl: string;
  createdAt: string;
}

export function serializeTrack(t: MusicTrack): MusicTrackDTO {
  return {
    id: t.id,
    name: t.name,
    moods: t.moods.split(",").map((m) => m.trim()).filter(Boolean),
    genre: t.genre,
    durationSec: t.durationSec,
    fileSizeBytes: t.fileSizeBytes,
    isOriginal: t.isOriginal,
    license: {
      type: t.licenseType,
      sourceUrl: t.sourceUrl,
      commercialUse: t.commercialUse,
      attributionRequired: t.attributionRequired,
      attributionText: t.attributionText,
      licenseEvidence: t.licenseEvidence,
      downloadedAt: t.downloadedAt.toISOString(),
      contentIdNotes: t.contentIdNotes,
    },
    isActive: t.isActive,
    previewUrl: `/api/music/${t.id}/audio`,
    createdAt: t.createdAt.toISOString(),
  };
}

export function trackAbsolutePath(t: MusicTrack): string {
  return path.join(UPLOAD_ROOT, t.filePath);
}

async function probeDuration(filePath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "json", filePath],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }
    );
    const d = Number((JSON.parse(stdout.toString()) as { format?: { duration?: string } }).format?.duration ?? 0);
    return Number.isFinite(d) ? d : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Original synthesized library
// ---------------------------------------------------------------------------

/** Niche → mood tags for the auto-selection engine. */
export const NICHE_MOODS: Record<string, string[]> = {
  Motivation: ["motivation", "uplifting"],
  "Fun Facts": ["funfacts", "bright"],
  History: ["history", "epic"],
  Finance: ["finance", "minimal"],
  Psychology: ["psychology", "soft"],
  "Space & Science": ["space", "airy"],
  Technology: ["technology", "clean"],
  Mysteries: ["mysteries", "dark"],
};

interface OriginalTrackDef {
  slug: string;
  name: string;
  moods: string[];
  genre: string;
  /** Stacked sine partials (Hz, gain) — chord A. */
  partials: [freq: number, gain: number][];
  /** Chord B = chord A transposed by this ratio; A↔B breathing cycle (s). */
  moveRatio: number;
  cycleSec: number;
  /** Breathing LFO cycles per 60 s (must divide 60 for a seamless loop). */
  lfoCycles60: number;
  lowpassHz: number;
  /** Detune between L/R channels in cents — stereo width via slow beating. */
  detuneCents: number;
  /**
   * Optional melodic layer — a step-sequenced arpeggio over the pad. Notes
   * play in fixed slots (slot i at phase i·stepSec of a notes.length·stepSec
   * cycle, which must divide 60 for a seamless loop), each windowed by a
   * triangular envelope so steps fade in/out instead of clicking.
   */
  arp?: {
    notes: [freq: number, gain: number][];
    stepSec: number; // slot length (one note per slot)
  };
}

/** The in-app original bed catalog. Exported read-only for verification tooling. */
export const ORIGINAL_LIBRARY: OriginalTrackDef[] = [
  {
    slug: "sunrise-drive", name: "Sunrise Drive", moods: ["motivation", "uplifting", "documentary"], genre: "Ambient",
    partials: [[55, 0.05], [110.4, 0.034], [164.8, 0.02], [220.5, 0.012]],
    moveRatio: 1.26, cycleSec: 20, lfoCycles60: 4, lowpassHz: 1000, detuneCents: 3,
  },
  {
    slug: "curiosity-spark", name: "Curiosity Spark", moods: ["funfacts", "bright", "documentary"], genre: "Ambient",
    partials: [[65.4, 0.05], [130.8, 0.032], [196.2, 0.022], [261.8, 0.011]],
    moveRatio: 1.2, cycleSec: 15, lfoCycles60: 6, lowpassHz: 1200, detuneCents: 3.5,
  },
  {
    slug: "empire-ledger", name: "Empire Ledger", moods: ["history", "epic", "documentary"], genre: "Cinematic",
    partials: [[36.7, 0.055], [73.4, 0.036], [110.2, 0.02], [146.9, 0.012]],
    moveRatio: 1.335, cycleSec: 30, lfoCycles60: 3, lowpassHz: 850, detuneCents: 2,
  },
  {
    slug: "cold-numbers", name: "Cold Numbers", moods: ["finance", "minimal", "documentary"], genre: "Minimal",
    partials: [[49.0, 0.05], [98.1, 0.03], [147.0, 0.018]],
    moveRatio: 1.25, cycleSec: 20, lfoCycles60: 3, lowpassHz: 800, detuneCents: 2.5,
  },
  {
    slug: "inner-rooms", name: "Inner Rooms", moods: ["psychology", "soft", "documentary"], genre: "Ambient",
    partials: [[41.2, 0.05], [82.4, 0.033], [123.5, 0.02], [164.8, 0.01]],
    moveRatio: 1.2, cycleSec: 30, lfoCycles60: 4, lowpassHz: 950, detuneCents: 3,
  },
  {
    slug: "orbit-bloom", name: "Orbit Bloom", moods: ["space", "airy", "documentary"], genre: "Ambient",
    partials: [[55.0, 0.05], [82.5, 0.03], [110.0, 0.022], [165.2, 0.01]],
    moveRatio: 1.5, cycleSec: 30, lfoCycles60: 3, lowpassHz: 1100, detuneCents: 2,
  },
  {
    slug: "clean-signal", name: "Clean Signal", moods: ["technology", "clean", "documentary"], genre: "Electronic",
    partials: [[58.3, 0.05], [116.6, 0.03], [174.7, 0.018]],
    moveRatio: 1.26, cycleSec: 15, lfoCycles60: 5, lowpassHz: 1150, detuneCents: 2.5,
  },
  {
    slug: "hollow-chapter", name: "Hollow Chapter", moods: ["mysteries", "dark", "documentary"], genre: "Cinematic",
    partials: [[46.2, 0.05], [69.3, 0.034], [92.6, 0.02], [139.0, 0.012]],
    moveRatio: 1.19, cycleSec: 30, lfoCycles60: 3, lowpassHz: 780, detuneCents: 2,
  },
  {
    slug: "quiet-anchor", name: "Quiet Anchor", moods: ["news", "neutral", "documentary"], genre: "Ambient",
    partials: [[65.4, 0.045], [98.1, 0.028], [130.8, 0.016]],
    moveRatio: 1.22, cycleSec: 20, lfoCycles60: 3, lowpassHz: 900, detuneCents: 2.5,
  },
  {
    slug: "open-archive", name: "Open Archive", moods: ["documentary", "cinematic"], genre: "Cinematic",
    partials: [[55, 0.05], [82.4, 0.03], [110, 0.018], [164.8, 0.01]],
    moveRatio: 1.26, cycleSec: 20, lfoCycles60: 4, lowpassHz: 1000, detuneCents: 3,
  },
  // ---- Musical layer (v2): arpeggio beds with real melodic movement ----
  {
    slug: "momentum-run", name: "Momentum Run", moods: ["motivation", "uplifting", "documentary"], genre: "Ambient",
    // Uplifting A-minor pentatonic climb over the warm Sunrise pad.
    partials: [[55, 0.045], [110.4, 0.03], [164.8, 0.018]],
    moveRatio: 1.26, cycleSec: 20, lfoCycles60: 4, lowpassHz: 1400, detuneCents: 3,
    arp: { notes: [[220, 0.020], [261.6, 0.018], [329.6, 0.016], [440, 0.013], [523.2, 0.011], [440, 0.013], [329.6, 0.016], [261.6, 0.018]], stepSec: 0.5 },
  },
  {
    slug: "neon-pulse", name: "Neon Pulse", moods: ["technology", "clean", "documentary"], genre: "Electronic",
    // Minimal 8th-note pulse — a heartbeat for tech explainers.
    partials: [[58.3, 0.045], [116.6, 0.028], [174.7, 0.016]],
    moveRatio: 1.26, cycleSec: 15, lfoCycles60: 5, lowpassHz: 1300, detuneCents: 2.5,
    arp: { notes: [[110, 0.018], [110, 0.013], [146.8, 0.015], [110, 0.013], [164.8, 0.013], [110, 0.013], [146.8, 0.015], [196, 0.011]], stepSec: 0.5 },
  },
  {
    slug: "masked-waltz", name: "Masked Waltz", moods: ["mysteries", "dark", "documentary"], genre: "Cinematic",
    // Dark F#-minor waltz — three slow beats per bar, unease with grace.
    partials: [[46.2, 0.05], [69.3, 0.032], [92.6, 0.018]],
    moveRatio: 1.19, cycleSec: 30, lfoCycles60: 3, lowpassHz: 1100, detuneCents: 2,
    arp: { notes: [[92.5, 0.016], [138.6, 0.013], [185, 0.011], [110, 0.014], [164.8, 0.011], [207.7, 0.01]], stepSec: 1 },
  },
  {
    slug: "starfield-waltz", name: "Starfield Waltz", moods: ["space", "airy", "documentary"], genre: "Ambient",
    // High airy arpeggio — orbital, weightless, gently sparkling.
    partials: [[55.0, 0.045], [82.5, 0.028], [110.0, 0.02]],
    moveRatio: 1.5, cycleSec: 30, lfoCycles60: 3, lowpassHz: 1500, detuneCents: 2,
    arp: { notes: [[164.8, 0.014], [220, 0.013], [261.6, 0.011], [196, 0.013], [246.9, 0.011], [329.6, 0.01]], stepSec: 1 },
  },
  {
    slug: "market-rhythm", name: "Market Rhythm", moods: ["finance", "minimal", "documentary"], genre: "Minimal",
    // Spare four-beat pulse — steady, businesslike, never busy.
    partials: [[49.0, 0.045], [98.1, 0.028], [147.0, 0.016]],
    moveRatio: 1.25, cycleSec: 20, lfoCycles60: 3, lowpassHz: 1200, detuneCents: 2.5,
    arp: { notes: [[98, 0.016], [98, 0.011], [130.8, 0.013], [116.5, 0.011]], stepSec: 1 },
  },
  {
    slug: "storybook-morning", name: "Storybook Morning", moods: ["funfacts", "bright", "documentary"], genre: "Ambient",
    // Bright plucky C-major run — curious, light-footed, friendly.
    partials: [[65.4, 0.045], [130.8, 0.03], [196.2, 0.02]],
    moveRatio: 1.2, cycleSec: 15, lfoCycles60: 6, lowpassHz: 1500, detuneCents: 3.5,
    arp: { notes: [[261.6, 0.016], [329.6, 0.014], [392, 0.013], [523.2, 0.011], [587.3, 0.01], [523.2, 0.011], [392, 0.013], [329.6, 0.014]], stepSec: 0.5 },
  },
];

/**
 * Build one stereo expression: two chord stacks (A, B) blended with a smooth
 * cos window, breathing LFO, an optional step-sequenced arpeggio, and a
 * slightly detuned right channel for width. All periods are quantized to
 * divisors of the file length so `-stream_loop` loops without a seam.
 * Exported for offline/CI verification of the aevalsrc graphs.
 */
export function bedExpression(def: OriginalTrackDef): string {
  const stack = (ratio: number, detuneCents: number) =>
    def.partials
      .map(([f, g]) => `${g.toFixed(4)}*sin(2*PI*${(f * ratio * Math.pow(2, detuneCents / 1200)).toFixed(3)}*t)`)
      .join("+");
  const lfoRate = (def.lfoCycles60 / TRACK_DURATION_SEC).toFixed(5); // cycles/sec
  const cycleRate = (1 / def.cycleSec).toFixed(5);
  const breath = `(0.82+0.18*sin(2*PI*${lfoRate}*t))`;
  const blend = `(0.5-0.5*cos(2*PI*${cycleRate}*t))`;

  // Arpeggio: note i lives in slot i of a cycle = N·stepSec (must divide 60).
  // Each slot gets a triangular window centred in the slot — a soft pluck
  // that rises and falls inside its own step, so steps never click and
  // neighbours never overlap. mod(t-P, CYC) wraps the phase; abs() distance
  // from the slot centre gives the envelope.
  const arpLayer = (detuneCents: number): string => {
    const arp = def.arp;
    if (!arp) return "0";
    const n = arp.notes.length;
    const cyc = (n * arp.stepSec).toFixed(3);
    const half = (arp.stepSec / 2).toFixed(3);
    return arp.notes
      .map(([f, g], i) => {
        const phase = (i * arp.stepSec).toFixed(3);
        const freq = (f * Math.pow(2, detuneCents / 1200)).toFixed(3);
        return `${g.toFixed(4)}*max(0,1-abs(mod(t-${phase},${cyc})-${half})/${half})*sin(2*PI*${freq}*t)`;
      })
      .join("+");
  };

  const left = `((${stack(1, 0)}+${arpLayer(0)})*(1-${blend})+(${stack(def.moveRatio, 0)}+${arpLayer(0)})*${blend})*${breath}`;
  const right = `((${stack(1, def.detuneCents)}+${arpLayer(def.detuneCents)})*(1-${blend})+(${stack(def.moveRatio, def.detuneCents)}+${arpLayer(def.detuneCents)})*${blend})*${breath}`;
  return `${left}|${right}`;
}

/** Synthesize one original bed as FLAC (loudness-anchored at -16 LUFS). */
async function synthesizeOriginal(def: OriginalTrackDef): Promise<{ filePath: string; durationSec: number; bytes: number }> {
  fs.mkdirSync(MUSIC_DIR, { recursive: true });
  const outPath = path.join(MUSIC_DIR, `${def.slug}.flac`);
  await execFileAsync(
    "ffmpeg",
    [
      "-f", "lavfi", "-t", String(TRACK_DURATION_SEC),
      "-i", `aevalsrc='${bedExpression(def)}':s=48000`,
      "-af", `lowpass=f=${def.lowpassHz},loudnorm=I=-16:TP=-1.5:LRA=11`,
      "-c:a", "flac", "-compression_level", "8",
      "-y", outPath,
    ],
    { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }
  );
  const durationSec = await probeDuration(outPath);
  return { filePath: path.relative(UPLOAD_ROOT, outPath), durationSec, bytes: fs.statSync(outPath).size };
}

// ---------------------------------------------------------------------------
// Bed preview resolution (GET /api/music/preview — "hear it before you pick")
// ---------------------------------------------------------------------------

export interface BedPreviewSource {
  /** Lavfi graph to synthesize live (original beds) — null when file-based. */
  graph: string | null;
  /** Absolute path of an existing track file to slice — null for presets. */
  file: string | null;
  /** True for the TubeForge-original library (no +6 dB preview boost). */
  isPreset: boolean;
}

/**
 * Resolve a preview source for a bed id — accepts either a MusicTrack row id
 * or an original-bed slug ("sunrise-drive"). Presets resolve to the SAME
 * aevalsrc graph the library synthesizer uses, so the preview is exactly what
 * the video will sound like; uploads resolve to their file for a sliced
 * sample. Returns null when the id is unknown or its file is missing.
 */
export async function resolveBedPreview(idOrSlug: string): Promise<BedPreviewSource | null> {
  const bySlug = ORIGINAL_LIBRARY.find((d) => d.slug === idOrSlug);
  if (bySlug)
    return { graph: `aevalsrc='${bedExpression(bySlug)}':s=48000`, file: null, isPreset: true };

  const row = await db.musicTrack.findUnique({ where: { id: idOrSlug } }).catch(() => null);
  if (!row) return null;

  // Original row (cuid id): recover the slug from the stored file name.
  if (row.isOriginal) {
    const slug = path.basename(row.filePath).replace(/\.(flac|wav)$/i, "");
    const rowDef = ORIGINAL_LIBRARY.find((d) => d.slug === slug);
    if (rowDef)
      return { graph: `aevalsrc='${bedExpression(rowDef)}':s=48000`, file: null, isPreset: true };
  }

  const abs = trackAbsolutePath(row);
  return fs.existsSync(abs) ? { graph: null, file: abs, isPreset: row.isOriginal } : null;
}

/**
 * Materialize the TubeForge-original library (idempotent): any track whose
 * row exists is left alone, missing ones are synthesized. Safe to call from
 * the library GET route and before renders.
 */
export async function seedMusicLibrary(force = false): Promise<{ created: number; skipped: number }> {
  let created = 0;
  let skipped = 0;

  for (const def of ORIGINAL_LIBRARY) {
    const existing = await db.musicTrack.findFirst({ where: { name: def.name, isOriginal: true } });
    if (existing && !force) {
      // Row exists but file vanished (fresh clone / partial cleanup) → re-synthesize.
      if (!fs.existsSync(trackAbsolutePath(existing))) {
        const made = await synthesizeOriginal(def);
        await db.musicTrack.update({ where: { id: existing.id }, data: { ...made, isActive: true } });
        created += 1;
      } else skipped += 1;
      continue;
    }
    if (existing && force) {
      const made = await synthesizeOriginal(def);
      await db.musicTrack.update({ where: { id: existing.id }, data: { ...made, isActive: true } });
      created += 1;
      continue;
    }
    const made = await synthesizeOriginal(def);
    await db.musicTrack.create({
      data: {
        name: def.name,
        moods: def.moods.join(","),
        genre: def.genre,
        durationSec: made.durationSec,
        filePath: made.filePath,
        fileSizeBytes: made.bytes,
        isOriginal: true,
        licenseType: "TubeForge Original (synthesized)",
        commercialUse: true,
        attributionRequired: false,
        licenseEvidence: "Generated in-app from pure sine synthesis — no third-party samples or recordings.",
        contentIdNotes: "None — 100% original synthesis cannot match any Content ID fingerprint.",
        isActive: true,
      },
    });
    created += 1;
  }

  return { created, skipped };
}

// ---------------------------------------------------------------------------
// User uploads
// ---------------------------------------------------------------------------

export interface UploadTrackMeta {
  name: string;
  moods: string;
  genre?: string;
  licenseType: string;
  sourceUrl?: string;
  commercialUse: boolean;
  attributionRequired: boolean;
  attributionText?: string;
  licenseEvidence?: string;
  contentIdNotes?: string;
}

/**
 * Ingest a user-supplied music file: ffprobe-validate it really is audio,
 * transcode to 48 kHz stereo FLAC anchored at -16 LUFS (predictable mixing),
 * register it with its full license record.
 */
export async function ingestUploadedTrack(buffer: Buffer, meta: UploadTrackMeta): Promise<MusicTrack> {
  if (buffer.length < 1000) throw new Error("That file is too small to be real audio");
  if (buffer.length > MAX_TRACK_BYTES) throw new Error(`Track exceeds the ${MAX_TRACK_BYTES / 1024 / 1024} MB limit`);

  fs.mkdirSync(MUSIC_DIR, { recursive: true });
  const tmp = path.join(MUSIC_DIR, `ingest-${Date.now()}`);
  fs.writeFileSync(tmp, buffer);

  try {
    // Must contain an audio stream.
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", tmp],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }
    );
    const streams = (JSON.parse(stdout.toString()) as { streams?: { codec_type?: string }[] }).streams ?? [];
    if (!streams.some((s) => s.codec_type === "audio"))
      throw new Error("That file has no audio track — upload an actual music file");

    const slug = (meta.name || "track")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "track";
    const outPath = path.join(MUSIC_DIR, `${slug}-${Date.now().toString(36)}.flac`);
    await execFileAsync(
      "ffmpeg",
      [
        "-i", tmp,
        "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
        "-ar", "48000", "-ac", "2",
        "-c:a", "flac", "-compression_level", "8",
        "-y", outPath,
      ],
      { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 }
    );

    const durationSec = await probeDuration(outPath);
    if (durationSec <= 0) throw new Error("Could not read the track's duration — file may be corrupt");

    return await db.musicTrack.create({
      data: {
        name: meta.name.slice(0, 80),
        moods: meta.moods.slice(0, 200),
        genre: meta.genre?.slice(0, 60) || null,
        durationSec,
        filePath: path.relative(UPLOAD_ROOT, outPath),
        fileSizeBytes: fs.statSync(outPath).size,
        isOriginal: false,
        licenseType: meta.licenseType.slice(0, 80),
        sourceUrl: meta.sourceUrl?.slice(0, 300) || null,
        commercialUse: meta.commercialUse,
        attributionRequired: meta.attributionRequired,
        attributionText: meta.attributionRequired ? meta.attributionText?.slice(0, 300) || null : null,
        licenseEvidence: meta.licenseEvidence?.slice(0, 300) || null,
        contentIdNotes: meta.contentIdNotes?.slice(0, 300) || null,
        isActive: true,
      },
    });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Auto-selection & render-time resolution
// ---------------------------------------------------------------------------

const moodTagsOf = (t: MusicTrack): string[] =>
  t.moods.toLowerCase().split(",").map((m) => m.trim()).filter(Boolean);

/** Pick the best active track for a niche: tag match, prefer loop-free length. */
export async function autoPickTrack(niche: string | null | undefined, videoDurationSec: number | null): Promise<MusicTrack | null> {
  const tags = new Set(
    (niche && NICHE_MOODS[niche]
      ? NICHE_MOODS[niche]
      : ["documentary", "cinematic"]).concat(["documentary"])
  );
  const active = await db.musicTrack.findMany({ where: { isActive: true } });
  if (active.length === 0) return null;

  const scored = active
    .map((t) => {
      const trackTags = moodTagsOf(t);
      const matches = trackTags.filter((m) => tags.has(m)).length;
      const need = videoDurationSec ?? 0;
      const loopFree = t.durationSec >= need ? 1 : 0;
      return { t, matches, loopFree, duration: t.durationSec };
    })
    .sort((a, b) => b.matches - a.matches || b.loopFree - a.loopFree || b.duration - a.duration);

  return scored.length > 0 && scored[0].matches > 0 ? scored[0].t : active.sort((a, b) => b.durationSec - a.durationSec)[0] ?? null;
}

export interface ResolvedMusic {
  track: MusicTrack;
  gain: number; // linear volume applied to the normalized track
  fadeInSec: number;
  fadeOutSec: number;
  why: string; // human explanation ("auto-matched Motivation → Sunrise Drive")
}

/** Slider (0..1) → linear bed gain. Track is anchored at -16 LUFS pre-gain. */
const sliderToGain = (slider: number) => Math.max(0, Math.min(1, slider)) * 0.3;

/**
 * Resolve the music config for one render:
 *   video.musicEnabled ?? settings.enabled
 *   track = video.musicTrackId (manual per-video) ?? settings.manual track ?? auto-match
 *   gain/fades = per-video overrides ?? settings defaults
 */
export async function resolveMusicForVideo(video: {
  musicEnabled: boolean | null;
  musicTrackId: string | null;
  musicVolume: number | null;
  musicFadeIn: number | null;
  musicFadeOut: number | null;
  niche: string;
  audioDuration: number | null;
}): Promise<ResolvedMusic | null> {
  const settings = await getMusicSettings();
  const enabled = video.musicEnabled ?? settings.enabled;
  if (!enabled) return null;

  let track: MusicTrack | null = null;
  let why = "";

  if (video.musicTrackId) {
    track = await db.musicTrack.findFirst({ where: { id: video.musicTrackId, isActive: true } });
    if (track) why = `pinned track “${track.name}”`;
  }
  if (!track && settings.mode === "manual" && settings.trackId) {
    track = await db.musicTrack.findFirst({ where: { id: settings.trackId, isActive: true } });
    if (track) why = `default track “${track.name}”`;
  }
  if (!track) {
    track = await autoPickTrack(video.niche, video.audioDuration);
    if (track) why = `auto mood-match (${video.niche || "documentary"} → ${moodTagsOf(track)[0] ?? "ambient"})`;
  }
  if (!track) return null; // render falls back to the inline niche drone

  return {
    track,
    gain: sliderToGain(video.musicVolume ?? settings.volume),
    fadeInSec: clampFade(video.musicFadeIn ?? settings.fadeInSec),
    fadeOutSec: clampFade(video.musicFadeOut ?? settings.fadeOutSec),
    why,
  };
}

const clampFade = (v: number) => (Number.isFinite(v) ? Math.min(8, Math.max(0.5, v)) : 1.5);

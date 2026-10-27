// Programmatic SFX library — every sound effect is SYNTHESIZED with ffmpeg
// from oscillators and noise, so the whole catalog is royalty-free by
// construction (no samples to license, no API calls, deterministic output).
//
// Files are rendered once into uploads/_sfx/<kind>.wav (48 kHz stereo PCM16)
// and reused across every render on the machine.
//
//   whoosh — pink-noise swell with a flanged sweep (transitions, speed)
//   boom   — pitch-dropping sine + impact transient (reveals, crashes)
//   riser  — rising sine + noise crescendo (tension before a payoff)
//   sting  — dissonant dual-sine hit with fast decay (twists, rehooks)
//   pop    — tiny filtered blip (light beats, humor)

import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { SFX_KINDS } from "./types";

const execFileAsync = promisify(execFile);

export const SFX_ROOT = path.join(process.cwd(), "uploads", "_sfx");

/** ffmpeg recipe per kind: filter_complex that renders the effect. */
const RECIPES: Record<string, string> = {
  // Pink noise shaped into an airy pass-by; the flanger gives it motion.
  whoosh: [
    "anoisesrc=color=pink:r=48000:amplitude=0.85:duration=0.8,",
    "lowpass=f=2600,",
    "flanger=delay=6:depth=5:regen=35:speed=9:width=50:shape=sinusoidal,",
    "afade=t=in:d=0.26,afade=t=out:st=0.32:d=0.48,",
    "volume=1.9",
  ].join(""),
  // Explosion body: a sine whose pitch falls 110→38 Hz inside a 1.1s decay,
  // plus a white-noise transient for the initial crack.
  boom: [
    "aevalsrc='0.95*sin(2*PI*(110-62*min(t/1.1\\,1))*t)*exp(-2.6*t)':d=1.3,",
    "volume=1.15[body];",
    "anoisesrc=color=white:r=48000:amplitude=0.55:duration=0.09,",
    "lowpass=f=900,volume=1.2[crack];",
    "[body][crack]amix=inputs=2:duration=longest:normalize=0",
  ].join(""),
  // Tension climb: sine glissando up an octave + pink noise crescendo.
  riser: [
    "aevalsrc='0.42*sin(2*PI*(180+520*t/1.4)*t)':d=1.4[tonal];",
    "anoisesrc=color=pink:r=48000:amplitude=0.5:duration=1.4,",
    "afade=t=in:d=1.3,volume=1.3[air];",
    "[tonal][air]amix=inputs=2:duration=longest:normalize=0,",
    "afade=t=out:st=1.15:d=0.25,volume=1.25",
  ].join(""),
  // Dramatic hit: a dissonant minor-second pair (660+699 Hz) with a fast
  // exponential decay and a click transient — classic "plot twist" sting.
  sting: [
    "aevalsrc='0.5*(sin(2*PI*660*t)+sin(2*PI*699*t))*exp(-6.5*t)':d=0.9,",
    "volume=1.1[hit];",
    "anoisesrc=color=white:r=48000:amplitude=0.5:duration=0.03,",
    "highpass=f=1200,volume=1.5[click];",
    "[hit][click]amix=inputs=2:duration=longest:normalize=0",
  ].join(""),
  // Small playful blip — an 880 Hz sine decaying in ~60 ms.
  pop: "aevalsrc='0.8*sin(2*PI*880*t)*exp(-38*t)':d=0.22,volume=1.1",
};

/**
 * Return the path to a synthesized SFX wav, rendering it on first use.
 * Unknown kinds / "none" return null so callers can skip silently.
 */
export async function ensureSfx(kind: string): Promise<string | null> {
  const recipe = RECIPES[kind];
  if (!recipe) return null;

  fs.mkdirSync(SFX_ROOT, { recursive: true });
  const outPath = path.join(SFX_ROOT, `${kind}.wav`);
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) return outPath;

  // Render mono source graph, then resample/upmix on output — keeps every
  // recipe identical in level across the catalog.
  await execFileAsync(
    "ffmpeg",
    [
      "-filter_complex", recipe,
      "-ar", "48000", "-ac", "2",
      "-c:a", "pcm_s16le",
      "-y", outPath,
    ],
    { timeout: 30_000, maxBuffer: 1024 * 1024 }
  ).catch((err) => {
    const e = err as { stderr?: string; message?: string };
    throw new Error(
      `SFX synthesis failed for "${kind}": ${(e.stderr ?? e.message ?? "").split("\n").slice(-4).join(" ").slice(0, 300)}`
    );
  });

  return outPath;
}

/** True when the kind is a real cue (used by prompt validation). */
export function isSfxKind(kind: string): kind is (typeof SFX_KINDS)[number] {
  return (SFX_KINDS as readonly string[]).includes(kind);
}

// Programmatic SFX library — every sound effect is SYNTHESIZED with ffmpeg
// from oscillators and noise, so the whole catalog is royalty-free by
// construction (no samples to license, no API calls, deterministic output).
//
// Files are rendered once into uploads/_sfx/<kind>.wav (48 kHz stereo PCM16)
// and reused across every render on the machine.
//
// Taste rules (the "no foolish sounds" bar):
//   • Everything is LOW and DARK. Nothing above ~700 Hz — bright beeps,
//     dings and blips read as game-show / UI noises, not cinema.
//   • No percussive clicks. Attacks are shaped noise, never raw transients.
//   • Fast decay everywhere — accents must never step on the narration.
//
//   whoosh — pink-noise swell with a flanged sweep (airy pass-by)
//   boom   — pitch-dropping sine + shaped noise attack (reveals, openers)
//   riser  — filtered noise crescendo with a dark tonal undertow (tension)
//   sting  — cinematic braam: dissonant low pair + sub drop (twists, rehooks)
//
// W7 — the WHITEBOARD kinds (S120 §3 W7, decision §10.4: OFF by default,
// event-driven, mixed under the existing bed/VO chain):
//   pen-stroke — a soft shaped-noise scratch (the pen touching down)
//   pen-stop   — a darker, shorter tick (the pen lifting)
//   page-turn  — an airy swish (the board wipe between clean scenes)
//   pop        — a LOW thump (180→70 Hz — the removed 880 Hz UI blip,
//                redesigned to the catalog's taste bar; scene-open accent)

import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { SFX_KINDS } from "./types";
import { runProcess } from "./proc";

const _execFileAsync = promisify(execFile);

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
  // plus a lowpass'd noise thud for the initial weight (no bright crack).
  boom: [
    "aevalsrc='0.95*sin(2*PI*(110-62*min(t/1.1\\,1))*t)*exp(-2.6*t)':d=1.3,",
    "volume=1.15[body];",
    "anoisesrc=color=brown:r=48000:amplitude=0.7:duration=0.14,",
    "lowpass=f=400,volume=1.3[thud];",
    "[body][thud]amix=inputs=2:duration=longest:normalize=0",
  ].join(""),
  // Tension climb: filtered pink-noise crescendo over a dark rising tone
  // (noise-dominant — a bare sine glissando sounds like a cheap theremin).
  riser: [
    "aevalsrc='0.2*sin(2*PI*(110+240*t/1.4)*t)':d=1.4,lowpass=f=500[tonal];",
    "anoisesrc=color=pink:r=48000:amplitude=0.6:duration=1.4,",
    "highpass=f=300,lowpass=f=2400,afade=t=in:d=1.3,volume=1.6[air];",
    "[tonal][air]amix=inputs=2:duration=longest:normalize=0,",
    "afade=t=out:st=1.15:d=0.25,volume=1.2",
  ].join(""),
  // Cinematic braam: a dissonant LOW pair (92 + 97.4 Hz) with a falling sub
  // (55→30 Hz) underneath and a soft filtered-noise bow attack. Replaces the
  // old 660 Hz "ding" which read as a game-show buzzer.
  sting: [
    "aevalsrc='0.55*(sin(2*PI*92*t)+sin(2*PI*97.4*t))*exp(-2.2*t)':d=1.2,",
    "lowpass=f=650,volume=1.1[braam];",
    "aevalsrc='0.5*sin(2*PI*(55-25*min(t/0.9\\,1))*t)*exp(-3.2*t)':d=1.0,",
    "volume=1.15[sub];",
    "anoisesrc=color=brown:r=48000:amplitude=0.5:duration=0.12,",
    "lowpass=f=700,volume=0.9[bow];",
    "[braam][sub][bow]amix=inputs=3:duration=longest:normalize=0",
  ].join(""),
  // W7 — pen-stroke: a soft scratch, shaped noise, nothing bright. Short
  // (180ms) so it accents the touchdown without faking continuous foley.
  "pen-stroke": [
    "anoisesrc=color=pink:r=48000:amplitude=0.5:duration=0.18,",
    "highpass=f=150,lowpass=f=900,",
    "afade=t=in:d=0.02,afade=t=out:st=0.06:d=0.12,",
    "volume=1.6",
  ].join(""),
  // W7 — pen-stop: the lift tick — darker and shorter than the stroke.
  "pen-stop": [
    "anoisesrc=color=brown:r=48000:amplitude=0.4:duration=0.09,",
    "lowpass=f=500,",
    "afade=t=in:d=0.01,afade=t=out:st=0.03:d=0.06,",
    "volume=1.4",
  ].join(""),
  // W7 — page-turn: the board wipe's airy swish (half a second, low-mid).
  "page-turn": [
    "anoisesrc=color=pink:r=48000:amplitude=0.7:duration=0.5,",
    "lowpass=f=1800,",
    "afade=t=in:d=0.12,afade=t=out:st=0.2:d=0.3,",
    "volume=1.5",
  ].join(""),
  // W7 — pop: the REDESIGNED low thump (the removed 880 Hz blip violated
  // the taste bar; this one is a 180→70 Hz drop with a dark noise tap).
  pop: [
    "aevalsrc='0.6*sin(2*PI*(180-110*min(t/0.12\\,1))*t)*exp(-22*t)':d=0.16,",
    "volume=1.2[body];",
    "anoisesrc=color=brown:r=48000:amplitude=0.3:duration=0.03,",
    "lowpass=f=600,volume=0.8[tap];",
    "[body][tap]amix=inputs=2:duration=longest:normalize=0",
  ].join(""),
};

/** W7 — the whiteboard SFX kinds (the recipe table above; NOT in the
 *  director lane's SFX_KINDS — the whiteboard engine consumes them
 *  directly and the prompt validation's vocabulary is unchanged). */
export const WB_SFX_KINDS = ["pen-stroke", "pen-stop", "page-turn", "pop"] as const;
export type WbSfxKind = (typeof WB_SFX_KINDS)[number];

/**
 * Return the path to a synthesized SFX wav, rendering it on first use.
 * Unknown kinds / "none" return null so callers can skip silently.
 * ("pop" was removed from the catalog — its 880 Hz blip read as a UI noise;
 * legacy scenes that still reference it silently skip the cue.)
 */
export async function ensureSfx(kind: string): Promise<string | null> {
  const recipe = RECIPES[kind];
  if (!recipe) return null;

  fs.mkdirSync(SFX_ROOT, { recursive: true });
  const outPath = path.join(SFX_ROOT, `${kind}.wav`);
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) return outPath;

  // Render mono source graph, then resample/upmix on output — keeps every
  // recipe identical in level across the catalog. (Zombie-aware runner —
  // see proc.ts.)
  await runProcess(
    "ffmpeg",
    [
      "-filter_complex", recipe,
      "-ar", "48000", "-ac", "2",
      "-c:a", "pcm_s16le",
      "-y", outPath,
    ],
    { timeoutMs: 30_000 }
  ).catch((err) => {
    throw new Error(
      `SFX synthesis failed for "${kind}": ${String((err as Error).message ?? err).slice(0, 300)}`
    );
  });

  return outPath;
}

/** True when the kind is a real cue (used by prompt validation). */
export function isSfxKind(kind: string): kind is (typeof SFX_KINDS)[number] {
  return (SFX_KINDS as readonly string[]).includes(kind);
}

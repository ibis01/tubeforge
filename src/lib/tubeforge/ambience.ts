// Module E (Stage 5) — the ambient audio bed catalog. Every bed is
// SYNTHESIZED with ffmpeg from noise sources and slow LFOs (the sfx.ts
// doctrine: royalty-free by construction, no samples, deterministic output),
// rendered once into uploads/_ambience/<kind>.wav (48 kHz stereo, 60 s) and
// looped under the narration for as long as the scene runs.
//
// Taste rules (same bar as sfx.ts, adapted for SUSTAINED textures):
//   • Beds sit UNDER the voice — nothing bright carries energy above ~1.2 kHz;
//     the narration lives there.
//   • Slow LFOs only, via the single-input volume filter with eval=frame (the
//     two-input volume2 filter is version-fragile). LFO frequencies are whole
//     divisors of the 60 s render (0.1 / 0.2 Hz) so a loop restarts in-phase.
//   • 60 s per bed: virtually every scene plays straight through with no loop
//     at all, and longer scenes restart on an LFO zero-crossing-ish boundary.
//
//   room  — faint brown-noise air + a 50 Hz mains hum (interior room tone)
//   city  — lowpass traffic rumble with a slow surging swell (distant streets)
//   rain  — steady band-limited noise, the interior rain-on-glass bed
//   wind  — brown noise breathing through a bandpass (open exposure)
//   waves — noise swells with a ~10 s period (shoreline, calm sea)
//   crowd — two low banded-noise layers modulated out of phase (a crowd never
//           breathes as one)
//   nature — airy high shelf over a gentle low bed (open air, implied birds)

import fs from "fs";
import path from "path";
import { runProcess } from "./proc";

export const AMBIENCE_ROOT = path.join(process.cwd(), "uploads", "_ambience");

const BED_SEC = 60;

/** ffmpeg filter_complex recipe per kind. */
const RECIPES: Record<string, string> = {
  // Room tone: very low brown-noise air + a faint mains hum. The quietest
  // bed — it reads as "silence with a floor", which is what interiors need.
  room: [
    "anoisesrc=color=brown:r=48000:amplitude=0.30:duration=60,",
    "lowpass=f=300,volume=0.9[air];",
    "aevalsrc='0.06*sin(2*PI*50*t)':d=60[hum];",
    "[air][hum]amix=inputs=2:duration=first:normalize=0,\n    " +
    "loudnorm=I=-30:TP=-3:LRA=15:linear=true",
  ].join(""),
  // Distant traffic: brown rumble lowpassed hard, with a slow swell so the
  // street passes by instead of sitting like a furnace.
  city: [
    "anoisesrc=color=brown:r=48000:amplitude=0.55:duration=60,",
    "lowpass=f=240[rumble];",
    "[rumble]volume=volume='0.75+0.75*sin(2*PI*0.1*t)':eval=frame,\n    " +
    "loudnorm=I=-30:TP=-3:LRA=15:linear=true",
  ].join(""),
  // Rain on glass: steady white noise, band-limited and darkened — the most
  // legible "weather" bed at low volume, with the gentlest breathing.
  rain: [
    "anoisesrc=color=white:r=48000:amplitude=0.35:duration=60,",
    "highpass=f=180,lowpass=f=1100[drop];",
    "[drop]volume=volume='0.9+0.2*sin(2*PI*0.2*t)':eval=frame,\n    " +
    "loudnorm=I=-30:TP=-3:LRA=15:linear=true",
  ].join(""),
  // Wind: brown noise through a breathing bandpass — gusts, not a drone.
  // pow(sin,2) doubles the fundamental to 0.2 Hz (6 gust cycles per minute).
  wind: [
    "anoisesrc=color=brown:r=48000:amplitude=0.6:duration=60,",
    "bandpass=f=300:w=200[gustsrc];",
    "[gustsrc]volume=volume='0.35+0.65*pow(sin(2*PI*0.1*t)\\,2)':eval=frame,\n    " +
    "loudnorm=I=-30:TP=-3:LRA=15:linear=true",
  ].join(""),
  // Waves: pink noise lowpassed with a ~10 s swell period — reads as a
  // shoreline without any literal water sample.
  waves: [
    "anoisesrc=color=pink:r=48000:amplitude=0.5:duration=60,",
    "lowpass=f=900[sea];",
    "[sea]volume=volume='0.25+0.75*pow(sin(2*PI*0.1*t)\\,2)':eval=frame,\n    " +
    "loudnorm=I=-30:TP=-3:LRA=15:linear=true",
  ].join(""),
  // Crowd murmur: two low banded-noise layers modulated OUT of phase (real
  // crowds never breathe together).
  crowd: [
    "anoisesrc=color=pink:r=48000:amplitude=0.4:duration=60,",
    "bandpass=f=260:w=140[m1];",
    "anoisesrc=color=pink:r=48000:amplitude=0.35:duration=60,",
    "bandpass=f=420:w=160[m2src];",
    "[m2src]volume=volume='0.5+0.5*sin(2*PI*0.1*t+3.14)':eval=frame[m2];",
    "[m1][m2]amix=inputs=2:duration=first:normalize=0,\n    " +
    "loudnorm=I=-30:TP=-3:LRA=15:linear=true",
  ].join(""),
  // Open air: a gentle low bed with a faint airy shelf — generic outdoors.
  nature: [
    "anoisesrc=color=brown:r=48000:amplitude=0.35:duration=60,",
    "lowpass=f=400,volume=0.9[low];",
    "anoisesrc=color=pink:r=48000:amplitude=0.18:duration=60,",
    "highpass=f=1200,lowpass=f=2400[airsrc];",
    "[airsrc]volume=volume='0.5+0.5*sin(2*PI*0.2*t)':eval=frame[air];",
    "[low][air]amix=inputs=2:duration=first:normalize=0,\n    " +
    "loudnorm=I=-30:TP=-3:LRA=15:linear=true",
  ].join(""),
};

/**
 * Return the path to a synthesized ambience wav, rendering it on first use.
 * Unknown kinds / "none" return null so callers skip silently — a bad plan
 * field must never break a render.
 */
export async function ensureAmbience(kind: string): Promise<string | null> {
  const recipe = RECIPES[kind];
  if (!recipe) return null;

  fs.mkdirSync(AMBIENCE_ROOT, { recursive: true });
  const outPath = path.join(AMBIENCE_ROOT, `${kind}.wav`);
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) return outPath;

  // Same level discipline as sfx.ts: render the graph, resample/upmix once.
  await runProcess(
    "ffmpeg",
    [
      "-filter_complex", recipe,
      "-ar", "48000", "-ac", "2",
      "-c:a", "pcm_s16le",
      "-y", outPath,
    ],
    { timeoutMs: 60_000 }
  ).catch((err) => {
    throw new Error(
      `Ambience synthesis failed for "${kind}": ${String((err as Error).message ?? err).slice(0, 300)}`
    );
  });

  return outPath;
}

/** Valid ambience kind? (used by plan validation) */
export function isAmbienceKind(kind: string): boolean {
  return kind in RECIPES;
}

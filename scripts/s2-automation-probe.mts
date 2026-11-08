// Probe 2: the S2 music automation inside the REAL finalize filter chain.
// Builds voiceSplitChain → bedChain → musicLevelAutomation → duckChain → mixTail
// from the actual audiomix.ts builders and runs it through real ffmpeg.
import { execFile } from "child_process";
import { promisify } from "util";
import {
  voiceSplitChain,
  bedChain,
  duckChain,
  mixTail,
  musicLevelAutomation,
} from "../src/lib/tubeforge/audiomix";

const run = promisify(execFile);
const dir = "/tmp/s2probe";

// A base "video" with voice-ish audio (speech-shaped tone bursts).
await run("ffmpeg", [
  "-y", "-v", "error",
  "-f", "lavfi", "-i", "sine=frequency=300:duration=8:sample_rate=48000",
  "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", `${dir}/base.wav`,
]);

// A "music track" (loopable tone).
await run("ffmpeg", [
  "-y", "-v", "error",
  "-f", "lavfi", "-i", "sine=frequency=120:duration=6:sample_rate=48000",
  "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", `${dir}/track.wav`,
]);

// Blended-timeline segments (windows overlap at the seam by 0.5).
const blended = [
  { start: 0, duration: 4.5 },
  { start: 4.0, duration: 4.0 },
];
const factors = [1, 0.4]; // scene 2's bed rides at 40%
const automation = musicLevelAutomation(blended, factors);
console.log("automation chain:", automation);
if (!automation) throw new Error("automation unexpectedly null — factors not uniform?");

const filters = [
  voiceSplitChain(),
  bedChain({ totalSec: 8, gain: 0.18, fadeInSec: 0.5, fadeOutSec: 0.5 }),
  automation,
  duckChain("standard", "mvol"),
  mixTail(1, 1),
].join(";");
console.log("full chain:", filters.replace(/;/g, ";\n  "));

await run("ffmpeg", [
  "-y", "-v", "error",
  "-i", `${dir}/base.wav`,
  "-stream_loop", "-1", "-i", `${dir}/track.wav`,
  "-filter_complex", filters,
  "-map", "[mix]",
  "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2",
  `${dir}/mix.wav`,
]);

// Verify the automation actually attenuated scene 2's bed: measure RMS in
// each window on the bed path in the REAL input layout (base = input 0,
// track = input 1 — the same -i order finalize uses).
const bedOnly = [
  bedChain({ totalSec: 8, gain: 0.18, fadeInSec: 0.5, fadeOutSec: 0.5 }),
  automation,
].join(";");
await run("ffmpeg", [
  "-y", "-v", "error",
  "-i", `${dir}/base.wav`,
  "-stream_loop", "-1", "-i", `${dir}/track.wav`,
  "-filter_complex", bedOnly,
  "-map", "[mvol]",
  "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2",
  `${dir}/bed.wav`,
]);
const rms = async (from: number, to: number) => {
  // INPUT-side seek (-ss before -i): sample-exact on WAV. An output-side
  // seek (-ss after -i) lets every frame reach volumedetect — the probe
  // then reads a whole-file average and the automation looks broken.
  try {
    const { stdout, stderr } = await run("ffmpeg", [
      "-ss", String(from), "-t", String(to - from), "-i", `${dir}/bed.wav`,
      "-af", "volumedetect", "-f", "null", "-",
    ]);
    const m = /mean_volume: ([-\d.]+) dB/.exec(`${stdout}${stderr}`);
    return m ? Number(m[1]) : null;
  } catch (e) {
    const m = /mean_volume: ([-\d.]+) dB/.exec(String(e.stderr ?? ""));
    return m ? Number(m[1]) : null;
  }
};
// Wait for ffmpeg stderr — volumedetect prints to stderr; promisify execFile
// rejects only on nonzero exit, stdout/stderr both returned on success.
const scene1 = await rms(1.0, 3.5); // inside window 1 (factor 1)
const scene2 = await rms(5.0, 7.5); // inside window 2 (factor 0.4)
console.log(`bed RMS window1: ${scene1} dB, window2: ${scene2} dB`);
if (scene1 === null || scene2 === null) throw new Error("volumedetect failed");
const drop = scene1 - scene2;
console.log(`drop: ${drop.toFixed(2)} dB (expected ~20·log10(1/0.4) = ${(-20 * Math.log10(0.4)).toFixed(2)} dB)`);
if (drop < 6.5 || drop > 10.5) throw new Error(`automation drop ${drop.toFixed(2)} dB outside the 0.4× band`);
console.log("PROBE 2 PASS — automation chain valid in real ffmpeg and attenuating per window");

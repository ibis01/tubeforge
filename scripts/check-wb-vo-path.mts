// Whiteboard VO path check: synthesize a scene WAV, run normalizeVoSlot +
// a narrated renderWhiteboard, and confirm the final.mp4 carries an audio
// stream and the loudness window holds. This is the path the s67 proof skips.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scaffoldWhiteboardProject } from "../src/lib/tubeforge/whiteboard/whiteboard-planner";
import { validateWhiteboardProject } from "../src/lib/tubeforge/whiteboard/storyboard";
import { loadLibrary } from "../src/lib/tubeforge/whiteboard/assets";
import { renderWhiteboard, normalizeVoSlot, probeDurationSec } from "../src/lib/tubeforge/whiteboard/render";
import { measureLoudness, LUFS_PASS_WINDOW } from "../src/lib/tubeforge/audiomix";

const execFileP = promisify(execFile);
const OUT = path.resolve("scratch/wb-vo-check");

// Generate a 3s 24kHz mono WAV via ffmpeg sine + a real-ish level, to stand
// in for a TTS slot. The loudness normalizer measures + (re)encodes it.
async function synthWav(file: string, secs = 3): Promise<void> {
  await execFileP("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `sine=frequency=220:duration=${secs}`,
    "-af", "volume=0.3",
    "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le",
    file,
  ]);
}

async function main(): Promise<void> {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // Scaffold + validate a 2-scene project.
  const project = scaffoldWhiteboardProject({
    scenes: [
      { index: 1, title: "Beat one", narration: "The first beat of the voiceover check." },
      { index: 2, title: "Beat two", narration: "The second beat closes the narrated render." },
    ],
    topic: "WB VO check",
  });
  const lib = loadLibrary();
  const { project: valid, errors } = validateWhiteboardProject(project, lib.libraryIndex);
  if (!valid) throw new Error(`scaffold failed validation: ${errors.join(" · ")}`);
  const target = { ...valid, width: 1280, height: 720, fps: 24 };

  // Synthesize a WAV per scene (stands in for TTS scene-NN.wav).
  const voFiles = new Map<string, string>();
  const voNormDir = path.join(OUT, "vo-norm");
  for (const scene of target.scenes) {
    const raw = path.join(OUT, `${scene.id}-raw.wav`);
    await synthWav(raw, 3);
    // The engine's own boundary contract:
    const normed = await normalizeVoSlot(raw, voNormDir, scene.id);
    voFiles.set(scene.id, normed);
    const m = await measureLoudness(normed);
    console.log(`  ${scene.id}: raw→${path.basename(normed)}, LUFS=${m?.integratedLUFS?.toFixed(1) ?? "?"}`);
  }

  console.log("[render] narrated 2-scene render…");
  const t0 = Date.now();
  const result = await renderWhiteboard(target, { outDir: OUT, voFiles });
  const dur = await probeDurationSec(result.file);
  console.log(`  final.mp4: ${dur?.toFixed(1)}s, ${((Date.now() - t0) / 1000).toFixed(1)}s wall`);

  // The real assertions: does final.mp4 carry an audio stream, and is it in window?
  const { stdout } = await execFileP("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", result.file,
  ]);
  const streams = (JSON.parse(stdout).streams ?? []) as { codec_type: string; codec_name: string }[];
  console.log("  streams:", streams.map((s) => `${s.codec_type}:${s.codec_name}`).join(", "));
  const hasAudio = streams.some((s) => s.codec_type === "audio");
  const mFinal = await measureLoudness(result.file);
  console.log(`  final LUFS: ${mFinal?.integratedLUFS?.toFixed(1) ?? "?"} (window ${LUFS_PASS_WINDOW[0]}..${LUFS_PASS_WINDOW[1]})`);

  const ok = hasAudio && mFinal != null &&
    mFinal.integratedLUFS >= LUFS_PASS_WINDOW[0] &&
    mFinal.integratedLUFS <= LUFS_PASS_WINDOW[1];
  console.log(ok ? "\nWHITEBOARD VO PATH GREEN" : "\nWHITEBOARD VO PATH FAILED");
  if (!ok) process.exit(1);
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });

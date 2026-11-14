#!/usr/bin/env node
/**
 * W4 slice 3 — the voice-anchor proof (S120 §3 W4's alignment exit pin).
 *
 * The roadmap pin: "anchor alignment tolerance pinned; |beatWindow −
 * speechRun| ≤ tolerance on fixture WAVs". This script builds a fixture VO
 * whose speech structure is KNOWN BY CONSTRUCTION (three gated tone bursts
 * — 1.1s of 440 Hz at exact times, digital silence between), runs the
 * captions lane's alignment through the whiteboard's voice-anchor bridge,
 * and pins the sentence windows against the measured speech runs. Then it
 * renders the scene through the REAL engine twice — the estimator (flag
 * off) and the anchored schedule (flag on, the production caller's shape)
 * — and runs the full house QC battery on the anchored render.
 *
 * The honest ladder shape on this fixture: the ASR arm cannot transcribe a
 * tone burst into the narration's words, so the proof pins the
 * narration-proportional ladder (silence-run-refined — the deterministic
 * default) for the window tolerances, and asserts the ASR arm DEGRADES
 * GRACEFULLY (no throw) on the same fixture. Real-TTS + real-ASR alignment
 * rides the staging rehearsal (the W-track's operator-side boundary).
 *
 *   node --import tsx scripts/w4-anchors-proof.mts
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { W1_ASPECTS, W1_FPS, type W1AspectId } from "../src/lib/tubeforge/whiteboard/benchmark-scenarios";
import { loadLibrary } from "../src/lib/tubeforge/whiteboard/assets";
import { validateWhiteboardProject, type WhiteboardProject } from "../src/lib/tubeforge/whiteboard/storyboard";
import { buildGeometry, type WordAnchors } from "../src/lib/tubeforge/whiteboard/timing";
import { beatSceneEvents, splitSentences, words } from "../src/lib/tubeforge/whiteboard/beat-plan";
import { sceneVoiceAnchors } from "../src/lib/tubeforge/whiteboard/voice-anchors";
import { detectSpeechRuns } from "../src/lib/tubeforge/captions";
import { renderWhiteboard, probeDurationSec } from "../src/lib/tubeforge/whiteboard/render";
import { runQcReport } from "../src/lib/tubeforge/qc";
import { bedExpression, ORIGINAL_LIBRARY } from "../src/lib/tubeforge/music";

const execFileP = promisify(execFile);
const OUT_DIR = path.resolve("validation/w4");

// The fixture's NOMINAL speech structure (the gate expression below).
const BURSTS = [
  { start: 1.0, end: 2.1 },
  { start: 2.6, end: 3.7 },
  { start: 4.2, end: 5.3 },
];
// Three sentences, FIVE beat tokens each — equal word counts against equal
// burst lengths, so the proportional mapping's known shape (chunk windows
// may lead their run by the preceding pause) is the ONLY tolerance to pin.
const NARRATION = "The heart pumps fresh blood. The lungs refill every day. The body gets its share.";
const VO_SEC = 5.6;
const SCENE_MS = 8000;

async function synthFixtureVo(outPath: string): Promise<void> {
  if (fs.existsSync(outPath)) return;
  const gate = BURSTS.map((b) => `between(t,${b.start},${b.end})`).join("+");
  await execFileP("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-t", VO_SEC.toFixed(2),
    // The gate's commas are option separators to ffmpeg's filter parser —
    // the expression rides in single quotes (the bedExpression convention).
    "-i", `aevalsrc='sin(2*PI*440*t)*0.4*(${gate})':s=48000`,
    "-c:a", "pcm_s16le", outPath,
  ]);
}

async function synthBed(outPath: string, seconds: number): Promise<void> {
  if (fs.existsSync(outPath)) return;
  const def = ORIGINAL_LIBRARY.find((t) => t.slug === "curiosity-spark");
  if (!def) throw new Error("curiosity-spark missing from ORIGINAL_LIBRARY");
  const expr = bedExpression(def);
  await execFileP("ffmpeg", [
    "-y", "-f", "lavfi", "-t", String(Math.ceil(seconds) + 4),
    "-i", `aevalsrc=${expr}:s=48000`,
    "-af", `lowpass=f=${def.lowpassHz},loudnorm=I=-16:TP=-1.5:LRA=11`,
    "-c:a", "flac", outPath,
  ]);
}

interface AnchorSceneProof {
  runsMeasured: { start: number; end: number }[];
  sentenceWindows: { text: string; startMs: number; endMs: number; runIndex: number; startDeltaMs: number; endDeltaMs: number; containsRun: boolean }[];
  envelope: { startMs: number; endMs: number };
  wordCount: number;
  asrArmDegraded: boolean;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const voPath = path.join(OUT_DIR, "vo-anchor-fixture.wav");
  await synthFixtureVo(voPath);
  const bedPath = path.join(OUT_DIR, "bed.flac");
  await synthBed(bedPath, SCENE_MS / 1000);

  // --- The measured speech structure (the honest ground truth) ---
  const runs = await detectSpeechRuns(voPath, VO_SEC);
  console.log(`[w4] measured speech runs: ${runs.map((r) => `${r.start.toFixed(2)}–${r.end.toFixed(2)}`).join(", ")}`);
  if (runs.length !== BURSTS.length) {
    throw new Error(`detectSpeechRuns found ${runs.length} runs, expected ${BURSTS.length} — the fixture is broken`);
  }
  for (const [i, b] of BURSTS.entries()) {
    if (Math.abs(runs[i].start - b.start) > 0.1 || Math.abs(runs[i].end - b.end) > 0.1) {
      throw new Error(`run ${i} measured ${runs[i].start}-${runs[i].end} vs nominal ${b.start}-${b.end} (±0.1s)`);
    }
  }

  // --- The anchor ladder (deterministic: the narration-proportional arm) ---
  const aspect: W1AspectId = "16:9";
  const anchors: WordAnchors | null = await sceneVoiceAnchors({
    narration: NARRATION,
    voPath,
    voDurationSec: VO_SEC,
    sceneDurationMs: SCENE_MS,
    asr: false,
  });
  if (!anchors) throw new Error("the voice-anchor ladder returned null on a sane fixture");
  const wordList = splitSentences(NARRATION).flatMap((s) => words(s));
  if (anchors.byWord.length !== wordList.length) {
    throw new Error(`anchor count ${anchors.byWord.length} ≠ the narration's ${wordList.length} beat tokens`);
  }

  // --- THE TOLERANCE PIN: |beatWindow − speechRun| ≤ 0.6s, and every
  // sentence window CONTAINS its run (the draw window covers the phrase). ---
  const TOLERANCE_MS = 600;
  const sentences = splitSentences(NARRATION);
  let off = 0;
  const sentenceWindows: AnchorSceneProof["sentenceWindows"] = [];
  for (let s = 0; s < sentences.length; s++) {
    const count = words(sentences[s]).length;
    const first = anchors.byWord[off];
    const last = anchors.byWord[off + count - 1];
    off += count;
    const window = { startMs: first.startMs, endMs: last.endMs };
    // Sentence s's words occupy run s by proportional construction —
    // pinned here (a mismatch would mean the mapping drifted).
    const run = runs[s];
    const startDeltaMs = Math.round((window.startMs - run.start * 1000) * 10) / 10;
    const endDeltaMs = Math.round((window.endMs - run.end * 1000) * 10) / 10;
    const containsRun = window.startMs <= run.start * 1000 + 1 && window.endMs >= run.end * 1000 - 1;
    sentenceWindows.push({
      text: sentences[s],
      startMs: window.startMs,
      endMs: window.endMs,
      runIndex: s,
      startDeltaMs,
      endDeltaMs,
      containsRun,
    });
    if (Math.abs(startDeltaMs) > TOLERANCE_MS || Math.abs(endDeltaMs) > TOLERANCE_MS) {
      throw new Error(
        `sentence ${s} window [${window.startMs}, ${window.endMs}] misses its run ` +
        `[${Math.round(run.start * 1000)}, ${Math.round(run.end * 1000)}] beyond the ${TOLERANCE_MS}ms tolerance`
      );
    }
    if (!containsRun) {
      throw new Error(`sentence ${s} window does not CONTAIN its speech run — the strokes could finish before the words do`);
    }
  }
  console.log(`[w4] tolerance pin: ${sentenceWindows.map((w) => `s${w.runIndex} Δ[${w.startDeltaMs}, ${w.endDeltaMs}]`).join("  ")} (≤ ±${TOLERANCE_MS}ms, every window contains its run)`);

  // --- The ASR arm degrades gracefully on a tone burst (no throw) ---
  let asrArmDegraded = false;
  try {
    const asrAnchors = await sceneVoiceAnchors({
      narration: NARRATION, voPath, voDurationSec: VO_SEC, sceneDurationMs: SCENE_MS, asr: true,
    });
    asrArmDegraded = asrAnchors === null || JSON.stringify(asrAnchors) !== JSON.stringify(anchors);
    console.log(`[w4] ASR arm: ${asrAnchors ? "answered" : "null"} (degraded honestly, no throw)`);
  } catch (e) {
    throw new Error(`the ASR arm THREW on a tone burst — the ladder must degrade, never throw: ${String(e)}`);
  }

  // --- The two schedules (the estimator vs the anchored clock) ---
  const project: WhiteboardProject = {
    title: "W4 voice-anchor proof — the strokes land on the spoken phrase",
    width: W1_ASPECTS[aspect].width,
    height: W1_ASPECTS[aspect].height,
    fps: W1_FPS,
    hand: { style: "marker", scale: 1 },
    scenes: [
      {
        id: "w4-anchors",
        narration: NARRATION,
        durationMs: SCENE_MS,
        background: "#ffffff",
        placements: [
          { assetId: "heart-main", placement: { x: 380, y: 300, scale: 1.4, rotateDeg: 0 }, order: 0 },
          { assetId: "lungs", placement: { x: 1120, y: 300, scale: 1.4, rotateDeg: 0 }, order: 1 },
        ],
        animations: [],
        camera: [],
      },
    ],
  };
  const lib = loadLibrary();
  const geometry = buildGeometry([...lib.extracted.entries()].map(([id, ex]) => ({ id, paths: ex.paths })));
  const assetTags = new Map<string, string[]>([...lib.assets.values()].map((a) => [a.id, a.tags]));
  const scene = project.scenes[0];
  const estimatorEvents = beatSceneEvents(scene, SCENE_MS, geometry, assetTags);
  const anchoredEvents = beatSceneEvents(scene, SCENE_MS, geometry, assetTags, anchors);
  const estimatorStart = estimatorEvents.reduce((a, e) => Math.min(a, e.startMs), Infinity);
  const anchoredStart = anchoredEvents.reduce((a, e) => Math.min(a, e.startMs), Infinity);
  if (JSON.stringify(estimatorEvents) === JSON.stringify(anchoredEvents)) {
    throw new Error("the anchored schedule is byte-identical to the estimator — the anchors did not move the clock");
  }
  if (anchoredStart < runs[0].start * 1000 - TOLERANCE_MS || anchoredStart > runs[0].start * 1000 + TOLERANCE_MS) {
    throw new Error(`the anchored first stroke starts at ${anchoredStart}ms — not on the first spoken window (${runs[0].start}s)`);
  }
  console.log(`[w4] schedules: estimator starts ${estimatorStart}ms, anchored starts ${anchoredStart}ms (the visual waits for the voice)`);

  // --- Render through the REAL engine, both modes; QC on the anchored one ---
  const { project: valid, errors } = validateWhiteboardProject(project, lib.libraryIndex);
  if (!valid) throw new Error(`the proof project failed validation: ${errors.join(" · ")}`);

  const renderReceipts: Record<string, { durationSec: number; qcFails: string[]; unmeasured: string[] }> = {};
  for (const mode of ["estimator", "anchored"] as const) {
    const t0 = Date.now();
    const result = await renderWhiteboard(valid, {
      outDir: path.join(OUT_DIR, `anchors-${mode}`),
      voFiles: new Map([["w4-anchors", voPath]]),
      musicPath: bedPath,
      asrAnchors: mode === "anchored",
      onProgress: (l, frac) => {
        const pct = Math.round(frac * 100);
        if (pct % 50 === 0) console.log(`  [${mode}] ${pct}% ${l}`);
      },
    });
    const durSec = (await probeDurationSec(result.file)) ?? 0;
    const qc = await runQcReport({
      mp4Path: result.file,
      videoDuration: durSec,
      narrationSec: null,
      srtPath: null,
      expectedAspect: aspect,
      frameRate: W1_FPS,
    });
    const qcFails = (qc.checks ?? []).filter((c) => c.status === "fail").map((c) => c.id);
    const unmeasured = (qc.checks ?? []).filter((c) => c.status === "unmeasured").map((c) => c.id);
    renderReceipts[mode] = { durationSec: Number(durSec.toFixed(2)), qcFails, unmeasured };
    console.log(`  [${mode}] ${durSec.toFixed(1)}s, wall ${((Date.now() - t0) / 1000).toFixed(0)}s, qc ${qcFails.length === 0 ? "GREEN" : `FAIL(${qcFails.join(",")})`}${unmeasured.length ? ` [unmeasured: ${unmeasured.join(",")}]` : ""}`);
    if (qcFails.length > 0) throw new Error(`[${mode}] the QC battery failed: ${qcFails.join(", ")}`);
  }

  const receipt = {
    stage: "W4",
    kind: "voice-anchor-proof",
    recordedAt: new Date().toISOString(),
    fixture: {
      narration: NARRATION,
      burstsNominal: BURSTS,
      voSec: VO_SEC,
      sceneMs: SCENE_MS,
      wordCount: wordList.length,
    },
    toleranceMs: TOLERANCE_MS,
    proof: {
      runsMeasured: runs,
      sentenceWindows,
      envelope: {
        startMs: anchors.byWord[0].startMs,
        endMs: anchors.byWord[anchors.byWord.length - 1].endMs,
      },
      wordCount: anchors.byWord.length,
      asrArmDegraded,
      schedules: { estimatorStartMs: estimatorStart, anchoredStartMs: anchoredStart },
    },
    renders: renderReceipts,
    gate: { passed: true },
  };
  fs.writeFileSync(path.join(OUT_DIR, "w4-anchors-proof.json"), JSON.stringify(receipt, null, 2));
  console.log(`\n[w4] receipt → validation/w4/w4-anchors-proof.json`);
  console.log(`[w4] GATE GREEN — the spoken-window alignment holds at ±${TOLERANCE_MS}ms with every window covering its run`);
}

main().catch((err) => {
  console.error("W4 ANCHOR PROOF FAILED:", err);
  process.exit(1);
});

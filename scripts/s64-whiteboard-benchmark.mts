#!/usr/bin/env node
/**
 * S64 — the Whiteboard Engine P0 benchmark: a complete 60-second whiteboard
 * video, 1920×1080 24fps, from the native engine (SVG + chromium + FFmpeg —
 * zero generation APIs, per the plan's cost doctrine §8).
 *
 *   node --import tsx scripts/s64-whiteboard-benchmark.mts
 *   node --import tsx scripts/s64-whiteboard-benchmark.mts --music-only
 *
 * Topic (the plan's own example): "How the human heart works". Five scenes:
 * title → chambers → blood flow → the beat → close. Evidence lands in
 * validation/s64/ (gitignored by size): the project JSON, the final MP4,
 * per-scene timings, extracted frames, and a manifest this script writes.
 *
 * Audio honesty: narration timing uses the house 2.6-wps estimate (no VO —
 * the gateway is throttled account-wide; when it clears, voFiles maps real
 * TTS WAVs in and the timing engine consumes their measured durations).
 * The music bed is the HOUSE music system (bedExpression, "curiosity-spark"
 * — the production path, not a placeholder).
 */
import { execFile } from "child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "util";

import { loadLibrary } from "../src/lib/tubeforge/whiteboard/assets";
import { buildGeometry, estimateNarrationMs, scheduleScene } from "../src/lib/tubeforge/whiteboard/timing";
import { validateWhiteboardProject } from "../src/lib/tubeforge/whiteboard/storyboard";
import { renderWhiteboard, probeDurationSec } from "../src/lib/tubeforge/whiteboard/render";
import { bedExpression, ORIGINAL_LIBRARY } from "../src/lib/tubeforge/music";
import { runQcReport } from "../src/lib/tubeforge/qc";

const execFileP = promisify(execFile);
const OUT_DIR = path.join(process.cwd(), "validation", "s64");

// ---------------------------------------------------------------------------
// The benchmark project (hand-authored storyboard — the automation planner
// is a later phase; P0 proves the DRAWING ENGINE on a real storyboard).
// ---------------------------------------------------------------------------

const PROJECT = {
  title: "How Your Heart Works — S64 whiteboard P0 benchmark",
  width: 1920,
  height: 1080,
  fps: 24,
  hand: { style: "marker" as const, scale: 1 },
  scenes: [
    {
      id: "title",
      narration:
        "Your heart beats about a hundred thousand times every single day, pushing blood to every corner of your body. So how does this fist-sized muscle actually work? Let's draw it.",
      background: "#ffffff" as const,
      placements: [
        { assetId: "title-hero", placement: { x: 560, y: 180, scale: 1.15, rotateDeg: 0 } },
        { assetId: "heart-main", placement: { x: 1080, y: 470, scale: 2.1, rotateDeg: 0 }, order: 2 },
      ],
      animations: [],
      camera: [
        { startMs: 0, durationMs: 0, cx: 960, cy: 540, scale: 1 },
        { startMs: 300, durationMs: 10200, cx: 1180, cy: 620, scale: 1.14 },
      ],
    },
    {
      id: "chambers",
      narration:
        "Picture the heart as a pump with four hollow chambers — two on the right, two on the left. A wall down the middle, the septum, keeps the two sides completely separate. And that separation is the whole trick.",
      background: "#ffffff" as const,
      placements: [
        { assetId: "heart-main", placement: { x: 700, y: 300, scale: 2.6, rotateDeg: 0 } },
        { assetId: "heart-labels", placement: { x: 700, y: 300, scale: 2.6, rotateDeg: 0 }, order: 2 },
      ],
      animations: [],
      camera: [
        { startMs: 0, durationMs: 0, cx: 960, cy: 540, scale: 1 },
        { startMs: 800, durationMs: 13200, cx: 940, cy: 560, scale: 1.22 },
      ],
    },
    {
      id: "bloodflow",
      narration:
        "The right side takes tired, oxygen-poor blood and pumps it to the lungs, where it swaps carbon dioxide for fresh oxygen. The bright oxygen-rich blood returns to the left side, which fires it out to the entire body.",
      background: "#ffffff" as const,
      placements: [
        { assetId: "heart-main", placement: { x: 640, y: 300, scale: 2.4, rotateDeg: 0 } },
        { assetId: "lungs", placement: { x: 1240, y: 210, scale: 1.7, rotateDeg: 0 }, order: 2 },
        { assetId: "arrow-curve", placement: { x: 1020, y: 430, scale: 1.35, rotateDeg: -12 }, order: 3 },
        { assetId: "arrow-return", placement: { x: 1240, y: 700, scale: 1.35, rotateDeg: 168 }, order: 4 },
      ],
      animations: [
        // Editor-senior events (the scheduler respects explicit timings):
        // the color reveals ride after the drawings complete.
        { type: "reveal_color", assetId: "lungs", pathId: "lg-left", startMs: 6200, durationMs: 900 },
        { type: "reveal_color", assetId: "lungs", pathId: "lg-right", startMs: 6600, durationMs: 900 },
      ],
      camera: [
        { startMs: 0, durationMs: 0, cx: 960, cy: 540, scale: 1 },
        { startMs: 400, durationMs: 4400, cx: 1120, cy: 500, scale: 1.1 },
        { startMs: 10000, durationMs: 4000, cx: 900, cy: 560, scale: 1.02 },
      ],
    },
    {
      id: "beat",
      narration:
        "And the beat itself? A tiny cluster of cells, the sinoatrial node, fires an electrical spark that ripples through the muscle, squeezing the chambers in exactly the right order. That's the lub-dub you hear.",
      background: "#ffffff" as const,
      placements: [
        { assetId: "heart-main", placement: { x: 560, y: 250, scale: 2.3, rotateDeg: 0 } },
        { assetId: "spark", placement: { x: 900, y: 470, scale: 1.6, rotateDeg: 0 }, order: 2 },
        { assetId: "ecg-pulse", placement: { x: 1120, y: 640, scale: 1.6, rotateDeg: 0 }, order: 3 },
      ],
      animations: [],
      camera: [
        { startMs: 0, durationMs: 0, cx: 960, cy: 540, scale: 1 },
        { startMs: 400, durationMs: 4000, cx: 1010, cy: 640, scale: 1.28 },
        { startMs: 7600, durationMs: 4500, cx: 1180, cy: 720, scale: 1.08 },
      ],
    },
    {
      id: "close",
      narration:
        "All of that, sixty to a hundred times a minute, every minute of your life. Your heart never takes a weekend. Take care of it.",
      background: "#ffffff" as const,
      placements: [
        { assetId: "close-card", placement: { x: 380, y: 330, scale: 1.5, rotateDeg: 0 } },
        { assetId: "heart-main", placement: { x: 1260, y: 330, scale: 1.9, rotateDeg: 0 }, order: 2 },
      ],
      animations: [
        { type: "reveal_color", assetId: "heart-main", pathId: "hm-outline", startMs: 6400, durationMs: 1000 },
      ],
      camera: [
        { startMs: 0, durationMs: 0, cx: 960, cy: 540, scale: 1 },
        { startMs: 400, durationMs: 8500, cx: 1000, cy: 540, scale: 1.06 },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// The music bed (the house system, curiosity-spark: funfacts/bright).
// ---------------------------------------------------------------------------

async function synthBed(outPath: string): Promise<void> {
  const def = ORIGINAL_LIBRARY.find((t) => t.slug === "curiosity-spark");
  if (!def) throw new Error("curiosity-spark missing from ORIGINAL_LIBRARY");
  // The house synthesizer's exact shape (music.ts): the stereo graph feeds
  // aevalsrc unwrapped — the "|" is the channel separator, parens would
  // break it — and the lowpass+loudnorm finishing pass rides along.
  const expr = bedExpression(def);
  await execFileP("ffmpeg", [
    "-y", "-f", "lavfi", "-t", "62",
    "-i", `aevalsrc=${expr}:s=48000`,
    "-af", `lowpass=f=${def.lowpassHz},loudnorm=I=-16:TP=-1.5:LRA=11`,
    "-c:a", "flac", outPath,
  ]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const args = process.argv.slice(2);

  if (args.includes("--music-only")) {
    await synthBed(path.join(OUT_DIR, "bed.flac"));
    console.log("bed synthesized");
    return;
  }

  // Validate the project against the loaded library.
  const lib = loadLibrary();
  const { project, errors } = validateWhiteboardProject(PROJECT, lib.libraryIndex);
  if (!project) throw new Error(`project invalid: ${errors.join("; ")}`);
  fs.writeFileSync(path.join(OUT_DIR, "project.json"), JSON.stringify(project, null, 2));

  // The music bed (house system).
  const bedPath = path.join(OUT_DIR, "bed.flac");
  if (!fs.existsSync(bedPath)) await synthBed(bedPath);

  // Narration timing preview (the engine will use real VO WAVs when the
  // gateway clears — voFiles maps scene id → wav then).
  const geometry = buildGeometry(
    [...lib.extracted.entries()].map(([id, ex]) => ({ id, paths: ex.paths }))
  );
  const schedule = project.scenes.map((s) => {
    const dur = s.durationMs ?? estimateNarrationMs(s.narration);
    const events = scheduleScene(s, dur, geometry);
    return { sceneId: s.id, estMs: dur, events: events.length };
  });

  const t0 = Date.now();
  const { scenes, file } = await renderWhiteboard(project, {
    outDir: OUT_DIR,
    musicPath: bedPath,
    onProgress: (label, frac) => {
      process.stdout.write(`\r[${Math.round(frac * 100)}%] ${label}                    `);
    },
  });
  console.log("\nrender complete in", Math.round((Date.now() - t0) / 1000), "s");

  // QC the final video with the house lenses.
  const dur = (await probeDurationSec(file)) ?? 0;
  const qc = await runQcReport({
    mp4Path: file,
    videoDuration: dur,
    narrationSec: null,
    srtPath: null,
  }).catch((e) => ({ error: String(e) }));
  const qcChecks = qc as { checks?: { id?: string; status?: string }[] };
  const qcLine = Array.isArray(qcChecks?.checks)
    ? qcChecks.checks.map((c) => `${c.id ?? "?"}:${c.status ?? "?"}`).join(" ")
    : "(qc report shape unparsed)";
  console.log("qc:", qcLine);

  // Frames for the record (early/mid/late).
  for (const t of [8, 30, 55]) {
    await execFileP("ffmpeg", ["-y", "-v", "error", "-ss", String(t), "-i", file,
      "-frames:v", "1", "-q:v", "3", path.join(OUT_DIR, `final.t${t}.jpg`)]).catch(() => {});
  }

  // The manifest.
  const manifest = {
    renderedAt: new Date().toISOString(),
    engine: "src/lib/tubeforge/whiteboard (S64 P0)",
    title: project.title,
    durationSec: Number(dur.toFixed(2)),
    scenes: scenes.map((s, i) => ({
      id: s.sceneId,
      estMs: schedule[i]?.estMs,
      renderedMs: s.durationMs,
      frames: s.frames,
      events: schedule[i]?.events ?? 0,
    })),
    narration: project.scenes.map((s) => ({ id: s.id, words: s.narration.split(/\s+/).length })),
    audio: { narration: "estimated 2.6 wps (gateway throttled — no TTS this run)", music: "house bedExpression curiosity-spark" },
    renderMs: Date.now() - t0,
    qc,
  };
  fs.writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log("manifest written; total", manifest.durationSec, "s;", scenes.length, "scenes");
}

await main();

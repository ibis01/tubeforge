#!/usr/bin/env node
/**
 * S67 — the E9 Phase A sandbox proof (design §8: real-render evidence is
 * the sandbox benchmark's job, CI pins the pure contracts).
 *
 * The EXACT product pipeline the studio drives, minus the DB row:
 *   story scenes → scaffoldWhiteboardProject (native planner, zero AI)
 *   → validateWhiteboardProject (the engine gate)
 *   → renderWhiteboard (chromium + ffmpeg — the ported 8-asset library
 *     drawn by the canonical engine through the scaffold's placements)
 *   → the QC-style receipts (duration, streams, non-blank frames).
 *
 *   node --import tsx scripts/s67-e9a-proof.mts
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { scaffoldWhiteboardProject } from "../src/lib/tubeforge/whiteboard/whiteboard-planner";
import { validateWhiteboardProject } from "../src/lib/tubeforge/whiteboard/storyboard";
import { loadLibrary } from "../src/lib/tubeforge/whiteboard/assets";
import { renderWhiteboard, probeDurationSec } from "../src/lib/tubeforge/whiteboard/render";

const execFileP = promisify(execFile);
const OUT = path.resolve("scratch/s67-e9a-proof");

// Four story beats whose narration hits four different rule-table rows —
// the planner must land four DIFFERENT concept assets on the board.
const SCENES = [
  { index: 1, title: "Opening", narration: "Every great idea starts smaller than anyone expects." },
  { index: 2, title: "The numbers", narration: "The data shows revenue growth compounding by the day." },
  { index: 3, title: "The deadline", narration: "Time is the one resource no budget can buy back." },
  { index: 4, title: "The close", narration: "Launch it, verify it, and let the world respond." },
];

async function main(): Promise<void> {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  console.log("[1/4] scaffolding (zero AI)…");
  const project = scaffoldWhiteboardProject({ scenes: SCENES, topic: "S67 proof" });
  const picks = project.scenes.map(
    (s) => s.placements.map((pl) => pl.assetId).join("+")
  );
  console.log("      picks:", picks.join(" | "));
  const distinct = new Set(picks.flatMap((p) => p.split("+"))).size;
  if (distinct < 5) throw new Error(`rule-table diversity collapsed: ${distinct} distinct assets`);

  console.log("[2/4] validating through the engine gate…");
  const lib = loadLibrary();
  const { project: valid, errors } = validateWhiteboardProject(project, lib.libraryIndex);
  if (!valid) throw new Error(`scaffold failed validation: ${errors.join(" · ")}`);

  // 720p/24 like a scene preview — fast, and it exercises every engine path
  // (compose → schedule → per-frame applier → hand → encode → concat).
  const target = { ...valid, width: 1280, height: 720, fps: 24 };
  console.log(`[3/4] rendering ${target.scenes.length} scenes at ${target.width}x${target.height}@${target.fps}…`);
  const t0 = Date.now();
  const result = await renderWhiteboard(target, {
    outDir: OUT,
    onProgress: (label, fraction) => {
      const pct = Math.round(fraction * 100);
      if (pct % 25 === 0) console.log(`      ${pct}% ${label}`);
    },
  });
  const wallSec = Math.round((Date.now() - t0) / 100) / 10;
  console.log(`[4/4] receipts:`);
  const durSec = await probeDurationSec(result.file);
  console.log(`      final.mp4: ${Math.round(durSec ?? 0)}s, engine-reported ${result.scenes.length} scenes in ${wallSec}s wall`);
  for (const s of result.scenes) {
    const sz = fs.statSync(s.file).size;
    console.log(`        ${path.basename(s.file)}: ${s.frames} frames, ${(sz / 1024).toFixed(0)} KB`);
  }
  if (!durSec || durSec < 8) throw new Error(`final duration ${durSec}s is implausibly short`);
  if (result.scenes.length !== SCENES.length) throw new Error("scene count mismatch");

  // Non-blank receipt: the mid-scene JPEG must carry ink (the S64 freeze lens
  // at the pipeline level — a blank canvas would mean the seam broke).
  const framesDir = path.join(OUT, "..", "s67-e9a-frame-probe");
  fs.mkdirSync(framesDir, { recursive: true });
  await execFileP("ffmpeg", [
    "-y", "-ss", "3", "-i", result.file, "-frames:v", "1",
    path.join(framesDir, "mid.jpg"),
  ]);
  const jpg = fs.statSync(path.join(framesDir, "mid.jpg"));
  if (jpg.size < 4000) throw new Error(`mid-render frame is ${(jpg.size / 1024).toFixed(1)} KB — reads as blank`);
  console.log(`      mid-render frame: ${(jpg.size / 1024).toFixed(1)} KB of ink (non-blank receipt)`);

  console.log(`\nE9 PHASE A PROOF GREEN — scaffold → gate → render → receipts in ${wallSec}s`);
  console.log(`artifacts: ${OUT}`);
}

main().catch((err) => {
  console.error("PROOF FAILED:", err);
  process.exit(1);
});

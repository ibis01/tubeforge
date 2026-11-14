#!/usr/bin/env node
/**
 * W5 — the camera-director proof (S120 §3 W5's exit gate).
 *
 * The gate: QC GREEN on the W1 benchmark with the drift fully demoted.
 * This script DIRECTS every benchmark scene (camera-director.ts — focus
 * rects from the W2 beat plan), renders through the REAL engine (the
 * scenes now carry keys → cameraAt rides them with NO drift), and runs
 * the FULL house QC battery per aspect. Receipts land in validation/w5/
 * (gitignored). The committed W1 baseline stays untouched — the
 * cameraless benchmark keeps its drift and its frozen hashes (the W1
 * harness still gates that); THIS receipt is the directed evidence.
 *
 *   node --import tsx scripts/w5-camera-proof.mts
 *   node --import tsx scripts/w5-camera-proof.mts --aspects 16:9
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
  W1_ASPECTS,
  W1_ASPECT_IDS,
  W1_FPS,
  buildBenchmarkProject,
  w1TotalDurationMs,
  type W1AspectId,
} from "../src/lib/tubeforge/whiteboard/benchmark-scenarios";
import { loadLibrary } from "../src/lib/tubeforge/whiteboard/assets";
import { validateWhiteboardProject } from "../src/lib/tubeforge/whiteboard/storyboard";
import { buildGeometry, sceneDurationMs } from "../src/lib/tubeforge/whiteboard/timing";
import { beatSceneEvents } from "../src/lib/tubeforge/whiteboard/beat-plan";
import { directCamera } from "../src/lib/tubeforge/whiteboard/camera-director";
import { renderWhiteboard, probeDurationSec } from "../src/lib/tubeforge/whiteboard/render";
import { runQcReport } from "../src/lib/tubeforge/qc";
import { bedExpression, ORIGINAL_LIBRARY } from "../src/lib/tubeforge/music";

const execFileP = promisify(execFile);
const OUT_DIR = path.resolve("validation/w5");

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

interface AspectProof {
  aspect: W1AspectId;
  durationSec: number;
  scenes: {
    id: string;
    keyCount: number;
    keys: { startMs: number; durationMs: number; cx: number; cy: number; scale: number }[];
  }[];
  qc: { passed: boolean; failing: string[]; checks: { id: string; status: string }[] };
}

async function proveAspect(aspect: W1AspectId): Promise<AspectProof> {
  const { width, height } = W1_ASPECTS[aspect];
  const project = buildBenchmarkProject(aspect);
  const lib = loadLibrary();
  const geometry = buildGeometry([...lib.extracted.entries()].map(([id, ex]) => ({ id, paths: ex.paths })));
  const assetTags = new Map<string, string[]>([...lib.assets.values()].map((a) => [a.id, a.tags]));

  // Direct every scene: the W2 beat plan → focus rects → camera keys.
  const sceneProofs: AspectProof["scenes"] = [];
  for (const scene of project.scenes) {
    const dur = sceneDurationMs(scene, null);
    const events = beatSceneEvents(scene, dur, geometry, assetTags);
    const keys = directCamera(scene, width, height, dur, geometry, events, { assetTags });
    scene.camera = keys;
    sceneProofs.push({
      id: scene.id,
      keyCount: keys.length,
      keys: keys.map((k) => ({ startMs: k.startMs, durationMs: k.durationMs, cx: k.cx, cy: k.cy, scale: k.scale })),
    });
  }

  const { project: valid, errors } = validateWhiteboardProject(project, lib.libraryIndex);
  if (!valid) throw new Error(`[${aspect}] directed benchmark failed validation: ${errors.join(" · ")}`);
  // Re-read the VALIDATED keys into the receipt (the validator is the law).
  for (const [i, s] of valid.scenes.entries()) {
    sceneProofs[i].keys = s.camera.map((k) => ({ startMs: k.startMs, durationMs: k.durationMs, cx: k.cx, cy: k.cy, scale: k.scale }));
    sceneProofs[i].keyCount = s.camera.length;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const bed = path.join(OUT_DIR, "bed.flac");
  await synthBed(bed, w1TotalDurationMs() / 1000);

  const t0 = Date.now();
  const result = await renderWhiteboard(valid, {
    outDir: path.join(OUT_DIR, aspect.replace(":", "x")),
    musicPath: bed,
    onProgress: (label, frac) => {
      const pct = Math.round(frac * 100);
      if (pct % 25 === 0) console.log(`  [${aspect}] ${pct}% ${label}`);
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
  // The QC three-state contract: "unmeasured" never reads as clean — and
  // it never reads as FAILED either. The gate here: no MEASURED failure.
  // (cut-alignment reports unmeasured on a doc-less whiteboard render —
  // there is no shot plan to align to; recorded honestly, not failed.)
  const failing = (qc.checks ?? []).filter((c) => c.status === "fail").map((c) => `${c.id}:${c.status}`);
  const unmeasured = (qc.checks ?? []).filter((c) => c.status === "unmeasured").map((c) => c.id);
  console.log(`  [${aspect}] ${durSec.toFixed(1)}s, wall ${((Date.now() - t0) / 1000).toFixed(0)}s, qc ${failing.length === 0 ? "GREEN" : "FAIL"}${failing.length ? ` (${failing.join(", ")})` : ""}${unmeasured.length ? ` [unmeasured: ${unmeasured.join(", ")}]` : ""}`);

  return {
    aspect,
    durationSec: Number(durSec.toFixed(2)),
    scenes: sceneProofs,
    qc: {
      passed: failing.length === 0,
      failing,
      checks: (qc.checks ?? []).map((c) => ({ id: c.id, status: c.status })),
    },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--aspects");
  const wanted = idx !== -1 && args[idx + 1] ? (args[idx + 1].split(",") as W1AspectId[]) : W1_ASPECT_IDS;
  const bad = wanted.filter((a) => !W1_ASPECT_IDS.includes(a));
  if (bad.length > 0) throw new Error(`unknown aspects: ${bad.join(", ")}`);

  const proofs: AspectProof[] = [];
  for (const aspect of wanted) proofs.push(await proveAspect(aspect));

  const allGreen = proofs.every((p) => p.qc.passed);
  const directed = proofs.reduce((a, p) => a + p.scenes.filter((s) => s.keys.length > 0).length, 0);
  const receipt = {
    stage: "W5",
    kind: "camera-director-proof",
    directedScenes: directed,
    qcGreen: allGreen,
    proofs,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "w5-camera-proof.json"), JSON.stringify(receipt, null, 2));
  console.log(`\n[w5] directed scenes: ${directed}, QC ${allGreen ? "GREEN across all aspects" : "FAILED"} → validation/w5/w5-camera-proof.json`);
  if (!allGreen) process.exit(1);
}

main().catch((e) => {
  console.error("W5 PROOF FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});

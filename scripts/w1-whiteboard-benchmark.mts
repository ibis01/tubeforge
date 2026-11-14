#!/usr/bin/env node
/**
 * W1 — the whiteboard perceptual baseline harness (the s67-e9a-proof
 * pattern: scaffold-free, real-render evidence).
 *
 * docs/design/whiteboard-videoscribe-reconciliation.md §9 W1: render the
 * FIVE fixed scene types (benchmark-scenarios.ts — pure, frozen) at all
 * three house aspects through the real engine (validate → chromium →
 * ffmpeg), and drop receipts the later W-stages diff against:
 *   - per-scene engine receipts (frames, durations)
 *   - RAW-RGB frame hashes at frozen sample points (the determinism anchor:
 *     the 16:9 video is rendered TWICE and the hashes MUST match)
 *   - ink coverage + dark-pixel ratio per sample (the blankness lens)
 *   - seam integrity per scene boundary (outgoing ink present, incoming
 *     clean board — the W6 gap recorded honestly, not failed)
 *   - the house QC battery on every final (zero-fail gate)
 *   - the blind kit (codenamed copies + local-only key) for the human
 *     rubric in docs/audits/w1-blind-rubric.md
 * The committed baseline lands in docs/baselines/ — binaries stay in
 * validation/w1/ (gitignored).
 *
 *   node --import tsx scripts/w1-whiteboard-benchmark.mts
 *   node --import tsx scripts/w1-whiteboard-benchmark.mts --aspects 16:9
 *   node --import tsx scripts/w1-whiteboard-benchmark.mts --no-repeat --no-blind
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  W1_ASPECTS,
  W1_ASPECT_IDS,
  W1_FPS,
  W1_RUBRIC_DIMENSIONS,
  W1_SCENE_IDS,
  buildBenchmarkProject,
  w1SamplePlan,
  w1SceneSpans,
  w1SeamPlan,
  w1TotalDurationMs,
  type W1AspectId,
} from "../src/lib/tubeforge/whiteboard/benchmark-scenarios";
import { loadLibrary } from "../src/lib/tubeforge/whiteboard/assets";
import { validateWhiteboardProject } from "../src/lib/tubeforge/whiteboard/storyboard";
import { renderWhiteboard, probeDurationSec } from "../src/lib/tubeforge/whiteboard/render";
import { runQcReport } from "../src/lib/tubeforge/qc";
import { bedExpression, ORIGINAL_LIBRARY } from "../src/lib/tubeforge/music";

const execFileP = promisify(execFile);
const OUT_DIR = path.resolve("validation/w1");

interface FrameStats {
  sha256: string;
  /** Ratio of near-white pixels (r,g,b ≥ 245) — the whiteboard canvas. */
  inkCoverage: number;
  /** Ratio of dark pixels (luma < 128) — the INK itself. */
  darkRatio: number;
  meanLuma: number;
}

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Decode ONE frame at tSec as raw RGB (codec-independent hashing — the
 *  bytes are the decoded pixels, not a lossy re-encode). */
function decodeFrameRgb(file: string, tSec: number, w: number, h: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-v", "error",
      "-ss", tSec.toFixed(3),
      "-i", file,
      "-frames:v", "1",
      "-f", "rawvideo",
      "-pix_fmt", "rgb24",
      "pipe:1",
    ]);
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      const buf = Buffer.concat(chunks);
      const expected = w * h * 3;
      if (code !== 0 || buf.length !== expected) {
        reject(new Error(`frame decode @${tSec}s: exit ${code}, got ${buf.length} bytes, expected ${expected}`));
        return;
      }
      resolve(buf);
    });
  });
}

function analyzeFrame(buf: Buffer, w: number, h: number): FrameStats {
  const total = w * h;
  let nearWhite = 0;
  let dark = 0;
  let lumaSum = 0;
  for (let i = 0; i < total; i++) {
    const r = buf[i * 3];
    const g = buf[i * 3 + 1];
    const b = buf[i * 3 + 2];
    if (r >= 245 && g >= 245 && b >= 245) nearWhite++;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (luma < 128) dark++;
    lumaSum += luma;
  }
  return {
    sha256: sha256(buf),
    inkCoverage: nearWhite / total,
    darkRatio: dark / total,
    meanLuma: lumaSum / total,
  };
}

async function decodedFrameCount(file: string): Promise<number | null> {
  try {
    const { stdout } = await execFileP("ffprobe", [
      "-v", "error", "-count_frames", "-select_streams", "v:0",
      "-show_entries", "stream=nb_read_frames", "-of", "json", file,
    ]);
    return Number(JSON.parse(stdout).streams?.[0]?.nb_read_frames ?? NaN) || null;
  } catch {
    return null;
  }
}

async function toolVersion(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP(cmd, args);
    return stdout.split("\n")[0].trim();
  } catch {
    return `${cmd}: unavailable`;
  }
}

function chromiumReceipt(): string {
  try {
    const cache = path.join(os.homedir(), ".cache", "ms-playwright");
    const hits = fs.readdirSync(cache).filter((d) => d.includes("chromium"));
    return hits.length ? hits.join(", ") : "no ms-playwright chromium cache found";
  } catch {
    return "ms-playwright cache unreadable";
  }
}

// The house music bed (the s64 pattern): the QC battery's "playable"
// contract is H.264 + AAC — production whiteboard renders always carry
// the bed, so the baseline must too. Audio-only: zero effect on the
// frame hashes, full effect on QC fidelity.
async function synthBed(outPath: string, seconds: number): Promise<void> {
  if (fs.existsSync(outPath)) return;
  const def = ORIGINAL_LIBRARY.find((t) => t.slug === "curiosity-spark");
  if (!def) throw new Error("curiosity-spark missing from ORIGINAL_LIBRARY");
  // The house synthesizer's exact shape (music.ts): the stereo graph feeds
  // aevalsrc unwrapped — the "|" is the channel separator, parens would
  // break it — and the lowpass+loudnorm finishing pass rides along.
  const expr = bedExpression(def);
  await execFileP("ffmpeg", [
    "-y", "-f", "lavfi", "-t", String(Math.ceil(seconds) + 4),
    "-i", `aevalsrc=${expr}:s=48000`,
    "-af", `lowpass=f=${def.lowpassHz},loudnorm=I=-16:TP=-1.5:LRA=11`,
    "-c:a", "flac", outPath,
  ]);
}

interface AspectReceipt {
  aspect: W1AspectId;
  dim: string;
  outDir: string;
  durationSec: number;
  decodedFrames: number | null;
  expectedFrames: number;
  renderWallMs: number;
  sceneReceipts: { id: string; frames: number; durationMs: number }[];
  samples: (FrameStats & { id: string; kind: string; tSec: number })[];
  seams: {
    between: [string, string];
    lastTSec: number;
    firstTSec: number;
    outgoing: FrameStats;
    incoming: FrameStats;
  }[];
  qc: { overall: string; checks: { id: string; status: string }[] };
}

async function renderAspect(
  aspect: W1AspectId,
  outDir: string,
  label: string
): Promise<AspectReceipt> {
  const { width, height } = W1_ASPECTS[aspect];
  const project = buildBenchmarkProject(aspect);

  const lib = loadLibrary();
  const { project: valid, errors } = validateWhiteboardProject(project, lib.libraryIndex);
  if (!valid) throw new Error(`[${label}] benchmark project failed validation: ${errors.join(" · ")}`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "project.json"), JSON.stringify(valid, null, 2));

  const t0 = Date.now();
  const result = await renderWhiteboard(valid, {
    outDir,
    musicPath: path.join(OUT_DIR, "bed.flac"),
    onProgress: (l, frac) => {
      const pct = Math.round(frac * 100);
      if (pct % 20 === 0) console.log(`      [${label}] ${pct}% ${l}`);
    },
  });
  const renderWallMs = Date.now() - t0;

  const durSec = (await probeDurationSec(result.file)) ?? 0;
  const decoded = await decodedFrameCount(result.file);
  const expectedFrames = Math.round(w1TotalDurationMs() / 1000 * W1_FPS);

  // Sample frames — the rubric's JPEGs + the hash receipts.
  const framesDir = path.join(outDir, "frames");
  fs.mkdirSync(framesDir, { recursive: true });
  const samples: AspectReceipt["samples"] = [];
  for (const s of w1SamplePlan()) {
    const buf = await decodeFrameRgb(result.file, s.tSec, width, height);
    const stats = analyzeFrame(buf, width, height);
    samples.push({ id: s.id, kind: s.kind, tSec: s.tSec, ...stats });
    await execFileP("ffmpeg", [
      "-y", "-v", "error", "-ss", s.tSec.toFixed(3), "-i", result.file,
      "-frames:v", "1", "-q:v", "2", path.join(framesDir, `${s.id}.jpg`),
    ]);
  }

  // Seam integrity — the honest W6 record, measured with the lens the
  // engine's ACTUAL seam behavior demands. The board is a dot-grid paper
  // (a blank board reads ~97.4% near-white — near-white is the WRONG lens
  // here) and the incoming scene's frame 0 carries the resting hand
  // (~0.16% dark) with NO ink strokes. So: outgoing must still carry ink
  // (dark ≥ 0.1%), incoming must be stroke-free (dark ≤ 0.5%).
  const seams: AspectReceipt["seams"] = [];
  for (const seam of w1SeamPlan()) {
    const last = await decodeFrameRgb(result.file, seam.lastTSec, width, height);
    const first = await decodeFrameRgb(result.file, seam.firstTSec, width, height);
    seams.push({
      between: seam.between,
      lastTSec: seam.lastTSec,
      firstTSec: seam.firstTSec,
      outgoing: analyzeFrame(last, width, height),
      incoming: analyzeFrame(first, width, height),
    });
  }

  // The house QC battery (the same lenses the ship gate runs) — with the
  // aspect + fps this render was BUILT for, exactly as production passes
  // them (a 9:16 whiteboard video is not a squeezed 16:9).
  const qc = await runQcReport({
    mp4Path: result.file,
    videoDuration: durSec,
    narrationSec: null,
    srtPath: null,
    expectedAspect: aspect,
    frameRate: W1_FPS,
  }).catch((e: unknown) => ({ error: String(e), checks: [] as { id?: string; status?: string }[] }));
  const qcAny = qc as { checks?: { id?: string; status?: string }[]; overall?: string };
  const checks = (qcAny.checks ?? []).map((c) => ({ id: c.id ?? "?", status: c.status ?? "?" }));
  fs.writeFileSync(
    path.join(outDir, "qc.json"),
    JSON.stringify({ aspect, durSec, qc }, null, 2)
  );

  return {
    aspect,
    dim: `${width}x${height}`,
    outDir: path.relative(process.cwd(), outDir),
    durationSec: Number(durSec.toFixed(2)),
    decodedFrames: decoded,
    expectedFrames,
    renderWallMs,
    sceneReceipts: result.scenes.map((s) => ({
      id: s.sceneId,
      frames: s.frames,
      durationMs: s.durationMs,
    })),
    samples,
    seams,
    qc: { overall: qcAny.overall ?? "(unreported)", checks },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const aspectsIdx = args.indexOf("--aspects");
  const aspectsEq = args.find((a) => a.startsWith("--aspects="));
  const aspectsRaw = aspectsEq
    ? aspectsEq.split("=")[1] ?? ""
    : aspectsIdx >= 0 ? args[aspectsIdx + 1] ?? "" : "";
  const aspects: W1AspectId[] = aspectsRaw
    ? aspectsRaw.split(",").filter((a): a is W1AspectId =>
        (W1_ASPECT_IDS as string[]).includes(a))
    : W1_ASPECT_IDS;
  if (aspects.length === 0) throw new Error(`--aspects: none of the given ids are in ${W1_ASPECT_IDS.join("/")}`);
  const repeat = !args.includes("--no-repeat");
  const blind = !args.includes("--no-blind");

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const bedPath = path.join(OUT_DIR, "bed.flac");
  await synthBed(bedPath, w1TotalDurationMs() / 1000);

  console.log(`[w1] five fixed scenes × aspects ${aspects.join(", ")} @ ${W1_FPS}fps — total ${(w1TotalDurationMs() / 1000).toFixed(1)}s each`);

  // The frozen definition hash — WHAT produced this baseline (the projects
  // are pure builds; their canonical JSON hashes pin the definition).
  const projectHashes: Record<string, string> = {};
  for (const a of aspects) {
    projectHashes[a] = sha256(JSON.stringify(buildBenchmarkProject(a)));
  }

  const receipts: Record<string, AspectReceipt> = {};
  for (const aspect of aspects) {
    const dirName = `aspect-${aspect.replace(":", "x")}`;
    console.log(`\n[w1] rendering ${aspect} (${W1_ASPECTS[aspect].width}x${W1_ASPECTS[aspect].height})…`);
    receipts[aspect] = await renderAspect(aspect, path.join(OUT_DIR, dirName), aspect);
    const r = receipts[aspect];
    console.log(
      `[w1] ${aspect}: ${r.durationSec}s, decoded ${r.decodedFrames ?? "?"} frames ` +
      `(expected ${r.expectedFrames}), ${r.renderWallMs}ms wall, qc ${r.qc.overall}`
    );
  }

  // THE DETERMINISM PIN — the reconciliation's W1 exit test: two runs,
  // identical frame hashes. Only the full 16:9 run repeats (cost), the
  // engine law it proves is aspect-independent (frameAt is pure).
  let determinismPin: {
    aspect: W1AspectId;
    runs: number;
    sampleHashesIdentical: boolean;
    sceneFrameCountsIdentical: boolean;
    hashes: string[][];
  } | null = null;
  if (repeat && aspects.includes("16:9")) {
    console.log("\n[w1] determinism pin — re-rendering 16:9…");
    const second = await renderAspect("16:9", path.join(OUT_DIR, "aspect-16x9-run2"), "16:9-r2");
    const first = receipts["16:9"];
    const h1 = first.samples.map((s) => s.sha256);
    const h2 = second.samples.map((s) => s.sha256);
    const f1 = first.sceneReceipts.map((s) => s.frames);
    const f2 = second.sceneReceipts.map((s) => s.frames);
    determinismPin = {
      aspect: "16:9",
      runs: 2,
      sampleHashesIdentical: JSON.stringify(h1) === JSON.stringify(h2),
      sceneFrameCountsIdentical: JSON.stringify(f1) === JSON.stringify(f2),
      hashes: [h1, h2],
    };
    console.log(
      `[w1] determinism pin: hashes ${determinismPin.sampleHashesIdentical ? "IDENTICAL" : "DIVERGED"}, ` +
      `scene frame counts ${determinismPin.sceneFrameCountsIdentical ? "identical" : "DIVERGED"}`
    );
  }

  // The blind kit — codenamed copies of the finals + the rubric's frames.
  // The key stays in gitignored validation/; the scorer scores codes, not
  // aspects (the rubric's protocol; what W2+ comparisons rely on).
  if (blind) {
    const blindDir = path.join(OUT_DIR, "blind");
    fs.mkdirSync(blindDir, { recursive: true });
    const key: Record<string, string> = {};
    for (const aspect of aspects) {
      const file = path.join(OUT_DIR, `aspect-${aspect.replace(":", "x")}`, "final.mp4");
      if (!fs.existsSync(file)) continue;
      const code = `WB-${sha256(fs.readFileSync(file)).slice(0, 8)}`;
      fs.copyFileSync(file, path.join(blindDir, `${code}.mp4`));
      const sampleIdx = new Map(w1SamplePlan().map((s, i) => [s.id, i + 1]));
      for (const s of receipts[aspect].samples) {
        const src = path.join(OUT_DIR, `aspect-${aspect.replace(":", "x")}`, "frames", `${s.id}.jpg`);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(blindDir, `${code}-P${sampleIdx.get(s.id)}.jpg`));
        }
      }
      key[code] = aspect;
    }
    fs.writeFileSync(path.join(blindDir, "key.json"), JSON.stringify(key, null, 2));
    console.log(`[w1] blind kit: ${Object.keys(key).length} codenamed finals in validation/w1/blind/ (key is local-only)`);
  }

  // ---------------------------------------------------------------------------
  // The gate — hard receipts or the baseline does not land.
  // ---------------------------------------------------------------------------
  const failures: string[] = [];
  const expectedSec = w1TotalDurationMs() / 1000;
  for (const aspect of aspects) {
    const r = receipts[aspect];
    if (Math.abs(r.durationSec - expectedSec) > 0.5)
      failures.push(`${aspect}: duration ${r.durationSec}s ≠ expected ${expectedSec}s (±0.5)`);
    if (r.decodedFrames === null || Math.abs(r.decodedFrames - r.expectedFrames) > r.expectedFrames * 0.02)
      failures.push(`${aspect}: decoded ${r.decodedFrames} frames vs expected ${r.expectedFrames} (±2%)`);
    if (r.sceneReceipts.length !== W1_SCENE_IDS.length)
      failures.push(`${aspect}: ${r.sceneReceipts.length} scenes ≠ ${W1_SCENE_IDS.length}`);
    for (const s of r.samples) {
      if (s.darkRatio < 0.001)
        failures.push(`${aspect}/${s.id}: sample @${s.tSec}s reads blank (dark ratio ${(s.darkRatio * 100).toFixed(3)}%)`);
    }
    for (const seam of r.seams) {
      if (seam.outgoing.darkRatio < 0.001)
        failures.push(`${aspect}: seam ${seam.between.join("→")} — outgoing last frame lost its ink (dark ${(seam.outgoing.darkRatio * 100).toFixed(3)}%)`);
      if (seam.incoming.darkRatio > 0.005)
        failures.push(`${aspect}: seam ${seam.between.join("→")} — incoming first frame carries unexpected ink (dark ${(seam.incoming.darkRatio * 100).toFixed(3)}%)`);
    }
    const qcFails = r.qc.checks.filter((c) => c.status === "fail");
    if (qcFails.length > 0)
      failures.push(`${aspect}: qc fails — ${qcFails.map((c) => c.id).join(", ")}`);
  }
  if (determinismPin && !determinismPin.sampleHashesIdentical)
    failures.push("determinism pin: 16:9 frame hashes DIVERGED between runs");

  // ---------------------------------------------------------------------------
  // The dated receipt is a LOCAL artifact (the 535c90e law, now structural):
  // it lands in gitignored validation/w1/ so a local run can never shadow
  // the FROZEN committed baseline (docs/baselines/w1-whiteboard-baseline-
  // 2026-11-13.json) — the S75 source pin reads the latest baseline-* in
  // docs/baselines/, and a dated file written there once broke it.
  const today = new Date().toISOString().slice(0, 10);
  const baseline = {
    stage: "W1",
    what: "whiteboard perceptual baseline — five fixed scene types × three aspects",
    definition: {
      module: "src/lib/tubeforge/whiteboard/benchmark-scenarios.ts",
      projectHashes,
      fps: W1_FPS,
      totalDurationMs: w1TotalDurationMs(),
      sceneIds: [...W1_SCENE_IDS],
      spans: w1SceneSpans(),
      narrations: Object.fromEntries(W1_SCENE_IDS.map((id) => {
        const p = buildBenchmarkProject("16:9").scenes.find((s) => s.id === id);
        return [id, p?.narration ?? ""];
      })),
    },
    recordedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      ffmpeg: await toolVersion("ffmpeg", ["-version"]),
      playwright: await toolVersion("node_modules/.bin/playwright", ["--version"]),
      chromium: chromiumReceipt(),
    },
    aspects: receipts,
    determinismPin,
    rubric: {
      doc: "docs/audits/w1-blind-rubric.md",
      dimensions: [...W1_RUBRIC_DIMENSIONS],
    },
    gate: { passed: failures.length === 0, failures },
  };
  const baselinePath = path.join(OUT_DIR, `w1-whiteboard-baseline-${today}.json`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));

  console.log(`\n[w1] baseline: ${path.relative(process.cwd(), baselinePath)}`);
  console.log(`[w1] GATE ${failures.length === 0 ? "GREEN" : "RED"}${failures.length ? " — " + failures.join(" | ") : ""}`);
  if (failures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error("W1 BENCHMARK FAILED:", err);
  process.exit(1);
});

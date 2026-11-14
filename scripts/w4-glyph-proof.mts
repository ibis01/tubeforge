#!/usr/bin/env node
/**
 * W4 — the glyph-text proof (S120 §3 W4 slice 2's exit gate).
 *
 * The roadmap pin: "glyph text renders at all 3 aspects with pen riding
 * glyphs; readability check enforced". This script renders a project whose
 * scenes USE the glyph-mode asset (glyph-note — the ONLY built-in with
 * textMode:"glyph") through the REAL engine (validate → chromium → ffmpeg)
 * at all three house aspects, beside a marker-mode text card in the SAME
 * scene (both text modes coexist), and runs the full house QC battery.
 *
 * Three layers of evidence per aspect:
 *   - STRUCTURAL (pre-render): the engine's own schedule (beatSceneEvents —
 *     the exact call the render loop makes) emits draw_path rows for the
 *     glyph contours and NO write_text row for the glyph asset, while the
 *     marker card still rides write_text; every contour is a single-subpath
 *     draw (the S67 seam law); checkReadability passes at the aspect's
 *     placement through the 12px wall.
 *   - PIXEL (post-render): inside a gate window that excludes the asset's
 *     underline and the resting hand, the frame is near-blank BEFORE the
 *     first glyph row starts and carries the word's ink AFTER the last one
 *     ends (delta ≥ 2% of the window) — the letters appear by the pen lane,
 *     not by a wipe. Evidence JPEGs (full frame + the word crop at
 *     before/mid/after) land beside the receipt.
 *   - PREVIEW (the editor pass): the coexist scene's settled frame applied
 *     through the SHARED wb-page applier (APPLY_FRAME_FN — the same seam the
 *     studio's playback canvas rides) and screenshotted.
 *
 * Determinism pin (16:9, --no-repeat to skip): the render runs TWICE and
 * the probe frames' raw-RGB hashes must be byte-identical.
 *
 * Receipts land in validation/w4/ (gitignored); the committed prose receipt
 * is docs/audits/w4-glyph-text.md. The W1 baseline stays untouched — this
 * project never enters the frozen benchmark definition.
 *
 *   node --import tsx scripts/w4-glyph-proof.mts
 *   node --import tsx scripts/w4-glyph-proof.mts --aspects 16:9
 *   node --import tsx scripts/w4-glyph-proof.mts --no-repeat
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
  type W1AspectId,
} from "../src/lib/tubeforge/whiteboard/benchmark-scenarios";
import { loadLibrary } from "../src/lib/tubeforge/whiteboard/assets";
import { validateWhiteboardProject, type WhiteboardProject, type WhiteboardScene } from "../src/lib/tubeforge/whiteboard/storyboard";
import { buildGeometry, frameAt, TEXT_ANCHORS, type AssetGeometry } from "../src/lib/tubeforge/whiteboard/timing";
import { checkReadability } from "../src/lib/tubeforge/whiteboard/text-draw";
import { beatSceneEvents } from "../src/lib/tubeforge/whiteboard/beat-plan";
import { composeScene, framePayload, APPLY_FRAME_FN } from "../src/lib/tubeforge/whiteboard/wb-page";
import { renderWhiteboard, probeDurationSec, WB_CHROMIUM_LAUNCH_ARGS } from "../src/lib/tubeforge/whiteboard/render";
import { runQcReport } from "../src/lib/tubeforge/qc";
import { bedExpression, ORIGINAL_LIBRARY } from "../src/lib/tubeforge/music";

const execFileP = promisify(execFile);
const OUT_DIR = path.resolve("validation/w4");

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

// ---------------------------------------------------------------------------
// The proof project — PURE, deterministic, explicit durations (the W1
// determinism anchor: no VO dependency, the clock is the same every run).
// Two scenes; glyph-note rides BOTH (coexisting with a marker-mode text
// card in one scene, and with an ordinary path asset in the other).
// ---------------------------------------------------------------------------

/** The proof assets' viewBox sizes (mirrored from assets.ts; the proof's
 *  placement arithmetic is pinned to them by the crop windows below). */
const VB = {
  "title-hero": { w: 800, h: 200 },
  "glyph-note": { w: 240, h: 120 },
  "check-badge": { w: 200, h: 200 },
} as const;

interface ProofPlacement {
  assetId: keyof typeof VB;
  x: number;
  y: number;
  scale: number;
  order: number;
}

/** Per-aspect placements — hand-fitted inside every canvas with margins
 *  (the W1 lesson: the mapped rects must sit inside the frame at 16:9,
 *  9:16 AND 1:1, and the unit battery would reject a stray rect). */
const PLACEMENTS: Record<W1AspectId, { coexist: ProofPlacement[]; solo: ProofPlacement[] }> = {
  "16:9": {
    coexist: [
      { assetId: "title-hero", x: 440, y: 140, scale: 1.3, order: 0 },
      { assetId: "glyph-note", x: 744, y: 560, scale: 1.8, order: 1 },
    ],
    solo: [
      { assetId: "check-badge", x: 800, y: 160, scale: 1.6, order: 0 },
      { assetId: "glyph-note", x: 744, y: 620, scale: 1.8, order: 1 },
    ],
  },
  "9:16": {
    coexist: [
      { assetId: "title-hero", x: 140, y: 560, scale: 1.0, order: 0 },
      { assetId: "glyph-note", x: 372, y: 1000, scale: 1.4, order: 1 },
    ],
    solo: [
      { assetId: "check-badge", x: 410, y: 600, scale: 1.3, order: 0 },
      { assetId: "glyph-note", x: 372, y: 1100, scale: 1.4, order: 1 },
    ],
  },
  "1:1": {
    coexist: [
      { assetId: "title-hero", x: 180, y: 220, scale: 0.9, order: 0 },
      { assetId: "glyph-note", x: 384, y: 560, scale: 1.3, order: 1 },
    ],
    solo: [
      { assetId: "check-badge", x: 420, y: 200, scale: 1.2, order: 0 },
      { assetId: "glyph-note", x: 384, y: 620, scale: 1.3, order: 1 },
    ],
  },
};

const SCENE_DURATIONS = { coexist: 7000, solo: 6400 } as const;

function proofScene(
  id: string,
  kind: "coexist" | "solo",
  aspect: W1AspectId
): WhiteboardScene {
  return {
    id: `w4-${kind}`,
    narration:
      kind === "coexist"
        ? "Handwritten text is drawn stroke by stroke, right on the board."
        : "The same hand draws every glyph it writes.",
    durationMs: SCENE_DURATIONS[kind],
    background: "#ffffff",
    placements: PLACEMENTS[aspect][kind].map((p) => ({
      assetId: p.assetId,
      placement: { x: p.x, y: p.y, scale: p.scale, rotateDeg: 0 },
      order: p.order,
    })),
    animations: [],
    camera: [],
  };
}

function buildProofProject(aspect: W1AspectId): WhiteboardProject {
  const { width, height } = W1_ASPECTS[aspect];
  return {
    title: "W4 glyph-text proof — the glyph mode renders through the real engine",
    width,
    height,
    fps: W1_FPS,
    hand: { style: "marker", scale: 1 },
    scenes: [proofScene("w4-coexist", "coexist", aspect), proofScene("w4-solo", "solo", aspect)],
  };
}

// ---------------------------------------------------------------------------
// Frame decoding + region ink analysis (the W1 harness's raw-RGB pattern,
// narrowed to a region: the decoded buffer is plain RGB24, so a crop is
// index arithmetic — no re-encode, no codec opinion).
// ---------------------------------------------------------------------------

interface RegionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

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

/** Dark-pixel ratio (luma < 128) inside one region of a raw RGB frame. */
function regionDarkRatio(buf: Buffer, frameW: number, rect: RegionRect): number {
  let dark = 0;
  let total = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = (y * frameW + x) * 3;
      const luma = 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
      if (luma < 128) dark += 1;
      total += 1;
    }
  }
  return total > 0 ? dark / total : 0;
}

function clampRect(rect: RegionRect, w: number, h: number): RegionRect {
  const x = Math.max(0, Math.min(Math.round(rect.x), w - 1));
  const y = Math.max(0, Math.min(Math.round(rect.y), h - 1));
  return {
    x,
    y,
    w: Math.max(1, Math.min(Math.round(rect.w), w - x)),
    h: Math.max(1, Math.min(Math.round(rect.h), h - y)),
  };
}

async function saveFrameJpeg(file: string, tSec: number, out: string, crop?: RegionRect): Promise<void> {
  const vf = crop
    ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`
    : "null";
  await execFileP("ffmpeg", [
    "-y", "-v", "error",
    "-ss", tSec.toFixed(3), "-i", file,
    "-frames:v", "1", "-vf", vf, "-q:v", "2", out,
  ]);
}

// ---------------------------------------------------------------------------
// The house music bed (the W1/W5 pattern): the QC battery's playable
// contract is H.264 + AAC; a solo bed carries the program at full level.
// ---------------------------------------------------------------------------

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

function chromiumReceipt(): string {
  try {
    const cache = path.join(os.homedir(), ".cache", "ms-playwright");
    const hits = fs.readdirSync(cache).filter((d) => d.includes("chromium"));
    return hits.length ? hits.join(", ") : "no ms-playwright chromium cache found";
  } catch {
    return "ms-playwright cache unreadable";
  }
}

// ---------------------------------------------------------------------------
// The glyph probe: from the ENGINE'S OWN schedule (beatSceneEvents — the
// exact call render.ts makes), find the glyph contour rows and derive the
// before/mid/after probe times + the two crop windows.
// ---------------------------------------------------------------------------

interface GlyphProbePlan {
  sceneId: string;
  glyphRows: { pathId: string; startMs: number; durationMs: number }[];
  glyphWriteTextRows: number;
  markerTextRows: { textId: string; startMs: number; durationMs: number }[];
  tBeforeSec: number;
  tMidSec: number;
  tAfterSec: number;
  /** The full placement rect (the evidence JPEGs' crop). */
  evidenceRect: RegionRect;
  /** The gate window — asset-space x 35–150, y 5–85: the word "Idea"'s own
   *  region, EXCLUDING the underline (y≈94) and the resting-hand parking
   *  spot at the underline's end (x≥192). Gates read THIS rect. */
  gateRect: RegionRect;
}

function planGlyphProbe(
  scene: WhiteboardScene,
  durationMs: number,
  geometry: Map<string, AssetGeometry>,
  assetTags: Map<string, string[]>,
  width: number,
  height: number
): GlyphProbePlan {
  const events = beatSceneEvents(scene, durationMs, geometry, assetTags);
  const glyphRows = events
    .filter((e) => e.type === "draw_path" && e.assetId === "glyph-note" && e.pathId.startsWith("gn-word-g"))
    .map((e) => ({ pathId: (e as { pathId: string }).pathId, startMs: e.startMs, durationMs: e.durationMs }))
    .sort((a, b) => a.startMs - b.startMs);
  const markerTextRows = events
    .filter((e) => e.type === "write_text" && e.assetId === "title-hero")
    .map((e) => ({ textId: (e as { textId: string }).textId, startMs: e.startMs, durationMs: e.durationMs }));
  if (glyphRows.length < 4) {
    throw new Error(`[${scene.id}] the engine schedule has ${glyphRows.length} glyph contour rows — the pen is not riding the glyphs`);
  }
  if (markerTextRows.length === 0) {
    throw new Error(`[${scene.id}] the marker-mode card lost its write_text rows — coexistence broken`);
  }
  const glyphWriteTextRows = events.filter(
    (e) => e.type === "write_text" && e.assetId === "glyph-note"
  ).length;
  if (glyphWriteTextRows > 0) {
    throw new Error(`[${scene.id}] the glyph asset still carries ${glyphWriteTextRows} write_text rows — the wipe law is drawing the glyphs, not the pen`);
  }
  const first = glyphRows[0];
  const last = glyphRows[glyphRows.length - 1];
  const tBeforeMs = Math.max(200, first.startMs - 20);
  const drawEndMs = last.startMs + last.durationMs;
  const tAfterMs = Math.min(durationMs - 150, drawEndMs + 250);
  const tMidMs = first.startMs + (drawEndMs - first.startMs) / 2;
  const pl = scene.placements.find((p) => p.assetId === "glyph-note");
  if (!pl) throw new Error(`[${scene.id}] no glyph-note placement`);
  const s = pl.placement.scale;
  return {
    sceneId: scene.id,
    glyphRows,
    glyphWriteTextRows,
    markerTextRows,
    tBeforeSec: tBeforeMs / 1000,
    tMidSec: tMidMs / 1000,
    tAfterSec: tAfterMs / 1000,
    evidenceRect: clampRect({ x: pl.placement.x, y: pl.placement.y, w: VB["glyph-note"].w * s, h: VB["glyph-note"].h * s }, width, height),
    gateRect: clampRect({ x: pl.placement.x + 35 * s, y: pl.placement.y + 5 * s, w: 115 * s, h: 80 * s }, width, height),
  };
}

// ---------------------------------------------------------------------------
// Per-aspect proof.
// ---------------------------------------------------------------------------

interface AspectProof {
  aspect: W1AspectId;
  dim: string;
  durationSec: number;
  decodedFrames: number | null;
  expectedFrames: number;
  renderWallMs: number;
  structural: {
    glyphContours: number;
    singleSubpath: boolean;
    glyphDrawRows: number;
    glyphWriteTextRows: number;
    markerTextRows: string[];
    readability: { ok: boolean; renderedPx: number; threshold: number };
  };
  probe: {
    tBeforeSec: number;
    tMidSec: number;
    tAfterSec: number;
    gateRect: RegionRect;
    beforeDark: number;
    midDark: number;
    afterDark: number;
    delta: number;
    probeHashes: string[];
  };
  qc: { passed: boolean; failing: string[]; unmeasured: string[] };
}

async function proveAspect(aspect: W1AspectId, runLabel: string): Promise<AspectProof> {
  const { width, height } = W1_ASPECTS[aspect];
  const project = buildProofProject(aspect);
  const lib = loadLibrary();
  const geometry = buildGeometry([...lib.extracted.entries()].map(([id, ex]) => ({ id, paths: ex.paths })));
  const assetTags = new Map<string, string[]>([...lib.assets.values()].map((a) => [a.id, a.tags]));

  // --- STRUCTURAL LAYER (pre-render; a failure here throws, never renders) ---
  // 1. The glyph asset registered as PATHS: contours present, the text gone,
  //    each contour ONE subpath (the S67 seam law), the anchor kept alive.
  const ex = lib.extracted.get("glyph-note");
  if (!ex) throw new Error("glyph-note missing from the extracted library");
  const glyphPaths = ex.paths.filter((p) => p.id.startsWith("gn-word-g"));
  if (glyphPaths.length < 4) throw new Error(`glyph-note registered ${glyphPaths.length} glyph contours — the transform did not land`);
  const singleSubpath = glyphPaths.every((p) => (p.d.match(/M/g) ?? []).length === 1);
  if (!singleSubpath) throw new Error("a glyph contour carries multiple M commands — the S67 single-subpath seam law is broken");
  if (ex.texts.some((t) => t.id === "gn-word")) throw new Error("gn-word still registered as a <text> — the transform did not consume it");
  if (!TEXT_ANCHORS.has("glyph-note::gn-word")) throw new Error("the replaced text's anchor is missing — readability would fly blind");

  // 2. The coexist scene's placements pass the readability wall per aspect.
  const coexist = project.scenes[0];
  const pl = coexist.placements.find((p) => p.assetId === "glyph-note");
  if (!pl) throw new Error("no glyph-note placement in the coexist scene");
  const readability = checkReadability(
    { assetId: "glyph-note", textId: "gn-word", placementScale: pl.placement.scale },
    { zoom: 1 },
    { width, sceneWidth: width }
  );
  if (!readability.ok) {
    throw new Error(`[${aspect}] glyph text fails the readability wall: ${readability.reason ?? "?"}`);
  }

  // 3. The probe plan reads the ENGINE'S OWN schedule (throws on any break).
  const probe = planGlyphProbe(coexist, SCENE_DURATIONS.coexist, geometry, assetTags, width, height);

  // --- VALIDATE + RENDER (the real engine, chromium + ffmpeg) ---
  const { project: valid, errors } = validateWhiteboardProject(project, lib.libraryIndex);
  if (!valid) throw new Error(`[${aspect}] proof project failed validation: ${errors.join(" · ")}`);

  const outDir = path.join(OUT_DIR, `${aspect.replace(":", "x")}${runLabel}`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "project.json"), JSON.stringify(valid, null, 2));

  const t0 = Date.now();
  const result = await renderWhiteboard(valid, {
    outDir,
    musicPath: path.join(OUT_DIR, "bed.flac"),
    onProgress: (l, frac) => {
      const pct = Math.round(frac * 100);
      if (pct % 50 === 0) console.log(`  [${aspect}${runLabel}] ${pct}% ${l}`);
    },
  });
  const renderWallMs = Date.now() - t0;

  const durSec = (await probeDurationSec(result.file)) ?? 0;
  const expectedFrames = result.scenes.reduce((a, s) => a + s.frames, 0);
  const decoded = await decodedFrameCount(result.file);

  // --- PIXEL LAYER: the word region goes from near-blank to inked. ---
  const framesDir = path.join(outDir, "probe");
  fs.mkdirSync(framesDir, { recursive: true });
  const beforeBuf = await decodeFrameRgb(result.file, probe.tBeforeSec, width, height);
  const midBuf = await decodeFrameRgb(result.file, probe.tMidSec, width, height);
  const afterBuf = await decodeFrameRgb(result.file, probe.tAfterSec, width, height);
  const beforeDark = regionDarkRatio(beforeBuf, width, probe.gateRect);
  const midDark = regionDarkRatio(midBuf, width, probe.gateRect);
  const afterDark = regionDarkRatio(afterBuf, width, probe.gateRect);
  await saveFrameJpeg(result.file, probe.tBeforeSec, path.join(framesDir, "word-before.jpg"), probe.evidenceRect);
  await saveFrameJpeg(result.file, probe.tMidSec, path.join(framesDir, "word-mid.jpg"), probe.evidenceRect);
  await saveFrameJpeg(result.file, probe.tAfterSec, path.join(framesDir, "word-after.jpg"), probe.evidenceRect);
  await saveFrameJpeg(result.file, probe.tAfterSec, path.join(framesDir, "full-after.jpg"));

  // --- QC BATTERY (the house lenses; the three-state contract: no MEASURED
  // failure — cut-alignment honestly reports unmeasured on a doc-less render). ---
  const qc = await runQcReport({
    mp4Path: result.file,
    videoDuration: durSec,
    narrationSec: null,
    srtPath: null,
    expectedAspect: aspect,
    frameRate: W1_FPS,
  });
  const failing = (qc.checks ?? []).filter((c) => c.status === "fail").map((c) => c.id);
  const unmeasured = (qc.checks ?? []).filter((c) => c.status === "unmeasured").map((c) => c.id);
  console.log(
    `  [${aspect}${runLabel}] ${durSec.toFixed(1)}s, wall ${(renderWallMs / 1000).toFixed(0)}s, ` +
    `probe before ${(beforeDark * 100).toFixed(2)}% → after ${(afterDark * 100).toFixed(2)}% (Δ ${((afterDark - beforeDark) * 100).toFixed(2)}%), ` +
    `qc ${failing.length === 0 ? "GREEN" : `FAIL(${failing.join(",")})`}${unmeasured.length ? ` [unmeasured: ${unmeasured.join(",")}]` : ""}`
  );

  return {
    aspect,
    dim: `${width}x${height}`,
    durationSec: Number(durSec.toFixed(2)),
    decodedFrames: decoded,
    expectedFrames,
    renderWallMs,
    structural: {
      glyphContours: glyphPaths.length,
      singleSubpath,
      glyphDrawRows: probe.glyphRows.length,
      glyphWriteTextRows: probe.glyphWriteTextRows,
      markerTextRows: probe.markerTextRows.map((r) => r.textId),
      readability: { ok: readability.ok, renderedPx: readability.renderedPx, threshold: readability.threshold },
    },
    probe: {
      tBeforeSec: Number(probe.tBeforeSec.toFixed(3)),
      tMidSec: Number(probe.tMidSec.toFixed(3)),
      tAfterSec: Number(probe.tAfterSec.toFixed(3)),
      gateRect: probe.gateRect,
      beforeDark: Number(beforeDark.toFixed(5)),
      midDark: Number(midDark.toFixed(5)),
      afterDark: Number(afterDark.toFixed(5)),
      delta: Number((afterDark - beforeDark).toFixed(5)),
      probeHashes: [sha256(beforeBuf), sha256(midBuf), sha256(afterBuf)],
    },
    qc: { passed: failing.length === 0, failing, unmeasured },
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

// ---------------------------------------------------------------------------
// The editor-preview pass: the coexist scene's settled frame applied through
// the SHARED wb-page applier (APPLY_FRAME_FN — the exact seam the studio's
// playback canvas rides), hand included, screenshotted at 16:9.
// ---------------------------------------------------------------------------

async function previewPass(): Promise<{ file: string; glyphPathEls: number; markerTextEls: number }> {
  const { width, height } = W1_ASPECTS["16:9"];
  const aspect: W1AspectId = "16:9";
  const project = buildProofProject(aspect);
  const lib = loadLibrary();
  const geometry = buildGeometry([...lib.extracted.entries()].map(([id, ex]) => ({ id, paths: ex.paths })));
  const assetTags = new Map<string, string[]>([...lib.assets.values()].map((a) => [a.id, a.tags]));
  const handAsset = lib.assets.get("hand-marker");
  if (!handAsset) throw new Error("hand-marker asset missing from the library");

  const scene = project.scenes[0];
  const dur = SCENE_DURATIONS.coexist;
  const events = beatSceneEvents(scene, dur, geometry, assetTags);
  const composed = composeScene(scene, project, lib.assets);

  // The namespaced element ids: the glyph contours and the marker card's
  // texts must BOTH be present in the preview's element maps (coexistence
  // at the page seam — the S65 asset-prefix law is the only `--`).
  const glyphPathEls = [...composed.pathEls.keys()].filter((k) => k.startsWith("glyph-note::gn-word-g")).length;
  const markerTextEls = [...composed.textEls.keys()].filter((k) => k.startsWith("title-hero::text:")).length;
  if (glyphPathEls < 4) throw new Error("the composed preview page is missing the glyph contour elements");
  if (markerTextEls < 2) throw new Error("the composed preview page is missing the marker card's text elements");

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true, args: [...WB_CHROMIUM_LAUNCH_ARGS] });
  try {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(composed.html, { waitUntil: "load" });
    // The engine's setup pass (render.ts, verbatim shape): defs root, hand
    // asset, dasharrays from OUR geometry, everything hidden, index maps.
    await page.evaluate(
      ({ handSvg, drawIndex, textIndex }) => {
        const board = document.getElementById("board");
        const handAssetEl = document.getElementById("hand-asset");
        const hand = document.getElementById("hand");
        if (!board || !handAssetEl || !hand) throw new Error("preview page is missing the board/hand roots");
        const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
        defs.id = "defs-root";
        board.appendChild(defs);
        handAssetEl.innerHTML = handSvg;
        const w = window as unknown as { __wbDraw?: Map<string, string>; __wbText?: Map<string, string> };
        w.__wbDraw = new Map(drawIndex);
        w.__wbText = new Map(textIndex);
      },
      { handSvg: handAsset.svg, drawIndex: [...composed.pathEls], textIndex: [...composed.textEls] }
    );
    for (const [key, elId] of composed.pathEls) {
      const [assetId, pathId] = key.split("::");
      const segs = geometry.get(assetId)?.paths.get(pathId);
      if (!segs) continue;
      let len = 0;
      for (const g of segs) len += g.lengths[g.lengths.length - 1] ?? 0;
      await page.evaluate(
        ({ elId, len }) => {
          const el = document.getElementById(elId);
          if (!el) return;
          el.dataset.len = String(len);
          el.setAttribute("stroke-dasharray", `${len} ${len}`);
          el.setAttribute("stroke-dashoffset", String(len));
          el.style.opacity = "0";
        },
        { elId, len }
      );
    }
    for (const [, elId] of composed.textEls) {
      await page.evaluate((elId) => {
        const el = document.getElementById(elId);
        if (el) el.style.opacity = "0";
      }, elId);
    }
    // The settled frame: the LAST probe time of the coexist scene — every
    // glyph drawn, the hand parked on the word, via the shared applier.
    const tAfter = Math.min(dur - 150, Math.max(...events.filter((e) => e.type === "draw_path" && e.assetId === "glyph-note").map((e) => e.startMs + e.durationMs)) + 250);
    const frame = frameAt(project, scene, events, geometry, tAfter);
    await page.evaluate(`(${APPLY_FRAME_FN})(${JSON.stringify(framePayload(frame, width, height))})`);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, "preview-16x9.jpg");
    await page.screenshot({ path: file, type: "jpeg", quality: 92, clip: { x: 0, y: 0, width, height } });
    console.log(`  [preview] the coexist scene's settled frame via APPLY_FRAME_FN → ${path.relative(process.cwd(), file)} (glyph els: ${glyphPathEls}, marker texts: ${markerTextEls})`);
    return { file, glyphPathEls, markerTextEls };
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--aspects");
  const wanted = idx !== -1 && args[idx + 1] ? (args[idx + 1].split(",") as W1AspectId[]) : W1_ASPECT_IDS;
  const bad = wanted.filter((a) => !W1_ASPECT_IDS.includes(a));
  if (bad.length > 0) throw new Error(`unknown aspects: ${bad.join(", ")}`);
  const repeat = !args.includes("--no-repeat");

  const totalMs = SCENE_DURATIONS.coexist + SCENE_DURATIONS.solo;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await synthBed(path.join(OUT_DIR, "bed.flac"), totalMs / 1000);
  console.log(`[w4] glyph-text proof — scenes ${totalMs / 1000}s × aspects ${wanted.join(", ")} @ ${W1_FPS}fps`);

  const proofs: AspectProof[] = [];
  for (const aspect of wanted) {
    console.log(`\n[w4] rendering ${aspect} (${W1_ASPECTS[aspect].width}x${W1_ASPECTS[aspect].height})…`);
    proofs.push(await proveAspect(aspect, ""));
  }

  // The determinism pin — 16:9 renders twice; the probe frames' raw-RGB
  // hashes must match (the engine law this proof rides is aspect-independent).
  let determinism: { aspect: W1AspectId; sampleHashesIdentical: boolean; framesIdentical: boolean } | null = null;
  if (repeat && wanted.includes("16:9")) {
    console.log("\n[w4] determinism pin — re-rendering 16:9…");
    const second = await proveAspect("16:9", "-r2");
    const first = proofs.find((p) => p.aspect === "16:9");
    if (first) {
      determinism = {
        aspect: "16:9",
        sampleHashesIdentical: JSON.stringify(first.probe.probeHashes) === JSON.stringify(second.probe.probeHashes),
        framesIdentical: first.expectedFrames === second.expectedFrames,
      };
      console.log(`[w4] determinism pin: hashes ${determinism.sampleHashesIdentical ? "IDENTICAL" : "DIVERGED"}, frame counts ${determinism.framesIdentical ? "identical" : "DIVERGED"}`);
    }
  }

  // The editor-preview pass (16:9, once).
  const preview = await previewPass();

  // ---------------------------------------------------------------------------
  // The gate — hard receipts or slice 2 does not close.
  // ---------------------------------------------------------------------------
  const failures: string[] = [];
  const expectedSec = totalMs / 1000;
  for (const p of proofs) {
    if (Math.abs(p.durationSec - expectedSec) > 0.5)
      failures.push(`${p.aspect}: duration ${p.durationSec}s ≠ expected ${expectedSec}s (±0.5)`);
    if (p.decodedFrames === null || Math.abs(p.decodedFrames - p.expectedFrames) > p.expectedFrames * 0.02)
      failures.push(`${p.aspect}: decoded ${p.decodedFrames} frames vs expected ${p.expectedFrames} (±2%)`);
    if (!p.structural.singleSubpath) failures.push(`${p.aspect}: a glyph contour broke the single-subpath seam law`);
    if (p.structural.glyphDrawRows < 4) failures.push(`${p.aspect}: only ${p.structural.glyphDrawRows} glyph draw rows`);
    if (p.structural.markerTextRows.length < 2)
      failures.push(`${p.aspect}: the marker card lost its write_text rows (${p.structural.markerTextRows.join(", ")})`);
    if (p.structural.glyphWriteTextRows > 0)
      failures.push(`${p.aspect}: the glyph asset carries ${p.structural.glyphWriteTextRows} write_text rows — the wipe law is drawing the glyphs`);
    if (!p.structural.readability.ok) failures.push(`${p.aspect}: readability wall failed`);
    if (p.probe.beforeDark > 0.06)
      failures.push(`${p.aspect}: the word window already carried ${(p.probe.beforeDark * 100).toFixed(2)}% ink BEFORE the first glyph row`);
    if (p.probe.delta < 0.02)
      failures.push(`${p.aspect}: the word window gained only ${(p.probe.delta * 100).toFixed(2)}% ink across the glyph draw (≥ 2% required)`);
    if (p.qc.failing.length > 0) failures.push(`${p.aspect}: qc fails — ${p.qc.failing.join(", ")}`);
  }
  if (determinism && !determinism.sampleHashesIdentical)
    failures.push("determinism pin: 16:9 probe hashes DIVERGED between runs");
  if (!fs.existsSync(preview.file)) failures.push("preview: the settled-frame screenshot did not land");

  const receipt = {
    stage: "W4",
    kind: "glyph-text-proof",
    recordedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      ffmpeg: await execFileP("ffmpeg", ["-version"]).then((r) => r.stdout.split("\n")[0]).catch(() => "unavailable"),
      chromium: chromiumReceipt(),
    },
    project: {
      scenes: ["w4-coexist (title-hero marker-mode + glyph-note glyph-mode)", "w4-solo (check-badge + glyph-note)"],
      durationsMs: SCENE_DURATIONS,
      fps: W1_FPS,
    },
    aspects: proofs,
    determinism,
    preview: { ...preview, applier: "wb-page APPLY_FRAME_FN (the editor playback seam)" },
    gate: { passed: failures.length === 0, failures },
  };
  fs.writeFileSync(path.join(OUT_DIR, "w4-glyph-proof.json"), JSON.stringify(receipt, null, 2));

  console.log(`\n[w4] receipt → validation/w4/w4-glyph-proof.json`);
  console.log(`[w4] GATE ${failures.length === 0 ? "GREEN" : "RED"}${failures.length ? " — " + failures.join(" | ") : ""}`);
  if (failures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error("W4 GLYPH PROOF FAILED:", err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * P0 — the whiteboard raster-to-stroke battery (the plan's P0-9).
 *
 *   node --import tsx scripts/test-whiteboard-trace.mts
 *
 * The pins, in the plan's own order:
 *   1. DETERMINISM — identical fixture bytes → byte-identical svgFragment
 *      (the receipt's per-stage `ms` fields are the only non-deterministic
 *      field; the pin compares the FRAGMENT + the receipt minus ms).
 *   2. STAGE PINS — skeletonize reduces a thick bar to a 1px centerline;
 *      junctions split strokes (an X never traces as one crossing stroke);
 *      Douglas-Peucker preserves endpoints; ordering is reading-order
 *      stable (top bands first, long structural strokes first inside a band).
 *   3. BUDGET PINS — the cap drops shortest-first WITH a receipt; the
 *      window-aware per-placement cap arithmetic.
 *   4. VALIDATOR PINS — traced output passes the W3 validator; crafted
 *      multi-subpath geometry FAILS it (proving the split law's purpose);
 *      every emitted path is a single-subpath `M…L…` under the per-path
 *      budget.
 *   5. MAGIC-BYTE PINS — PNG/JPEG accepted; WebP/empty/truncated named
 *      readably; SVG input still rides the SVG gates; the quality gate
 *      refuses blank/photo-like sources with the useful explanation.
 *   6. SCHEDULER PINS — the traced cap excludes over-cap paths and fades
 *      them through reveal_color; absent split → byte-identical legacy
 *      schedule; tracedSplitForScene is null without traced tags.
 *   7. BENCHMARK SEED — buildTracedBenchmarkProject is deterministic and
 *      in-canvas; the five subject slots exist with their policy ids; the
 *      frozen W1 set is untouched.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import {
  TRACE_VIEWBOX_MAX,
  classifyQuality,
  followCenterlines,
  orderStrokes,
  skeletonize,
  simplifyPolyline,
  traceRasterToStrokes,
  type TraceResult,
} from "../src/lib/tubeforge/whiteboard/trace";
import {
  WB_TRACED_ITEM_FLOOR_MS,
  WB_TRACED_PATH_BUDGET,
  WB_TRACED_STROKES_PER_PLACEMENT,
  tracedCapForWindow,
} from "../src/lib/tubeforge/whiteboard/trace-budget";
import {
  validateUpload,
  validateUploadedRaster,
  validateUploadedSvg,
} from "../src/lib/tubeforge/whiteboard/upload";
import { validateAsset, checkTeleport } from "../src/lib/tubeforge/whiteboard/asset-validate";
import { countPathCommands } from "../src/lib/tubeforge/whiteboard/svg";
import {
  buildBenchmarkProject,
  buildTracedBenchmarkProject,
  W1_SCENE_IDS,
  W1_SUBJECT_SLOTS,
  W1_TRACED_FIXTURE,
  W1_TRACED_SCENE_ID,
} from "../src/lib/tubeforge/whiteboard/benchmark-scenarios";
import {
  scheduleScene,
  tracedSplitForScene,
  type AssetGeometry,
} from "../src/lib/tubeforge/whiteboard/timing";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

let passed = 0;
const failures: string[] = [];
async function pin(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  FAIL ${name}`);
    console.error(err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Synthetic raster fixtures — sharp renders tiny SVGs to deterministic bytes.
// ---------------------------------------------------------------------------

async function svgToPng(svg: string, density = 72): Promise<Buffer> {
  return sharp(Buffer.from(svg), { density }).png().toBuffer();
}

const svgBar = `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="80"><rect width="220" height="80" fill="white"/><rect x="30" y="20" width="160" height="16" fill="black"/></svg>`;

const svgX = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="white"/><rect x="10" y="72" width="140" height="14" fill="black" transform="rotate(45 80 80)"/><rect x="10" y="72" width="140" height="14" fill="black" transform="rotate(-45 80 80)"/></svg>`;

const svgDiagram = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320"><rect width="480" height="320" fill="white"/>
<rect x="40" y="60" width="120" height="80" fill="none" stroke="black" stroke-width="4"/>
<circle cx="330" cy="100" r="55" fill="none" stroke="black" stroke-width="4"/>
<path d="M 170 100 L 265 100" stroke="black" stroke-width="4" fill="none"/>
<path d="M 230 92 L 250 100 L 230 108" fill="none" stroke="black" stroke-width="4"/>
<path d="M 60 240 C 140 200, 240 280, 330 240 S 440 220, 440 240" fill="none" stroke="black" stroke-width="4"/>
<line x1="90" y1="170" x2="90" y2="230" stroke="black" stroke-width="4"/>
<line x1="90" y1="230" x2="60" y2="240" stroke="black" stroke-width="4"/>
</svg>`;

const svgBlank = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="150"><rect width="200" height="150" fill="white"/></svg>`;

/** Photo-like: heavy random speckle (deterministic LCG, not Math.random). */
function svgNoise(): string {
  let seed = 0x2f6e2b1;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  let rects = "";
  for (let i = 0; i < 900; i++) {
    const x = Math.floor(rnd() * 190);
    const y = Math.floor(rnd() * 140);
    const s = 1 + Math.floor(rnd() * 3);
    const g = Math.floor(rnd() * 120);
    rects += `<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="rgb(${g},${g},${g})"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="150"><rect width="200" height="150" fill="white"/>${rects}</svg>`;
}

const receiptWithoutMs = (r: TraceResult) => {
  const { ms: _ms, ...rest } = r.receipt;
  return { fragment: r.svgFragment, viewBox: r.viewBox, strokes: r.strokes, commands: r.commands, receipt: rest };
};

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("P0 whiteboard raster-to-stroke battery");

  const fixturePath = path.join(root, W1_TRACED_FIXTURE);
  const hasFixture = fs.existsSync(fixturePath);

  // ------------------------------------------------------------------
  // 1. Determinism
  // ------------------------------------------------------------------
  let fixtureBytes: Buffer | null = null;
  await pin("determinism: committed fixture traces byte-identically twice", async () => {
    assert.ok(hasFixture, `the committed fixture is missing: ${W1_TRACED_FIXTURE}`);
    fixtureBytes = fs.readFileSync(fixturePath);
    const a = await traceRasterToStrokes(fixtureBytes);
    const b = await traceRasterToStrokes(fixtureBytes);
    assert.equal(a.svgFragment, b.svgFragment);
    assert.deepEqual(receiptWithoutMs(a), receiptWithoutMs(b));
    assert.ok(a.strokes >= 5, `the fixture traces to real linework (got ${a.strokes} strokes)`);
  });

  await pin("determinism: the traced fragment passes the W3 validator", async () => {
    const r = await traceRasterToStrokes(fixtureBytes as Buffer);
    const report = validateAsset({
      id: "fixture",
      viewBox: r.viewBox,
      tags: ["upload", "traced"],
      svg: r.svgFragment,
    });
    assert.ok(report.ok, `validator findings: ${report.findings.map((f) => `${f.check}:${f.reason}`).join(" · ")}`);
  });

  // ------------------------------------------------------------------
  // 2. Stage pins
  // ------------------------------------------------------------------
  await pin("stage: skeletonize reduces a 16px bar to a 1px centerline", async () => {
    const png = await svgToPng(svgBar);
    const { data, info } = await sharp(png).grayscale().raw().toBuffer({ resolveWithObject: true });
    const mask = new Uint8Array(info.width * info.height);
    for (let i = 0; i < mask.length; i++) mask[i] = (data as Uint8Array)[i] < 128 ? 1 : 0;
    const { skel } = skeletonize(mask, info.width, info.height);
    // Every remaining pixel must have ≤ 2 skeleton neighbors (a 1px line).
    let maxDeg = 0;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const i = y * info.width + x;
        if (!skel[i]) continue;
        let d = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= info.width || ny >= info.height) continue;
            if (skel[ny * info.width + nx]) d++;
          }
        if (d > maxDeg) maxDeg = d;
      }
    }
    assert.ok(maxDeg <= 2, `skeleton kept a thick region (max degree ${maxDeg})`);
    const { strokes } = followCenterlines(skel, info.width, info.height);
    assert.equal(strokes.length, 1, `a single bar traces as ONE stroke (got ${strokes.length})`);
  });

  await pin("stage: an X crossing splits at the junction (never one crossing stroke)", async () => {
    const png = await svgToPng(svgX);
    const r = await traceRasterToStrokes(png);
    assert.ok(r.receipt.junctions >= 1, "the X produces junction pixels");
    assert.ok(r.strokes >= 3, `the X traces as ≥3 strokes (got ${r.strokes})`);
    // Every emitted path is single-M (the teleport law's precondition).
    for (const m of r.svgFragment.matchAll(/<path id="tr-\d+" d="([^"]+)"/g)) {
      assert.equal((m[1].match(/M /g) ?? []).length, 1, `path has one M: ${m[1].slice(0, 40)}`);
    }
  });

  await pin("stage: Douglas-Peucker preserves endpoints exactly", () => {
    const pts = Array.from({ length: 40 }, (_, i) => ({ x: i, y: Math.round(10 * Math.sin(i / 4)) }));
    const out = simplifyPolyline(pts, 2);
    assert.deepEqual(out[0], pts[0]);
    assert.deepEqual(out[out.length - 1], pts[pts.length - 1]);
    assert.ok(out.length < pts.length, "simplification actually simplified");
  });

  await pin("stage: ordering is reading-order stable (top band first, long first inside a band)", () => {
    const strokes = [
      { points: [{ x: 10, y: 300 }, { x: 20, y: 300 }] }, // bottom band, short
      { points: [{ x: 10, y: 30 }, { x: 200, y: 30 }] }, // top band, long
      { points: [{ x: 5, y: 40 }, { x: 15, y: 40 }] }, // top band, short
    ];
    const ordered = orderStrokes(strokes, 320);
    assert.equal(ordered[0], strokes[1], "the long top-band stroke leads");
    assert.equal(ordered[1], strokes[2], "the short top-band stroke follows");
    assert.equal(ordered[2], strokes[0], "the bottom-band stroke trails");
  });

  // ------------------------------------------------------------------
  // 3. Budget pins
  // ------------------------------------------------------------------
  await pin("budget: the stroke cap drops shortest-first and records it", async () => {
    const r = await traceRasterToStrokes(fixtureBytes as Buffer, { maxStrokes: 5 });
    assert.equal(r.strokes, 5);
    assert.ok(r.receipt.droppedForCap > 0, "the receipt records the cap drop");
  });

  await pin("budget: every emitted path is a single M under the per-path budget", async () => {
    const r = await traceRasterToStrokes(fixtureBytes as Buffer);
    for (const m of r.svgFragment.matchAll(/<path id="tr-\d+" d="([^"]+)"/g)) {
      const cmds = countPathCommands(m[1]);
      assert.ok(cmds <= WB_TRACED_PATH_BUDGET, `path budget: ${cmds} ≤ ${WB_TRACED_PATH_BUDGET}`);
      assert.equal((m[1].match(/M /g) ?? []).length, 1);
    }
    assert.ok(r.commands <= 4096, `traced total budget: ${r.commands} ≤ 4096`);
  });

  await pin("budget: the window-aware cap arithmetic (trace-budget's one source)", () => {
    assert.equal(tracedCapForWindow(7000), Math.floor(7000 / WB_TRACED_ITEM_FLOOR_MS));
    assert.equal(tracedCapForWindow(600_000), WB_TRACED_STROKES_PER_PLACEMENT);
    assert.equal(tracedCapForWindow(120), 1, "a degenerate window still draws one stroke");
  });

  // ------------------------------------------------------------------
  // 4. Validator pins
  // ------------------------------------------------------------------
  await pin("validator: a crafted multi-subpath path FAILS the teleport check", () => {
    const finding = checkTeleport({ id: "multi", d: "M 0 0 L 10 10 M 20 10 L 30 0" });
    assert.equal(finding.ok, false);
    assert.equal(finding.check, "teleport");
  });

  await pin("validator: the upload gates refuse a traced-shaped multi-subpath SVG", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path id="p" d="M 0 0 L 50 50 M 50 0 L 0 50" fill="none" stroke="black"/></svg>`;
    const v = validateUploadedSvg(Buffer.from(svg), "multi.svg");
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.errors.join(" "), /teleport|separate strokes/);
  });

  // ------------------------------------------------------------------
  // 5. Magic-byte + quality pins
  // ------------------------------------------------------------------
  await pin("magic bytes: PNG traces through the unified validateUpload", async () => {
    const png = await svgToPng(svgDiagram);
    const v = await validateUpload(png, "diagram.png", new Set());
    assert.ok(v.ok, v.ok ? "" : v.errors.join(" · "));
    if (v.ok) {
      assert.deepEqual(v.asset.tags, ["upload", "traced"]);
      assert.ok(v.trace, "the receipt rides the ok branch");
      assert.equal(v.texts, 0);
    }
  });

  await pin("magic bytes: JPEG decodes through the raster branch", async () => {
    const jpeg = await sharp(Buffer.from(svgDiagram)).jpeg().toBuffer();
    const v = await validateUploadedRaster(jpeg, "diagram.jpg");
    assert.ok(v.ok, v.ok ? "" : v.errors.join(" · "));
    if (v.ok) assert.equal(v.trace?.sourceFormat, "jpeg");
  });

  await pin("magic bytes: WebP is refused with the readable format list", async () => {
    const webp = await sharp(Buffer.from(svgDiagram)).webp().toBuffer();
    const v = await validateUpload(webp, "photo.webp");
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.errors.join(" "), /PNG, JPEG or SVG/);
  });

  await pin("magic bytes: empty and truncated files name the failure", async () => {
    const empty = await validateUpload(Buffer.alloc(0), "x.png");
    assert.equal(empty.ok, false);
    if (!empty.ok) assert.match(empty.errors.join(" "), /empty/);
    // A valid magic + broken body → the decoder's readable error.
    const truncated = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 0x41)]);
    const t = await validateUploadedRaster(truncated, "broken.png");
    assert.equal(t.ok, false);
    if (!t.ok) assert.ok(t.errors[0].length > 10, "the error is readable");
  });

  await pin("quality gate: a blank image is refused with the explanation", async () => {
    const png = await svgToPng(svgBlank);
    const v = await validateUploadedRaster(png, "blank.png");
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.errors.join(" "), /blank|0 strokes/);
  });

  await pin("quality gate: photo-like noise is refused with the explanation", async () => {
    const png = await svgToPng(svgNoise());
    const v = await validateUploadedRaster(png, "photo.png");
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.errors.join(" "), /photo|noise|solid/);
    const r = await traceRasterToStrokes(png);
    assert.ok(
      ["dense", "noisy", "photo"].includes(r.receipt.quality) || r.strokes === 0,
      `the classifier reads noise as photo-like (got ${r.receipt.quality})`
    );
  });

  await pin("quality gate: classifyQuality's thresholds are the exported law", () => {
    assert.equal(classifyQuality(0.0001, 2), "blank");
    assert.equal(classifyQuality(0.9, 40), "dense");
    assert.equal(classifyQuality(0.1, 9000), "noisy");
    assert.equal(classifyQuality(0.1, 9000, 0.9), "noisy");
    assert.equal(classifyQuality(0.08, 600, 0.92), "noisy", "mid-density speckle (tiny-component grain) reads as noise");
    assert.equal(classifyQuality(0.08, 600, 0.1), "illustration", "the same census with real linework sizes stays acceptable");
    assert.equal(classifyQuality(0.4, 3000, 0.1), "photo");
    assert.equal(classifyQuality(0.03, 12), "icon");
    assert.equal(classifyQuality(0.1, 120), "line-art");
  });

  await pin("emit: the fragment's ids satisfy the namespace law", async () => {
    const png = await svgToPng(svgDiagram);
    const r = await traceRasterToStrokes(png);
    const ids = [...r.svgFragment.matchAll(/<path id="(tr-\d+)"/g)].map((m) => m[1]);
    assert.ok(ids.length >= 1);
    for (const id of ids) {
      assert.match(id, /^tr-\d+$/);
      assert.ok(!id.includes("--") && !id.includes("::"));
    }
    assert.equal(ids.length, new Set(ids).size, "ids are unique");
    assert.ok(r.viewBox.w >= 16 && r.viewBox.h >= 16, "the viewBox respects the 16px floor");
    assert.ok(r.viewBox.w <= TRACE_VIEWBOX_MAX || r.viewBox.h <= TRACE_VIEWBOX_MAX);
  });

  // ------------------------------------------------------------------
  // 6. Scheduler pins
  // ------------------------------------------------------------------
  const mkGeometry = (n: number): Map<string, AssetGeometry> => {
    const paths = new Map<string, AssetGeometry["paths"] extends Map<string, infer V> ? V : never>();
    for (let i = 0; i < n; i++) {
      paths.set(`p${i + 1}`, [{ points: [{ x: 0, y: i * 10 }, { x: 100, y: i * 10 }], lengths: [0, 100], closed: false }]);
    }
    const geo: AssetGeometry = { paths: paths as AssetGeometry["paths"], totalLen: n * 100 };
    return new Map([["t1", geo]]);
  };
  const scene = (assetId = "t1") => ({
    id: "scene-1",
    narration: "one two three four five six seven eight nine ten eleven twelve thirteen",
    placements: [{ assetId, placement: { x: 100, y: 100, scale: 1, rotateDeg: 0 } }],
    animations: [],
    camera: [],
  }) as Parameters<typeof scheduleScene>[0];

  await pin("scheduler: no traced tags → the split is null (legacy path)", () => {
    const split = tracedSplitForScene(scene(), mkGeometry(30), new Map([["t1", ["upload"]]]), 8000);
    assert.equal(split, null);
  });

  await pin("scheduler: the cap excludes over-cap paths and fades them via reveal_color", () => {
    const tags = new Map([["t1", ["upload", "traced"]]]);
    const geometry = mkGeometry(30);
    const split = tracedSplitForScene(scene(), geometry, tags, 8000);
    assert.ok(split, "a traced overflow produces a split");
    if (!split) return;
    // 8000ms window: [400, 7100] → 6700ms → cap 17.
    assert.equal(split.allowed.get("t1")?.size, tracedCapForWindow(6700));
    assert.equal(split.remainder.length, 30 - tracedCapForWindow(6700));
    const events = scheduleScene(scene(), 8000, geometry, undefined, { allowed: split.allowed, remainder: split.remainder });
    const draws = events.filter((e) => e.type === "draw_path");
    const fades = events.filter((e) => e.type === "reveal_color");
    assert.equal(draws.length, tracedCapForWindow(6700));
    assert.equal(fades.length, split.remainder.length);
    for (const f of fades) {
      assert.ok((f as { pathId?: string }).pathId, "the fade rides the per-path reveal_color grammar");
      assert.ok((f as { startMs: number }).startMs + (f as { durationMs: number }).durationMs <= 8000, "the fade never outlasts the scene clock");
    }
  });

  await pin("scheduler: an in-cap traced asset takes the byte-identical legacy schedule", () => {
    const tags = new Map([["t1", ["upload", "traced"]]]);
    const geometry = mkGeometry(10);
    const legacy = scheduleScene(scene(), 8000, geometry);
    const tracedEvents = scheduleScene(
      scene(),
      8000,
      geometry,
      undefined,
      (() => {
        const split = tracedSplitForScene(scene(), geometry, tags, 8000);
        return split ? { allowed: split.allowed, remainder: split.remainder } : undefined;
      })()
    );
    assert.deepEqual(tracedEvents, legacy, "no remainder → no deviation");
  });

  // ------------------------------------------------------------------
  // 7. Benchmark seed pins
  // ------------------------------------------------------------------
  await pin("benchmark: the traced seed builder is deterministic and in-canvas", () => {
    const r = hasFixture ? null : null;
    const assetInput = {
      assetId: "up-trace-fixture",
      svg: '<path id="tr-1" d="M 0 0 L 10 10"/>',
      viewBox: { w: 100, h: 60 },
      strokes: 1,
    };
    const a = buildTracedBenchmarkProject("16:9", assetInput);
    const b = buildTracedBenchmarkProject("16:9", assetInput);
    assert.deepEqual(a, b);
    assert.equal(a.scenes[0].id, W1_TRACED_SCENE_ID);
    for (const pl of a.scenes[0].placements) {
      assert.ok(pl.placement.x >= 0 && pl.placement.y >= 0);
      assert.ok(pl.placement.x < a.width && pl.placement.y < a.height);
    }
    void r;
  });

  await pin("benchmark: the five subject slots exist with their policy ids", () => {
    assert.equal(W1_SUBJECT_SLOTS.length, 5);
    const ids = W1_SUBJECT_SLOTS.map((s) => s.id);
    assert.deepEqual(ids, ["science", "engineering", "islamic-history", "business", "general-education"]);
    const islamic = W1_SUBJECT_SLOTS.find((s) => s.id === "islamic-history");
    assert.equal(islamic?.policyId, "islamic-history", "the I.8 constraint rides the slot");
    const science = W1_SUBJECT_SLOTS.find((s) => s.id === "science");
    assert.equal(science?.status, "active");
    assert.deepEqual([...(science?.scenarioIds ?? [])], [...W1_SCENE_IDS]);
  });

  await pin("benchmark: the frozen W1 set is untouched (5 scenes, deterministic build)", () => {
    assert.equal(W1_SCENE_IDS.length, 5);
    assert.deepEqual(buildBenchmarkProject("16:9"), buildBenchmarkProject("16:9"));
    assert.deepEqual(buildBenchmarkProject("9:16"), buildBenchmarkProject("9:16"));
  });

  // ------------------------------------------------------------------
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.error(`FAILED PINS: ${failures.join(" · ")}`);
    process.exit(1);
  }
  console.log("ALL CHECKS PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

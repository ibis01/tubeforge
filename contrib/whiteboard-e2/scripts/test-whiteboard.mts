#!/usr/bin/env node
/**
 * Whiteboard engine — E2 automated test suite (plan §9).
 *
 *   node --import tsx scripts/test-whiteboard.mts
 *   (also wired into package.json as `npm run test:whiteboard`)
 *
 * Coverage layers required by plan §9 and design §9:
 *   1. Unit       — geometry (parse, length, sample, tangent), easing, dash math
 *   2. Contract   — zod schemas accept valid, reject invalid, referential integrity
 *   3. Security   — malicious SVG rejected, path bombs rejected
 *   4. Integration— mini SVG → frames → ffmpeg → MP4 (real ffmpeg + real resvg)
 *   5. Determinism— two consecutive renderProject calls → identical sha256
 *   6. Regression— Director import surface untouched (structural check)
 *
 * Output: PASS/FAIL summary line per the plan §13 governance contract.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SCHEMA_VERSION,
  migrateProject,
  validateReferences,
  ReferentialIntegrityError,
  whiteboardProjectSchema,
  canonicalSerialize,
  buildSampleProject,
} from "../src/lib/tubeforge/whiteboard";
import { parsePath, samplePath, arcLength, pointAt, tangentAt, tangentAngleDeg, applyEasing, clamp } from "../src/lib/tubeforge/whiteboard";
import { validateSvg, assertSvgRejected, isSafeSvg } from "../src/lib/tubeforge/whiteboard";
import { extractAsset } from "../src/lib/tubeforge/whiteboard";
import { assetRegistry } from "../src/lib/tubeforge/whiteboard";
import { evaluateFrame, projectDurationMs } from "../src/lib/tubeforge/whiteboard";
import { composeFrameSvg } from "../src/lib/tubeforge/whiteboard";
import { rasterizeSvg } from "../src/lib/tubeforge/whiteboard";
import { renderProject, renderProjectToBuffer } from "../src/lib/tubeforge/whiteboard";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    // console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq<T>(name: string, actual: T, expected: T, detail?: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, detail ?? `expected ${e}, got ${a}`);
}
function throws(name: string, fn: () => void, msgContains?: string) {
  let threw = false;
  let msg = "";
  try { fn(); } catch (e) { threw = true; msg = (e as Error).message; }
  ok(name, threw, threw ? undefined : "expected to throw");
  if (threw && msgContains && !msg.toLowerCase().includes(msgContains.toLowerCase())) {
    ok(`${name} (message mentions "${msgContains}")`, false, `got: ${msg}`);
  }
}

// ============================================================
// 1. UNIT — geometry
// ============================================================
console.log("\n[1] Unit — geometry");
{
  const cmds = parsePath("M 10 10 L 100 10 L 100 100");
  ok("parsePath: M L L → 3 commands", cmds.length === 3, `got ${cmds.length}`);
  ok("parsePath: first is M", cmds[0].cmd === "M");
  const sp = samplePath(cmds);
  ok("samplePath: total length 90+90=180", Math.abs(arcLength(sp) - 180) < 0.01, `got ${arcLength(sp)}`);
  const mid = pointAt(sp, 45); // midpoint of first segment (10,10)→(100,10)
  ok("pointAt: midpoint at (55,10)", Math.abs(mid.x - 55) < 0.01 && Math.abs(mid.y - 10) < 0.01, `got (${mid.x},${mid.y})`);
  const tan = tangentAt(sp, 45);
  ok("tangentAt: at first-segment midpoint points +x", Math.abs(tan.x - 1) < 0.01, `got (${tan.x},${tan.y})`);
}
{
  // Cubic bezier: a simple curve, length should be > chord length
  const cmds = parsePath("M 0 0 C 50 0 50 100 100 100");
  const sp = samplePath(cmds);
  const L = arcLength(sp);
  ok("cubic arcLength > chord (141.4)", L > 141.4 && L < 200, `got ${L}`);
  const end = pointAt(sp, L);
  ok("cubic endpoint at (100,100)", Math.abs(end.x - 100) < 0.5 && Math.abs(end.y - 100) < 0.5, `got (${end.x},${end.y})`);
}
{
  // Quadratic
  const cmds = parsePath("M 0 0 Q 50 100 100 0");
  const sp = samplePath(cmds);
  const L = arcLength(sp);
  ok("quadratic arcLength > chord (100)", L > 100, `got ${L}`);
}
{
  // Closepath Z
  const cmds = parsePath("M 10 10 L 100 10 L 100 100 Z");
  const sp = samplePath(cmds);
  const L = arcLength(sp);
  // 90 + 90 + close line back to start (√(90²+90²) ≈ 127.28) = 307.28
  ok("Z closes back to start", L > 300 && L < 315, `got ${L}`);
}
{
  // H and V commands
  const cmds = parsePath("M 10 10 H 100 V 100");
  const sp = samplePath(cmds);
  ok("H+V length = 90+90=180", Math.abs(arcLength(sp) - 180) < 0.01, `got ${arcLength(sp)}`);
}
{
  // tangentAngleDeg + applyEasing
  ok("tangentAngleDeg: +x → 0°", Math.abs(tangentAngleDeg({ x: 1, y: 0 })) < 0.01);
  ok("tangentAngleDeg: +y → 90°", Math.abs(tangentAngleDeg({ x: 0, y: 1 }) - 90) < 0.01);
  ok("applyEasing linear at 0.5 → 0.5", Math.abs(applyEasing(0.5, "linear") - 0.5) < 1e-9);
  ok("applyEasing easeInOut at 0.5 → 0.5", Math.abs(applyEasing(0.5, "easeInOut") - 0.5) < 1e-9);
  ok("applyEasing easeInOut at 0.25 → 0.15625", Math.abs(applyEasing(0.25, "easeInOut") - 0.15625) < 1e-9);
  ok("clamp(5, 0, 10) → 5", clamp(5, 0, 10) === 5);
  ok("clamp(-1, 0, 10) → 0", clamp(-1, 0, 10) === 0);
}
{
  // Parser rejects unsupported commands
  throws("parsePath rejects arc (A)", () => parsePath("M 0 0 A 50 50 0 0 1 100 0"));
  throws("parsePath rejects relative moveto (m)", () => parsePath("m 10 10"));
  throws("parsePath rejects empty", () => parsePath(""));
  throws("parsePath rejects leading L", () => parsePath("L 10 10"));
}

// ============================================================
// 2. CONTRACT — schemas
// ============================================================
console.log("\n[2] Contract — zod schemas");
{
  const p = buildSampleProject();
  // Round-trip: schema should accept what buildSampleProject produced
  const parsed = whiteboardProjectSchema.parse(p);
  ok("schema accepts sample project", parsed.id === p.id);
  ok("schemaVersion === 1", parsed.schemaVersion === SCHEMA_VERSION);

  // migrateProject v1 passthrough
  const migrated = migrateProject(p);
  ok("migrateProject v1 passthrough works", migrated.id === p.id);
  throws("migrateProject rejects newer schemaVersion", () => migrateProject({ ...p, schemaVersion: 99 as unknown as 1 }));
  throws("migrateProject rejects missing schemaVersion", () => migrateProject({ id: "x" } as unknown));

  // Referential integrity — good case
  const reg = assetRegistry();
  let okRef = true;
  try { validateReferences(p, reg); } catch { okRef = false; }
  ok("validateReferences accepts clean sample", okRef);

  // Referential integrity — dangling asset
  const bad = JSON.parse(JSON.stringify(p)) as typeof p;
  bad.scenes[0].assets[0].assetId = "does-not-exist";
  throws("validateReferences rejects dangling assetId", () => {
    try { validateReferences(bad, reg); } catch (e) {
      if (e instanceof ReferentialIntegrityError) throw e;
      throw new Error("wrong error type");
    }
  }, "is not in the registry");

  // Referential integrity — dangling pathId
  const bad2 = JSON.parse(JSON.stringify(p)) as typeof p;
  bad2.scenes[0].events[0] = { ...bad2.scenes[0].events[0] as Extract<typeof bad2.scenes[0].events[number]>, pathId: "no-such-path" };
  throws("validateReferences rejects dangling pathId", () => validateReferences(bad2, reg), "not present on asset");

  // Scene contiguity
  const bad3 = JSON.parse(JSON.stringify(p)) as typeof p;
  bad3.scenes[1].startMs = bad3.scenes[0].startMs + bad3.scenes[0].durationMs + 1000;
  throws("validateReferences rejects non-contiguous scenes", () => validateReferences(bad3, reg), "not contiguous");

  // Canonical serialize deterministic
  const s1 = canonicalSerialize(p);
  const s2 = canonicalSerialize(JSON.parse(JSON.stringify(p)));
  ok("canonicalSerialize is order-independent", s1 === s2);

  // Schema rejects bad enum / out-of-range
  const bad4 = JSON.parse(JSON.stringify(p)) as typeof p;
  (bad4.settings as { fps: number }).fps = 60; // not in 24|30
  throws("schema rejects fps=60", () => whiteboardProjectSchema.parse(bad4));
  const bad5 = JSON.parse(JSON.stringify(p)) as typeof p;
  bad5.settings.background = "red";
  throws("schema rejects non-hex background", () => whiteboardProjectSchema.parse(bad5));
  const bad6 = JSON.parse(JSON.stringify(p)) as typeof p;
  bad6.scenes[0].durationMs = 0;
  throws("schema rejects durationMs=0", () => whiteboardProjectSchema.parse(bad6));
}

// ============================================================
// 3. SECURITY — SVG validator
// ============================================================
console.log("\n[3] Security — SVG validator");
{
  const safe = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M 10 10 L 90 90" stroke="#111827" stroke-width="6" fill="none"/></svg>`;
  ok("safe SVG accepted", isSafeSvg(safe));
  const v = validateSvg(safe);
  ok("validateSvg returns pathCount=1", v.pathCount === 1);

  // Forbidden elements / attributes
  assertSvgRejected(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`, "script");
  assertSvgRejected(`<svg xmlns="http://www.w3.org/2000/svg"><foreignObject>x</foreignObject></svg>`, "foreignObject");
  assertSvgRejected(`<svg xmlns="http://www.w3.org/2000/svg"><path d="M 0 0" onclick="alert(1)"/></svg>`, "onclick");
  assertSvgRejected(`<svg xmlns="http://www.w3.org/2000/svg"><path d="M 0 0" xlink:href="http://evil"/></svg>`, "xlink:href");
  assertSvgRejected(`<svg xmlns="http://www.w3.org/2000/svg"><path d="M 0 0" href="http://evil"/></svg>`, "href");
  assertSvgRejected(`<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="url(http://evil)"/></svg>`, "url(");
  assertSvgRejected(`<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg/>`, "entity");
  assertSvgRejected(`<svg xmlns="http://www.w3.org/2000/svg"><image href="evil.png" width="10" height="10"/></svg>`, "not allowed"); // <image> not in allowlist
  assertSvgRejected(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:ev="http://xxx"><path ev:event="x" d="M 0 0"/></svg>`, "not allowed"); // xmlns:ev not in svg allowlist

  // Path bomb — 10k paths (limit 600)
  const bombPaths = Array.from({ length: 10000 }, (_, i) => `<path d="M ${i} 0 L ${i} 10" id="p${i}"/>`).join("");
  const bomb = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10000 10">${bombPaths}</svg>`;
  throws("path bomb (10k paths) rejected", () => validateSvg(bomb), "MAX_PATHS");

  // Oversized source
  const huge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="${"M 0 0 L 1 0 ".repeat(100000)}"/></svg>`;
  throws("oversized SVG rejected", () => validateSvg(huge), "MAX_ASSET_BYTES");

  // Valid path with attribute that the allowlist forbids
  assertSvgRejected(`<svg xmlns="http://www.w3.org/2000/svg"><path d="M 0 0" filter="url(#evil)"/></svg>`, "filter");
  assertSvgRejected(`<svg xmlns="http://www.w3.org/2000/svg"><style/></svg>`, "not allowed"); // <style> not in allowlist
  ok("all security cases ran", true);
}

// ============================================================
// 4. Path extractor — registry loads
// ============================================================
console.log("\n[4] Path extractor + asset registry");
{
  const reg = assetRegistry();
  const list = reg.list();
  ok("registry loads ≥ 8 starter assets", list.length >= 8, `got ${list.length}`);
  ok("registry has lightbulb", reg.has("lightbulb"));
  ok("registry has hand-right", reg.has("hand-right"));
  const lb = reg.asset("lightbulb");
  ok("lightbulb has 3 paths", lb && lb.paths.length === 3, `got ${lb?.paths.length}`);
  // Each path has a positive duration assigned by the extractor
  const allHaveDuration = reg.list().every((a) => a.paths.every((p) => p.durationMs > 0));
  ok("every path has durationMs > 0", allHaveDuration);

  // Extract standalone asset
  const safe = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path id="p1" d="M 10 10 L 90 90" stroke="#111827" stroke-width="6" fill="none"/></svg>`;
  const ex = extractAsset(safe, { id: "test", name: "Test", category: "test", tags: ["t"] });
  ok("extractAsset returns 1 path", ex.paths.length === 1);
  ok("extractAsset assigns positive duration", ex.paths[0].durationMs > 0);
  ok("extractAsset captures viewBox", ex.viewBox?.w === 100);
}

// ============================================================
// 5. Animator — frame evaluation purity
// ============================================================
console.log("\n[5] Animator — frame evaluation");
{
  const p = buildSampleProject();
  const total = projectDurationMs(p);
  ok("sample project duration = 60000ms", total === 60000, `got ${total}`);

  // Purity: two evaluations of the same project+t must deep-equal
  const f1a = evaluateFrame(p, 1000);
  const f1b = evaluateFrame(p, 1000);
  ok("evaluateFrame is pure (same t → same state)", JSON.stringify(f1a) === JSON.stringify(f1b));

  // Different scenes
  const s1 = evaluateFrame(p, 1000);
  const s2 = evaluateFrame(p, 13000);
  ok("frame at t=1s is in scene 1 (different from t=13s)", JSON.stringify(s1) !== JSON.stringify(s2));

  // At t=0 (very start of scene 1), nothing is drawn yet — hand hidden
  const f0 = evaluateFrame(p, 0);
  ok("at t=0 scene 1 has 1 layer", f0.layers.length === 1, `got ${f0.layers.length}`);
  ok("at t=0 the first path has dashOffset == dashArray (not yet drawn)",
    Math.abs(f0.layers[0].paths[0].dashOffset - f0.layers[0].paths[0].dashArray) < 0.01);

  // At t=mid-scene-1, the first path should be partially drawn (progress between 0 and 1)
  const mid = evaluateFrame(p, 1400); // 500ms offset + 900ms into first draw (durationMs 1800)
  const p0 = mid.layers[0].paths[0];
  ok("at t=1.4s first path progress is in (0,1)",
    p0.dashOffset > 0 && p0.dashOffset < p0.dashArray,
    `dashOffset=${p0.dashOffset} dashArray=${p0.dashArray}`);

  // Hand visible during an active draw
  ok("hand visible during active draw at t=1.4s", mid.hand !== null && mid.hand.visible);

  // At scene end, all paths of scene 1 fully drawn
  const end1 = evaluateFrame(p, 12_000 - 1);
  const allDone = end1.layers[0].paths.every((p) => p.dashOffset <= 0.01);
  ok("at scene 1 end all paths fully drawn", allDone);
}

// ============================================================
// 6. Composer + Rasterizer — frame → PNG
// ============================================================
console.log("\n[6] Composer + Rasterizer");
{
  const p = buildSampleProject();
  const state = evaluateFrame(p, 5000);
  const svg = composeFrameSvg(state, 1920, 1080, { handStyle: "right" });
  ok("composeFrameSvg returns non-empty string", svg.length > 500);
  ok("composed SVG starts with <svg", svg.startsWith("<svg"));
  ok("composed SVG closes with </svg>", svg.endsWith("</svg>"));

  const png = rasterizeSvg(svg, { width: 1920, height: 1080, background: "#FFFFFF" });
  ok("rasterizeSvg returns PNG buffer > 1KB", png.length > 1024, `got ${png.length}`);
  ok("PNG starts with \\x89PNG signature", png[0] === 0x89 && png[1] === 0x50);

  // Deterministic rasterization: same SVG → same PNG
  const png2 = rasterizeSvg(svg, { width: 1920, height: 1080, background: "#FFFFFF" });
  ok("rasterizeSvg is deterministic (same SVG → same PNG)",
    png.length === png2.length && png.equals(png2));

  // Different state → different PNG (sanity check the rasterizer isn't returning a constant)
  const state2 = evaluateFrame(p, 30000); // scene 3 mid-draw
  const svg2 = composeFrameSvg(state2, 1920, 1080, { handStyle: "right" });
  const png3 = rasterizeSvg(svg2, { width: 1920, height: 1080, background: "#FFFFFF" });
  ok("different frame state → different PNG", !png.equals(png3));
}

// ============================================================
// 7. Integration — full render (mini, short scene)
// ============================================================
console.log("\n[7] Integration — mini render (preview quality)");
{
  const p = buildSampleProject();
  // Mini project: a 2-second slice (single scene shortened to 2000ms)
  // → at preview fps 15 = 30 frames. Fast enough for CI, exercises the
  // full pipeline (frame eval → rasterize → ffmpeg encode).
  const miniProject: typeof p = {
    ...p,
    scenes: p.scenes.slice(0, 1).map((s) => ({
      ...s,
      durationMs: 2000,
      // Trim events to fit the 2s window
      events: s.events.filter((ev) => ev.startMs < 2000).map((ev) => ({
        ...ev,
        durationMs: Math.min(ev.durationMs, 2000 - ev.startMs),
      })),
      camera: [],
    })),
  };
  const tmp = mkdtempSync(join(tmpdir(), "wb-int-"));
  const outPath = join(tmp, "mini.mp4");
  try {
    const result = await renderProject(miniProject, {
      outPath,
      quality: "preview",
    });
    ok("renderProject produced a file", existsSync(result.outPath));
    ok("renderProject frameCount ≈ 30 (2s @ 15fps preview, ±1 for fp rounding)", result.frameCount >= 29 && result.frameCount <= 30, `got ${result.frameCount}`);
    ok("renderProject width = 640 (preview)", result.width === 640);
    ok("renderProject height = 360 (preview)", result.height === 360);
    ok("renderProject durationSec > 0", result.durationSec > 0, `got ${result.durationSec}`);
    ok("renderProject sha256 is 64 chars", result.sha256.length === 64);
    ok("renderProject bytes > 5KB (real video)", result.bytes > 5000, `got ${result.bytes}`);

    // ffprobe-readable (real ffmpeg encode)
    const buf = readFileSync(result.outPath);
    ok("MP4 starts with ftyp box", buf.length > 8 && buf.toString("ascii", 4, 8).includes("ftyp"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ============================================================
// 8. Determinism — two consecutive renders produce identical sha256
// ============================================================
console.log("\n[8] Determinism — double render");
{
  const p = buildSampleProject();
  const r1 = await renderProjectToBuffer(p, { quality: "preview" });
  const r2 = await renderProjectToBuffer(p, { quality: "preview" });
  ok("double render: same sha256", r1.result.sha256 === r2.result.sha256,
    `${r1.result.sha256} vs ${r2.result.sha256}`);
  ok("double render: same bytes", r1.mp4.length === r2.mp4.length, `${r1.mp4.length} vs ${r2.mp4.length}`);
  ok("double render: bytes equal", r1.mp4.equals(r2.mp4));
}

// ============================================================
// 9. Regression — Director / render.ts not imported by whiteboard
// ============================================================
console.log("\n[9] Regression — module boundary");
{
  // Read the whiteboard module files and confirm none import Director / render.ts
  const { readdirSync, readFileSync: rfs } = await import("node:fs");
  const { join: joinPath } = await import("node:path");
  const wbDir = "src/lib/tubeforge/whiteboard";
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = joinPath(dir, e.name);
      if (e.isDirectory()) out.push(...walk(full));
      else if (e.name.endsWith(".ts")) out.push(full);
    }
    return out;
  }
  const files = walk(wbDir);
  let bad = 0;
  for (const f of files) {
    const src = rfs(f, "utf8");
    if (/\.\.\/render['"\/]/.test(src) || /\.\.\/director(-plan)?['"\/]/.test(src)) {
      console.log(`  ✗ ${f} imports a forbidden parent module`);
      bad++;
    }
  }
  ok("no whiteboard module imports ../render or ../director", bad === 0, `${bad} violations`);
}

// ============================================================
// Summary
// ============================================================
console.log("\n" + "=".repeat(60));
console.log(`PASS: ${pass}  ·  FAIL: ${fail}`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("\nExit gate (E2): PASS");
process.exit(0);

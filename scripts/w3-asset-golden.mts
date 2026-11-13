#!/usr/bin/env node
/**
 * W3 — the per-asset golden-frame receipt (the starter pack's image law).
 *
 * S120 §3 W3: the extended starter pack (education / business / science /
 * process) ships with golden-frame renders per asset. This script renders
 * EVERY built-in asset through the REAL engine (validate → chromium →
 * ffmpeg — the same renderWhiteboard the production lane rides), one
 * minimal scene per asset, and hashes the final (draw-complete) frame of
 * each scene. The receipt lands in docs/baselines/ and the suite's
 * determinism law applies: same tree + same toolchain → same hashes.
 *
 * The receipt is chunkable: `--assets heart-main,spark` renders only those
 * ids and UPSERTS them into the existing receipt (sorted keys, no
 * timestamps — the file stays byte-stable per toolchain). A full run on a
 * quiet machine needs no flags.
 *
 *   node --import tsx scripts/w3-asset-golden.mts
 *   node --import tsx scripts/w3-asset-golden.mts --assets heart-main,flask
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { ASSETS } from "../src/lib/tubeforge/whiteboard/assets";
import { loadLibrary } from "../src/lib/tubeforge/whiteboard/assets";
import { validateWhiteboardProject } from "../src/lib/tubeforge/whiteboard/storyboard";
import { renderWhiteboard } from "../src/lib/tubeforge/whiteboard/render";
import { extractAsset } from "../src/lib/tubeforge/whiteboard/assets";

const execFileP = promisify(execFile);
const OUT_DIR = path.resolve("validation/w3-golden");
const RECEIPT = path.resolve("docs/baselines/w3-asset-golden-2026-11-13.json");

const GOLDEN_WIDTH = 960;
const GOLDEN_HEIGHT = 540;
const GOLDEN_FPS = 24;
/** The asset box inside the golden canvas (16:9 stage, centered). */
const GOLDEN_BOX = 320;

const sha256 = (buf: Buffer | string): string => createHash("sha256").update(buf).digest("hex");

/** Decode ONE frame at tSec as raw RGB — the W1 harness's own hash law
 *  (codec-independent: the bytes are the decoded pixels, never a lossy
 *  re-encode). The render deletes its JPEG frames after encoding, and the
 *  per-scene MP4s persist — the golden hash reads the same bytes the W1
 *  baseline would. */
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

async function toolVersion(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP(cmd, args);
    return stdout.trim().split("\n")[0];
  } catch {
    return "unknown";
  }
}

function chromiumReceipt(): string {
  try {
    const cache = path.join(process.env.HOME ?? osHome(), ".cache", "ms-playwright");
    const hits = fs.readdirSync(cache).filter((d) => d.startsWith("chromium-"));
    return hits.sort().join(", ");
  } catch {
    return "ms-playwright cache unreadable";
  }
}

function osHome(): string {
  return "/home/z";
}

/** Deterministic scene duration: the fill law needs a window per path. */
function goldenSceneDurationMs(pathCount: number): number {
  return 2000 + 600 * pathCount;
}

interface GoldenEntry {
  sceneId: string;
  frame: string;
  sha256: string;
  paths: number;
  durationMs: number;
}

async function main(): Promise<void> {
  const argIdx = process.argv.indexOf("--assets");
  const only =
    argIdx !== -1 && process.argv[argIdx + 1]
      ? new Set(process.argv[argIdx + 1].split(",").map((s) => s.trim()))
      : null;

  const wanted = only ? ASSETS.filter((a) => only.has(a.id)) : ASSETS;
  const missing = only ? [...only].filter((id) => !ASSETS.some((a) => a.id === id)) : [];
  if (missing.length > 0) throw new Error(`unknown asset ids: ${missing.join(", ")}`);

  const lib = loadLibrary();
  // One scene per asset: centered, scaled into the golden box, no camera,
  // no events — the fill law schedules the draw, the hand rides it.
  const sceneFor = (a: (typeof ASSETS)[number]) => {
    const ex = extractAsset(a);
    const scale = Math.min(GOLDEN_BOX / a.viewBox.w, GOLDEN_BOX / a.viewBox.h);
    return {
      id: `golden-${a.id}`,
      narration: `The ${a.id.replace(/-/g, " ")} asset draws as one authored stroke set.`,
      durationMs: goldenSceneDurationMs(ex.paths.length),
      background: "#ffffff" as const,
      placements: [
        {
          assetId: a.id,
          placement: {
            x: Math.round((GOLDEN_WIDTH - a.viewBox.w * scale) / 2),
            y: Math.round((GOLDEN_HEIGHT - a.viewBox.h * scale) / 2),
            scale: Math.round(scale * 1000) / 1000,
            rotateDeg: 0,
          },
          order: 0,
        },
      ],
      animations: [],
      camera: [],
    };
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  // The 24-scene project budget is the law — the golden run chunks into
  // separate projects (each its own render + frames dir) and the receipt
  // merges them. Chunk size 20 leaves headroom under the wall.
  const CHUNK = 20;
  const entries: Record<string, GoldenEntry> = {};
  let chunkIdx = 0;
  for (let off = 0; off < wanted.length; off += CHUNK) {
    const slice = wanted.slice(off, off + CHUNK);
    chunkIdx++;
    const scenes = slice.map(sceneFor);
    const project = {
      title: `W3 golden frames — one asset per scene (chunk ${chunkIdx})`,
      width: GOLDEN_WIDTH,
      height: GOLDEN_HEIGHT,
      fps: GOLDEN_FPS,
      hand: { style: "marker" as const, scale: 1 },
      scenes,
    };
    const { project: valid, errors } = validateWhiteboardProject(project, lib.libraryIndex);
    if (!valid) throw new Error(`golden project failed validation: ${errors.join(" · ")}`);

    const chunkDir = path.join(OUT_DIR, `chunk-${chunkIdx}`);
    fs.mkdirSync(chunkDir, { recursive: true });
    console.log(`[w3-golden] chunk ${chunkIdx}: ${scenes.length} scenes @ ${GOLDEN_WIDTH}x${GOLDEN_HEIGHT} @ ${GOLDEN_FPS}fps`);
    const result = await renderWhiteboard(valid, {
      outDir: chunkDir,
      onProgress: (label, frac) => {
        const pct = Math.round(frac * 100);
        if (pct % 20 === 0) console.log(`  ${pct}% ${label}`);
      },
    });

    // Hash the draw-complete state of each scene — decoded raw RGB from
    // the persisted per-scene MP4 (the W1 hash law). The hash point sits
    // one frame inside the final hold: input-seek at the very last frame
    // can overshoot EOF on short MP4s (0 bytes), and the hold is the
    // state that matters (the ink is complete and stable).
    for (let si = 0; si < result.scenes.length; si++) {
      const sr = result.scenes[si];
      const lastTSec = Math.max(0, (sr.frames - 2) / GOLDEN_FPS);
      const buf = await decodeFrameRgb(sr.file, lastTSec, GOLDEN_WIDTH, GOLDEN_HEIGHT);
      const assetId = sr.sceneId.replace(/^golden-/, "");
      entries[assetId] = {
        sceneId: sr.sceneId,
        frame: `f${String(sr.frames - 2).padStart(5, "0")} @${lastTSec.toFixed(3)}s`,
        sha256: sha256(buf),
        paths: extractAsset(slice[si]).paths.length,
        durationMs: sr.durationMs,
      };
      console.log(`  ${assetId}: frame ${sr.frames - 1} → ${entries[assetId].sha256.slice(0, 12)}…`);
    }
  }

  // Upsert-merge into the receipt (sorted, byte-stable per toolchain).
  let receipt: Record<string, unknown> = {};
  if (fs.existsSync(RECEIPT)) receipt = JSON.parse(fs.readFileSync(RECEIPT, "utf8"));
  const prevAssets = (receipt.assets as Record<string, GoldenEntry> | undefined) ?? {};
  const mergedAssets = { ...prevAssets, ...entries };
  const out = {
    stage: "W3",
    kind: "asset-golden-frames",
    canvas: { width: GOLDEN_WIDTH, height: GOLDEN_HEIGHT, fps: GOLDEN_FPS, box: GOLDEN_BOX },
    toolchain: {
      chromium: chromiumReceipt(),
      ffmpeg: await toolVersion("ffmpeg", ["-version"]),
      playwright: await toolVersion("node_modules/.bin/playwright", ["--version"]),
    },
    assets: Object.fromEntries(Object.entries(mergedAssets).sort(([a], [b]) => a.localeCompare(b))),
  };
  fs.mkdirSync(path.dirname(RECEIPT), { recursive: true });
  fs.writeFileSync(RECEIPT, JSON.stringify(out, null, 2) + "\n");
  console.log(`[w3-golden] receipt → ${RECEIPT} (${Object.keys(mergedAssets).length} assets)`);
}

main().catch((e) => {
  console.error("W3 GOLDEN FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});

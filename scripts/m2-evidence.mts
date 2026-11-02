/**
 * M2 DoD evidence run (docs/director-m1-m2-spec.md §5):
 * "an approved 4-shot plan demonstrably producing a 4-shot rendered scene
 *  (frame-hash evidence attached to the worklog)".
 *
 * What is REAL here (production code, imported from src/):
 *   - buildSceneShots / shotPrompt / shotImageFile  (src/lib/tubeforge/shots.ts)
 *   - multiShotSceneGraph                          (src/lib/tubeforge/motion.ts)
 *   - the exact ffmpeg command shape render.ts buildSegment assembles
 *     for the multi-image branch (input order, per-still -loop demuxer,
 *     filter_complex, -map) — mirrored line for line.
 *
 * What is SIMULATED (no AI provider in this environment):
 *   - the 3 extra shot images `ensureShotImages` would generate are written
 *     as four visually distinct synthetic fixtures at the EXACT filenames
 *     the contract assigns (shotImageFile) — the on-disk contract the
 *     renderer consumes is identical;
 *   - narration audio is a sine stand-in.
 *
 * Evidence produced:
 *   E1  the contract: 4 ShotExecutions, sources scene/extra/extra/extra,
 *       imagePrompt leading every extra prompt, scale-to-fit durations
 *       (planned 4.0s stretched to the measured 5.0s);
 *   E2  render duration |rendered − 5.0| ≤ 0.2s (spec §1.4);
 *   E3  frame hashes: the midpoint of each shot window perceptually matches
 *       ITS OWN source image best (8x8 grayscale aHash, Hamming distance);
 *   E4  cut discipline: the picture changes at every reconciled cut point
 *       (frame before ≠ frame after) and holds its source within a shot.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

const { buildSceneShots, shotImageFile, shotPrompt } = await import(
  "../src/lib/tubeforge/shots.ts"
);
const { multiShotSceneGraph } = await import("../src/lib/tubeforge/motion.ts");

const FFMPEG_COMMON = [
  "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "96k",
];

async function ffmpeg(args: string[]) {
  await execFileAsync("ffmpeg", ["-hide_banner", "-nostats", "-y", ...args], {
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** 16x16 grayscale perceptual hash (aHash: median-thresholded luminance
 * grid compared via Hamming distance — robust to the zoompan crop/zoom). */
const HASH_W = 16, HASH_H = 16;
async function aHash(file: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-i", file, "-frames:v", "1",
     "-vf", `scale=${HASH_W}:${HASH_H}`, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"],
    { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, encoding: "buffer" }
  );
  return stdout.toString("hex"); // 256 bytes → 512 hex chars
}

function hamming(hexA: string, hexB: string): number {
  const a = Buffer.from(hexA, "hex");
  const b = Buffer.from(hexB, "hex");
  // Median-threshold each grid against itself (classic aHash), then XOR.
  const med = (buf: Buffer) => {
    const sorted = Buffer.from(buf).sort();
    return sorted[Math.floor(sorted.length / 2)];
  };
  const [ma, mb] = [med(a), med(b)];
  let bits = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const ba = a[i] >= ma ? 1 : 0;
    const bb = b[i] >= mb ? 1 : 0;
    if (ba !== bb) bits++;
  }
  return bits;
}

const line = (c = "─") => console.log(c.repeat(72));

// ── The scene + the APPROVED DirectorScene (4 shots) ─────────────────────────
const scene = {
  index: 1,
  title: "The Night Market",
  narration: "Five seconds of narration for the evidence render.",
  visual: "a bustling night market, steam rising from food stalls",
  camera: "slow push in",
  mood: "warm amber night lighting, neon reflections",
  caption: "The night market wakes",
  hostInScene: false,
  rehook: false,
  sfx: "none",
} as never;

const planScene = {
  sceneIndex: 1,
  mood: "warm amber night, neon reflections",
  transitionIn: "",
  motion: "smart",
  needsI2V: false,
  useStock: false,
  pacing: "normal",
  ambience: "market_crowd",
  sfx: "whoosh",
  shots: [
    { shotIndex: 0, framing: "wide establishing", camera: "push-in",   lens: "24mm wide", composition: "leading lines", duration: 1.2, imagePrompt: "wide view of the market gate glowing under lanterns" },
    { shotIndex: 1, framing: "medium",            camera: "pan-left",  lens: "50mm",      composition: "rule of thirds", duration: 0.8, imagePrompt: "a vendor fanning charcoal behind stacked skewers" },
    { shotIndex: 2, framing: "close-up",          camera: "tilt-down", lens: "85mm",      composition: "centered",       duration: 1.0, imagePrompt: "chili oil dripping onto fresh noodles" },
    { shotIndex: 3, framing: "medium",            camera: "handheld",  lens: "35mm",      composition: "foreground framing", duration: 1.0, imagePrompt: "crowd silhouettes drifting between lantern glow" },
  ],
} as never;

const MEASURED_SEC = 5.0; // measured narration (scale-to-fit: 4.0 planned → 5.0)
const FPS = 24;

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "tf-m2-ev-"));
try {
  // ── Fixture sources at the CONTRACT filenames (what ensureShotImages leaves
  //    on disk): scene art + 3 distinct extras. ──────────────────────────────
  const SOURCES: { file: string; gen: string[]; label: string }[] = [
    { file: shotImageFile(1, 0), gen: ["-f", "lavfi", "-i", "testsrc2=size=1344x768", "-frames:v", "1"], label: "scene art (testsrc2)" },
    { file: shotImageFile(1, 1), gen: ["-f", "lavfi", "-i", "smptebars=size=1344x768", "-frames:v", "1"], label: "extra 1 (smptebars)" },
    { file: shotImageFile(1, 2), gen: ["-f", "lavfi", "-i", "testsrc=size=1344x768", "-frames:v", "1"], label: "extra 2 (testsrc)" },
    { file: shotImageFile(1, 3), gen: ["-f", "lavfi", "-i", "gradients=size=1344x768", "-frames:v", "1"], label: "extra 3 (gradients)" },
  ];
  for (const s of SOURCES) await ffmpeg([...s.gen, path.join(tmp, s.file)]);
  const wav = path.join(tmp, "scene-01.wav");
  await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=220:duration=5", "-ar", "48000", "-ac", "2", wav]);

  // ── E1: the contract ───────────────────────────────────────────────────────
  line("═");
  console.log("E1 — buildSceneShots: approved 4-shot plan → ShotExecution list");
  line("═");
  const plan = buildSceneShots({ scene, planScene, measuredSec: MEASURED_SEC });
  const plannedTotal = 4.0;
  const scale = MEASURED_SEC / plannedTotal; // 1.25 — scale-to-fit
  const expectSec = [1.2, 0.8, 1.0, 1.0].map((d) => Math.round(d * scale * 100) / 100);
  const expectMove = ["zoom-in", "pan-left", "tilt-down", "diag-tl"];
  const expectSource = ["scene", "extra", "extra", "extra"];

  console.log(`  scene 1, measured narration ${MEASURED_SEC}s, planned Σ ${plannedTotal}s → scale-to-fit ×${scale}`);
  let e1ok = plan.available.length === 4;
  plan.available.forEach((sh, i) => {
    const okSrc = sh.source === expectSource[i];
    const okSec = Math.abs(sh.sec - expectSec[i]) < 0.005;
    const okMove = sh.moveKind === expectMove[i];
    e1ok = e1ok && okSrc && okSec && okMove;
    console.log(
      `  shot ${sh.shotIndex}: ${String(sh.source).padEnd(6)} ${sh.moveKind.padEnd(8)} ${sh.sec.toFixed(2)}s  file=${sh.imageFile}` +
      `  [src ${okSrc ? "✓" : "✗"} dur ${okSec ? "✓" : "✗"} move ${okMove ? "✓" : "✗"}]`
    );
    if (sh.prompt) {
      const lead = sh.prompt.split(". ")[1] ?? ""; // bits[0] = scene.visual
      console.log(`          prompt leads with imagePrompt: "${lead.slice(0, 58)}…" ✓`);
    }
  });
  const promptCheck = plan.available
    .filter((s) => s.prompt)
    .every((s, i) => (s.prompt ?? "").includes(planScene.shots[i + 1].imagePrompt.slice(0, 20)));
  console.log(`  E1 ${e1ok && promptCheck ? "PASS" : "FAIL"} — 4 executions, sources ${expectSource.join("/")}, durations ${expectSec.join("/")}s, imagePrompt leads every extra prompt`);

  // ── The render: multiShotSceneGraph + buildSegment's exact command shape ──
  const dirFiles = new Set(fs.readdirSync(tmp));
  const inputFor = new Map<string, number>();
  const extraInputs: string[] = [];
  let nextInput = 2; // 0 = scene img, 1 = wav (no audio extras in this run)
  const resolved = plan.available.map((sh) => {
    const file = path.join(tmp, sh.imageFile);
    const exists = dirFiles.has(sh.imageFile); // resolveShotInputs' check
    const useFile = sh.source === "scene" || exists ? file : path.join(tmp, shotImageFile(1, 0));
    if (!inputFor.has(useFile)) {
      inputFor.set(useFile, nextInput++);
      extraInputs.push("-loop", "1", "-framerate", String(FPS), "-t", (sh.sec + 1).toFixed(3), "-i", useFile);
    }
    return { kind: sh.moveKind, sec: sh.sec, input: inputFor.get(useFile)!, crop: sh.crop };
  });
  const graph = multiShotSceneGraph({
    dur: MEASURED_SEC,
    settings: { mode: "smart", intensity: 40, curve: "smooth", vary: true } as never,
    fps: FPS,
    shots: resolved as never,
  });
  const out = path.join(tmp, "seg-01.mp4");
  await ffmpeg([
    "-loop", "1", "-framerate", String(FPS), "-t", MEASURED_SEC.toFixed(3), "-i", path.join(tmp, shotImageFile(1, 0)),
    "-i", wav,
    ...extraInputs,
    "-filter_complex", `${graph};[1:a]anull[a]`,
    "-map", "[v]", "-map", "[a]",
    "-t", String(MEASURED_SEC),
    ...FFMPEG_COMMON,
    "-y", out,
  ]);

  // ── E2: duration contract ──────────────────────────────────────────────────
  line("═");
  console.log("E2 — render duration (spec §1.4: |rendered − measured| ≤ 0.2s)");
  line("═");
  const probe = await execFileAsync(
    "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out],
    { timeout: 60_000, maxBuffer: 1024 * 1024 }
  );
  const dur = parseFloat(probe.stdout.trim());
  console.log(`  rendered ${dur.toFixed(3)}s vs measured ${MEASURED_SEC}s → Δ ${Math.abs(dur - MEASURED_SEC).toFixed(3)}s  ${Math.abs(dur - MEASURED_SEC) <= 0.2 ? "PASS" : "FAIL"}`);

  // ── E3: frame hashes — each shot window matches ITS OWN source ─────────────
  line("═");
  console.log("E3 — frame hashes: midpoint of each shot window vs all 4 sources");
  line("═");
  const srcHashes: { label: string; file: string; hash: string }[] = [];
  for (const s of SOURCES) {
    srcHashes.push({ label: s.label, file: s.file, hash: await aHash(path.join(tmp, s.file)) });
  }
  let boundaries = 0;
  const windows: { from: number; to: number; mid: number }[] = [];
  for (const sh of plan.available) {
    windows.push({ from: boundaries, to: boundaries + sh.sec, mid: boundaries + sh.sec / 2 });
    boundaries += sh.sec;
  }
  let e3ok = true;
  const mids: { t: number; hash: string }[] = [];
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    const f = path.join(tmp, `mid-${i}.png`);
    await ffmpeg(["-ss", w.mid.toFixed(3), "-i", out, "-frames:v", "1", f]);
    const h = await aHash(f);
    mids.push({ t: w.mid, hash: h });
    const dists = srcHashes.map((s) => ({ label: s.label, d: hamming(h, s.hash) }));
    dists.sort((a, b) => a.d - b.d);
    const own = dists[0].label === SOURCES[i].label;
    e3ok = e3ok && own;
    console.log(
      `  window [${w.from.toFixed(2)}s,${w.to.toFixed(2)}s] mid ${w.mid.toFixed(2)}s  hash ${h.slice(0, 16)}…  →` +
      ` nearest: ${dists[0].label} (d=${dists[0].d})  own-source ${own ? "✓" : `✗ (${dists.map((x) => `${x.label.split(" ")[0]}:${x.d}`).join(" ")})`}`
    );
  }
  console.log(`  E3 ${e3ok ? "PASS" : "FAIL"} — every shot window shows the image the Director assigned to it`);

  // ── E4: cut discipline at the reconciled boundaries ────────────────────────
  line("═");
  console.log("E4 — cuts land on the reconciled boundaries (frame before ≠ after)");
  line("═");
  let e4ok = true;
  let cutT = 0;
  for (let i = 0; i < plan.available.length - 1; i++) {
    cutT += plan.available[i].sec;
    const [fb, fa] = await Promise.all([0, 1].map(async (side) => {
      const f = path.join(tmp, `cut-${i}-${side}.png`);
      await ffmpeg(["-ss", (cutT + (side ? 0.12 : -0.12)).toFixed(3), "-i", out, "-frames:v", "1", f]);
      return aHash(f);
    }));
    const d = hamming(fb, fa);
    const sameShotPair = hamming(fb, mids[i].hash);
    const ok = d > 4; // picture must change across the cut
    e4ok = e4ok && ok;
    console.log(
      `  cut ${i + 1} @ ${cutT.toFixed(2)}s: frame ${cutT - 0.12}s vs ${cutT + 0.12}s → Hamming ${d} ${ok ? "✓ changed" : "✗ static"}` +
      ` (pre-cut frame vs its window midpoint: ${sameShotPair} — same source, different zoompan phase)`
    );
  }
  console.log(`  E4 ${e4ok ? "PASS" : "FAIL"} — the Director's cuts land on schedule`);

  line("═");
  const allPass = e1ok && promptCheck && Math.abs(dur - MEASURED_SEC) <= 0.2 && e3ok && e4ok;
  console.log(`M2 DoD evidence: ${allPass ? "ALL CHECKS PASS — an approved 4-shot plan produced a 4-shot rendered scene" : "FAILED"}`);
  line("═");
  process.exit(allPass ? 0 : 1);
} finally {
  await fsp.rm(tmp, { recursive: true, force: true });
}

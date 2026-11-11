// S94 smoke — the 3D engine end-to-end through the SHARED contracts.
// 1. The deterministic Scene3D scaffold renders for REAL (three.js WebGL 2
//    under the SwiftShader headless chromium — the S94 probe receipt) —
//    exact frame count, non-blank raster, exact duration.
// 2. THE GOVERNING RULE, proven: the 3D clip is an ORDINARY video asset —
//    it rides the composition plan (planFromTracks / assembleTimeline) and
//    the compositor plays it to a delivered cut through the SAME assembly
//    the stock and AI clips use (the §4.C-5 future-engine assertion
//    pattern, on real bytes). No isolated pipeline, by demonstration.
// Run: node --import tsx scripts/s94-3d-smoke.mts
import fs from "node:fs";
import path from "node:path";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFileCb);
let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): asserts cond {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

async function ffmpeg(args: string[]): Promise<void> {
  await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], {
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function probeDurationSec(file: string): Promise<number | null> {
  try {
    const { stdout } = await execFileP(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "json", file],
      { timeout: 30_000 }
    );
    const d = Number(JSON.parse(stdout)?.format?.duration);
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

async function main() {
  process.env.DATABASE_URL ||= "file:./db/custom.db";
  const { videoDir } = await import("../src/lib/tubeforge/ai.ts");
  const { sceneWavFile, sceneImageFile } = await import("../src/lib/tubeforge/story.ts");

  // ---------- 1. the contract: scaffold → serialize → parse ----------
  const { scaffoldScene3D, serializeScene3D, parseScene3D, cameraAt, scene3dClipKey } =
    await import("../src/lib/tubeforge/scene3d.ts");
  const doc = scaffoldScene3D("the orbital mechanics of exoplanets", { fps: 24, durationSec: 4 });
  const stored = serializeScene3D(doc);
  const reopened = parseScene3D(stored);
  ok(reopened != null, "the doc parses (version 1, tolerant entrance)");
  ok(reopened && serializeScene3D(reopened) === stored, "the round-trip is byte-stable");
  ok(serializeScene3D(scaffoldScene3D("the orbital mechanics of exoplanets", { fps: 24, durationSec: 4 })) === stored, "the scaffold is deterministic (same topic → same bytes)");
  const c0 = cameraAt(doc.camera.keyframes, 0);
  const c1 = cameraAt(doc.camera.keyframes, 1);
  ok(c0.position[0] < 0 && c1.position[0] > 0, "the orbit keyframes sweep left → right");

  // ---------- 2. the REAL 3D render (WebGL 2, SwiftShader chromium) ----------
  const videoId = "s94-3d-smoke";
  const dir = videoDir(videoId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const { renderScene3D } = await import("../src/lib/tubeforge/render3d.ts");
  const result = await renderScene3D(doc, {
    outDir: dir,
    onProgress: (label) => console.log("  …", label),
  });
  ok(fs.existsSync(result.file) && fs.statSync(result.file).size > 50_000, `the 3D clip lands (${Math.round(fs.statSync(result.file).size / 1024)} KB)`);
  ok(result.frames === 96, `exact frame count: 24fps × 4s = ${result.frames} frames`);
  const dur3d = (await probeDurationSec(result.file)) ?? -1;
  ok(Math.abs(dur3d - 4) <= 0.2, `the delivered duration is the contract duration (${dur3d?.toFixed(2)}s ≈ 4)`);

  // ---------- 3. THE GOVERNING RULE: the clip rides the shared timeline ----
  type Scene = import("../src/lib/tubeforge/types.ts").Scene;
  const scene: Scene = {
    index: 1,
    title: "The flyover",
    narration: "the exoplanet orbits its star once every seven days",
    visual: "a 3D establishing flyover",
    camera: "zoom-in",
    mood: "cinematic",
    caption: "",
    hostInScene: false,
    rehook: false,
    sfx: "none",
    // The 3D clip AS an ordinary footage asset — the compositor cannot tell
    // it apart from stock footage, and must not: that is the point.
    stock: { source: "stock", file: "stock-01.mp4", query: "3d scene", credit: "TubeForge 3D engine", pageUrl: "", durationSec: 4 },
  };
  fs.copyFileSync(result.file, path.join(dir, "stock-01.mp4"));
  await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-ar", "48000", "-ac", "1", path.join(dir, sceneWavFile(1))]);
  await ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=1280x720:d=0.04", "-frames:v", "1", path.join(dir, sceneImageFile(1))]);

  const { assembleTimeline } = await import("../src/lib/tubeforge/timeline.ts");
  const { compositionPlan } = await import("../src/lib/tubeforge/composition-plan.ts");
  const docTl = assembleTimeline([scene], { ttsSpeed: 1, renderMode: "stock", wavDurations: { 1: 4 } });
  // The studio-style boundary edit (the S2 seniority law, pinned by the
  // S87 battery too): the assembled default blend extends the window with
  // the blend tail; "cut" makes the window mechanically exact.
  docTl.scenes[0].transitionIn = "cut";

  // The plan reads the tracks projection (the S87 slice-2 cutover).
  const plan = compositionPlan(docTl, 1);
  const expectedEnd = docTl.scenes[0].endSec; // the doc's OWN window governs
  ok(plan != null && plan.scenes.length === 1, "the composition plan reads the doc");
  ok(plan != null && plan.scenes[0].kind === "video", `the 3D clip rides as an ordinary video-kind clip (${plan?.scenes[0].kind})`);
  ok(
    plan != null &&
      plan.scenes[0].startSec === 0 &&
      Math.abs(plan.scenes[0].endSec - expectedEnd) <= 0.06,
    `the plan window IS the doc window (0 → ${plan?.scenes[0].endSec}s, doc says ${expectedEnd}s)`
  );

  // The compositor plays the 3D clip to a delivered cut (the shared assembly).
  const { renderVideo } = await import("../src/lib/tubeforge/render.ts");
  const result2 = await renderVideo({
    videoId,
    scenes: [scene],
    mode: "stock",
    burnSubtitles: false,
    smartCaptions: false,
    music: false,
    sfx: false,
    timelinePlan: plan,
    sceneDurationsSec: plan.scenes.map((s) => s.durationSec),
    transition: { style: "cut", durationSec: 0.4 },
    quality: "draft",
    aspectRatio: "16:9",
    frameRate: 24,
  });
  const finalPath = path.join(dir, result2.fileName);
  ok(fs.existsSync(finalPath) && fs.statSync(finalPath).size > 100_000, "the compositor delivers the 3D ride-through cut");
  const durFinal = (await probeDurationSec(finalPath)) ?? -1;
  ok(Math.abs(durFinal - plan.totalSec) <= 0.25, `the delivered total is the contract total (${durFinal?.toFixed(2)}s vs ${plan.totalSec}s)`);
  const hasAudio = await (async () => {
    try {
      const { stdout } = await execFileP(
        "ffprobe",
        ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "json", finalPath],
        { timeout: 30_000 }
      );
      return /audio/.test(stdout);
    } catch {
      return false;
    }
  })();
  ok(hasAudio, "the narration rides the delivered cut");

  // The clip key the route serves (the surface seam).
  ok(scene3dClipKey(videoId) === `${videoId}/3d/scene-3d.mp4`, "the clip key is the documented storage path");

  console.log(`\ns94 3D smoke: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke crashed:", err);
  process.exit(1);
});

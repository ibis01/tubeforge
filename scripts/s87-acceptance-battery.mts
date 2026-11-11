// S87 slice 5 — THE §4.C ACCEPTANCE BATTERY (the Universal Timeline close).
//
// The S76 §4.C conditions, proven the S76 standard way: deterministic pins
// (already in scripts/test-unit.mts, slices 1-4) PAIRED with real output
// artifacts and mechanical measurement, human-reviewable. This script is
// the artifacts half — it renders REAL videos through BOTH engine lanes
// with zero AI spend and holds the delivered pixels to the contract:
//
//   §4.C-1  cross-engine rendering through the contract:
//             A) the Whiteboard lane — renderWhiteboard over a scaffolded
//                project (real planner, real chromium, synthesized VO +
//                music bed) composing on the frame-quantized tracks clock;
//             B) the compositor lane — renderVideo (kenburns) over a
//                schema-2 doc, the plan feed driving durations + kinds.
//   §4.C-2  sync: VO slots + the music bed ride the scene windows (A: the
//             final carries audio; the per-scene encodes carry their VO);
//             B: the narration segments ride the plan windows.
//   §4.C-3  transition timing: cut boundaries land where the contract says
//             (A: probed per-scene durations ≡ the plan windows; B: the
//             render's expectedCuts ≡ the plan boundary, hard cuts).
//   §4.C-4  round-trip identity: serialize → parse → serialize is
//             byte-identical (B's doc); the engine tracks re-derive
//             byte-identically from the same frame plan (A).
//   §4.C-5  future-engine compatibility: the engine-authored tracks read
//             back through the SAME planFromTracks (A re-proves it on the
//             real render's own numbers).
//
// Usage: node --import tsx scripts/s87-acceptance-battery.mts [--out DIR]
// Exit 0 = the battery passed; anything else prints the failing condition.
// Artifacts (final.mp4s, per-scene encodes, the report JSON) stay in the
// out dir for human review — the battery never claims visual quality.
import fs from "node:fs";
import path from "node:path";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFileCb);

const OUT_DIR = (() => {
  const i = process.argv.indexOf("--out");
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : "/tmp/s87-battery";
})();

// ---- receipts -------------------------------------------------------------
interface Check {
  condition: string;
  label: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
let failed = 0;
function check(condition: string, label: string, ok: boolean, detail: string): void {
  checks.push({ condition, label, ok, detail });
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} [${condition}] ${label} — ${detail}`);
}
const near = (a: number, b: number, tol: number) =>
  Math.abs(a - b) <= tol ? `${a}s ≡ ${b}s (±${tol})` : `${a}s vs ${b}s (tol ${tol}) — MISMATCH`;

async function ffmpeg(args: string[]): Promise<void> {
  await execFileP("ffmpeg", ["-y", "-v", "error", ...args], { maxBuffer: 32 * 1024 * 1024 });
}
async function probeDurationSec(file: string): Promise<number | null> {
  try {
    const { stdout } = await execFileP("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "json", file,
    ]);
    return Number(JSON.parse(stdout).format?.duration ?? NaN) || null;
  } catch {
    return null;
  }
}
async function hasAudioStream(file: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP("ffprobe", [
      "-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", file,
    ]);
    return stdout.includes("audio");
  } catch {
    return false;
  }
}
function deepEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ===========================================================================
// PART A — the ENGINE lane: a real Whiteboard render on the contract clock
// ===========================================================================
async function partA(): Promise<void> {
  console.log("\nPart A — the Whiteboard lane (real chromium render, $0 AI spend)");
  const { renderWhiteboard } = await import("../src/lib/tubeforge/whiteboard/render");
  const { scaffoldWhiteboardProject } = await import("../src/lib/tubeforge/whiteboard/whiteboard-planner");
  const { loadLibrary } = await import("../src/lib/tubeforge/whiteboard/assets");
  const { validateWhiteboardProject } = await import("../src/lib/tubeforge/whiteboard/storyboard");
  const { estimateProjectFrames } = await import("../src/lib/tubeforge/whiteboard/timing");
  const { whiteboardTracks } = await import("../src/lib/tubeforge/whiteboard/tracks");
  const { planFromTracks } = await import("../src/lib/tubeforge/composition-plan");

  const dir = path.join(OUT_DIR, "whiteboard");
  fs.mkdirSync(dir, { recursive: true });

  // The REAL planner scaffolds the project (rule-table picks, engine
  // placements, 640×360@24 to keep the battery fast).
  const project = scaffoldWhiteboardProject({
    scenes: [
      { index: 1, title: "The hook", narration: "money grows when you measure the budget" },
      { index: 2, title: "The proof", narration: "the data chart shows the growth trend" },
      { index: 3, title: "The close", narration: "one two three four five" },
    ],
    topic: "acceptance battery",
    width: 640,
    height: 360,
    fps: 24,
  });
  // Mixed duration sources — every precedence the estimator supports:
  // scene-1 EXPLICIT 4000ms; scene-2 VO-MEASURED (a 4.0s WAV + the 350ms
  // tail); scene-3 NARRATION-ESTIMATED (5 words → the 4s clamp floor).
  project.scenes[0].durationMs = 4000;
  const lib = loadLibrary();
  const { project: valid, errors } = validateWhiteboardProject(project, lib.libraryIndex);
  if (!valid) throw new Error(`the battery fixture is invalid: ${errors.join("; ")}`);

  // Synthesized VO (scene-2 only — the VO-measured path) + the music bed.
  const vo2 = path.join(dir, "vo-scene-2.wav");
  await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=330:duration=4", "-ar", "48000", "-ac", "1", vo2]);
  const bed = path.join(dir, "bed.flac");
  await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=220:duration=15", "-ar", "48000", "-ac", "2", bed]);

  // The independent recompute the assertions hold the render to.
  const voMsBySceneId = new Map<string, number>([["scene-2", 4000]]);
  const { sceneMs } = estimateProjectFrames(valid, voMsBySceneId);
  // 4000 → 96f = 4.000s; VO 4000+350=4350 → 104f = 4.3333s; estimate 4000 → 96f = 4.000s.
  const expectedWindows = [
    { startSec: 0, endSec: 4, durationSec: 4 },
    { startSec: 4, endSec: 8.33, durationSec: 4.33 },
    { startSec: 8.33, endSec: 12.33, durationSec: 4 },
  ];
  const expectedTracks = whiteboardTracks(valid, sceneMs, { voSceneIds: ["scene-2"], musicOn: true });

  const result = await renderWhiteboard(valid, {
    outDir: dir,
    voFiles: new Map([["scene-2", vo2]]),
    musicPath: bed,
  });

  // §4.C-1 — the render composed through the contract: the returned plan is
  // the tracks read, and the tracks are the frame plan in the grammar.
  check("4.C-1", "the engine emits contract tracks (re-derivation is byte-identical)",
    deepEq(result.tracks, expectedTracks),
    `${result.tracks[0].clips.length} whiteboard clips, kinds ${result.tracks.map((t) => t.kind).join("/")}`);
  check("4.C-1", "the plan is the tracks read (one consumer, every engine)",
    deepEq(result.plan, planFromTracks({ tracks: result.tracks }, 3)),
    `origin=${result.plan.origin}, total=${result.plan.totalSec}s`);
  check("4.C-1", "the composition clock is the frame plan",
    result.plan.scenes.map((s) => [s.startSec, s.endSec]).join(" | ") === expectedWindows.map((w) => [w.startSec, w.endSec]).join(" | "),
    `windows ${result.plan.scenes.map((s) => `${s.startSec}-${s.endSec}`).join(", ")}`);

  // §4.C-3 — the delivered cut: per-scene encodes land on the plan windows.
  for (let i = 0; i < result.scenes.length; i++) {
    const dur = (await probeDurationSec(result.scenes[i].file)) ?? -1;
    check("4.C-3", `scene ${i + 1} encodes on its contract window`,
      Math.abs(dur - expectedWindows[i].durationSec) <= 0.06,
      near(dur, expectedWindows[i].durationSec, 0.06));
  }
  const finalDur = (await probeDurationSec(result.file)) ?? -1;
  check("4.C-3", "the concat total is the contract total",
    Math.abs(finalDur - result.plan.totalSec) <= 0.25,
    near(finalDur, result.plan.totalSec, 0.25));

  // §4.C-2 — sync: the VO slots and the bed actually ride the file.
  check("4.C-2", "the final carries the mixed audio (VO slot + bed)",
    await hasAudioStream(result.file), (await hasAudioStream(result.file)) ? "audio stream present" : "NO audio stream");
  const voScene = await probeDurationSec(result.scenes[1].file);
  check("4.C-2", "the VO-carrying scene keeps its narration (apad to the window)",
    voScene !== null && Math.abs(voScene - expectedWindows[1].durationSec) <= 0.06,
    near(voScene ?? -1, expectedWindows[1].durationSec, 0.06));

  // §4.C-5 — future-engine compatibility, re-proven on the real numbers:
  // the engine-authored tracks parse through the shared reader with the
  // scaffold's row linkages intact.
  check("4.C-5", "engine tracks carry the row linkages through the shared reader",
    result.plan.scenes.map((s) => s.sceneIndex).join(",") === "1,2,3",
    `sceneIndex [${result.plan.scenes.map((s) => s.sceneIndex).join(", ")}]`);
}

// ===========================================================================
// PART B — the COMPOSITOR lane: a real kenburns render on the plan feed
// ===========================================================================
async function partB(): Promise<void> {
  console.log("\nPart B — the compositor lane (real kenburns render, the plan feed)");
  const { renderVideo } = await import("../src/lib/tubeforge/render");
  const { assembleTimeline, serializeTimeline, parseTimeline } = await import("../src/lib/tubeforge/timeline");
  const { compositionPlan } = await import("../src/lib/tubeforge/composition-plan");
  const { videoDir } = await import("../src/lib/tubeforge/ai");
  const { sceneImageFile, sceneWavFile } = await import("../src/lib/tubeforge/story");
  type Scene = import("../src/lib/tubeforge/types").Scene;

  const videoId = "s87-battery-compositor";
  const dir = videoDir(videoId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const scenes: Scene[] = [
    {
      index: 1, title: "Beat one", narration: "one two three four five",
      visual: "a red frame", camera: "slow push", mood: "bright",
      caption: "", hostInScene: false, rehook: false, sfx: "none",
    },
    {
      index: 2, title: "Beat two", narration: "six seven eight nine ten",
      visual: "a blue frame", camera: "gentle pan", mood: "warm",
      caption: "", hostInScene: false, rehook: false, sfx: "none",
    },
  ];

  // Synthetic art + narration (measured lengths the doc will carry).
  await ffmpeg(["-f", "lavfi", "-i", "color=c=0x803030:s=1280x720:d=0.04", "-frames:v", "1", path.join(dir, sceneImageFile(1))]);
  await ffmpeg(["-f", "lavfi", "-i", "color=c=0x304080:s=1280x720:d=0.04", "-frames:v", "1", path.join(dir, sceneImageFile(2))]);
  await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-ar", "48000", "-ac", "1", path.join(dir, sceneWavFile(1))]);
  await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=330:duration=3.5", "-ar", "48000", "-ac", "1", path.join(dir, sceneWavFile(2))]);

  // The contract doc: assemble (measured WAV windows) → a studio-style
  // boundary edit (the doc's per-scene pick is SENIOR to the video-level
  // seam — the S2 law; pinning it to "cut" makes §4.C-3 mechanically exact:
  // the assembled default is a blend, whose windows are already
  // parity-pinned in the unit suite) → save → reopen.
  const doc = assembleTimeline(scenes, {
    ttsSpeed: 1,
    renderMode: "kenburns",
    wavDurations: { 1: 3.0, 2: 3.5 },
  });
  doc.scenes[1].transitionIn = "cut";
  const stored = serializeTimeline(doc);
  const reopened = parseTimeline(stored);
  if (!reopened) throw new Error("the battery doc failed to reopen — the battery cannot run");

  // §4.C-4 — round-trip identity: serialize → parse → serialize, byte-identical.
  const reserialized = serializeTimeline(reopened);
  check("4.C-4", "a saved timeline reopens and re-serializes byte-identically",
    reserialized === stored,
    stored === reserialized ? `${stored.length} bytes identical` : "the bytes DIVERGED");

  const plan = compositionPlan(reopened, 2);
  if (!plan) throw new Error("the battery doc produced no plan — the battery cannot run");
  check("4.C-1", "the compositor reads the TRACKS (schema 2, origin ledger)",
    plan.origin === "tracks", `origin=${plan.origin}, windows ${plan.scenes.map((s) => `${s.startSec}-${s.endSec}`).join(", ")}`);
  check("4.C-1", "the studio's boundary edit rides the tracks (the per-scene pick is senior)",
    plan.scenes[1].transitionIn === "cut", `plan transitionIn[1]=${String(plan.scenes[1].transitionIn)}`);

  // The real render — the plan feed drives durations + kinds (the slice-2
  // cutover), hard cuts so §4.C-3 is mechanically exact.
  const result = await renderVideo({
    videoId,
    scenes,
    mode: "kenburns",
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

  // §4.C-3 — the cut lands exactly where the contract says.
  const boundary = plan.scenes[1].startSec;
  const cuts = result.expectedCuts?.cuts ?? [];
  check("4.C-3", "the hard cut sits on the contract boundary",
    cuts.length === 1 && Math.abs(cuts[0] - boundary) <= 0.01,
    `expectedCuts [${cuts.join(", ")}] vs the plan boundary ${boundary}s`);

  const finalPath = path.join(dir, result.fileName);
  const finalDur = (await probeDurationSec(finalPath)) ?? -1;
  check("4.C-3", "the delivered total is the contract total (cuts: no overlap)",
    Math.abs(finalDur - plan.totalSec) <= 0.25,
    near(finalDur, plan.totalSec, 0.25));
  check("4.C-4", "the render result's own clock agrees with the file",
    Math.abs(result.durationSec - finalDur) <= 0.3,
    near(result.durationSec, finalDur, 0.3));

  // §4.C-2 — the narration segments ride the file.
  check("4.C-2", "the final carries the narration audio",
    await hasAudioStream(finalPath), (await hasAudioStream(finalPath)) ? "audio stream present" : "NO audio stream");

  // §4.C-1 — the lanes' geometries: the compositor kept the row's 16:9.
  check("4.C-1", "the compositor lane rendered at the row geometry",
    result.aspect === "16:9", `aspect=${result.aspect}`);
}

// ===========================================================================
async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const t0 = Date.now();
  await partA();
  await partB();

  const report = {
    battery: "S87 slice 5 — the §4.C acceptance battery",
    ranAt: new Date().toISOString(),
    durationSec: Math.round((Date.now() - t0) / 100) / 10,
    outDir: OUT_DIR,
    passed: checks.length - failed,
    failed,
    checks,
  };
  fs.writeFileSync(path.join(OUT_DIR, "battery-report.json"), JSON.stringify(report, null, 2));
  console.log(`\n${failed === 0 ? "ALL GREEN" : "FAIL"} — ${checks.length - failed}/${checks.length} checks in ${report.durationSec}s`);
  console.log(`artifacts + report: ${OUT_DIR} (human review — the battery never claims visual quality)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("the battery crashed:", err instanceof Error ? err.stack : String(err));
  process.exit(1);
});

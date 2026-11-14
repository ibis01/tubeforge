/**
 * W7 — the finishing-layer proof (S120 §3 W7): the hand family, the
 * pen-up travel, the poses, the board carry, and the optional whiteboard
 * SFX — rendered through the REAL engine (chromium + ffmpeg) with the
 * FULL house QC battery riding the final (the loudness contract is the
 * exit gate's judge).
 *
 * The fixture project:
 *   scene 1 "s1" — heart-main (role-less → draw), arrow-curve (arrow →
 *                  point), heart-labels (label → write): every pose fires;
 *   scene 2 "s2" — CONTINUOUS board carrying heart-main (exit fade), plus
 *                  lungs (draw): the W6 carry and the W7 travel coexist;
 *   sfxOn: true — pop (scene 1 open), page-turn GONE (scene 2 carries),
 *                  pen strokes/stops across the schedule;
 *   a synthetic VO slot (normalized at the engine boundary, the S76 path)
 *   and a synthetic music bed — the full three-way mix arm.
 *
 * Receipts (validation/w7/, gitignored — the 535c90e law):
 *   structural — the REAL schedule's inter-stroke gaps ride the travel
 *                (visible, bounded, pose-correct) instead of the old mask;
 *   page       — the composed page carries all five pose groups with the
 *                project's chosen tool hand embedded;
 *   audio      — sfx.wav exists at the exact program duration; the cue
 *                plan counts match the planner;
 *   qc         — the unchanged battery (loudness/true-peak included) on
 *                the mixed final.
 * Determinism of the frames is the W1 gate's business (GREEN this
 * session, pre-W7); the SFX path is deterministic by construction (same
 * cues → same ffmpeg args), pinned by the pure planner's double-run.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { loadLibrary, handAssetIdFor } from "../src/lib/tubeforge/whiteboard/assets";
import {
  buildGeometry,
  estimateProjectFrames,
  frameAt,
  handAt,
  resolveCarriedInk,
  type AssetGeometry,
} from "../src/lib/tubeforge/whiteboard/timing";
import { beatSceneEvents } from "../src/lib/tubeforge/whiteboard/beat-plan";
import { composeScene } from "../src/lib/tubeforge/whiteboard/wb-page";
import { whiteboardSfxCues } from "../src/lib/tubeforge/whiteboard/sfx-plan";
import { framePlanClock } from "../src/lib/tubeforge/whiteboard/tracks";
import { renderWhiteboard } from "../src/lib/tubeforge/whiteboard/render";
import { runQcReport } from "../src/lib/tubeforge/qc";
import type { WhiteboardProject, WhiteboardScene } from "../src/lib/tubeforge/whiteboard/storyboard";

const execFileP = promisify(execFile);

const OUT_DIR = path.resolve("validation/w7");
const failures: string[] = [];
const ok = (cond: unknown, msg: string): asserts cond => {
  if (!cond) {
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
};

async function synthWav(file: string, args: string[]): Promise<void> {
  await execFileP("ffmpeg", ["-y", ...args, file], { maxBuffer: 32 * 1024 * 1024 });
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outDir = path.join(OUT_DIR, "render");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const lib = loadLibrary();
  const geometry: Map<string, AssetGeometry> = buildGeometry(
    [...lib.extracted.entries()].map(([id, ex]) => ({ id, paths: ex.paths }))
  );

  const s1: WhiteboardScene = {
    id: "s1",
    narration: "The heart pumps blood through the body every second of every day.",
    durationMs: 7000,
    background: "#ffffff",
    placements: [
      { assetId: "heart-main", placement: { x: 260, y: 220, scale: 1.4, rotateDeg: 0 }, order: 0 },
      { assetId: "arrow-curve", placement: { x: 700, y: 180, scale: 1.2, rotateDeg: 0 }, order: 1 },
      { assetId: "heart-labels", placement: { x: 300, y: 240, scale: 1.4, rotateDeg: 0 }, order: 2 },
    ],
    animations: [],
    camera: [],
  };
  const s2: WhiteboardScene = {
    id: "s2",
    narration: "The lungs renew it, and the loop begins again.",
    durationMs: 6000,
    background: "#ffffff",
    placements: [{ assetId: "lungs", placement: { x: 1050, y: 240, scale: 1.4, rotateDeg: 0 }, order: 0 }],
    animations: [],
    camera: [],
    board: { mode: "continuous", exit: "fade", transitionMs: 900 },
  };
  const project: WhiteboardProject = {
    title: "W7 finishing proof",
    width: 1920,
    height: 1080,
    fps: 24,
    hand: { style: "pencil", scale: 1.2 },
    sfxOn: true,
    scenes: [s1, s2],
  };

  // ---- structural pre-flight (the plan BEFORE chromium) ------------------
  console.log("[w7] structural receipts — the REAL schedule's travel + poses");
  const roles = new Map<string, NonNullable<WhiteboardScene["placements"][number]> & string>();
  for (const a of lib.assets.values()) if (a.role) roles.set(a.id, a.role as never);
  const events1 = beatSceneEvents(s1, 7000, geometry, new Map([...lib.assets.values()].map((a) => [a.id, a.tags] as [string, string[]])), undefined);
  const events2 = beatSceneEvents(s2, 6000, geometry, new Map([...lib.assets.values()].map((a) => [a.id, a.tags] as [string, string[]])), undefined);
  const eventsByScene = [events1, events2];

  const pen1 = events1.filter((e) => e.type === "draw_path" || e.type === "write_text") as { startMs: number; durationMs: number }[];
  pen1.sort((a, b) => a.startMs - b.startMs);
  let travelFrames = 0;
  let worstJump = 0;
  // Pose sampling runs over the WHOLE scene (the travel receipt loop is
  // separate and allowed to break early).
  const posesSeen = new Set<string>();
  for (let t = 0; t <= 7000; t += 1000 / 24) {
    const h = handAt(events1, s1, geometry, t, roles as never);
    if (h.visible) posesSeen.add(h.pose);
  }
  for (let t = 0; t < 7000; t += 1000 / 24) {
    const h = handAt(events1, s1, geometry, t, roles as never);
    // The REAL schedule's inter-stroke gaps: while NOT on a stroke, the
    // hand must be visible (travel) unless before the first stroke's entry
    // window or after the last — the plan's own semantics.
    const onStroke = pen1.some((e) => t >= e.startMs && t < e.startMs + e.durationMs);
    const afterLast = t >= Math.max(...pen1.map((e) => e.startMs + e.durationMs));
    const beforeFirst = t < pen1[0].startMs;
    if (!onStroke && !afterLast && !beforeFirst) {
      travelFrames++;
      ok(h.visible, `the pen travels at t=${t.toFixed(0)}ms (scene 1 gap)`);
      if (travelFrames > 3) break; // three receipts are enough; the unit pins own the rest
    }
  }
  // Consecutive-frame bound across one real gap.
  const gapStart = pen1[0].startMs + pen1[0].durationMs;
  const gapEnd = pen1[1]?.startMs ?? gapStart + 1;
  if (gapEnd > gapStart) {
    let prev = handAt(events1, s1, geometry, gapStart, roles as never);
    for (let t = gapStart + 1000 / 24; t < gapEnd; t += 1000 / 24) {
      const cur = handAt(events1, s1, geometry, t, roles as never);
      worstJump = Math.max(worstJump, Math.hypot(cur.x - prev.x, cur.y - prev.y));
      prev = cur;
    }
    const dist = Math.hypot(
      handAt(events1, s1, geometry, gapEnd, roles as never).x - prev.x + handAt(events1, s1, geometry, gapEnd, roles as never).x - handAt(events1, s1, geometry, gapStart, roles as never).x,
      0
    );
    ok(worstJump < 60, `the real gap's per-frame jump stays bounded (worst ${worstJump.toFixed(2)}px, gap ${(gapEnd - gapStart).toFixed(0)}ms)`);
    void dist;
  }
  ok(posesSeen.has("draw"), "the draw pose fired (role-less strokes)");
  ok(posesSeen.has("point"), "the point pose fired (arrow-curve is role arrow)");
  ok(posesSeen.has("write"), "the write pose fired (heart-labels is role label)");
  ok(posesSeen.has("rest"), "the tail rests");

  // The W6 carry coexists: scene 2 inherits heart-main at s1's end state.
  const s2Board = s2.board;
  ok(s2Board != null, "scene 2 carries its board policy");
  if (!s2Board) process.exit(1);
  const carry = resolveCarriedInk(s1, 7000, s2Board);
  ok(carry !== null && carry.placements.has("heart-main"), "scene 2 carries the heart (the W6 plan)");
  const f2 = frameAt(project, s2, events2, geometry, 0, carry, roles as never);
  ok(f2.carried !== null && f2.carried.exit.opacity === 1, "the carried ink is fully visible at scene 2's frame 0");

  // The cue plan (pure) — receipts before the render.
  const { sceneMs } = estimateProjectFrames(project, new Map());
  const clock = framePlanClock(sceneMs, project.fps);
  const { cues } = whiteboardSfxCues(project, clock, eventsByScene);
  ok(cues.some((c) => c.kind === "pop"), "the opening pop is planned");
  ok(!cues.some((c) => c.kind === "page-turn"), "scene 2 carries — NO page-turn (the carry IS the continuity)");
  const strokeCount = eventsByScene.flat().filter((e) => e.type === "draw_path" || e.type === "write_text").length;
  ok(cues.filter((c) => c.kind === "pen-stroke").length === strokeCount, `every stroke cues a pen-stroke (${strokeCount})`);
  ok(cues.length > strokeCount, `pen-stops/page accents ride along (${cues.length} cues total)`);

  // The composed page carries the pose skeleton with the PENCIL embedded.
  const composed = composeScene(s1, project, lib.assets, null);
  for (const pose of ["write", "draw", "point", "circle", "rest"]) {
    ok(composed.html.includes(`data-pose="${pose}"`), `the ${pose} group is in the page`);
  }
  // The setup embeds the project's chosen tool hand BY ID (render.ts's
  // evaluate pass, not the compose) — the proof pins the resolution.
  const toolId = handAssetIdFor(project.hand.style, project.hand.side);
  const toolAsset = lib.assets.get(toolId);
  ok(toolAsset && toolAsset.svg.length > 100, `the project's hand resolves to ${toolId} with real art`);

  // ---- the REAL render: synthetic VO + bed + SFX on ----------------------
  console.log("[w7] rendering through the real engine (pencil hand, sfxOn, carry)…");
  const voFile = path.join(outDir, "vo-s1.wav");
  // A speech-like synthetic slot: a soft 220 Hz tone with fades. The S76
  // boundary normalizes it (the production path) — the loudness gate then
  // judges the MIX. BOTH scenes carry slots (the production shape — a
  // partially-voiced project is a silent-draft edge, not the proof's job).
  await synthWav(voFile, [
    "-f", "lavfi", "-i", "sine=frequency=220:duration=4.2",
    "-af", "afade=t=in:d=0.1,afade=t=out:st=4:d=0.2,volume=0.8",
    "-ar", "48000", "-ac", "2",
  ]);
  const voFile2 = path.join(outDir, "vo-s2.wav");
  await synthWav(voFile2, [
    "-f", "lavfi", "-i", "sine=frequency=196:duration=3.6",
    "-af", "afade=t=in:d=0.1,afade=t=out:st=3.4:d=0.2,volume=0.8",
    "-ar", "48000", "-ac", "2",
  ]);
  const bedFile = path.join(OUT_DIR, "bed.wav");
  await synthWav(bedFile, [
    "-f", "lavfi", "-i", "sine=frequency=55:duration=13.5",
    "-af", "volume=0.5",
    "-ar", "48000", "-ac", "2",
  ]);
  const voFiles = new Map([["s1", voFile], ["s2", voFile2]]);
  const result = await renderWhiteboard(project, {
    outDir,
    voFiles,
    musicPath: bedFile,
    onProgress: (label, frac) => {
      if (label.includes("composing") || label.endsWith("1/1") || Math.abs(frac * 100) % 25 < 1) {
        console.log(`  [render] ${label}`);
      }
    },
  });

  ok(fs.existsSync(result.file), "final.mp4 exists");
  ok(result.boardModes.join(",") === "clean,continuous", `the result records the board modes (${result.boardModes.join(",")})`);
  const sfxWav = path.join(outDir, "sfx.wav");
  ok(fs.existsSync(sfxWav), "the SFX layer assembled");
  const { stdout: durOut } = await execFileP("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", sfxWav]);
  const sfxDur = Number(JSON.parse(durOut).format?.duration ?? 0);
  const expectedDur = clock.totalSec;
  ok(Math.abs(sfxDur - expectedDur) < 0.1, `the SFX layer spans the program (${sfxDur.toFixed(2)}s ≈ ${expectedDur.toFixed(2)}s)`);

  // ---- the QC battery on the mixed final ---------------------------------
  console.log("[w7] the full QC battery on the mixed final…");
  const qc = await runQcReport({
    mp4Path: result.file,
    videoDuration: clock.totalSec,
    narrationSec: null,
    srtPath: null,
    expectedAspect: "16:9",
    frameRate: project.fps,
  });
  const checks = (qc as { checks?: { id: string; status: string; value?: string }[] }).checks ?? [];
  for (const c of checks) console.log(`  [qc] ${c.id}: ${c.status}${c.value ? ` (${c.value})` : ""}`);
  const qcFails = checks.filter((c) => c.status === "fail");
  ok(qcFails.length === 0, `QC GREEN on the mixed final${qcFails.length ? " — fails: " + qcFails.map((c) => c.id).join(", ") : ""}`);
  const loudness = checks.find((c) => c.id === "loudness");
  ok(loudness && loudness.status === "pass", `the loudness contract holds with SFX in the mix (${loudness?.value ?? "?"})`);
  const truePeak = checks.find((c) => c.id === "true-peak");
  ok(truePeak && truePeak.status === "pass", `true-peak holds (${truePeak?.value ?? "?"})`);

  // The receipt (local, gitignored).
  const receipt = {
    stage: "W7",
    what: "the finishing layer — hand family/travel/poses + the carry + the SFX mix, through the real engine",
    posesSeen: [...posesSeen],
    travelReceipts: { travelFrames, worstJumpPx: Number(worstJump.toFixed(2)) },
    cueCount: cues.length,
    strokeCount,
    boardModes: result.boardModes,
    sfxDurSec: sfxDur,
    qc: checks.map((c) => ({ id: c.id, status: c.status })),
    failures,
    recordedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(OUT_DIR, "w7-proof.json"), JSON.stringify(receipt, null, 2));
  console.log(`\n[w7] PROOF ${failures.length === 0 ? "GREEN" : "RED"} — receipt: validation/w7/w7-proof.json`);
  if (failures.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error("[w7] PROOF FAILED:", e);
  process.exit(1);
});

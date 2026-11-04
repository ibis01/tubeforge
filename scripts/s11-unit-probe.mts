// S11 unit probe — "the pace": the narrator-tempo contract through REAL
// modules. Two layers, mirroring the sprint's evidence pattern:
//   1. PURE boundaries (no I/O): the stale-artifact set the re-read uses
//      (the .wav/.mp4 split — the same doctrine as the narrator swap),
//      the zod shape gate (bounds, coercion, junk), the doc fold — the
//      exact per-scene fold performPaceChange runs, minus the TTS —
//      proving every creative field + the S6/S7/S9/S10 picks on
//      renderPrefs SURVIVE a pace change while every window honestly
//      re-derives (faster reads → shorter windows), the segment math, and
//      the estimator's pace direction.
//   2. DB-backed guard matrix (a real video row, surgical overrides): every
//      guard refuses with a readable message BEFORE any TTS work — non-story
//      format, custom audio, no voiceover, out-of-range pace, unchanged
//      pace, no doc, no scenes. The happy path (real synthesis) belongs to
//      the route e2e.
// Run: node --import tsx scripts/s11-unit-probe.mts
import {
  isVoiceSwapStale,
  applyRevoiceToDoc,
  sceneSegmentSec,
} from "../src/lib/tubeforge/clip-ops";
import { paceChangeSchema } from "../src/lib/tubeforge/validation";
import {
  assembleTimeline,
  serializeTimeline,
  estimateNarrationSec,
  type AssembledTimeline,
} from "../src/lib/tubeforge/timeline";
import { parseScenes } from "../src/lib/tubeforge/story";
import { LEAD_SEC, TAIL_SEC, MIN_SEG_SEC } from "../src/lib/tubeforge/render";
import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

const sceneJson = () =>
  JSON.stringify([
    {
      index: 1, title: "Hook", narration: "The opening line lands here.", visual: "a dark skyline",
      camera: "zoom-in", mood: "tense", caption: "", hostInScene: false, rehook: true, sfx: "boom",
    },
    {
      index: 2, title: "Turn", narration: "The turn arrives and holds attention.", visual: "rain on glass",
      camera: "static", mood: "calm", caption: "", hostInScene: false, rehook: false, sfx: "none",
    },
    {
      index: 3, title: "Close", narration: "The close earns the click.", visual: "first light",
      camera: "pull-back", mood: "warm", caption: "", hostInScene: false, rehook: false, sfx: "none",
    },
  ]);

// =====================================================================
// 1. pure: the stale-artifact boundary (the .wav/.mp4 split) — a pace
//    change re-reads, so the SAME set the narrator swap drops governs:
//    renders keyed to the old reads die; reads, art and exports survive.
// =====================================================================
check(
  "the re-read drops the rendered outputs keyed to the OLD reads",
  ["vid/final.mp4", "vid/preview.mp4", "vid/subtitles.srt", "vid/short.mp4", "vid/short-thumb.png", "vid/scene-01.mp4", "vid/scene-12.mp4"].every(isVoiceSwapStale)
);

check(
  "the re-read REBUILDS the reads + art + thumbnail (they survive the drop)",
  !["vid/voiceover.wav", "vid/scene-01.wav", "vid/scene-12.wav", "vid/scene-01.png", "vid/thumbnail.png", "vid/thumb-a.png", "vid/export.zip"]
    .some(isVoiceSwapStale)
);

check(
  "near-miss keys never match (suffix must be exact)",
  !isVoiceSwapStale("vid/final.mp4?x=1") &&
    !isVoiceSwapStale("vid/final.mp4.bak") &&
    !isVoiceSwapStale("vid/myfinal.mp4") &&
    !isVoiceSwapStale("vid/scene-01.wav.exe")
);

// =====================================================================
// 2. pure: the zod shape gate — bounds, coercion, junk
// =====================================================================
check(
  "paceChangeSchema: the ladder + boundaries + off-ladder speeds pass, coercion works",
  (() => {
    const ladder = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2].every(
      (s) => paceChangeSchema.safeParse({ speed: s }).success
    );
    const offLadder = paceChangeSchema.safeParse({ speed: 1.2 });
    const coerced = paceChangeSchema.safeParse({ speed: "1.3" });
    return (
      ladder &&
      offLadder.success && offLadder.data.speed === 1.2 &&
      coerced.success && coerced.data.speed === 1.3
    );
  })()
);

check(
  "paceChangeSchema: out-of-range, junk, missing all die at the shape gate",
  !paceChangeSchema.safeParse({ speed: 0.49 }).success &&
    !paceChangeSchema.safeParse({ speed: 2.01 }).success &&
    !paceChangeSchema.safeParse({ speed: 0 }).success &&
    !paceChangeSchema.safeParse({ speed: -1 }).success &&
    !paceChangeSchema.safeParse({ speed: "fast" }).success &&
    !paceChangeSchema.safeParse({ speed: NaN }).success &&
    !paceChangeSchema.safeParse({ speed: Infinity }).success &&
    !paceChangeSchema.safeParse({}).success &&
    !paceChangeSchema.safeParse({ speed: null }).success
);

// =====================================================================
// 3. pure: the doc fold — a pace change re-derives every window (faster
//    reads → shorter windows) and preserves EVERY creative field + the
//    doc-level picks (caption style, score, poster, short)
// =====================================================================

/** The exact fold performPaceChange runs per scene (minus the TTS): fold
 *  applyRevoiceToDoc over the row order with the fresh read lengths. */
const foldPace = (
  doc: AssembledTimeline,
  scenes: { index: number; narration: string }[],
  freshDurSec: number[]
): AssembledTimeline => {
  let next = doc;
  scenes.forEach((s, i) => {
    next = applyRevoiceToDoc(next, s.index, s.narration, freshDurSec[i]);
  });
  return next;
};

const seedDoc = (): AssembledTimeline => {
  const doc = assembleTimeline(parseScenes(sceneJson()), {
    sceneDurationsSec: [5, 5, 5],
  });
  // Sprinkle EVERY creative layer the sprints added — a pace change must
  // carry each one across untouched (the re-read changes only the tempo).
  doc.renderPrefs = {
    quality: "high",
    captionStyle: "amber-warm",
    music: { mode: "mood", moodId: "calm" },
    poster: { mode: "scene", sceneIndex: 2 },
    short: { mode: "scene", sceneIndex: 3 },
  };
  const s0 = doc.scenes[0];
  s0.grade = { brightness: 1.1, contrast: 1.2, saturation: 0.8, temperature: 0.1, vignette: 0.4 };
  s0.titleOverlay = { text: "The Hook", style: "bold", anim: "rise", pos: "bottom", size: 1.2 };
  s0.cameraKeys = { from: { scale: 1.3, x: 0.5, y: 0.4 }, to: { scale: 1.0, x: 0.5, y: 0.5 }, ease: "smooth" };
  s0.speed = 1.1;
  s0.chroma = { color: "#00ff00", similarity: 0.32, blend: 0.08, background: "#101010" };
  s0.pip = { pos: "tr", size: 0.18, opacity: 0.9, border: true, margin: 0.03 };
  s0.audio = {
    voice: { enabled: true, level: 0.9, fadeInSec: 0.4, fadeOutSec: 0.6 },
    music: { enabled: true, level: 0.5, ducking: true },
    sfx: { enabled: true, level: 0.55, kind: "boom" },
    ambient: { enabled: true, level: 0.1, kind: "rain" },
  };
  s0.caption = { text: "an edited caption", startSec: 1, endSec: 4 };
  s0.transitionOut = "fadeblack";
  const s1 = doc.scenes[1];
  s1.grade = { brightness: 0.95, contrast: 1.0, saturation: 1.15, temperature: 0, vignette: 0 };
  s1.transitionIn = "cut";
  return doc;
};

check(
  "the fold preserves every creative field and ALL the doc-level picks (S6/S7/S9/S10)",
  (() => {
    const doc = seedDoc();
    const rowScenes = parseScenes(sceneJson());
    // a 1.3× read of the same words comes out shorter — the tempo tell
    const paced = foldPace(doc, rowScenes, [3.9, 5.2, 1.9]);
    const a = paced.scenes[0];
    return (
      paced.renderPrefs?.quality === "high" &&
      paced.renderPrefs?.captionStyle === "amber-warm" &&
      paced.renderPrefs?.music?.mode === "mood" &&
      paced.renderPrefs?.music?.moodId === "calm" &&
      paced.renderPrefs?.poster?.mode === "scene" &&
      paced.renderPrefs?.poster?.sceneIndex === 2 &&
      paced.renderPrefs?.short?.mode === "scene" &&
      paced.renderPrefs?.short?.sceneIndex === 3 &&
      JSON.stringify(a.grade) === JSON.stringify(doc.scenes[0].grade) &&
      JSON.stringify(a.titleOverlay) === JSON.stringify(doc.scenes[0].titleOverlay) &&
      JSON.stringify(a.cameraKeys) === JSON.stringify(doc.scenes[0].cameraKeys) &&
      a.speed === 1.1 &&
      JSON.stringify(a.chroma) === JSON.stringify(doc.scenes[0].chroma) &&
      JSON.stringify(a.pip) === JSON.stringify(doc.scenes[0].pip) &&
      JSON.stringify(a.audio) === JSON.stringify(doc.scenes[0].audio) &&
      a.caption?.text === "an edited caption" &&
      a.transitionOut === "fadeblack" &&
      paced.scenes[1].transitionIn === "cut" &&
      paced.scenes.every((s, i) => s.narration === rowScenes[i].narration)
    );
  })()
);

check(
  "the fold re-derives every window: durations follow the faster reads, starts re-anchor, total sums",
  (() => {
    const doc = seedDoc();
    const rowScenes = parseScenes(sceneJson());
    const paced = foldPace(doc, rowScenes, [3.9, 5.2, 1.9]);
    const durs = paced.scenes.map((s) => s.durationSec);
    const starts = paced.scenes.map((s) => s.startSec);
    return (
      durs[0] === 3.9 && durs[1] === 5.2 && durs[2] === 1.9 &&
      starts[0] === 0 && starts[1] === 3.9 && starts[2] === 9.1 &&
      paced.totalDurationSec === 11 &&
      paced.sceneCount === 3
    );
  })()
);

check(
  "an explicit trim honestly resets — a window tuned to the OLD tempo is stale the moment the words are re-read",
  (() => {
    const doc = seedDoc();
    // the studio stretched scene 2 out to 7s against the OLD 5s window
    doc.scenes[1] = { ...doc.scenes[1], durationSec: 7 };
    const rowScenes = parseScenes(sceneJson());
    const paced = foldPace(doc, rowScenes, [5, 5, 5]);
    // the fresh read is 5s — the trim does NOT survive its own scene's re-read
    return paced.scenes[1].durationSec === 5 && paced.totalDurationSec === 15;
  })()
);

check(
  "sceneSegmentSec: the render's window formula — short reads floor at MIN_SEG, longer reads carry lead + tail",
  sceneSegmentSec(0.2) === MIN_SEG_SEC &&
    sceneSegmentSec(0.8) === MIN_SEG_SEC &&
    Math.abs(sceneSegmentSec(4) - (4 + LEAD_SEC + TAIL_SEC)) < 1e-9 &&
    Math.abs(sceneSegmentSec(11.5) - (11.5 + LEAD_SEC + TAIL_SEC)) < 1e-9
);

check(
  "estimateNarrationSec: the estimator scales with the pace (faster = shorter) — the assemble-time shadow of the tempo",
  (() => {
    const line = "The opening line lands here and keeps going for a while.";
    const words = line.trim().split(/\s+/).filter(Boolean).length;
    const base = estimateNarrationSec(line, 1);
    const faster = estimateNarrationSec(line, 1.5);
    const slower = estimateNarrationSec(line, 0.5);
    // the formula: max(1.5, words / (2.5 × speed) + 0.4) — the lead-in
    // constant and the silent-beat floor ride along, so the ratio is not
    // pure; the honest assertions are the formula + the direction.
    return (
      base > 0 &&
      Math.abs(base - (words / 2.5 + 0.4)) < 1e-9 &&
      Math.abs(faster - (words / (2.5 * 1.5) + 0.4)) < 1e-9 &&
      Math.abs(slower - (words / (2.5 * 0.5) + 0.4)) < 1e-9 &&
      faster < base && base < slower &&
      estimateNarrationSec(line) === base && // default = the standing 1×
      estimateNarrationSec("") === 1.5 // silent scene still needs a beat
    );
  })()
);

check(
  "the paced result is saveable: serializeTimeline accepts the folded doc (the row round-trip)",
  (() => {
    const doc = seedDoc();
    const rowScenes = parseScenes(sceneJson());
    const paced = foldPace(doc, rowScenes, [3.9, 5.2, 1.9]);
    const text = serializeTimeline(paced);
    return (
      typeof text === "string" &&
      text.includes("amber-warm") &&
      text.includes('"mode":"mood"') &&
      text.includes('"sceneCount":3')
    );
  })()
);

// =====================================================================
// 4. DB-backed guard matrix — a real video row, surgical overrides; every
//    call must refuse BEFORE any synthesis work (no TTS in the unit probe).
//    The happy path with real synthesis is the route e2e's job.
// =====================================================================
const MARK = crypto.randomBytes(4).toString("hex");
const raw = new PrismaClient();

const expectRefusal = async (
  name: string,
  video: Record<string, unknown>,
  speed: number,
  needle: string
) => {
  try {
    const { performPaceChange } = await import("../src/lib/tubeforge/clip-ops");
    await performPaceChange(video as never, speed);
    check(name, false, "the pace change PROCEEDED — guard missing");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    check(name, msg.includes(needle), msg);
  }
};

try {
  const org = await raw.organization.create({
    data: { name: `s11 ${MARK}`, slug: `s11-${MARK}` },
  });
  const doc = assembleTimeline(parseScenes(sceneJson()), { sceneDurationsSec: [5, 5, 5] });
  const base = await raw.video.create({
    data: {
      organizationId: org.id,
      topic: `S11 pace probe ${MARK}`,
      niche: "Motivation",
      format: "story",
      status: "draft",
      voice: "jam",
      ttsSpeed: 1.0,
      hasVoiceover: true,
      scenes: sceneJson(),
      timeline: serializeTimeline(doc),
    },
  });

  await expectRefusal(
    "guard: a non-story video cannot pick the pace in the studio",
    { ...base, format: "script" },
    1.3,
    "scene-format videos only"
  );
  await expectRefusal(
    "guard: custom audio cannot be re-read at a studio pace",
    { ...base, voiceSource: "custom" },
    1.3,
    "custom audio"
  );
  await expectRefusal(
    "guard: the studio re-paces EXISTING reads — generate the voiceover first",
    { ...base, hasVoiceover: false },
    1.3,
    "Generate the voiceover first"
  );
  await expectRefusal(
    "guard: an under-range pace refuses at the pure boundary",
    { ...base },
    0.3,
    "between 0.5× and 2×"
  );
  await expectRefusal(
    "guard: an over-range pace refuses at the pure boundary",
    { ...base },
    2.7,
    "between 0.5× and 2×"
  );
  await expectRefusal(
    "guard: re-reading at the CURRENT pace is a no-op refusal",
    { ...base },
    1.0,
    "current pace"
  );
  await expectRefusal(
    "guard: no timeline doc — assemble first",
    { ...base, timeline: null },
    1.3,
    "Assemble the timeline first"
  );
  await expectRefusal(
    "guard: no scenes — the script stage must run first",
    { ...base, scenes: "[]" },
    1.3,
    "No scenes"
  );

  // cleanup (self-cleaning: the probe leaves no rows behind)
  await raw.video.delete({ where: { id: base.id } }).catch(() => {});
  await raw.organization.delete({ where: { id: org.id } }).catch(() => {});
} finally {
  await raw.$disconnect();
}

// wrap-up
console.log(failures === 0 ? "\nS11 UNIT PROBE: ALL PASS" : `\nS11 UNIT PROBE: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

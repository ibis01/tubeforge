// S8 unit probe — "the voice": the narrator-swap contract through REAL
// modules. Two layers, mirroring the sprint's evidence pattern:
//   1. PURE boundaries (no I/O): which artifacts a swap invalidates (the
//      .wav/.mp4 split), the zod save boundary, the doc fold — the exact
//      per-scene fold performVoiceSwap runs, minus the TTS — proving every
//      creative field + the S6/S7 picks on renderPrefs SURVIVE a narrator
//      swap while every window honestly re-derives, and the segment math.
//   2. DB-backed guard matrix (a real video row, surgical overrides): every
//      guard refuses with a readable message BEFORE any TTS work — non-story
//      format, custom audio, no voiceover, unchanged voice, no doc, no
//      scenes. The happy path (real synthesis) belongs to the route e2e.
// Run: node --import tsx scripts/s8-unit-probe.mts
import {
  isVoiceSwapStale,
  applyRevoiceToDoc,
  sceneSegmentSec,
} from "../src/lib/tubeforge/clip-ops";
import { voiceSwapSchema } from "../src/lib/tubeforge/validation";
import {
  assembleTimeline,
  serializeTimeline,
  type AssembledTimeline,
} from "../src/lib/tubeforge/timeline";
import { parseScenes } from "../src/lib/tubeforge/story";
import { voiceCatalog } from "../src/lib/tubeforge/providers/tts";
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
// 1. pure: the stale-artifact boundary (the .wav/.mp4 split)
// =====================================================================
check(
  "isVoiceSwapStale: rendered outputs die on a swap",
  ["vid/final.mp4", "vid/preview.mp4", "vid/subtitles.srt", "vid/short.mp4", "vid/short-thumb.png", "vid/scene-01.mp4", "vid/scene-12.mp4"].every(isVoiceSwapStale)
);

check(
  "isVoiceSwapStale: the reads + art + thumbnail SURVIVE (the swap rebuilds them)",
  !["vid/voiceover.wav", "vid/scene-01.wav", "vid/scene-12.wav", "vid/scene-01.png", "vid/thumbnail.png", "vid/thumb-a.png", "vid/export.zip"]
    .some(isVoiceSwapStale)
);

check(
  "isVoiceSwapStale: near-miss keys never match (suffix must be exact; keys come from storage.list, always normalized)",
  !isVoiceSwapStale("vid/final.mp4?x=1") &&
    !isVoiceSwapStale("vid/final.mp4.bak") &&
    !isVoiceSwapStale("vid/myfinal.mp4") &&
    !isVoiceSwapStale("vid/scene-01.wav.exe") &&
    !isVoiceSwapStale("vid/voiceover.wav.mp4")
);

// =====================================================================
// 2. pure: the zod save boundary + the catalog pair
// =====================================================================
check(
  "voiceSwapSchema: stock + clone ids pass (trimmed), junk dies at the shape gate",
  (() => {
    const stock = voiceSwapSchema.safeParse({ voice: "kazi" });
    const clone = voiceSwapSchema.safeParse({ voice: "voice_clone_20240315_143052_001" });
    const padded = voiceSwapSchema.safeParse({ voice: " jam " });
    return (
      stock.success && stock.data.voice === "kazi" &&
      clone.success &&
      padded.success && padded.data.voice === "jam" &&
      !voiceSwapSchema.safeParse({ voice: "" }).success &&
      !voiceSwapSchema.safeParse({ voice: "../../etc/passwd" }).success &&
      !voiceSwapSchema.safeParse({ voice: "DROP TABLE voices" }).success &&
      !voiceSwapSchema.safeParse({ voice: 42 }).success &&
      !voiceSwapSchema.safeParse({}).success
    );
  })()
);

check(
  "the catalog carries the studio voices (the e2e swap pair is legal)",
  (() => {
    const ids = voiceCatalog("zai").map((v) => v.id);
    return ids.includes("jam") && ids.includes("kazi") && ids.includes("luodo");
  })()
);

// =====================================================================
// 3. pure: the doc fold — a narrator swap re-derives every window and
//    preserves EVERY creative field + the doc-level picks
// =====================================================================

/** The exact fold performVoiceSwap runs per scene (minus the TTS): fold
 *  applyRevoiceToDoc over the row order with the fresh read lengths. */
const foldSwap = (
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
  // Sprinkle EVERY creative layer the sprints added — a swap must carry
  // each one across untouched.
  doc.renderPrefs = {
    quality: "high",
    captionStyle: "amber-warm",
    music: { mode: "mood", moodId: "calm" },
  };
  const s0 = doc.scenes[0];
  s0.grade = { brightness: 1.1, contrast: 1.2, saturation: 0.8, vignette: 0.4 };
  s0.titleOverlay = { text: "The Hook", style: "bold", anim: "rise", pos: "bottom", durSec: 2.5 };
  s0.cameraKeys = { from: { scale: 1.3, cx: 0.5, cy: 0.4 }, to: { scale: 1.0, cx: 0.5, cy: 0.5 }, ease: "easeOut" };
  s0.speed = 1.1;
  s0.chroma = { color: "#00ff00", similarity: 0.32, blend: 0.08, spill: 0.06 };
  s0.pip = { asset: "logo.png", pos: "tr", scale: 0.18, opacity: 0.9 };
  s0.audio = {
    voice: { enabled: true, level: 0.9, fadeInSec: 0.4, fadeOutSec: 0.6 },
    music: { enabled: true, level: 0.5, ducking: true },
    sfx: { enabled: true, level: 0.55, kind: "boom" },
    ambient: { enabled: true, level: 0.1, kind: "rain" },
  };
  s0.caption = { text: "an edited caption", startSec: 1, endSec: 4 };
  s0.transitionOut = "fadeblack";
  const s1 = doc.scenes[1];
  s1.grade = { brightness: 0.95, contrast: 1.0, saturation: 1.15, vignette: 0 };
  s1.transitionIn = "cut";
  return doc;
};

check(
  "the fold preserves every creative field, the S6/S7 picks and the narration",
  (() => {
    const doc = seedDoc();
    const rowScenes = parseScenes(sceneJson());
    // fresh reads: shorter, longer, shorter — windows must follow each read
    const swapped = foldSwap(doc, rowScenes, [3.2, 6.8, 2.4]);
    const a = swapped.scenes[0];
    return (
      swapped.renderPrefs?.quality === "high" &&
      swapped.renderPrefs?.captionStyle === "amber-warm" &&
      swapped.renderPrefs?.music?.mode === "mood" &&
      swapped.renderPrefs?.music?.moodId === "calm" &&
      JSON.stringify(a.grade) === JSON.stringify(doc.scenes[0].grade) &&
      JSON.stringify(a.titleOverlay) === JSON.stringify(doc.scenes[0].titleOverlay) &&
      JSON.stringify(a.cameraKeys) === JSON.stringify(doc.scenes[0].cameraKeys) &&
      a.speed === 1.1 &&
      JSON.stringify(a.chroma) === JSON.stringify(doc.scenes[0].chroma) &&
      JSON.stringify(a.pip) === JSON.stringify(doc.scenes[0].pip) &&
      JSON.stringify(a.audio) === JSON.stringify(doc.scenes[0].audio) &&
      a.caption?.text === "an edited caption" &&
      a.transitionOut === "fadeblack" &&
      swapped.scenes[1].transitionIn === "cut" &&
      a.narration === rowScenes[0].narration &&
      swapped.scenes.every((s, i) => s.narration === rowScenes[i].narration)
    );
  })()
);

check(
  "the fold re-derives every window: durations follow the fresh reads, starts re-anchor, total sums",
  (() => {
    const doc = seedDoc();
    const rowScenes = parseScenes(sceneJson());
    const swapped = foldSwap(doc, rowScenes, [3.2, 6.8, 2.4]);
    const durs = swapped.scenes.map((s) => s.durationSec);
    const starts = swapped.scenes.map((s) => s.startSec);
    const total = swapped.totalDurationSec;
    return (
      durs[0] === 3.2 && durs[1] === 6.8 && durs[2] === 2.4 &&
      starts[0] === 0 && starts[1] === 3.2 && starts[2] === 10 &&
      total === 12.4 &&
      swapped.sceneCount === 3
    );
  })()
);

check(
  "an explicit trim honestly resets — a window tuned to the OLD read is stale the moment the words are re-read",
  (() => {
    const doc = seedDoc();
    // the studio trimmed scene 2 down to 3.5s against the OLD 5s window
    doc.scenes[1] = { ...doc.scenes[1], durationSec: 3.5 };
    const rowScenes = parseScenes(sceneJson());
    const swapped = foldSwap(doc, rowScenes, [5, 5, 5]);
    // the fresh read is 5s — the trim does NOT survive its own scene's re-read
    return swapped.scenes[1].durationSec === 5 && swapped.totalDurationSec === 15;
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
  "the swap result is saveable: serializeTimeline accepts the folded doc (the row round-trip)",
  (() => {
    const doc = seedDoc();
    const rowScenes = parseScenes(sceneJson());
    const swapped = foldSwap(doc, rowScenes, [3.2, 6.8, 2.4]);
    const text = serializeTimeline(swapped);
    return typeof text === "string" && text.includes("amber-warm") && text.includes('"mode":"mood"');
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
  needle: string
) => {
  try {
    const { performVoiceSwap } = await import("../src/lib/tubeforge/clip-ops");
    await performVoiceSwap(video as never, "kazi");
    check(name, false, "the swap PROCEEDED — guard missing");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    check(name, msg.includes(needle), msg);
  }
};

try {
  const org = await raw.organization.create({
    data: { name: `s8 ${MARK}`, slug: `s8-${MARK}` },
  });
  const doc = assembleTimeline(parseScenes(sceneJson()), { sceneDurationsSec: [5, 5, 5] });
  const base = await raw.video.create({
    data: {
      organizationId: org.id,
      topic: `S8 voice probe ${MARK}`,
      niche: "Motivation",
      format: "story",
      status: "draft",
      voice: "jam",
      hasVoiceover: true,
      scenes: sceneJson(),
      timeline: serializeTimeline(doc),
    },
  });

  await expectRefusal(
    "guard: a non-story video cannot pick the narrator in the studio",
    { ...base, format: "script" },
    "scene-format videos only"
  );
  await expectRefusal(
    "guard: custom audio cannot be re-read by a studio voice",
    { ...base, voiceSource: "custom" },
    "custom audio"
  );
  await expectRefusal(
    "guard: the studio re-voices EXISTING reads — generate the voiceover first",
    { ...base, hasVoiceover: false },
    "Generate the voiceover first"
  );
  await expectRefusal(
    "guard: swapping to the SAME voice is a no-op refusal",
    { ...base, voice: "kazi" },
    "current narrator"
  );
  await expectRefusal(
    "guard: no timeline doc — assemble first",
    { ...base, timeline: null },
    "Assemble the timeline first"
  );
  await expectRefusal(
    "guard: no scenes — the script stage must run first",
    { ...base, scenes: "[]" },
    "No scenes"
  );

  // cleanup (self-cleaning: the probe leaves no rows behind)
  await raw.video.delete({ where: { id: base.id } }).catch(() => {});
  await raw.organization.delete({ where: { id: org.id } }).catch(() => {});
} finally {
  await raw.$disconnect();
}

// wrap-up
console.log(failures === 0 ? "\nS8 UNIT PROBE: ALL PASS" : `\nS8 UNIT PROBE: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

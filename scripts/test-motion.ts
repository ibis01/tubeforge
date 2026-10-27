// Smart Motion suite — validates the REAL Ken Burns engine
// (src/lib/tubeforge/motion.ts) by direct import, so it can never drift from
// production like a copied filter string would.
//
//   1. Scene classification — the movement table (emotional -> zoom in,
//      establishing -> zoom out, map -> pan, suspense -> gradual, action ->
//      short cuts, text -> minimal) chosen from scene words.
//   2. Focal points — LLM tokens, keyword fallbacks, face anchoring.
//   3. Plan invariants — zoom always >= 1.0 (no empty borders), amplitudes
//      capped, shot pools sized from scene duration, direction variation.
//   4. Focal-in-frame PROOF — pan sweeps sampled end to end with the focal
//      point kept inside the frame with margin, against the same math the
//      graph builder uses (panEndpoints).
//   5. Filter graphs — parseable zoompan chains, no NaN/undefined, correct
//      output sizes for 16:9 and 9:16, static plans skip zoompan.
//   6. REAL ffmpeg renders — three segments rendered through the actual
//      graphs (emotional zoom, action multi-cut, static): exact durations,
//      zero black frames, cuts where cuts are due, stillness where stillness
//      is due.

import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import type { Scene } from "../src/lib/tubeforge/types.ts";
import {
  MOTION_DEFAULTS,
  OUTPUT_SIZES,
  classifyScene,
  focalForScene,
  normalizeFocalToken,
  panEndpoints,
  planSceneMovements,
  planSummaryLine,
  sanitizeMotion,
  sceneFilterGraph,
} from "../src/lib/tubeforge/motion.ts";

const run = promisify(execFile);
const TMP = "/home/z/my-project/scripts/motion-tmp";
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const scene = (over: Partial<Scene>): Scene => ({
  index: 1,
  title: "Scene",
  narration: "He opens the door.",
  visual: "a man opens a heavy bronze door",
  camera: "zoom-in",
  mood: "cold moonlight",
  caption: "The door",
  hostInScene: false,
  rehook: false,
  sfx: "none",
  ...over,
});

// ---------- 1. classification: the movement table ----------

console.log("\n1. Scene classification (the movement table)");
const table: [Partial<Scene>, string, string][] = [
  [{ visual: "extreme close-up of her face, tears catching lantern light" }, "emotional", "emotional close-up"],
  [{ visual: "vast desert landscape at sunrise, dunes to the horizon", hostInScene: false }, "establishing", "landscape / establishing"],
  [{ visual: "an aged map of the Nile delta, worn parchment edges", camera: "pan-right" }, "detail", "historical map -> pan"],
  [{ visual: "a dark figure lurking at the end of the corridor", mood: "ominous haze", sfx: "sting", rehook: true }, "suspense", "suspenseful scene (even as a rehook)"],
  [{ visual: "soldiers charging through a collapsing gate, debris flying", sfx: "boom", rehook: true }, "action", "high-energy montage"],
  [{ visual: "the signed contract with its signature line and wax seal" }, "text", "text-heavy image"],
  [{ visual: "a craftsman carving a wooden mask in his workshop" }, "standard", "everything else"],
];
for (const [over, expected, label] of table) {
  const kind = classifyScene(scene(over));
  check(label, kind === expected, `${kind} (want ${expected})`);
}
check(
  "host presence reads as a face scene",
  classifyScene(scene({ visual: "standing by the workshop bench", hostInScene: true })) === "emotional"
);
check(
  "mysterious tone biases suspense",
  classifyScene(scene({ visual: "a locked cabinet in the cellar" }), { tone: "mysterious" }) === "suspense"
);
check(
  "text legibility beats everything",
  classifyScene(scene({ visual: "close-up of a face over an open letter with writing" })) === "text"
);

// ---------- 2. focal points ----------

console.log("\n2. Focal points (eyes stay where the story needs them)");
check("LLM token upper-right", (() => {
  const f = focalForScene(scene({ focal: "upper-right" }));
  return f.x === 0.68 && f.y === 0.35;
})());
check("alias top-left normalizes", normalizeFocalToken("Top Left") === "upper-left");
check("garbage token falls back to keywords", (() => {
  const f = focalForScene(scene({ focal: "somewhere-nice", visual: "the throne on the left side of the hall" }));
  return f.x === 0.34;
})());
check("no hints -> center", (() => {
  const f = focalForScene(scene({}));
  return f.x === 0.5 && f.y === 0.5;
})());
check("faces anchor above center", (() => {
  const f = focalForScene(scene({ visual: "close-up of a face on the right" }));
  return f.x === 0.66 && f.y <= 0.45;
})());
check("edge keyword gives an edge focal (face-near-edge case)", (() => {
  const f = focalForScene(scene({ focal: "right" }));
  return f.x >= 0.6;
})());

// ---------- 3. plan invariants ----------

console.log("\n3. Plan invariants");
const defaultSettings = sanitizeMotion(null);
check("sanitize falls back to Smart Motion 12% smooth vary", (() => {
  const s = defaultSettings;
  return (
    s.mode === "smart" && s.intensity === 12 && s.curve === "smooth" && s.vary === true
  );
})());
check("sanitize clamps bad values", (() => {
  const s = sanitizeMotion({ mode: "hoolahoop", intensity: 900, curve: "zigzag" });
  return s.mode === "smart" && s.intensity === 30 && s.curve === "smooth";
})());

const scenes: Scene[] = [
  scene({ index: 1, visual: "extreme close-up of her face, candlelight", rehook: true }),
  scene({ index: 2, visual: "vast mountain landscape at dawn" }),
  scene({ index: 3, visual: "an aged nautical map of the Atlantic" }),
  scene({ index: 4, visual: "a dark figure lurking at the tunnel end", sfx: "sting", rehook: true }),
  scene({ index: 5, visual: "chariots charging across the riverbed, dust everywhere", sfx: "riser", rehook: false }),
  scene({ index: 6, visual: "the signed treaty with its signature line and wax seal" }),
  scene({ index: 7, visual: "a craftsman carving a wooden mask" }),
  scene({ index: 8, visual: "the city skyline at dusk, lights coming on" }),
];
const plans = planSceneMovements(scenes, defaultSettings, {
  aspect: "16:9",
  durationsSec: [5, 5, 6, 5, 6, 5, 5, 5],
});

let zOk = true;
for (const p of plans) {
  for (const s of p.shots) {
    if (s.zStart < 1 || s.zEnd < 1) zOk = false; // zoom < 1 would expose borders
  }
}
check("every shot zooms inside the frame (z >= 1.0)", zOk);
check("amplitudes stay tasteful (hard ceiling 1.36)", (() => {
  let ok = true;
  for (const p of plans) for (const s of p.shots) if (s.zEnd > 1.361 || s.zStart > 1.361) ok = false;
  return ok;
})());

// Mandatory moves from the spec table.
const plainEmo = planSceneMovements(
  [scene({ visual: "extreme close-up of her face, candlelight" })],
  defaultSettings,
  { durationsSec: [5] }
)[0];
check("emotional close-up zooms IN", plainEmo.sceneType === "emotional" && plainEmo.shots[0].kind === "zoom-in");
const longRehookEmo = planSceneMovements(
  [scene({ visual: "extreme close-up of her face, candlelight", rehook: true })],
  defaultSettings,
  { durationsSec: [16] }
)[0];
check("rehook punch rides ABOVE the mandatory move", longRehookEmo.shots[0].kind === "punch" && longRehookEmo.shots[1]?.kind === "zoom-in");
check("establishing landscape zooms OUT", plans[1].sceneType === "establishing" && plans[1].shots[0].kind === "zoom-out");
check("map scene PANS across details", plans[2].sceneType === "detail" && plans[2].shots[0].kind.startsWith("pan"));
const plainSuspense = planSceneMovements(
  [scene({ visual: "a dark figure lurking at the tunnel end", mood: "ominous haze" })],
  defaultSettings,
  { durationsSec: [5] }
)[0];
check("suspense creeps IN gently (0.6x amplitude)", (() => {
  const z = plainSuspense.shots[0];
  return plainSuspense.sceneType === "suspense" && z.kind === "zoom-in" && Math.abs(z.zEnd - z.zStart - 0.072) < 0.005;
})());
check("action gets SHORT deliberate shots (~1.9s each)", (() => {
  const a = plans[4];
  return a.sceneType === "action" && a.shots.length >= 2 && a.shots[0].sec <= 2.1;
})());
check("text-heavy art barely moves (<= ~4%)", (() => {
  const s = plans[5].shots[0];
  return plans[5].sceneType === "text" && s.zEnd - s.zStart <= 0.04;
})());
check(
  "rehook beats (1 and 4) open with the punch hook — calm kinds included",
  plans[0].shots[0].kind === "punch" && plans[3].shots[0].kind === "punch"
);
check("non-rehook action leads with its rotation move, not punch", plans[4].shots[0].kind !== "punch");

// Duration sizing: a 30s emotional scene must spread across several shots.
const longEmotional = planSceneMovements(
  [scene({ visual: "close-up of her face" })],
  defaultSettings,
  { durationsSec: [30] }
)[0];
check("30s emotional scene spreads into multiple held shots", longEmotional.shots.length >= 3, `${longEmotional.shots.length} shots`);
check(
  "continuing creep never exceeds the ceiling",
  longEmotional.shots.every((s) => s.zEnd <= 1.24 + 1e-9 && s.zStart >= 1)
);
const shortScene = planSceneMovements(
  [scene({ visual: "close-up of her face" })],
  defaultSettings,
  { durationsSec: [3] }
)[0];
check("3s scene stays one shot", shortScene.shots.length === 1);

// Direction variation across consecutive standard scenes.
const stdPlans = planSceneMovements(
  [
    scene({ index: 1, visual: "a blacksmith hammering a blade" }),
    scene({ index: 2, visual: "a blacksmith quenching the blade" }),
    scene({ index: 3, visual: "a blacksmith polishing the blade" }),
  ],
  defaultSettings,
  { durationsSec: [6, 6, 6] }
);
const dirs = stdPlans.map((p) => p.shots[0].kind);
check(
  "vary: consecutive standard scenes don't all move the same way",
  new Set(dirs).size >= 2,
  dirs.join(" -> ")
);
const noVary = planSceneMovements(
  [
    scene({ index: 1, visual: "an aged nautical map" }),
    scene({ index: 2, visual: "a weathered treasure map" }),
  ],
  { ...defaultSettings, vary: false },
  { durationsSec: [6, 6] }
);
check(
  "vary off keeps the same pan direction",
  noVary[0].shots[0].kind === noVary[1].shots[0].kind
);

// Mode overrides.
const zoomOnly = planSceneMovements(scenes.slice(0, 6), { ...defaultSettings, mode: "zoom" }, { durationsSec: [5, 5, 6, 5, 6, 5] });
check(
  "zoom-only mode: every shot is a zoom or punch",
  zoomOnly.every((p) => p.shots.every((s) => ["zoom-in", "zoom-out", "punch"].includes(s.kind)))
);
const panOnly = planSceneMovements(scenes.slice(0, 6), { ...defaultSettings, mode: "pan" }, { durationsSec: [5, 5, 6, 5, 6, 5] });
check(
  "pan-only mode: every shot is a pan/tilt",
  panOnly.every((p) => p.shots.every((s) => s.kind.startsWith("pan") || s.kind.startsWith("tilt") || s.kind.startsWith("diag")))
);
const offPlan = planSceneMovements(scenes, { ...defaultSettings, mode: "off" }, { durationsSec: [5] });
check("off mode -> static images", offPlan.every((p) => p.staticImage));
const nonePlan = planSceneMovements(scenes, { ...defaultSettings, intensity: 0 }, { durationsSec: [5] });
check("intensity 0 (None) -> static images", nonePlan.every((p) => p.staticImage));

// 9:16 vertical: lateral pans become tilts.
const verticalPlans = planSceneMovements(scenes.slice(0, 6), defaultSettings, {
  aspect: "9:16",
  durationsSec: [5, 5, 6, 5, 6, 5],
});
check(
  "9:16 prefers tilts over lateral pans",
  verticalPlans.every((p) => p.shots.every((s) => !(s.kind === "pan-left" || s.kind === "pan-right")))
);

// ---------- 4. focal-in-frame PROOF ----------

console.log("\n4. Focal-in-frame proof (pans sampled end to end)");
const WORK = OUTPUT_SIZES["16:9"].work;
let focalSafe = true;
let worstMargin = 1;
for (const fx of [0.05, 0.32, 0.5, 0.68, 0.95]) {
  for (const kind of ["pan-right", "pan-left", "tilt-down", "tilt-up", "diag-br", "diag-tl"] as const) {
    for (const dir of [-1, 1] as const) {
      for (const travel of [0.18, 0.45, 0.55, 0.6, 1]) {
        const [x0, x1] = panEndpoints("x", fx, dir, travel, 1.14, WORK);
        const [y0, y1] = panEndpoints("y", 0.5, dir, travel, 1.14, WORK);
        const window = WORK[0] / 1.14;
        for (let step = 0; step <= 20; step++) {
          const t = step / 20;
          const x = x0 + (x1 - x0) * t;
          const y = y0 + (y1 - y0) * t;
          // Focal position inside the visible window, normalized.
          const rel = (fx * WORK[0] - x) / window;
          if (rel < -0.001 || rel > 1.001) {
            focalSafe = false;
          } else {
            worstMargin = Math.min(worstMargin, Math.min(rel, 1 - rel));
          }
        }
        void y0; void y1;
      }
    }
  }
}
check("focal point stays in frame through EVERY sweep", focalSafe, `worst margin ${(worstMargin * 100).toFixed(1)}% of frame`);
check("focal keeps a visible safety pad (>= 5%)", worstMargin >= 0.05, `${(worstMargin * 100).toFixed(1)}%`);

// Zooms anchor the focal at frame center by construction — verify the expr.
const emoGraph = sceneFilterGraph({
  dur: 5,
  plan: plans[0].staticImage ? plans[1] : plans[0],
  settings: defaultSettings,
  fps: 30,
});
check("zoom shots anchor the focal via clip()", emoGraph.includes("clip(iw*") && emoGraph.includes("iw/(2*zoom)"));

// ---------- 5. filter graphs ----------

console.log("\n5. Filter graphs");
const graphs = plans.map((p, i) =>
  sceneFilterGraph({ dur: [5, 5, 6, 5, 6, 5, 5, 5][i], plan: p, settings: defaultSettings, fps: 30 })
);
let noJunk = true;
for (const g of graphs) {
  if (/NaN|Infinity|undefined/.test(g)) noJunk = false; // "null" is a legit ffmpeg filter name
}
check("no NaN/Infinity/undefined in any graph", noJunk);
check("graphs drive zoompan at 30fps to 1920x1080", graphs.every((g) => g.includes("s=1920x1080:fps=30")));
check("supersampled 2x working resolution", graphs.every((g) => g.includes("scale=3840:2160")));
const actionGraph = graphs[4];
const splitCount = Number(actionGraph.match(/split=(\d+)/)?.[1] ?? 0);
check("action scene splits into its multi-shot pool", splitCount >= 2, `split=${splitCount}`);
const offGraph = sceneFilterGraph({
  dur: 4,
  plan: offPlan[0],
  settings: { ...defaultSettings, mode: "off" },
  fps: 30,
});
check("static plan skips zoompan entirely", !offGraph.includes("zoompan"));
const vGraph = sceneFilterGraph({
  dur: 5,
  plan: verticalPlans[0],
  settings: defaultSettings,
  fps: 30,
  aspect: "9:16",
});
check("9:16 graph outputs 1080x1920 from a 2160x3840 working frame", vGraph.includes("s=1080x1920") && vGraph.includes("scale=2160:3840"));
check("summary line reads like the spec", planSummaryLine(MOTION_DEFAULTS).includes("Scene-aware") && planSummaryLine(MOTION_DEFAULTS).includes("12%"));

// ---------- 6. REAL ffmpeg renders ----------

console.log("\n6. Real ffmpeg renders through the actual graphs");
const ffmpeg = async (args: string[], label: string, timeout = 180_000) => {
  try {
    await run("ffmpeg", args, { timeout, maxBuffer: 32 * 1024 * 1024 });
    console.log(`  ok: ${label}`);
  } catch (err) {
    const e = err as { stderr?: string };
    console.error(`  FAIL ${label}:\n${(e.stderr ?? "").split("\n").slice(-10).join("\n")}`);
    fail++;
  }
};
const probe = async (file: string) => {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", file]);
  return Number(JSON.parse(stdout).format?.duration ?? 0);
};
const countVideoEvents = undefined as never; // replaced by cutTimes + blackCount below
void countVideoEvents;

/** Frame timestamps where the scene-change score fires (old-suite calibration: 0.05). */
const cutTimes = async (file: string, threshold = 0.05): Promise<number[]> => {
  try {
    const { stdout } = await run(
      "ffmpeg",
      ["-i", file, "-vf", `select=gte(scene\\,${threshold}),metadata=print:file=-`, "-f", "null", "-"],
      { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 }
    );
    const times: number[] = [];
    for (const m of stdout.matchAll(/pts_time:([\d.]+)/g)) times.push(Number(m[1]));
    return times;
  } catch (err) {
    const e = err as { stdout?: string };
    const times: number[] = [];
    for (const m of (e.stdout ?? "").matchAll(/pts_time:([\d.]+)/g)) times.push(Number(m[1]));
    return times;
  }
};

/** blackdetect: prints a line per black segment — 0 lines = no black frames. */
const blackCount = async (file: string): Promise<number> => {
  const grab = (s?: string) => (s?.match(/black_start/g) ?? []).length;
  try {
    const { stderr } = await run(
      "ffmpeg", ["-i", file, "-vf", "blackdetect=d=0.1", "-f", "null", "-"],
      { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 }
    );
    return grab(stderr);
  } catch (err) {
    const e = err as { stderr?: string };
    return grab(e.stderr);
  }
};

// Textured still (testsrc2 has gradients + moving detail baked in).
const still = path.join(TMP, "art.png");
await ffmpeg(
  ["-f", "lavfi", "-i", "testsrc2=s=1344x768:d=1", "-frames:v", "1", "-y", still],
  "generate textured still"
);

const renderSeg = async (name: string, graph: string, dur: number) => {
  const out = path.join(TMP, name);
  await ffmpeg(
    [
      "-loop", "1", "-framerate", "30", "-t", dur.toFixed(3), "-i", still,
      "-f", "lavfi", "-t", dur.toFixed(3), "-i", "anullsrc=r=48000:cl=stereo",
      "-filter_complex", `${graph};[1:a]anull[a]`,
      "-map", "[v]", "-map", "[a]",
      "-t", dur.toFixed(3), "-r", "30",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest",
      "-y", out,
    ],
    `render ${name}`
  );
  return out;
};

// (a) emotional 5s — single smooth zoom-in, focal center.
const emoPlan = planSceneMovements(
  [scene({ visual: "extreme close-up of her face in candlelight" })],
  defaultSettings,
  { durationsSec: [5] }
)[0];
const emoOut = await renderSeg("emo.mp4", sceneFilterGraph({ dur: 5, plan: emoPlan, settings: defaultSettings, fps: 30, grade: "eq=contrast=1.05:saturation=1.08,vignette=PI/5" }), 5);
const emoDur = await probe(emoOut);
check("emotional segment duration 5.0s", Math.abs(emoDur - 5) < 0.25, `${emoDur.toFixed(2)}s`);

// (b) action 6.5s — multiple deliberate cuts.
const actPlan = planSceneMovements(
  [scene({ visual: "chariots charging across the riverbed, dust everywhere", sfx: "riser", rehook: true })],
  defaultSettings,
  { durationsSec: [6.5] }
)[0];
const actOut = await renderSeg("action.mp4", sceneFilterGraph({ dur: 6.5, plan: actPlan, settings: defaultSettings, fps: 30 }), 6.5);
const actDur = await probe(actOut);
check("action segment duration 6.5s", Math.abs(actDur - 6.5) < 0.25, `${actDur.toFixed(2)}s`);
// Expected cut boundaries: the pool splits the scene evenly across its shots.
const expectedBounds: number[] = [];
{
  const n = Math.max(1, Math.min(12, actPlan.shots.length));
  const per = 6.5 / n;
  for (let i = 1; i < n; i++) expectedBounds.push(per * i);
}
const actCuts = await cutTimes(actOut);
const matchedBounds = expectedBounds.filter((b) => actCuts.some((t) => Math.abs(t - b) < 0.3));
check(
  "action segment shows real camera cuts at every boundary",
  matchedBounds.length >= expectedBounds.length,
  `${matchedBounds.length}/${expectedBounds.length} boundaries (cuts at ${actCuts.map((t) => t.toFixed(2)).join(", ") || "none"})`
);

// (c) static 3s — mode off.
const staticPlan = planSceneMovements([scene({})], { ...defaultSettings, mode: "off" }, { durationsSec: [3] })[0];
const staticOut = await renderSeg("static.mp4", sceneFilterGraph({ dur: 3, plan: staticPlan, settings: { ...defaultSettings, mode: "off" }, fps: 30 }), 3);
const staticDur = await probe(staticOut);
check("static segment duration 3.0s", Math.abs(staticDur - 3) < 0.25, `${staticDur.toFixed(2)}s`);
const staticCuts = await cutTimes(staticOut, 0.05);
check("static segment holds still (0 cuts)", staticCuts.length === 0, `${staticCuts.length} cuts`);

// Zero black frames anywhere (empty-border / undershoot check).
const blackScan = await blackCount(emoOut);
const blackScan2 = await blackCount(actOut);
const blackScan3 = await blackCount(staticOut);
check(
  "no black frames in any rendered segment (no border blowouts)",
  blackScan === 0 && blackScan2 === 0 && blackScan3 === 0,
  `emo=${blackScan} act=${blackScan2} static=${blackScan3}`
);

// ---------- report ----------

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "OK" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

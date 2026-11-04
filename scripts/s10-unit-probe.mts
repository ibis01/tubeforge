// S10 unit probe — "the short": the moment-pick contract through REAL modules.
// One layer, all pure (the chain is body > doc pick > hook heuristic; the
// doc leg is what this probe pins):
//   1. the ShortPick sanitizer at the doc choke point (modes survive, junk
//      dies, index bounds hold, irrelevant fields drop);
//   2. the renderPrefs round-trip through the real doc serializer (the pick
//      survives, junk is dropped, a legacy doc serializes byte-stable);
//   3. the zod save boundary (a sane pick passes, hostile shapes 400);
//   4. shortSceneIndexFor — the ONE truth the short job reads: doc pick >
//      null (the hook heuristic), junk and out-of-range indices fall back
//      to the heuristic, non-story reads null, never a crash and never a
//      selected path;
//   5. the heuristic itself still rules when no pick stands — the pre-S10
//      behavior byte-for-byte (pickBestScene is the same function the cut
//      falls back to).
// Run: node --import tsx scripts/s10-unit-probe.mts
import {
  sanitizeShortPick,
  docShortPick,
  sanitizeRenderPrefs,
} from "../src/lib/tubeforge/studio-doc";
import { assembleSaveSchema } from "../src/lib/tubeforge/validation";
import { assembleTimeline, parseTimeline, serializeTimeline } from "../src/lib/tubeforge/timeline";
import { parseScenes } from "../src/lib/tubeforge/story";
import { shortSceneIndexFor } from "../src/lib/tubeforge/video-jobs";
import { pickBestScene } from "../src/lib/tubeforge/shorts";

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
      index: 2, title: "Turn", narration: "The turn arrives and holds.", visual: "rain on glass",
      camera: "static", mood: "calm", caption: "", hostInScene: false, rehook: false, sfx: "none",
    },
    {
      index: 3, title: "Payoff", narration: "The payoff answers the promise.", visual: "sunrise over the city",
      camera: "pull-back", mood: "hopeful", caption: "", hostInScene: false, rehook: false, sfx: "none",
    },
  ]);

// =====================================================================
// 1. the doc boundary (pure)
// =====================================================================
check(
  "sanitizeShortPick: the two modes survive, case/whitespace normalize",
  (() => {
    const auto = sanitizeShortPick({ mode: "auto" });
    const scene = sanitizeShortPick({ mode: " SCENE ", sceneIndex: 3 });
    return !!auto && auto.mode === "auto" && !("sceneIndex" in auto) &&
      !!scene && scene.mode === "scene" && scene.sceneIndex === 3;
  })()
);

check(
  "sanitizeShortPick: junk indices are no pick at all",
  sanitizeShortPick({ mode: "scene" }) === null &&
    sanitizeShortPick({ mode: "scene", sceneIndex: 0 }) === null &&
    sanitizeShortPick({ mode: "scene", sceneIndex: -2 }) === null &&
    sanitizeShortPick({ mode: "scene", sceneIndex: 2.5 }) === null &&
    sanitizeShortPick({ mode: "scene", sceneIndex: "3" }) === null &&
    sanitizeShortPick({ mode: "scene", sceneIndex: 1000 }) === null &&
    sanitizeShortPick({ mode: "scene", sceneIndex: NaN }) === null
);

check(
  "sanitizeShortPick: unknown modes + non-objects read as no pick",
  sanitizeShortPick({ mode: "viral" }) === null &&
    sanitizeShortPick(null) === null &&
    sanitizeShortPick("auto") === null &&
    sanitizeShortPick(42) === null &&
    sanitizeShortPick({}) === null &&
    sanitizeShortPick([1, 2]) === null
);

check(
  "sanitizeShortPick: irrelevant fields drop — a pick is self-consistent",
  (() => {
    const p = sanitizeShortPick({ mode: "auto", sceneIndex: 9, hostile: "x" });
    const s = sanitizeShortPick({ mode: "scene", sceneIndex: 2, caption: "junk" });
    return (
      !!p && !("sceneIndex" in p) && !("hostile" in p) &&
      !!s && s.sceneIndex === 2 && !("caption" in s)
    );
  })()
);

check(
  "docShortPick reads the doc's renderPrefs; absent/junk reads as no opinion",
  docShortPick({ quality: "standard", short: { mode: "scene", sceneIndex: 2 } })?.mode === "scene" &&
    docShortPick({ quality: "standard" }) === null &&
    docShortPick({ quality: "standard", short: null }) === null &&
    docShortPick({ quality: "standard", short: { mode: "scene", sceneIndex: 0 } }) === null &&
    docShortPick(null) === null
);

check(
  "sanitizeRenderPrefs keeps quality + caption + music + poster + short, omits absent picks",
  (() => {
    const full = sanitizeRenderPrefs({
      quality: "high", captionStyle: "bold-pop", music: { mode: "mood", moodId: "calm" },
      poster: { mode: "scene", sceneIndex: 2 }, short: { mode: "scene", sceneIndex: 3 },
      hostile: "x",
    });
    const bare = sanitizeRenderPrefs({ quality: "standard" });
    return (
      !!full && full.quality === "high" && full.captionStyle === "bold-pop" &&
      !!full.music && full.music.mode === "mood" &&
      !!full.poster && full.poster.mode === "scene" &&
      !!full.short && full.short.mode === "scene" && full.short.sceneIndex === 3 &&
      !("hostile" in full) &&
      !!bare && bare.captionStyle === undefined && bare.music === undefined &&
      bare.poster === undefined && bare.short === undefined
    );
  })()
);

// =====================================================================
// 2. the serializer round-trip (pure, real doc modules)
// =====================================================================
check(
  "serializeTimeline → parseTimeline round-trips the short pick (shape-hostile junk drops)",
  (() => {
    const scenes = parseScenes(sceneJson());
    const doc = assembleTimeline(scenes, { sceneDurationsSec: [5, 5, 5] });
    doc.renderPrefs = { quality: "high", short: { mode: "scene", sceneIndex: 3 } };
    const round = parseTimeline(serializeTimeline(doc));
    if (!round || round.renderPrefs?.short?.mode !== "scene" || round.renderPrefs.short.sceneIndex !== 3)
      return false;
    // A well-formed-but-out-of-range index (999 ≤ the shape cap) round-trips
    // AS-IS — range validity is shortSceneIndexFor's layer (it falls back to
    // the heuristic), the doc boundary only drops SHAPE-hostile picks.
    doc.renderPrefs = { quality: "high", short: { mode: "scene", sceneIndex: 999 } };
    const wide = parseTimeline(serializeTimeline(doc));
    if (!wide || wide.renderPrefs?.short?.sceneIndex !== 999) return false;
    doc.renderPrefs = { quality: "high", short: { mode: "scene", sceneIndex: 1000 } as never };
    const round2 = parseTimeline(serializeTimeline(doc));
    return !!round2 && round2.renderPrefs?.short === undefined;
  })()
);

// =====================================================================
// 3. the zod save boundary (pure)
// =====================================================================
check(
  "assembleSaveSchema accepts a sane pick and rejects hostile shapes",
  (() => {
    const base = { scenes: [{ index: 1, startSec: 0, endSec: 5, durationSec: 5 }], totalDurationSec: 5 };
    const ok = assembleSaveSchema.safeParse({
      ...base,
      renderPrefs: { quality: "high", short: { mode: "scene", sceneIndex: 2 } },
    });
    const badMode = assembleSaveSchema.safeParse({
      ...base,
      renderPrefs: { quality: "high", short: { mode: "viral" } },
    });
    const badIndex = assembleSaveSchema.safeParse({
      ...base,
      renderPrefs: { quality: "high", short: { mode: "scene", sceneIndex: 0 } },
    });
    const badFloat = assembleSaveSchema.safeParse({
      ...base,
      renderPrefs: { quality: "high", short: { mode: "scene", sceneIndex: 1.5 } },
    });
    return ok.success && !badMode.success && !badIndex.success && !badFloat.success;
  })()
);

// =====================================================================
// 4. shortSceneIndexFor — the one truth (pure, real modules)
// =====================================================================
const shaped = (over: Partial<Parameters<typeof shortSceneIndexFor>[0]> = {}) => ({
  format: "story",
  scenes: sceneJson(),
  timeline: null,
  ...over,
});

// a doc timeline carrying a short pick (through the REAL serializer)
const timelineWithPick = (pick: unknown) => {
  const doc = assembleTimeline(parseScenes(sceneJson()), { sceneDurationsSec: [5, 5, 5] });
  doc.renderPrefs = { quality: "standard", ...(pick ? { short: pick as never } : {}) };
  return serializeTimeline(doc);
};

check(
  "no pick → null (the hook heuristic decides, the pre-S10 behavior)",
  shortSceneIndexFor(shaped()) === null &&
    shortSceneIndexFor(shaped({ timeline: timelineWithPick(null) })) === null
);

check(
  "an explicit pick selects that scene — the cut centers on it",
  shortSceneIndexFor(shaped({ timeline: timelineWithPick({ mode: "scene", sceneIndex: 3 }) })) === 3 &&
    shortSceneIndexFor(shaped({ timeline: timelineWithPick({ mode: "scene", sceneIndex: 1 }) })) === 1
);

check(
  "\"auto\" is a real pick that still defers to the heuristic",
  shortSceneIndexFor(shaped({ timeline: timelineWithPick({ mode: "auto" }) })) === null
);

check(
  "an out-of-range index falls back to the heuristic — never a crash, never a selected path",
  shortSceneIndexFor(shaped({ timeline: timelineWithPick({ mode: "scene", sceneIndex: 99 }) })) === null
);

check(
  "a hostile pick (path strings, floats, huge numbers) is shape-dropped → the heuristic",
  shortSceneIndexFor(
    shaped({ timeline: JSON.stringify({ scenes: [], renderPrefs: { quality: "standard", short: { mode: "scene", sceneIndex: "../../etc" } } }) })
  ) === null &&
    shortSceneIndexFor(
      shaped({ timeline: JSON.stringify({ scenes: [], renderPrefs: { quality: "standard", short: { mode: "scene", sceneIndex: 2.5 } } }) })
    ) === null
);

check(
  "non-story format → null (the route refuses those anyway)",
  shortSceneIndexFor(shaped({ format: "classic" })) === null &&
    shortSceneIndexFor({ format: "classic", scenes: sceneJson(), timeline: timelineWithPick({ mode: "scene", sceneIndex: 2 }) }) === null
);

check(
  "empty scenes → null (no scene can back the pick)",
  shortSceneIndexFor(shaped({ scenes: JSON.stringify([]) })) === null
);

// =====================================================================
// 5. the fallback itself — the heuristic the cut defers to (pure, REAL module)
// =====================================================================
check(
  "pickBestScene still rules the unpicked doc — the pre-S10 doctrine, hook-first",
  (() => {
    const scenes = parseScenes(sceneJson());
    const best = pickBestScene(scenes);
    if (!best) return false;
    // a scene with a hook-y caption must outscore plain narration
    const hooked = parseScenes(
      JSON.stringify([
        { ...scenes[0], caption: "", narration: "Plain words about a quiet hill." },
        { ...scenes[1], caption: "The 7 secrets nobody tells you", narration: "This one carries numbers and a hook." },
      ])
    );
    return pickBestScene(hooked)?.index === 2;
  })()
);

// wrap-up
console.log(failures === 0 ? "\nS10 UNIT PROBE: ALL PASS" : `\nS10 UNIT PROBE: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

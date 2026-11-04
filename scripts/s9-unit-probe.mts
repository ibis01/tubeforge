// S9 unit probe — "the poster": the scene-pick contract through REAL modules.
// One layer, all pure (the chain is doc-pick → concept, no DB between):
//   1. the PosterPick sanitizer at the doc choke point (modes survive, junk
//      dies, index bounds hold, irrelevant fields drop);
//   2. the renderPrefs round-trip through the real doc serializer (the pick
//      survives, junk is dropped, a legacy doc serializes byte-stable);
//   3. the zod save boundary (a catalog pick passes, hostile shapes 400);
//   4. posterSceneFor — the ONE truth the thumbnail job, the A/B variants
//      job and the studio all read: doc pick > scene 1, junk and
//      out-of-range indices fall back to scene 1, non-story reads null,
//      never a crash and never a selected path.
// Run: node --import tsx scripts/s9-unit-probe.mts
import {
  sanitizePosterPick,
  docPosterPick,
  sanitizeRenderPrefs,
} from "../src/lib/tubeforge/studio-doc";
import { assembleSaveSchema } from "../src/lib/tubeforge/validation";
import { assembleTimeline, parseTimeline, serializeTimeline } from "../src/lib/tubeforge/timeline";
import { parseScenes } from "../src/lib/tubeforge/story";
import { posterSceneFor } from "../src/lib/tubeforge/video-jobs";

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
  "sanitizePosterPick: the two modes survive, case/whitespace normalize",
  (() => {
    const auto = sanitizePosterPick({ mode: "auto" });
    const scene = sanitizePosterPick({ mode: " SCENE ", sceneIndex: 3 });
    return !!auto && auto.mode === "auto" && !("sceneIndex" in auto) &&
      !!scene && scene.mode === "scene" && scene.sceneIndex === 3;
  })()
);

check(
  "sanitizePosterPick: junk indices are no pick at all",
  sanitizePosterPick({ mode: "scene" }) === null &&
    sanitizePosterPick({ mode: "scene", sceneIndex: 0 }) === null &&
    sanitizePosterPick({ mode: "scene", sceneIndex: -2 }) === null &&
    sanitizePosterPick({ mode: "scene", sceneIndex: 2.5 }) === null &&
    sanitizePosterPick({ mode: "scene", sceneIndex: "3" }) === null &&
    sanitizePosterPick({ mode: "scene", sceneIndex: 1000 }) === null &&
    sanitizePosterPick({ mode: "scene", sceneIndex: NaN }) === null
);

check(
  "sanitizePosterPick: unknown modes + non-objects read as no pick",
  sanitizePosterPick({ mode: "moodboard" }) === null &&
    sanitizePosterPick(null) === null &&
    sanitizePosterPick("auto") === null &&
    sanitizePosterPick(42) === null &&
    sanitizePosterPick({}) === null &&
    sanitizePosterPick([1, 2]) === null
);

check(
  "sanitizePosterPick: irrelevant fields drop — a pick is self-consistent",
  (() => {
    const p = sanitizePosterPick({ mode: "auto", sceneIndex: 9, hostile: "x" });
    const s = sanitizePosterPick({ mode: "scene", sceneIndex: 2, visual: "junk" });
    return (
      !!p && !("sceneIndex" in p) && !("hostile" in p) &&
      !!s && s.sceneIndex === 2 && !("visual" in s)
    );
  })()
);

check(
  "docPosterPick reads the doc's renderPrefs; absent/junk reads as no opinion",
  docPosterPick({ quality: "standard", poster: { mode: "scene", sceneIndex: 2 } })?.mode === "scene" &&
    docPosterPick({ quality: "standard" }) === null &&
    docPosterPick({ quality: "standard", poster: null }) === null &&
    docPosterPick({ quality: "standard", poster: { mode: "scene", sceneIndex: 0 } }) === null &&
    docPosterPick(null) === null
);

check(
  "sanitizeRenderPrefs keeps quality + caption + music + poster, omits absent picks",
  (() => {
    const full = sanitizeRenderPrefs({
      quality: "high", captionStyle: "bold-pop", music: { mode: "mood", moodId: "calm" },
      poster: { mode: "scene", sceneIndex: 2 }, hostile: "x",
    });
    const bare = sanitizeRenderPrefs({ quality: "standard" });
    return (
      !!full && full.quality === "high" && full.captionStyle === "bold-pop" &&
      !!full.music && full.music.mode === "mood" &&
      !!full.poster && full.poster.mode === "scene" && full.poster.sceneIndex === 2 &&
      !("hostile" in full) &&
      !!bare && bare.captionStyle === undefined && bare.music === undefined && bare.poster === undefined
    );
  })()
);

// =====================================================================
// 2. the serializer round-trip (pure, real doc modules)
// =====================================================================
check(
  "serializeTimeline → parseTimeline round-trips the poster pick (shape-hostile junk drops)",
  (() => {
    const scenes = parseScenes(sceneJson());
    const doc = assembleTimeline(scenes, { sceneDurationsSec: [5, 5, 5] });
    doc.renderPrefs = { quality: "high", poster: { mode: "scene", sceneIndex: 3 } };
    const round = parseTimeline(serializeTimeline(doc));
    if (!round || round.renderPrefs?.poster?.mode !== "scene" || round.renderPrefs.poster.sceneIndex !== 3)
      return false;
    // A well-formed-but-out-of-range index (999 ≤ the shape cap) round-trips
    // AS-IS — range validity is posterSceneFor's layer (it falls back to
    // scene 1), the doc boundary only drops SHAPE-hostile picks.
    doc.renderPrefs = { quality: "high", poster: { mode: "scene", sceneIndex: 999 } };
    const wide = parseTimeline(serializeTimeline(doc));
    if (!wide || wide.renderPrefs?.poster?.sceneIndex !== 999) return false;
    doc.renderPrefs = { quality: "high", poster: { mode: "scene", sceneIndex: 1000 } as never };
    const round2 = parseTimeline(serializeTimeline(doc));
    return !!round2 && round2.renderPrefs?.poster === undefined;
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
      renderPrefs: { quality: "high", poster: { mode: "scene", sceneIndex: 2 } },
    });
    const badMode = assembleSaveSchema.safeParse({
      ...base,
      renderPrefs: { quality: "high", poster: { mode: "moodboard" } },
    });
    const badIndex = assembleSaveSchema.safeParse({
      ...base,
      renderPrefs: { quality: "high", poster: { mode: "scene", sceneIndex: 0 } },
    });
    const badFloat = assembleSaveSchema.safeParse({
      ...base,
      renderPrefs: { quality: "high", poster: { mode: "scene", sceneIndex: 1.5 } },
    });
    return ok.success && !badMode.success && !badIndex.success && !badFloat.success;
  })()
);

// =====================================================================
// 4. posterSceneFor — the one truth (pure, real modules)
// =====================================================================
const shaped = (over: Partial<Parameters<typeof posterSceneFor>[0]> = {}) => ({
  format: "story",
  scenes: sceneJson(),
  timeline: null,
  ...over,
});

// a doc timeline carrying a poster pick (through the REAL serializer)
const timelineWithPick = (pick: unknown) => {
  const doc = assembleTimeline(parseScenes(sceneJson()), { sceneDurationsSec: [5, 5, 5] });
  doc.renderPrefs = { quality: "standard", ...(pick ? { poster: pick as never } : {}) };
  return serializeTimeline(doc);
};

check(
  "no pick → scene 1 (the pre-S9 hook-first doctrine)",
  (() => {
    const s = posterSceneFor(shaped());
    return s?.index === 1 && s.visual === "a dark skyline";
  })()
);

check(
  "an explicit pick selects that scene — visual AND mood re-derive",
  (() => {
    const s = posterSceneFor(shaped({ timeline: timelineWithPick({ mode: "scene", sceneIndex: 3 }) }));
    return s?.index === 3 && s.visual === "sunrise over the city" && s.mood === "hopeful";
  })()
);

check(
  "\"auto\" is a real pick that keeps scene 1",
  (() => {
    const s = posterSceneFor(shaped({ timeline: timelineWithPick({ mode: "auto" }) }));
    return s?.index === 1;
  })()
);

check(
  "an out-of-range index falls back to scene 1 — never a crash, never a selected path",
  (() => {
    const s = posterSceneFor(shaped({ timeline: timelineWithPick({ mode: "scene", sceneIndex: 99 }) }));
    return s?.index === 1;
  })()
);

check(
  "a hostile pick (path strings, floats, huge numbers) is shape-dropped → scene 1",
  (() => {
    const s = posterSceneFor(
      shaped({ timeline: JSON.stringify({ scenes: [], renderPrefs: { quality: "standard", poster: { mode: "scene", sceneIndex: "../../etc" } } }) })
    );
    const s2 = posterSceneFor(
      shaped({ timeline: JSON.stringify({ scenes: [], renderPrefs: { quality: "standard", poster: { mode: "scene", sceneIndex: 2.5 } } }) })
    );
    return s?.index === 1 && s2?.index === 1;
  })()
);

check(
  "non-story format → null (the concept derives from topic/script)",
  posterSceneFor(shaped({ format: "classic" })) === null &&
    posterSceneFor({ format: "classic", scenes: sceneJson(), timeline: timelineWithPick({ mode: "scene", sceneIndex: 2 }) }) === null
);

check(
  "empty scenes → null (nothing to depict; the job's topic/script path decides)",
  posterSceneFor(shaped({ scenes: JSON.stringify([]) })) === null
);

// wrap-up
console.log(failures === 0 ? "\nS9 UNIT PROBE: ALL PASS" : `\nS9 UNIT PROBE: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

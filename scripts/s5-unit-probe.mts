// S5 unit probe — "the sound stage": the per-scene sound-pick contract through
// REAL modules (no HTTP). The studio can now CHOOSE the scene's SFX cue and
// ambience bed, not just mix their levels — this probe pins the one rule that
// makes that honest: the doc's pick outranks the plan's, every source is
// sanitized against the same catalog, and the audition route's params can
// only ever select a catalog sound.
// Run: node --import tsx scripts/s5-unit-probe.mts
import {
  SFX_CATALOG,
  AMBIENCE_CATALOG,
  sanitizeSoundKind,
  sanitizeSfxKind,
  sanitizeAmbienceKind,
  resolveSoundChoice,
  resolveSoundBank,
  soundChoice,
} from "../src/lib/tubeforge/studio-sound";
import { SFX_KINDS } from "../src/lib/tubeforge/types";
import { isSfxKind } from "../src/lib/tubeforge/sfx";
import { isAmbienceKind } from "../src/lib/tubeforge/ambience";
import {
  assembleTimeline,
  docSceneSettings,
  parseTimeline,
  serializeTimeline,
} from "../src/lib/tubeforge/timeline";
import { parseScenes } from "../src/lib/tubeforge/story";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

const sceneJson = (extra: Record<string, unknown>) =>
  JSON.stringify([
    {
      index: 1, title: "A", narration: "First scene narration here.", visual: "v", camera: "static",
      mood: "m", caption: "cap", hostInScene: false, rehook: false, sfx: "none",
      ...extra,
    },
    {
      index: 2, title: "B", narration: "Second scene narration here.", visual: "v2", camera: "static",
      mood: "m", caption: "", hostInScene: false, rehook: false, sfx: "none",
    },
  ]);

// ---- 1. one vocabulary: the studio catalog IS the synthesizers' catalog ----
check(
  "SFX_CATALOG ids are EXACTLY the synthesizer's SFX_KINDS (no drift, no orphans)",
  (() => {
    const a = SFX_CATALOG.map((c) => c.id).sort();
    const b = [...SFX_KINDS].sort();
    return a.length === b.length && a.every((id, i) => id === b[i]);
  })()
);

check(
  "every catalog id is accepted by its synthesizer's validator — and by no other bank",
  (() => {
    const sfxOk = SFX_CATALOG.every((c) => isSfxKind(c.id)) && AMBIENCE_CATALOG.every((c) => !isSfxKind(c.id));
    const ambOk = AMBIENCE_CATALOG.every((c) => isAmbienceKind(c.id)) && SFX_CATALOG.every((c) => !isAmbienceKind(c.id));
    return sfxOk && ambOk;
  })()
);

// ---- 2. the doc boundary — accept anything, return a catalog id or null ----
check(
  "sanitizeSoundKind: ids survive (case/whitespace normalized), none/off/junk do not",
  (() => {
    return (
      sanitizeSoundKind(" BOOM ", SFX_CATALOG) === "boom" &&
      sanitizeSoundKind("Boom", SFX_CATALOG) === "boom" &&
      sanitizeSoundKind("none", SFX_CATALOG) === null &&
      sanitizeSoundKind("off", AMBIENCE_CATALOG) === null &&
      sanitizeSoundKind("", SFX_CATALOG) === null &&
      sanitizeSoundKind("   ", AMBIENCE_CATALOG) === null &&
      sanitizeSoundKind("DROP TABLE scenes", SFX_CATALOG) === null &&
      sanitizeSoundKind("../../etc/passwd", SFX_CATALOG) === null &&
      sanitizeSoundKind(42 as never, SFX_CATALOG) === null &&
      sanitizeSoundKind(null as never, AMBIENCE_CATALOG) === null
    );
  })()
);

check(
  "the banks do not cross — a real ambience kind is not an SFX kind and vice versa",
  sanitizeSfxKind("rain") === null &&
    sanitizeAmbienceKind("whoosh") === null &&
    sanitizeSfxKind("whoosh") === "whoosh" &&
    sanitizeAmbienceKind("rain") === "rain"
);

// ---- 3. the one precedence rule the render calls ----
check(
  "resolveSoundChoice: the doc's pick outranks the plan's; null falls through",
  (() => {
    const docWins = resolveSoundChoice("sting", "boom", SFX_CATALOG) === "sting";
    const planFallback = resolveSoundChoice(null, "boom", SFX_CATALOG) === "boom";
    const planFallbackUndefined = resolveSoundChoice(undefined, "riser", SFX_CATALOG) === "riser";
    const bothNull = resolveSoundChoice(null, null, SFX_CATALOG) === null;
    return docWins && planFallback && planFallbackUndefined && bothNull;
  })()
);

check(
  "resolveSoundChoice: EVERY source is sanitized — a plan row is data, never trusted",
  (() => {
    const hostileDocFallsToPlan =
      resolveSoundChoice("DROP TABLE scenes", "boom", SFX_CATALOG) === "boom";
    const hostilePlan = resolveSoundChoice(null, "javascript:alert(1)", SFX_CATALOG) === null;
    const hostileBoth = resolveSoundChoice(42 as never, "../../x", SFX_CATALOG) === null;
    const wrongBank = resolveSoundChoice("rain", "rain", SFX_CATALOG) === null;
    return hostileDocFallsToPlan && hostilePlan && hostileBoth && wrongBank;
  })()
);

// ---- 4. the extraction choke point — the render reads ONLY clean kinds ----
check(
  "docSceneSettings: hand-written kinds survive extraction, hostile kinds read as no-override",
  (() => {
    const doc = {
      scenes: [
        {
          index: 1, title: "A", narration: "n", visual: "v", startSec: 0, endSec: 5, durationSec: 5,
          transitionIn: null, transitionOut: null,
          audio: {
            voice: { enabled: true, level: 1 },
            music: { enabled: true, level: 0.6, ducking: true },
            sfx: { enabled: true, level: 0.55, kind: "boom" },
            ambient: { enabled: true, level: 0.1, kind: "rain" },
          },
          caption: null, source: "ai", stockSource: null, stockQuery: null, shot: null,
        },
        {
          index: 2, title: "B", narration: "n2", visual: "v2", startSec: 5, endSec: 9, durationSec: 4,
          transitionIn: null, transitionOut: null,
          audio: {
            voice: { enabled: true, level: 1 },
            music: { enabled: true, level: 0.6, ducking: true },
            sfx: { enabled: false, level: 0, kind: "DROP TABLE scenes" },
            ambient: { enabled: false, level: 0, kind: 42 as never },
          },
          caption: null, source: "ai", stockSource: null, stockQuery: null, shot: null,
        },
      ],
      sceneCount: 2,
      totalDurationSec: 9,
      generatedAt: new Date().toISOString(),
    };
    const out = docSceneSettings(doc as never, 2);
    if (!out) return false;
    return (
      out[0].sfxKind === "boom" &&
      out[0].ambientKind === "rain" &&
      out[1].sfxKind === null &&
      out[1].ambientKind === null
    );
  })()
);

check(
  "docSceneSettings: a legacy doc with no audio block reads as no-override (never crashes)",
  (() => {
    const legacy = {
      scenes: [
        {
          index: 1, title: "A", narration: "n", visual: "v", startSec: 0, endSec: 5, durationSec: 5,
          transitionIn: null, transitionOut: null, caption: null,
          source: "ai", stockSource: null, stockQuery: null, shot: null,
        },
        {
          index: 2, title: "B", narration: "n2", visual: "v2", startSec: 5, endSec: 9, durationSec: 4,
          transitionIn: null, transitionOut: null, caption: null,
          source: "ai", stockSource: null, stockQuery: null, shot: null,
        },
      ],
      sceneCount: 2,
      totalDurationSec: 9,
      generatedAt: new Date().toISOString(),
    };
    const out = docSceneSettings(legacy as never, 2);
    return !!out && out.every((s) => s.sfxKind === null && s.ambientKind === null);
  })()
);

// ---- 5. the seed — assemble writes the row's cue INTO the doc, at the ----
// ---- render's own default level (the UI's seeding number must agree) ----
check(
  "assembleTimeline seeds audio.sfx from the row scene at the catalog's default level",
  (() => {
    const scenes = parseScenes(sceneJson({ sfx: "boom" }));
    const doc = assembleTimeline(scenes, { sceneDurationsSec: [5, 5] });
    const s1 = doc.scenes[0];
    const s2 = doc.scenes[1];
    const boom = SFX_CATALOG.find((c) => c.id === "boom");
    return (
      s1.audio.sfx.kind === "boom" &&
      s1.audio.sfx.enabled === true &&
      s1.audio.sfx.level === boom?.defaultLevel && // 0.55 — one number, both sides
      s2.audio.sfx.kind === null &&
      s2.audio.sfx.enabled === false
    );
  })()
);

// ---- 6. the writer — kinds survive the S4 field whitelist (round-trip) ----
check(
  "serializeTimeline round-trips the sound kinds (the declared audio block is never dropped)",
  (() => {
    const scenes = parseScenes(sceneJson({ sfx: "sting" }));
    const doc = assembleTimeline(scenes, { sceneDurationsSec: [5, 5] });
    doc.scenes[0].audio.ambient = { enabled: true, level: 0.1, kind: "waves" };
    const round = parseTimeline(serializeTimeline(doc));
    if (!round) return false;
    const out = docSceneSettings(round, 2);
    if (!out) return false;
    return out[0].sfxKind === "sting" && out[0].ambientKind === "waves";
  })()
);

// ---- 7. the audition route's gate — a hostile param can only pick a ----
// ---- catalog sound, never a path ----
check(
  "resolveSoundBank: only the two bank ids pass (exact match — the route maps banks onto synthesizers)",
  (() => {
    return (
      resolveSoundBank("sfx") === "sfx" &&
      resolveSoundBank("ambience") === "ambience" &&
      resolveSoundBank("SFX") === null &&
      resolveSoundBank("sfx;rm -rf /") === null &&
      resolveSoundBank("../../uploads") === null &&
      resolveSoundBank(null as never) === null &&
      resolveSoundBank(42 as never) === null
    );
  })()
);

check(
  "soundChoice: the UI resolves labels/notes/defaults from the same ids the route accepts",
  (() => {
    const whoosh = soundChoice("whoosh", "sfx");
    const bed = soundChoice("waves", "ambience");
    const junk = soundChoice("whoosh\r\nInject: true", "sfx");
    const none = soundChoice(null, "ambience");
    return (
      whoosh?.label === "Whoosh" && typeof whoosh.note === "string" && whoosh.defaultLevel === 0.35 &&
      bed?.label === "Waves" && bed.defaultLevel === 0.1 &&
      junk === null && none === null
    );
  })()
);

// wrap-up
console.log(failures === 0 ? "\nS5 UNIT PROBE: ALL PASS" : `\nS5 UNIT PROBE: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

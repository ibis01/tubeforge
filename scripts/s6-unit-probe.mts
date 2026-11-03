// S6 unit probe — "the words' face": the caption-style contract through REAL
// modules (no HTTP). The studio can now PICK the look the render burns, so
// the probe pins the rules that make that honest: the classic entry is the
// pre-S6 look byte-for-byte, every pick maps to a catalog ASS string (a
// hostile doc can only select a catalog look), the pick survives the doc
// round-trip, and the preview mirrors the geometry without ever moving the
// classic draw.
// Run: node --import tsx scripts/s6-unit-probe.mts
import {
  CAPTION_STYLES,
  captionAssStyle,
  captionPreview,
  captionStyle,
  docCaptionStyle,
  sanitizeCaptionStyle,
  sanitizeRenderPrefs,
} from "../src/lib/tubeforge/studio-doc";
import { assembleSaveSchema } from "../src/lib/tubeforge/validation";
import { assembleTimeline, docSceneSettings, parseTimeline, serializeTimeline } from "../src/lib/tubeforge/timeline";
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

// ---- 1. the catalog itself ----
check(
  "the catalog is unique, slug-id'd and classic-first",
  (() => {
    const ids = CAPTION_STYLES.map((s) => s.id);
    return (
      ids.length === new Set(ids).size &&
      ids[0] === "classic" &&
      ids.every((id) => id === id.toLowerCase() && /^[a-z0-9-]+$/.test(id)) &&
      CAPTION_STYLES.every((s) => s.label.trim() && s.note.trim())
    );
  })()
);

// ---- 2. the byte-for-byte back-compat pins (the render's pre-S6 consts) ----
check(
  "classic wide === the pre-S6 16:9 force_style constant",
  captionAssStyle("classic", false) ===
    "FontName=Noto Sans SC,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H20000000,BorderStyle=1,Outline=2.4,Shadow=1.1,Alignment=2,MarginV=36",
  captionAssStyle("classic", false)
);

check(
  "classic vertical === the pre-S6 slides-mode constant (Shorts safe zone)",
  captionAssStyle("classic", true) ===
    "FontName=Noto Sans SC,FontSize=19,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H8C000000,BorderStyle=1,Outline=2.2,Shadow=0,Alignment=2,MarginV=190",
  captionAssStyle("classic", true)
);

// ---- 3. the ASS mapping — one vocabulary, never hostile ----
check(
  "every style maps to a well-formed ASS string in BOTH orientations",
  (() => {
    return CAPTION_STYLES.every((s) =>
      [false, true].every((vert) => {
        const a = captionAssStyle(s.id, vert);
        return (
          a.startsWith("FontName=Noto Sans SC,FontSize=") &&
          /Alignment=(2|8),/.test(a) &&
          /MarginV=\d+/.test(a) &&
          /PrimaryColour=&H[0-9A-F]{8}/.test(a)
        );
      })
    );
  })()
);

check(
  "junk picks fall back to the classic string — never null, never hostile text",
  captionAssStyle("DROP TABLE scenes", false) === captionAssStyle("classic", false) &&
    captionAssStyle("../../etc/passwd", true) === captionAssStyle("classic", true) &&
    captionAssStyle(42 as never, false) === captionAssStyle("classic", false) &&
    captionAssStyle(null, true) === captionAssStyle("classic", true)
);

// ---- 4. the doc boundary ----
check(
  "sanitizeCaptionStyle: ids survive (case/whitespace), classic/none/off/junk read as no-pick",
  (() => {
    return (
      sanitizeCaptionStyle(" Bold-Pop ") === "bold-pop" &&
      sanitizeCaptionStyle("TOP-LINE") === "top-line" &&
      sanitizeCaptionStyle("classic") === null &&
      sanitizeCaptionStyle("none") === null &&
      sanitizeCaptionStyle("off") === null &&
      sanitizeCaptionStyle("") === null &&
      sanitizeCaptionStyle("DROP TABLE scenes") === null &&
      sanitizeCaptionStyle("../../etc/passwd") === null &&
      sanitizeCaptionStyle(42 as never) === null &&
      sanitizeCaptionStyle(null) === null
    );
  })()
);

check(
  "docCaptionStyle reads the doc's renderPrefs; junk reads as no-pick",
  docCaptionStyle({ quality: "standard", captionStyle: "clean-box" }) === "clean-box" &&
    docCaptionStyle({ quality: "standard", captionStyle: "javascript:alert(1)" }) === null &&
    docCaptionStyle({ quality: "standard" }) === null &&
    docCaptionStyle(null) === null
);

check(
  "sanitizeRenderPrefs keeps quality + a clean pick, drops junk keys, fails closed on bad quality",
  (() => {
    const kept = sanitizeRenderPrefs({ quality: "high", captionStyle: "bold-pop", hostile: "x" });
    const nopick = sanitizeRenderPrefs({ quality: "standard", captionStyle: "../../x" });
    return (
      !!kept && kept.quality === "high" && kept.captionStyle === "bold-pop" && !("hostile" in kept) &&
      !!nopick && nopick.quality === "standard" && nopick.captionStyle === undefined &&
      sanitizeRenderPrefs({ quality: "ultra" }) === null &&
      sanitizeRenderPrefs(null) === null
    );
  })()
);

// ---- 5. the round-trip — the pick survives the doc save/parse ----
check(
  "serializeTimeline → parseTimeline round-trips the caption pick (and drops junk)",
  (() => {
    const scenes = parseScenes(sceneJson({}));
    const doc = assembleTimeline(scenes, { sceneDurationsSec: [5, 5] });
    doc.renderPrefs = { quality: "high", captionStyle: "clean-box" };
    const round = parseTimeline(serializeTimeline(doc));
    if (!round) return false;
    if (round.renderPrefs?.captionStyle !== "clean-box") return false;
    doc.renderPrefs = { quality: "high", captionStyle: "DROP TABLE scenes" as never };
    const round2 = parseTimeline(serializeTimeline(doc));
    return !!round2 && round2.renderPrefs?.captionStyle === undefined;
  })()
);

// ---- 6. the render's extraction choke point carries the pick ----
check(
  "docSceneSettings extraction still passes with renderPrefs present (S5 fields unharmed)",
  (() => {
    const scenes = parseScenes(sceneJson({ sfx: "boom" }));
    const doc = assembleTimeline(scenes, { sceneDurationsSec: [5, 5] });
    doc.renderPrefs = { quality: "standard", captionStyle: "top-line" };
    const round = parseTimeline(serializeTimeline(doc));
    if (!round) return false;
    const out = docSceneSettings(round, 2);
    return !!out && out[0].sfxKind === "boom" && !!round.renderPrefs?.captionStyle;
  })()
);

// ---- 7. the save boundary (zod) accepts the pick and caps its length ----
check(
  "assembleSaveSchema accepts a catalog pick and rejects an oversized one",
  (() => {
    const base = { scenes: [{ index: 1, startSec: 0, endSec: 5, durationSec: 5 }], totalDurationSec: 5 };
    const ok = assembleSaveSchema.safeParse({ ...base, renderPrefs: { quality: "high", captionStyle: "amber-warm" } });
    const junk = assembleSaveSchema.safeParse({
      ...base,
      renderPrefs: { quality: "high", captionStyle: "x".repeat(500) },
    });
    return ok.success && !junk.success;
  })()
);

// ---- 8. the preview mirror ----
check(
  "captionPreview: the classic look pins the pre-S6 draw in BOTH orientations",
  (() => {
    const wide = captionPreview("classic", false);
    const vert = captionPreview("classic", true);
    return (
      wide.faceMul === 1 && vert.faceMul === 1 &&
      wide.weight === 600 && vert.weight === 600 &&
      wide.fill === "#ffffff" && wide.stroke === "rgba(0,0,0,0.72)" &&
      wide.strokeRatio === 0.18 && wide.box === null &&
      wide.align === "bottom" && wide.marginRatio === 0.032 && vert.marginRatio === 0.075
    );
  })()
);

check(
  "captionPreview: every non-classic style yields sane, finite geometry",
  (() => {
    return CAPTION_STYLES.filter((s) => s.id !== "classic").every((s) =>
      [false, true].every((vert) => {
        const p = captionPreview(s.id, vert);
        return (
          Number.isFinite(p.faceMul) && p.faceMul > 0 &&
          p.marginRatio >= 0.02 && p.marginRatio <= 0.16 &&
          (p.align === "bottom" || p.align === "top") &&
          (p.fill.startsWith("rgba(") || p.fill.startsWith("#")) &&
          (p.stroke.startsWith("rgba(") || p.stroke.startsWith("#")) &&
          (s.borderStyle === 3 ? p.box !== null : p.box === null) &&
          typeof p.uppercase === "boolean"
        );
      })
    );
  })()
);

check(
  "captionPreview: box styles carry a box, top styles align top, junk falls back to classic",
  captionPreview("clean-box", false).box !== null &&
    captionPreview("top-line", false).align === "top" &&
    (() => {
      const junk = captionPreview("javascript:alert(1)", false);
      return junk.faceMul === 1 && junk.align === "bottom" && junk.box === null;
    })()
);

// ---- 9. the catalog lookup seam ----
check(
  "captionStyle: catalog entries resolve by id; junk resolves to null",
  captionStyle("amber-warm")?.label === "Amber warm" &&
    captionStyle("amber-warm")?.primary === "&H0043C8FF" &&
    captionStyle("nope") === null &&
    captionStyle(7 as never) === null
);

// wrap-up
console.log(failures === 0 ? "\nS6 UNIT PROBE: ALL PASS" : `\nS6 UNIT PROBE: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

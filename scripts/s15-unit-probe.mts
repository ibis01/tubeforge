// S15 unit probe — "the motion": the camera + the seam contract through
// REAL modules. The last render tier the studio previewed but couldn't
// shape (motion + transitions rode the detail dialog only, and the PATCH
// route accepted the family with a silent drop/clamp). Layers:
//   1. PURE — the catalog law: motion modes/curves (motion.ts) and the
//      transition catalog (transitions.ts) are unique, labeled, and their
//      defaults are members — a pick can never strand a row outside.
//   2. PURE — the resolver law (sanitizeMotion): null means DEFAULT
//      exactly like absent — the S15 fix pins the null-intensity path
//      (Number(null) is 0; the naive coercion used to read "unset" as
//      "dead still"), a legal explicit 0 survives, junk coerces.
//   3. PURE — the one seam resolver (resolveTransition): null + slides is
//      a HARD CUT (the deck's beats land clean), an explicit pick is
//      honored on BOTH modes, junk falls to the fade default, and the
//      blend length clamps to the window (the deep layer; the GATE
//      rejects what the resolver clamps).
//   4. PURE — the preview's resolution law (previewSettingsFrom): the
//      motion quartet + blend length resolve through the SAME law the
//      render job runs — the falsy-zero bug (a legal 0 read back as 12)
//      is pinned dead.
//   5. PURE — the picker ⊆ gate law: every curated stop the studio's new
//      dropdowns offer is legal at the route's gate — a pick from the
//      dropdown can never die with a 400.
//   6. DB-backed — a real row with the whole family set serializes
//      through serializeVideo intact (the DTO surface the studio pickers
//      read), and a cleared row serializes null (default reads as
//      default — the pickers show the resolved truth).
// Run: node --import tsx scripts/s15-unit-probe.mts
import {
  MOTION_MODES,
  MOTION_CURVES,
  MOTION_DEFAULTS,
  MOTION_MODE_IDS,
  MOTION_CURVE_IDS,
  MOTION_INTENSITY_MIN,
  MOTION_INTENSITY_MAX,
  sanitizeMotion,
} from "../src/lib/tubeforge/motion";
import {
  TRANSITIONS,
  TRANSITION_IDS,
  TRANSITION_DEFAULT,
  TRANSITION_DURATION_MIN,
  TRANSITION_DURATION_MAX,
  resolveTransition,
} from "../src/lib/tubeforge/transitions";
import { previewSettingsFrom } from "../src/lib/tubeforge/preview-lanes";
import { serializeVideo } from "../src/lib/tubeforge/serialize";
import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

// =====================================================================
// 1. the catalog law
// =====================================================================
check(
  "the catalog: motion modes unique + labeled, curves unique, defaults are members",
  (() => {
    const modeIds = MOTION_MODES.map((m) => m.id);
    const curveIds = MOTION_CURVES.map((c) => c.id);
    return (
      modeIds.length === 4 &&
      new Set(modeIds).size === modeIds.length &&
      MOTION_MODES.every((m) => m.label.trim().length > 0) &&
      curveIds.length === 2 &&
      new Set(curveIds).size === curveIds.length &&
      MOTION_MODE_IDS.includes(MOTION_DEFAULTS.mode) &&
      MOTION_CURVE_IDS.includes(MOTION_DEFAULTS.curve)
    );
  })()
);

check(
  "the catalog: the intensity window holds its default (12) — null is never a stranger",
  MOTION_INTENSITY_MIN === 0 &&
    MOTION_INTENSITY_MAX === 30 &&
    MOTION_DEFAULTS.intensity >= MOTION_INTENSITY_MIN &&
    MOTION_DEFAULTS.intensity <= MOTION_INTENSITY_MAX
);

check(
  "the catalog: 15 transition styles, unique, labeled, cut + fade present, default is a member",
  (() => {
    const ids = TRANSITIONS.map((t) => t.id);
    return (
      TRANSITIONS.length === 15 &&
      new Set(ids).size === ids.length &&
      TRANSITIONS.every((t) => t.label.trim().length > 0) &&
      ids.includes("cut") &&
      ids.includes("fade") &&
      TRANSITION_IDS.has(TRANSITION_DEFAULT.style) &&
      TRANSITION_DEFAULT.durationSec === 0.5
    );
  })()
);

check(
  "the catalog: the blend window (0.2..1.5s) holds its default",
  TRANSITION_DURATION_MIN === 0.2 &&
    TRANSITION_DURATION_MAX === 1.5 &&
    TRANSITION_DEFAULT.durationSec >= TRANSITION_DURATION_MIN &&
    TRANSITION_DEFAULT.durationSec <= TRANSITION_DURATION_MAX
);

// =====================================================================
// 2. the resolver law — sanitizeMotion (null = default, exactly like absent)
// =====================================================================
const d = sanitizeMotion(null);
check(
  "sanitizeMotion: a null row resolves to the built-in defaults (smart / 12 / smooth / varied)",
  d.mode === "smart" && d.intensity === 12 && d.curve === "smooth" && d.vary === true,
  d
);

check(
  "sanitizeMotion: null intensity means the 12 default, NOT 0 (the Number(null) trap — S15 fix)",
  sanitizeMotion({ mode: "zoom", intensity: null }).intensity === 12,
  sanitizeMotion({ mode: "zoom", intensity: null })
);

check(
  "sanitizeMotion: a legal explicit 0 (the slider's None) survives — still means still",
  sanitizeMotion({ intensity: 0 }).intensity === 0
);

check(
  "sanitizeMotion: in-window values pass, out-of-window clamps to the window",
  sanitizeMotion({ intensity: 20 }).intensity === 20 &&
    sanitizeMotion({ intensity: 99 }).intensity === 30 &&
    sanitizeMotion({ intensity: -5 }).intensity === 0
);

check(
  "sanitizeMotion: junk coerces the deep-defense way (foreign mode → smart, junk intensity → 12, foreign curve → smooth, non-boolean vary → true)",
  (() => {
    const s = sanitizeMotion({ mode: "wild", intensity: "abc", curve: "jumpy", vary: "yes" });
    return s.mode === "smart" && s.intensity === 12 && s.curve === "smooth" && s.vary === true;
  })()
);

check(
  "sanitizeMotion: legal picks pass through untouched (zoom / 16 / linear / false)",
  (() => {
    const s = sanitizeMotion({ mode: "zoom", intensity: 16, curve: "linear", vary: false });
    return s.mode === "zoom" && s.intensity === 16 && s.curve === "linear" && s.vary === false;
  })()
);

// =====================================================================
// 3. the one seam resolver — resolveTransition (slides null → cut)
// =====================================================================
check(
  "resolveTransition: a story row with no pick crossfades at the 0.5s default",
  (() => {
    const t = resolveTransition({ transitionStyle: null, transitionDuration: null }, "kenburns");
    return t.style === "fade" && t.durationSec === 0.5;
  })()
);

check(
  "resolveTransition: a slides row with no pick HARD-CUTS (the deck's beats land clean)",
  (() => {
    const t = resolveTransition({ transitionStyle: null, transitionDuration: null }, "slides");
    return t.style === "cut";
  })()
);

check(
  "resolveTransition: an explicit pick is honored on BOTH modes (fadeblack 0.8s survives on slides too)",
  (() => {
    const story = resolveTransition({ transitionStyle: "fadeblack", transitionDuration: 0.8 }, "kenburns");
    const slides = resolveTransition({ transitionStyle: "fadeblack", transitionDuration: 0.8 }, "slides");
    return (
      story.style === "fadeblack" && story.durationSec === 0.8 &&
      slides.style === "fadeblack" && slides.durationSec === 0.8
    );
  })()
);

check(
  "resolveTransition: an explicit cut is a cut, a null duration blends at 0.5s, junk falls to the fade default",
  (() => {
    const cut = resolveTransition({ transitionStyle: "cut", transitionDuration: 0.3 }, "kenburns");
    const noDur = resolveTransition({ transitionStyle: "hblur", transitionDuration: null }, "kenburns");
    const junk = resolveTransition({ transitionStyle: "meltpixels", transitionDuration: 9 }, "kenburns");
    return (
      cut.style === "cut" &&
      noDur.durationSec === 0.5 &&
      junk.style === "fade" && junk.durationSec === 1.5
    );
  })()
);

// =====================================================================
// 4. the preview's resolution law — previewSettingsFrom (one law with render)
// =====================================================================
check(
  "previewSettingsFrom: null motion → 12% smooth varied, null blend → 0.5s (defaults read as defaults)",
  (() => {
    const s = previewSettingsFrom({});
    return s.motionIntensity === 12 && s.motionCurve === "smooth" && s.motionVary === true && s.transitionDurationSec === 0.5;
  })()
);

check(
  "previewSettingsFrom: a legal 0 amplitude stays 0 — the preview holds still with the render (S15 falsy-zero fix)",
  previewSettingsFrom({ motionIntensity: 0 }).motionIntensity === 0
);

check(
  "previewSettingsFrom: the quartet + blend clamp like the render (50→30, linear passes, false survives, 2s→1.5s)",
  (() => {
    const s = previewSettingsFrom({
      motionIntensity: 50,
      motionCurve: "linear",
      motionVary: false,
      transitionDurationSec: 2,
    });
    return (
      s.motionIntensity === 30 && s.motionCurve === "linear" && s.motionVary === false && s.transitionDurationSec === 1.5
    );
  })()
);

// =====================================================================
// 5. the picker ⊆ gate law — every curated stop the studio offers is legal
// =====================================================================
const INTENSITY_STOPS = [0, 6, 12, 18, 24, 30];
const DURATION_STOPS = [0.2, 0.3, 0.5, 0.7, 1, 1.5];
check(
  "the picker ⊆ gate: every amplitude stop is an integer inside the window, every blend stop inside 0.2..1.5s",
  INTENSITY_STOPS.every(
    (n) => Number.isInteger(n) && n >= MOTION_INTENSITY_MIN && n <= MOTION_INTENSITY_MAX
  ) &&
    DURATION_STOPS.every(
      (n) => n >= TRANSITION_DURATION_MIN && n <= TRANSITION_DURATION_MAX
    )
);

check(
  "the picker ⊆ gate: every dropdown style/mode id is a member of the shared catalogs",
  MOTION_MODES.every((m) => MOTION_MODE_IDS.includes(m.id)) &&
    TRANSITIONS.every((t) => TRANSITION_IDS.has(t.id))
);

// =====================================================================
// 6. DB-backed — the DTO round-trip
// =====================================================================
const MARK = crypto.randomBytes(4).toString("hex");
const raw = new PrismaClient();

try {
  const org = await raw.organization.create({
    data: { name: `s15 ${MARK}`, slug: `s15-${MARK}` },
  });
  // the whole family, never the defaults, so a pass can't ride a default
  const video = await raw.video.create({
    data: {
      organizationId: org.id,
      topic: `S15 motion probe ${MARK}`,
      niche: "Motivation",
      format: "story",
      status: "draft",
      voice: "jam",
      motionMode: "zoom",
      motionIntensity: 20,
      motionCurve: "linear",
      motionVary: false,
      transitionStyle: "fadeblack",
      transitionDuration: 0.8,
    },
  });

  const dto = await serializeVideo(video);
  check(
    "serializeVideo: the whole motion family rides the DTO (the surface the studio pickers read)",
    dto.motionMode === "zoom" &&
      dto.motionIntensity === 20 &&
      dto.motionCurve === "linear" &&
      dto.motionVary === false &&
      dto.transitionStyle === "fadeblack" &&
      dto.transitionDuration === 0.8,
    {
      motionMode: dto.motionMode,
      motionIntensity: dto.motionIntensity,
      motionCurve: dto.motionCurve,
      motionVary: dto.motionVary,
      transitionStyle: dto.transitionStyle,
      transitionDuration: dto.transitionDuration,
    }
  );

  const cleared = await raw.video.update({
    where: { id: video.id },
    data: {
      motionMode: null,
      motionIntensity: null,
      motionCurve: null,
      motionVary: null,
      transitionStyle: null,
      transitionDuration: null,
    },
  });
  const dtoNull = await serializeVideo(cleared);
  check(
    "serializeVideo: a cleared row reads null across the family (default reads as default — the pickers show the resolved truth)",
    dtoNull.motionMode === null &&
      dtoNull.motionIntensity === null &&
      dtoNull.motionCurve === null &&
      dtoNull.motionVary === null &&
      dtoNull.transitionStyle === null &&
      dtoNull.transitionDuration === null,
    {
      motionMode: dtoNull.motionMode,
      motionIntensity: dtoNull.motionIntensity,
      motionCurve: dtoNull.motionCurve,
      motionVary: dtoNull.motionVary,
      transitionStyle: dtoNull.transitionStyle,
      transitionDuration: dtoNull.transitionDuration,
    }
  );

  await raw.video.delete({ where: { id: video.id } }).catch(() => {});
  await raw.organization.delete({ where: { id: org.id } }).catch(() => {});
} finally {
  await raw.$disconnect();
}

console.log(
  failures === 0
    ? "\nS15 UNIT PROBE: ALL PASS"
    : `\nS15 UNIT PROBE: ${failures} FAILURE(S)`
);
process.exit(failures === 0 ? 0 : 1);

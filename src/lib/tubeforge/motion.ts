// Smart Motion — TubeForge's scene-aware Ken Burns engine.
//
// One reusable module that turns storyboard scenes into intentional camera
// work: every scene gets a MOVEMENT PLAN (which move, how big, how fast,
// where the eye must stay), and the plan compiles into a single ffmpeg
// filter_complex graph the renderer feeds a still image through.
//
// Design rules (from the Ken Burns product spec):
//   • Movement must feel INTENTIONAL, not "every image zooms in" — the move
//     is chosen from what the scene IS (emotional close-up, map, action…).
//   • Default amplitude is subtle: 12% (zoom 1.00 -> 1.12) across the scene,
//     smooth cinematic easing, direction varied between scenes.
//   • A focal point (face / key object, suggested by the storyboard LLM or
//     heuristics) is LOCKED in frame while zooming/panning — no drifting
//     faces, no cut-off subjects.
//   • No empty borders: images are supersampled to 2x output, zoom is always
//     >= 1.0 and pan endpoints are clamped to the legal window.
//   • Both aspects are first-class: 16:9 master and 9:16 Shorts get plans
//     shaped for their frame (vertical favours tilts over lateral pans).
//
// Pure module — no fs, no Prisma, no side effects. Unit-tested against the
// REAL source in scripts/test-motion.ts (bun imports this file directly).

import type { Scene } from "./types";
import { must } from "./must";

// ---------- settings ----------

export type MotionMode = "smart" | "zoom" | "pan" | "off";
export type MotionCurve = "smooth" | "linear";
export type Aspect = "16:9" | "9:16" | "1:1";

export interface MotionSettings {
  mode: MotionMode; // smart = scene-aware | zoom only | pan only | off
  intensity: number; // zoom amplitude in % (1.00 -> 1.00+intensity/100)
  curve: MotionCurve; // smooth cinematic easing vs constant speed
  vary: boolean; // vary movement direction between scenes
}

export const MOTION_DEFAULTS: MotionSettings = {
  mode: "smart",
  intensity: 12,
  curve: "smooth",
  vary: true,
};

export const MOTION_MODES = [
  { id: "smart", label: "Smart Motion", desc: "Choose movement by scene type — faces, maps, landscapes and action each get the right move" },
  { id: "zoom", label: "Zoom only", desc: "Every scene gets a zoom move — pushes and pulls, no lateral pans" },
  { id: "pan", label: "Pan only", desc: "Every scene gets a pan or tilt sweep — no zooms" },
  { id: "off", label: "Off — static images", desc: "No camera movement; scenes hold still" },
] as const;

export const MOTION_CURVES = [
  { id: "smooth", label: "Smooth — cinematic easing" },
  { id: "linear", label: "Linear — constant speed" },
] as const;

export const MOTION_MODE_IDS: readonly string[] = MOTION_MODES.map((m) => m.id);
export const MOTION_CURVE_IDS: readonly string[] = MOTION_CURVES.map((c) => c.id);

// The intensity window (S15): one exported law for the route's gate, this
// resolver and the studio picker — the same numbers that used to live
// inline in three places.
export const MOTION_INTENSITY_MIN = 0;
export const MOTION_INTENSITY_MAX = 30;

/** Coerce anything (API body, DB row) into a valid MotionSettings.
 *
 * S15 law: a null field means "follow the built-in default" EXACTLY like
 * an absent one. `Number(null)` is 0 — the naive coercion used to turn
 * every unset intensity into 0 (dead still) instead of the 12 default,
 * the same bug class sanitizeTransitionDuration's comment documents
 * (a naive Number() turned every unset duration into the MINIMUM). */
export function sanitizeMotion(raw: {
  mode?: unknown;
  intensity?: unknown;
  curve?: unknown;
  vary?: unknown;
} | null | undefined): MotionSettings {
  const mode = MOTION_MODE_IDS.includes(String(raw?.mode))
    ? (String(raw?.mode) as MotionMode)
    : MOTION_DEFAULTS.mode;
  const n = raw?.intensity == null ? Number.NaN : Number(raw?.intensity);
  const intensity = Number.isFinite(n)
    ? Math.round(
        Math.min(Math.max(n, MOTION_INTENSITY_MIN), MOTION_INTENSITY_MAX)
      )
    : MOTION_DEFAULTS.intensity;
  const curve = MOTION_CURVE_IDS.includes(String(raw?.curve))
    ? (String(raw?.curve) as MotionCurve)
    : MOTION_DEFAULTS.curve;
  const vary = typeof raw?.vary === "boolean" ? raw.vary : MOTION_DEFAULTS.vary;
  return { mode, intensity, curve, vary };
}

// ---------- scene classification ----------

/**
 * What a scene IS, decided from its own words. This drives the movement
 * table below — the same mapping a documentary editor applies by hand:
 * emotional close-ups creep in, landscapes reveal, maps sweep, action cuts.
 */
export type SceneKind =
  | "emotional" // faces / close-ups / discoveries -> slow zoom IN
  | "establishing" // landscapes / settings / endings -> slow zoom OUT
  | "detail" // maps, documents, wide scenes with key details -> PAN across
  | "suspense" // tension beats -> gradual, restrained zoom in
  | "action" // high-energy beats -> shorter, deliberate cuts
  | "text" // text/legal-heavy art -> minimize movement, keep readable
  | "standard"; // everything else -> follow the storyboard camera intent

const RE_FACE = /\b(close[\s-]?up|closeup|face|faces|portrait|eyes?|tears|smil\w*|whisper\w*|gasp\w*|reaction)\b/i;
const RE_LANDSCAPE = /\b(landscape|vista|skyline|horizon|panorama\w*|aerial|cityscape|mountain\w*|ocean|sea|forest|valley|desert|glacier|dunes|establishing|wide shot|vast|sunset|sunrise)\b/i;
const RE_MAPDOC = /\b(map|atlas|chart|document|scroll|blueprint|ledger|manuscript|letter|archive|inscription|painting|photograph|mural|hieroglyph\w*)\b/i;
const RE_TEXTY = /\b(text|writing|written|letters|words|inscription|contract|signature|pages? of)\b/i;
const RE_SUSPENSE = /\b(suspense|tension|ominous|eerie|foreboding|dread|creep\w*|haunt\w*|dark figure|mystery|mysterious|vanish\w*)\b/i;
const RE_ACTION = /\b(action|chase|charg\w+|battle|combat|explosion|erupt\w*|storm\w*|crash\w*|collaps\w*|runn?ing|sprint\w*|fight\w*|stampede|riot)\b/i;

export interface SceneContext {
  tone?: string | null; // video tone ("mysterious", "dramatic"…)
  niche?: string | null; // video niche ("Mysteries"…)
}

/**
 * Classify one scene. Order matters: text-legibility wins over everything
 * (moving text-heavy art destroys readability), then maps/documents, then
 * emotional faces, then action, suspense, landscape; standard falls back to
 * the storyboard LLM's own camera intent.
 */
export function classifyScene(scene: Scene, ctx?: SceneContext): SceneKind {
  const haystack = `${scene.visual} ${scene.mood} ${scene.title} ${scene.caption}`;
  if (RE_TEXTY.test(haystack)) return "text";
  if (RE_MAPDOC.test(haystack)) return "detail";
  if (RE_FACE.test(haystack) || scene.hostInScene) return "emotional";
  if (RE_ACTION.test(haystack)) return "action";
  if (RE_SUSPENSE.test(haystack) || ctx?.tone === "mysterious" || ctx?.niche === "Mysteries")
    return "suspense";
  if (RE_LANDSCAPE.test(haystack)) return "establishing";
  return "standard";
}

// ---------- focal point ----------

export interface Focal {
  x: number; // normalized 0..1
  y: number;
}

const FOCAL_CENTER: Focal = { x: 0.5, y: 0.5 };

/** Normalized anchor for each focal token the storyboard LLM can emit. */
const FOCAL_TOKENS: Record<string, Focal> = {
  center: { x: 0.5, y: 0.5 },
  left: { x: 0.32, y: 0.5 },
  right: { x: 0.68, y: 0.5 },
  upper: { x: 0.5, y: 0.35 },
  lower: { x: 0.5, y: 0.65 },
  "upper-left": { x: 0.32, y: 0.35 },
  "upper-right": { x: 0.68, y: 0.35 },
  "lower-left": { x: 0.32, y: 0.65 },
  "lower-right": { x: 0.68, y: 0.65 },
};

/** Normalize LLM/human phrasing into a canonical focal token. */
export function normalizeFocalToken(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = String(raw).trim().toLowerCase().replace(/\s+/g, "-");
  const alias: Record<string, string> = {
    "top-left": "upper-left",
    "top-right": "upper-right",
    "bottom-left": "lower-left",
    "bottom-right": "lower-right",
    top: "upper",
    bottom: "lower",
    middle: "center",
  };
  const token = alias[t] ?? t;
  return token in FOCAL_TOKENS ? token : null;
}

/** S48 — resolve a Director focal token to its anchor point (null when the
 *  token is absent/unknown — the caller then falls back to its own
 *  heuristic). The single seam the plan layer uses; FOCAL_TOKENS stays
 * private to this module. */
export function focalFromToken(raw: string | null | undefined): Focal | null {
  const token = normalizeFocalToken(raw);
  return token ? FOCAL_TOKENS[token] : null;
}

/** S48 — the per-shot Ken Burns intensity: the video-level base multiplied
 * by the Director's moveSpeed (slow 0.7 / normal 1 / fast 1.35), clamped to
 * the 0..30 setting range so a "fast" request can never exceed what the
 * intensity knob itself allows. */
export function shotIntensity(base: number, speed?: number): number {
  const b = Number.isFinite(base) ? base : 0;
  const m = Number.isFinite(speed) && speed !== undefined ? speed : 1;
  return Math.max(0, Math.min(MOTION_INTENSITY_MAX, b * m));
}

/**
 * Where the eye must stay. Priority: the storyboard LLM's explicit "focal"
 * token > composition keywords in the visual prompt > center.
 * Faces sit slightly above frame center (eyes on the upper third).
 */
export function focalForScene(scene: Scene): Focal {  // exported for the M2 shot path (render.ts)
  const token = normalizeFocalToken(scene.focal);
  if (token) return FOCAL_TOKENS[token];

  const visual = scene.visual.toLowerCase();
  const x = /\bleft\b/.test(visual) && !/\bright\b/.test(visual)
    ? 0.34
    : /\bright\b/.test(visual) && !/\bleft\b/.test(visual)
      ? 0.66
      : 0.5;
  const y = /\b(above|overhead|sky|ceiling|towers?|upper)\b/.test(visual) && !/\bbelow\b/.test(visual)
    ? 0.38
    : /\b(below|ground|floor|feet|beneath|lower)\b/.test(visual)
      ? 0.62
      : 0.5;

  // Faces anchor a touch high so eyes stay on the upper third.
  if (RE_FACE.test(scene.visual) || scene.hostInScene) {
    return { x, y: Math.min(y, 0.45) };
  }
  return { x, y };
}

// ---------- movement plans ----------

export type MoveKind =
  | "zoom-in"
  | "zoom-out"
  | "pan-left"
  | "pan-right"
  | "tilt-up"
  | "tilt-down"
  | "diag-tl" // drift toward upper-left (x-, y-)
  | "diag-br" // drift toward lower-right (x+, y+)
  | "punch" // fast attack then slow drift (rehook opener)
  | "studio" // S2: the user's two-key camera (from/to framing + ease)
  | "hold"; // static frame

export interface MotionShot {
  kind: MoveKind;
  zStart: number;
  zEnd: number; // == zStart for pans/tilts
  focal: Focal; // point locked in frame for this shot
  travel: number; // 0..1 fraction of max window travel (pans/tilts/diags)
  sec: number; // target seconds for this shot
  /** S2 "studio" shots — the user's two-key camera, expressed in the SAME
   *  vocabulary as the studio preview (window center fractions + scale).
   *  Absent on every engine-authored shot; optional so all existing
   *  constructors stay untouched. */
  from?: { scale: number; x: number; y: number };
  to?: { scale: number; x: number; y: number };
  ease?: "smooth" | "linear" | "pop";
}

export interface MotionScenePlan {
  sceneType: SceneKind;
  move: string; // human label of the primary move
  shots: MotionShot[];
  staticImage: boolean; // true -> renderer skips zoompan entirely
}

export const MOTION_MOVE_LABELS: Record<MoveKind, string> = {
  "zoom-in": "Slow zoom in",
  "zoom-out": "Slow zoom out",
  "pan-left": "Pan left",
  "pan-right": "Pan right",
  "tilt-up": "Tilt up",
  "tilt-down": "Tilt down",
  "diag-tl": "Diagonal drift (up-left)",
  "diag-br": "Diagonal drift (down-right)",
  punch: "Punch-in hook",
  studio: "Studio keyframes",
  hold: "Static hold",
};

/** S2 — build the ONE-shot plan a doc's cameraKeys renders through: the user
 *  two-key camera spans the whole scene, outranking the Director's auto
 *  camera for that scene (an explicit user edit is senior by definition). */
export function studioCameraPlan(keys: { from: { scale: number; x: number; y: number }; to: { scale: number; x: number; y: number }; ease: "smooth" | "linear" | "pop" }, sec: number): MotionScenePlan {
  return {
    sceneType: "standard",
    move: "Studio keyframes",
    shots: [
      {
        kind: "studio",
        zStart: keys.from.scale,
        zEnd: keys.to.scale,
        focal: { x: keys.from.x, y: keys.from.y },
        travel: 0,
        sec,
        from: keys.from,
        to: keys.to,
        ease: keys.ease,
      },
    ],
    staticImage: false,
  };
}

// Per-kind shot pacing (seconds per camera shot). Calm scenes HOLD one move
// across most of the scene (the spec: "movement should progress smoothly
// from the first frame to the last"); action keeps deliberate quick cuts.
const SHOT_SEC: Record<SceneKind, number> = {
  emotional: 7,
  establishing: 8,
  suspense: 9,
  detail: 4.5,
  action: 1.9,
  text: 99, // whole scene in one shot
  standard: 3.6,
};

const MAX_SHOTS = 12;
/** Amplitude multiplier per kind (of the user's intensity). */
const AMP_SCALE: Record<SceneKind, number> = {
  emotional: 1.0,
  establishing: 1.0,
  suspense: 0.6, // gradual, restrained
  detail: 0.0, // pans carry no zoom amplitude
  action: 1.4, // punchier — but capped below
  text: 0.25, // barely-there drift
  standard: 1.0,
};
const AMP_CAP = 0.26; // never beyond a strong-but-tasteful zoom
const ZOOM_CEIL = 1.24; // the widest a continuing creep may get before reset
/** Pans need MORE base zoom than zooms to travel visibly. */
const PAN_BASE_ZOOM = (intensity: number) => 1 + Math.max(intensity, 14) / 100;

const isPan = (k: MoveKind) =>
  k === "pan-left" ||
  k === "pan-right" ||
  k === "tilt-up" ||
  k === "tilt-down" ||
  k === "diag-tl" ||
  k === "diag-br";

/** Rotation pool for multi-shot scenes (never repeats back-to-back). */
const ROTATION: MoveKind[] = [
  "zoom-in",
  "pan-right",
  "zoom-out",
  "tilt-down",
  "diag-br",
  "pan-left",
  "zoom-out",
  "tilt-up",
  "diag-tl",
];

interface VaryState {
  pan: -1 | 1; // NEXT lateral sweep direction (window glides this way)
  tilt: -1 | 1; // NEXT vertical sweep direction (-1 = upward)
  zoom: "in" | "out"; // NEXT zoom direction
}

/** Camera intent from the storyboard LLM, as a MoveKind. */
function cameraToMove(camera: string): MoveKind {
  switch (camera) {
    case "zoom-out": return "zoom-out";
    case "pan-left": return "pan-left";
    case "pan-right": return "pan-right";
    case "push-in": return "zoom-in";
    case "zoom-in":
    default: return "zoom-in";
  }
}

/** Mode filters: which moves are allowed at all? */
function allowedByMode(kind: MoveKind, mode: MotionMode): boolean {
  if (mode === "zoom") return kind === "zoom-in" || kind === "zoom-out" || kind === "punch";
  if (mode === "pan") return isPan(kind);
  return true;
}

const _flipPan = (k: MoveKind): MoveKind =>
  k === "pan-left" ? "pan-right" : k === "pan-right" ? "pan-left" : k === "diag-tl" ? "diag-br" : "diag-tl";

/**
 * Build the shot list for ONE scene, honoring mode/intensity/vary and the
 * mandatory-movement table. `durSec` sizes the shot pool to the scene.
 */
function planSceneShots(
  scene: Scene,
  kind: SceneKind,
  settings: MotionSettings,
  aspect: Aspect,
  ctx: SceneContext | undefined,
  vary: VaryState,
  durSec: number | undefined
): MotionScenePlan {
  const intensity = settings.intensity;
  const focal = focalForScene(scene);
  const vertical = aspect === "9:16";

  // --- global static cases -------------------------------------------------
  // Off mode, or "None" intensity: still images, no camera movement.
  if (settings.mode === "off" || intensity < 1) {
    return {
      sceneType: kind,
      move: MOTION_MOVE_LABELS.hold,
      shots: [{ kind: "hold", zStart: 1, zEnd: 1, focal, travel: 0, sec: SHOT_SEC.text }],
      staticImage: true,
    };
  }

  // Visible-motion floor: with low slider values on low-detail (dark, smooth)
  // art, the per-frame crop shift drops below freezedetect's noise floor and
  // the scene reads as a still (Battle Yamuk's 2.5s "frozen" stretch). Any
  // intensity ≥ 1 therefore produces at least a 10% zoom travel per shot —
  // "subtle", never "imperceptible". Intensity 0 (or mode off) is the
  // explicit still-images contract and stays untouched.
  const amp = Math.max(
    Math.min((intensity / 100) * AMP_SCALE[kind], AMP_CAP),
    intensity >= 1 && AMP_SCALE[kind] > 0 ? 0.1 : 0
  );
  const shotSec = SHOT_SEC[kind];
  const shotCount = Math.max(
    1,
    Math.min(MAX_SHOTS, durSec && durSec > 0 ? Math.round(durSec / shotSec) : 1)
  );

  const panShot = (k: MoveKind, travel: number, base?: number): MotionShot => {
    const z = base ?? PAN_BASE_ZOOM(intensity);
    return { kind: k, zStart: z, zEnd: z, focal, travel, sec: shotSec };
  };
  const zoomShot = (k: "zoom-in" | "zoom-out", from: number, to: number): MotionShot => ({
    kind: k,
    zStart: from,
    zEnd: to,
    focal,
    travel: 0,
    sec: shotSec,
  });

  // Wide <-> tight re-framing bands for multi-shot pools. Within a shot the
  // move stays subtle (the user's intensity); BETWEEN shots the framing jumps
  // ~12-20% so every cut reads as a deliberate re-frame instead of a
  // continuation — the same trick documentary editors use on stills.
  const TIGHT = 1.26;
  const bandZoom = (wantTight: boolean, dir: "in" | "out"): [number, number] => {
    const a2 = wantTight ? amp * 0.5 : amp;
    const from = wantTight ? TIGHT : 1;
    return dir === "in" ? [from, Math.min(from + a2, 1.36)] : [Math.min(from + a2, 1.36), from];
  };

  // Mandatory moves from the movement table (never flipped by vary).
  const mandatory: { kind: "zoom-in" | "zoom-out"; amp: number } | null =
    kind === "emotional" || kind === "suspense"
      ? { kind: "zoom-in", amp }
      : kind === "establishing"
        ? { kind: "zoom-out", amp }
        : kind === "text"
          ? { kind: "zoom-in", amp }
          : null;

  // Rehook beats always land the PUNCH first (the attention pivot is senior
  // to the movement table) — then the mandatory move continues under it.
  const punchFirst = mandatory && scene.rehook && settings.mode !== "pan";

  // --- single-kind scenes: one intentional move, continued across cuts ------
  if (mandatory) {
    let k: MoveKind = mandatory.kind;
    const a = mandatory.amp;

    // Mode overrides remap zoom<->pan while keeping the INTENT (creep in /
    // reveal out) expressed through the allowed vocabulary.
    if (!allowedByMode(k, settings.mode)) {
      if (settings.mode === "zoom") {
        k = k === "zoom-out" ? "zoom-out" : "zoom-in";
      } else {
        // pan mode: "reveal out" -> tilt up (camera rises); "creep in" -> tilt down
        if (kind === "establishing") k = "tilt-up";
        else if (kind === "text") k = vary.pan === 1 ? "pan-right" : "pan-left";
        else k = vertical ? (vary.tilt === -1 ? "tilt-up" : "tilt-down") : "tilt-down";
      }
    }

    if (isPan(k)) {
      const travel = kind === "text" ? 0.18 : 0.45;
      const shots: MotionShot[] = [];
      for (let i = 0; i < shotCount; i++) {
        // Sweep direction follows the queue (alternates with vary on); with
        // vary off every shot sweeps the scene's own direction. The vertical
        // aspect swaps lateral pans for tilts with more travel room.
        let next: MoveKind = k;
        if (settings.vary) {
          if (k === "tilt-up" || k === "tilt-down") {
            next = vary.tilt === -1 ? "tilt-up" : "tilt-down";
            vary.tilt = next === "tilt-up" ? 1 : -1;
          } else {
            next = vary.pan === 1 ? "pan-right" : "pan-left";
            vary.pan = next === "pan-right" ? -1 : 1;
          }
        }
        shots.push(panShot(next, travel));
      }
      return { sceneType: kind, move: MOTION_MOVE_LABELS[shots[0].kind], shots, staticImage: false };
    }

    // Zoom kind: one slow creep per shot; across cuts the creep CONTINUES
    // from the previous end zoom (a long scene keeps breathing in) until it
    // hits the ceiling and resets wide — like a documentary editor re-framing.
    const shots: MotionShot[] = [];
    let from = k === "zoom-out" ? 1 + a : 1;
    let to = k === "zoom-out" ? 1 : 1 + a;
    if (punchFirst) {
      shots.push({
        kind: "punch",
        zStart: 1 + Math.min(Math.max(amp * 2.0, 0.22), 0.36),
        zEnd: 1 + Math.min(Math.max(amp * 0.75, 0.1), 0.16),
        focal,
        travel: 0,
        sec: shotSec,
      });
      from = k === "zoom-out" ? 1 + a : 1; // the mandatory move restarts wide under the punch
      to = k === "zoom-out" ? 1 : 1 + a;
    }
    for (let i = shots.length; i < shotCount; i++) {
      shots.push(zoomShot(k, from, to));
      if (k === "zoom-in") {
        if (to >= ZOOM_CEIL - 0.001) {
          from = 1;
          to = 1 + a;
        } else {
          from = to;
          to = Math.min(to + a, ZOOM_CEIL);
        }
      } else {
        if (to <= 1.001) {
          from = 1 + a;
          to = 1;
        } else {
          from = to;
          to = Math.max(to - a, 1);
        }
      }
    }
    vary.zoom = k === "zoom-in" ? "out" : "in"; // queue the opposite for the next scene
    return { sceneType: kind, move: MOTION_MOVE_LABELS[k], shots, staticImage: false };
  }

  // --- multi-shot kinds (detail / action / standard) ------------------------
  const shots: MotionShot[] = [];

  // Opening shot — rehook scenes land the punch; otherwise the scene's own
  // storyboard camera intent leads. With vary on, the INTENT's direction
  // yields to the queued direction so consecutive scenes never open the same
  // way (the spec's "vary movement direction between scenes").
  let open: MoveKind =
    scene.rehook && settings.mode !== "pan" ? "punch" : cameraToMove(scene.camera);
  if (!allowedByMode(open, settings.mode)) {
    open = settings.mode === "zoom" ? "zoom-in" : "pan-right";
  }
  if (open === "punch") {
    // Quick settle-back impact, then a slow creep. Biggest single move in the
    // system — reserved for rehook beats so it never reads as routine. Ends
    // tight so the NEXT shot can open wide with a visible re-frame.
    const zStart = 1 + Math.min(Math.max(amp * 2.0, 0.22), 0.36);
    const zEnd = 1 + Math.min(Math.max(amp * 0.75, 0.1), 0.16);
    shots.push({ kind: "punch", zStart, zEnd, focal, travel: 0, sec: shotSec });
    vary.zoom = "in"; // queue a wide open for the next shot
  } else if (isPan(open)) {
    let dirKind = open;
    if (settings.vary && (open === "pan-left" || open === "pan-right")) {
      dirKind = vary.pan === 1 ? "pan-right" : "pan-left";
      vary.pan = dirKind === "pan-right" ? -1 : 1;
    } else if (settings.vary && (open === "tilt-up" || open === "tilt-down")) {
      dirKind = vary.tilt === -1 ? "tilt-up" : "tilt-down";
      vary.tilt = dirKind === "tilt-up" ? 1 : -1;
    }
    if (vertical && (dirKind === "pan-left" || dirKind === "pan-right")) {
      dirKind = dirKind === "pan-left" ? "tilt-down" : "tilt-up"; // lateral pans waste vertical frame
    }
    shots.push(panShot(dirKind, 0.55));
  } else {
    let zoomIn = open === "zoom-in";
    if (settings.vary) {
      zoomIn = vary.zoom === "in";
      vary.zoom = zoomIn ? "out" : "in";
    }
    const [from, to] = bandZoom(false, zoomIn ? "in" : "out");
    shots.push(zoomShot(zoomIn ? "zoom-in" : "zoom-out", from, to));
  }

  // Remaining shots — rotating mix, no back-to-back repeats, direction varied,
  // and every cut lands as a wide<->tight re-frame of the artwork.
  const pool = ROTATION.filter((k) => allowedByMode(k, settings.mode) && k !== "punch");
  let i = 0;
  while (shots.length < shotCount && pool.length > 0) {
    const next = pool[i++ % pool.length];
    const prev = shots[shots.length - 1];
    if (next === prev.kind) continue;

    /**
     * Band choice: pick the framing band whose START zoom is FARTHEST from
     * the previous shot's end — the cut then reads as a deliberate re-frame
     * (~11-20% FOV jump) instead of a near-continuous drift.
     */
    const startFor = (tight: boolean): number => {
      if (next === "zoom-in") return tight ? TIGHT : 1;
      if (next === "zoom-out") return Math.min((tight ? TIGHT : 1) + (tight ? amp * 0.5 : amp), 1.36);
      return tight ? 1.3 : 1.16; // pans / tilts / diagonals
    };
    const wantTight =
      Math.abs(prev.zEnd - startFor(true)) >= Math.abs(prev.zEnd - startFor(false));

    if (isPan(next)) {
      let k = next;
      if (settings.vary) {
        // Take the queued direction, then queue the opposite.
        if (k === "pan-left" || k === "pan-right") {
          k = vary.pan === 1 ? "pan-right" : "pan-left";
          vary.pan = k === "pan-right" ? -1 : 1;
        } else if (k === "tilt-up" || k === "tilt-down") {
          k = vary.tilt === -1 ? "tilt-up" : "tilt-down";
          vary.tilt = k === "tilt-up" ? 1 : -1;
        } else {
          k = vary.pan === 1 ? "diag-tl" : "diag-br";
          vary.pan = k === "diag-tl" ? -1 : 1;
        }
        if (vertical && (k === "pan-left" || k === "pan-right"))
          k = k === "pan-left" ? "tilt-down" : "tilt-up"; // lateral pans waste vertical frame
      }
      shots.push(panShot(k, 0.5, wantTight ? 1.3 : 1.16));
    } else {
      // Zooms: with vary on, follow the queued direction then flip it.
      const zoomIn = settings.vary ? vary.zoom === "in" : next === "zoom-in";
      if (settings.vary) vary.zoom = zoomIn ? "out" : "in";
      const [from, to] = bandZoom(wantTight, zoomIn ? "in" : "out");
      shots.push(zoomShot(zoomIn ? "zoom-in" : "zoom-out", from, to));
    }
  }

  // Detail scenes (maps/documents) must LEAD with a pan across the details —
  // only when the mode actually allows pans.
  if (kind === "detail" && settings.mode !== "zoom" && !isPan(shots[0].kind)) {
    const k: MoveKind = vertical
      ? vary.tilt === -1
        ? "tilt-up"
        : "tilt-down"
      : vary.pan === 1
        ? "pan-right"
        : "pan-left";
    shots.unshift(panShot(k, 0.6));
    shots.pop(); // keep the pool sized to the scene
    if (k === "pan-left") vary.pan = -1;
    else if (k === "pan-right") vary.pan = 1;
    else vary.tilt = k === "tilt-up" ? 1 : -1;
  }

  return {
    sceneType: kind,
    move: MOTION_MOVE_LABELS[shots[0].kind],
    shots,
    staticImage: false,
  };
}

// ---------- planner (multi-scene, cross-scene variation) ----------

export interface PlanOptions {
  aspect?: Aspect;
  ctx?: SceneContext;
  /** Scene durations in seconds (from the narration WAVs) — sizes shot pools. */
  durationsSec?: number[];
}

/**
 * Plan every scene of a video. Cross-scene state (next pan/tilt/zoom
 * direction) makes movement VARY between scenes instead of every scene
 * zooming the same way — the difference between a camera plan and a loop.
 */
export function planSceneMovements(
  scenes: Scene[],
  settings: MotionSettings,
  opts: PlanOptions = {}
): MotionScenePlan[] {
  const aspect = opts.aspect ?? "16:9";
  const vary: VaryState = { pan: 1, tilt: -1, zoom: "in" };
  return scenes.map((scene, i) =>
    planSceneShots(
      scene,
      classifyScene(scene, opts.ctx),
      settings,
      aspect,
      opts.ctx,
      vary,
      opts.durationsSec?.[i]
    )
  );
}

/** One-line summary of a plan ("Scene-aware zoom and pan" style). */
export function planSummaryLine(settings: MotionSettings): string {
  const modeLine =
    settings.mode === "smart"
      ? "Scene-aware zoom and pan"
      : settings.mode === "zoom"
        ? "Zoom moves only"
        : settings.mode === "pan"
          ? "Pan moves only"
          : "Static images — no movement";
  if (settings.mode === "off" || settings.intensity < 1) return modeLine;
  const intensity =
    settings.intensity <= 16 ? `${settings.intensity}% (subtle)` : `${settings.intensity}% (strong)`;
  return `${modeLine} · ${intensity} · ${settings.curve === "smooth" ? "smooth easing" : "linear"}${
    settings.vary ? " · direction variation on" : ""
  }`;
}

// ---------- ffmpeg graph ----------

/** Working (supersampled) and output resolutions per aspect. */
export const OUTPUT_SIZES: Record<Aspect, { work: [number, number]; out: [number, number] }> = {
  "16:9": { work: [3840, 2160], out: [1920, 1080] },
  "9:16": { work: [2160, 3840], out: [1080, 1920] },
  // Square — 1080x1080 output (Instagram feed + the "1:1" ROADMAP §6
  // aspect option). The work canvas matches the output aspect so the cover
  // scale + crop don't distort.
  "1:1": { work: [2160, 2160], out: [1080, 1080] },
};

const fmt = (n: number, dp = 3): string => {
  const v = Number.isFinite(n) ? n : 0;
  const s = v.toFixed(dp);
  return s.startsWith("-0.") && Number(s) === 0 ? (0).toFixed(dp) : s;
};

/** Ease-in-out progress expression over `last` frames (smooth) or linear. */
function progressExpr(curve: MotionCurve, last: number): string {
  return curve === "smooth" ? `(0.5-0.5*cos(PI*on/${last}))` : `(on/${last})`;
}

/**
 * X/Y expressions that keep the focal point at the OUTPUT center while the
 * window zooms: x = fx*iw - 0.5*iw/zoom, clamped to the legal window. With
 * zoom >= 1 the clamp mathematically guarantees the focal point never
 * leaves the frame.
 */
function focalAnchorExpr(axis: "x" | "y", f: number): string {
  const dim = axis === "x" ? "iw" : "ih";
  return `clip(${dim}*${fmt(f, 4)}-${dim}/(2*zoom),0,${dim}-${dim}/zoom)`;
}

/**
 * Clamped sweep endpoints on one axis (exported for tests — the graph builder
 * and the test suite must agree on focal-safety math). `center` = focal
 * dead-center; the sweep stays inside [lo, hi] so the focal keeps a safety
 * pad of 8% of the window — a face near the edge stays in frame throughout.
 */
export function panEndpoints(
  axis: "x" | "y",
  f: number,
  dir: -1 | 1,
  travel: number,
  zStart: number,
  work: [number, number]
): [number, number] {
  const dim = axis === "x" ? work[0] : work[1];
  const window = dim / zStart;
  const maxTravel = dim - window;
  const center = Math.min(Math.max(f * dim - 0.5 * window, 0), maxTravel);
  if (maxTravel <= 1) return [center, center];
  const pad = 0.08 * window;
  const lo = Math.max(0, f * dim - window + pad);
  const hi = Math.min(maxTravel, f * dim - pad);
  const from = Math.min(Math.max(center, lo), hi);
  // travel=0 is the NON-sweep axis of a pan (y on a lateral pan, x on a
  // tilt) — it must hold still, never trigger the edge-pin fallbacks below.
  if (travel <= 0) return [from, from];
  let to = Math.min(Math.max(from + dir * travel * maxTravel, lo), hi);
  // Edge-pin guard (Battle Yamuk's 2.5s "frozen" stretch): a pan-left whose
  // window starts at the left edge (or a pan-right at the right edge) has its
  // intended sweep clamped straight back to the start — a 99-frame DEAD pan
  // that freezedetect rightly flags. Any movement beats a dead pan: sweep the
  // opposite direction, and if even that pins (no room), cross the full
  // available span.
  if (Math.abs(to - from) < 0.02 * maxTravel) {
    to = Math.min(Math.max(from - dir * travel * maxTravel, lo), hi);
  }
  if (Math.abs(to - from) < 0.02 * maxTravel && hi > lo) {
    to = from <= (lo + hi) / 2 ? hi : lo;
  }
  return [from, to];
}

/** zoompan filter segment for one shot. `d` = output frames per input frame
 * (1 for a pre-timed stream; the full shot length when the input is a single
 * still frame — the slides compositor's canonical shape). */
function shotZoompan(
  shot: MotionShot,
  frames: number,
  settings: MotionSettings,
  work: [number, number],
  out: [number, number],
  fps: number,
  d = 1
): string {
  const last = Math.max(frames - 1, 1);
  const p = progressExpr(settings.curve, last);
  const [ow, oh] = out;
  const { kind } = shot;

  let zExpr: string;
  let xExpr: string;
  let yExpr: string;

  if (kind === "studio" && shot.from && shot.to) {
    // S2 — the user's two-key camera. The window CENTER lerps between the
    // two keys with the chosen ease; scale lerps too; the focal-anchor clamp
    // (`clip`) keeps every intermediate window legal — exactly the guarantee
    // the engine's own focal-anchor math gives its own shots.
    const easeExpr =
      shot.ease === "linear"
        ? `(on/${last})`
        : shot.ease === "pop"
          ? `(1-(1-(on/${last}))*(1-(on/${last})))`
          : `(0.5-0.5*cos(PI*on/${last}))`;
    const z0 = Math.min(Math.max(shot.from.scale, 1), 2.2);
    const z1 = Math.min(Math.max(shot.to.scale, 1), 2.2);
    const cx0 = Math.min(Math.max(shot.from.x, 0), 1);
    const cx1 = Math.min(Math.max(shot.to.x, 0), 1);
    const cy0 = Math.min(Math.max(shot.from.y, 0), 1);
    const cy1 = Math.min(Math.max(shot.to.y, 0), 1);
    zExpr = `${fmt(z0, 4)}+${fmt(z1 - z0, 4)}*${easeExpr}`;
    xExpr = `clip(iw*(${fmt(cx0, 4)}+${fmt(cx1 - cx0, 4)}*${easeExpr})-iw/(2*zoom),0,iw-iw/zoom)`;
    yExpr = `clip(ih*(${fmt(cy0, 4)}+${fmt(cy1 - cy0, 4)}*${easeExpr})-ih/(2*zoom),0,ih-ih/zoom)`;
  } else if (kind === "hold") {
    // S55 — the ambient-drift static: a DECLARED static carries a tiny
    // zStart→zEnd creep (movementForKind); execute it with the standard
    // eased progress, focal-anchored like a zoom so the subject keeps its
    // place while the frame creeps tighter. A TRUE hold (zStart === zEnd —
    // the user's stillness contract, the plan-less defaults) keeps the
    // exact constant-zoom graph, byte-identical to pre-S55.
    if (shot.zEnd > shot.zStart) {
      zExpr = `${fmt(shot.zStart, 4)}+${fmt(shot.zEnd - shot.zStart, 4)}*${p}`;
      xExpr = focalAnchorExpr("x", shot.focal.x);
      yExpr = focalAnchorExpr("y", shot.focal.y);
    } else {
      zExpr = "1";
      xExpr = "iw/2-(iw/zoom)/2";
      yExpr = "ih/2-(ih/zoom)/2";
    }
  } else if (kind === "zoom-in" || kind === "zoom-out") {
    zExpr = `${fmt(shot.zStart, 4)}+${fmt(shot.zEnd - shot.zStart, 4)}*${p}`;
    xExpr = focalAnchorExpr("x", shot.focal.x);
    yExpr = focalAnchorExpr("y", shot.focal.y);
  } else if (kind === "punch") {
    // Fast attack (impact frame the instant the cut lands), then slow creep.
    const attack = Math.max(Math.round(0.45 * fps), 2);
    const a = fmt(shot.zStart, 4);
    const b = fmt(shot.zEnd, 4);
    zExpr = `if(lte(on\\,${attack})\\,${a}+(${fmt(shot.zEnd - shot.zStart, 4)})*on/${attack}\\,${b}+${fmt(0.04, 4)}*(on-${attack})/${Math.max(last - attack, 1)})`;
    xExpr = focalAnchorExpr("x", shot.focal.x);
    yExpr = focalAnchorExpr("y", shot.focal.y);
  } else {
    // Pans/tilts/diagonals: numeric lerp between two clamped window
    // positions (precomputed), constant zoom — diagonals add a faint zoom.
    const z = fmt(shot.zStart, 4);
    const zoomAmp = kind === "diag-tl" || kind === "diag-br" ? Math.min(shot.zEnd - shot.zStart, 0.08) : 0;
    zExpr = zoomAmp > 0 ? `${z}+${fmt(zoomAmp, 4)}*${p}` : z;

    const horiz = kind === "pan-left" || kind === "pan-right" || kind === "diag-tl" || kind === "diag-br";
    const vert = kind === "tilt-up" || kind === "tilt-down" || kind === "diag-tl" || kind === "diag-br";
    const travel = Math.min(Math.max(shot.travel, 0), 1);

    // Sweep away from the focal edge: a face on the right keeps its place
    // while the window glides leftward past it, never off it.
    const dirX: -1 | 1 =
      kind === "pan-left" || kind === "diag-tl"
        ? -1
        : kind === "pan-right" || kind === "diag-br"
          ? 1
          : shot.focal.x > 0.6
            ? -1
            : shot.focal.x < 0.4
              ? 1
              : 1;
    const dirY: -1 | 1 = kind === "tilt-up" || kind === "diag-tl" ? -1 : 1;

    const [x0, x1] = horiz
      ? panEndpoints("x", shot.focal.x, dirX, travel, shot.zStart, work)
      : panEndpoints("x", shot.focal.x, 1, 0, shot.zStart, work);
    const [y0, y1] = vert
      ? panEndpoints("y", shot.focal.y, dirY, travel, shot.zStart, work)
      : panEndpoints("y", shot.focal.y, 1, 0, shot.zStart, work);

    xExpr = `${fmt(x0, 2)}+${fmt(x1 - x0, 2)}*${p}`;
    yExpr = `${fmt(y0, 2)}+${fmt(y1 - y0, 2)}*${p}`;
  }

  return `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=${d}:s=${ow}x${oh}:fps=${fps}`;
}

/**
 * Build the visual filter graph for one scene: the still is supersampled to
 * 2x output, split into N shots, each driven by its own zoompan move, then
 * concat'd — hard camera cuts without extra images — and finished with the
 * grade. A static plan skips zoompan entirely.
 */
export function sceneFilterGraph(opts: {
  dur: number;
  plan: MotionScenePlan;
  settings: MotionSettings;
  fps: number;
  aspect?: Aspect;
  grade?: string;
}): string {
  const { dur, plan, settings, fps, grade = "" } = opts;
  const aspect = opts.aspect ?? "16:9";
  const { work, out } = OUTPUT_SIZES[aspect];
  const [W, H] = work;
  const [ow, oh] = out;
  const totalFrames = Math.max(Math.round(dur * fps), 2);

  const cover = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;

  if (plan.staticImage) {
    return `[0:v]${cover},scale=${ow}:${oh},format=yuv420p${grade ? `,${grade}` : ""}[v]`;
  }

  const shotCount = Math.max(1, Math.min(MAX_SHOTS, plan.shots.length));
  const per = Math.max(Math.floor(totalFrames / shotCount), 2);
  const bounds: number[] = [];
  for (let i = 1; i < shotCount; i++) bounds.push(Math.min(per * i, totalFrames - 1));

  const parts: string[] = [
    `[0:v]${cover},split=${shotCount}${plan.shots.slice(0, shotCount).map((_, i) => `[s${i}]`).join("")}`,
  ];

  let start = 0;
  for (let i = 0; i < shotCount; i++) {
    const end = i < shotCount - 1 ? bounds[i] : totalFrames;
    const frames = Math.max(end - start, 2);
    const shot = plan.shots[Math.min(i, plan.shots.length - 1)];
    const zp = shotZoompan(shot, frames, settings, work, out, fps);
    parts.push(
      `[s${i}]trim=start_frame=${start}:end_frame=${end},setpts=PTS-STARTPTS,${zp},format=yuv420p[v${i}]`
    );
    start = end;
  }

  parts.push(
    `${Array.from({ length: shotCount }, (_, i) => `[v${i}]`).join("")}concat=n=${shotCount}:v=1:a=0[vc]`,
    `[vc]${grade ? grade : "null"}[v]`
  );
  return parts.join(";");
}

// ---------- M2 — multi-image shot graph (docs/director-m1-m2-spec.md §1.7) ----------

/**
 * MotionShot for ONE Director-chosen MoveKind, using the engine's own
 * amplitude conventions (the visible-motion floor, PAN_BASE_ZOOM, the punch
 * attack). Each shot of the M2 path animates a DIFFERENT image, so zooms
 * always start wide at 1 — the wide<->tight re-frame banding of
 * planSceneShots exists to reframe ONE image across cuts, which per-shot
 * images make unnecessary (the cut itself is the re-frame).
 */
/** S55 (T-55.3b — owner option ii of the three on record in
 * docs/audits/s55-render-forensics.md) — the ambient drift a DECLARED
 * static shot executes with: z 1.00→1.03 across the shot. Perceptually
 * still (~1%/s on a 3 s shot) while the pixels move, so the
 * motion-everywhere law keeps catching real freezes without exempting
 * anything. Exported for the tests that pin the law. */
export const STATIC_AMBIENT_DRIFT = 0.03;

export function movementForKind(kind: MoveKind, focal: Focal, intensity: number): MotionShot {
  // The user's stillness contract outranks any shot move: intensity < 1 (or
  // the "off" mode, which the caller maps here too) holds every shot — the
  // Director's CUTS still land (images change), the cameras stay still.
  if (intensity < 1) {
    return { kind: "hold", zStart: 1, zEnd: 1, focal, travel: 0, sec: 3 };
  }
  // S55 — a DECLARED static (the Director's camera vocabulary, motion on)
  // executes as a minimal ambient drift, not a z=1 freeze: the S54 §B
  // anchor's frozen-frames failures were exactly these holds (T-55.1 — a
  // vocabulary/law conflict, not a renderer defect). Creative intent kept,
  // law bright.
  if (kind === "hold") {
    return { kind: "hold", zStart: 1, zEnd: 1 + STATIC_AMBIENT_DRIFT, focal, travel: 0, sec: 3 };
  }
  const amp = Math.max(Math.min(intensity / 100, AMP_CAP), 0.1);
  if (kind === "zoom-in") return { kind, zStart: 1, zEnd: 1 + amp, focal, travel: 0, sec: 3 };
  if (kind === "zoom-out") return { kind, zStart: 1 + amp, zEnd: 1, focal, travel: 0, sec: 3 };
  if (kind === "punch") {
    return {
      kind,
      zStart: 1 + Math.min(Math.max(amp * 2.0, 0.22), 0.36),
      zEnd: 1 + Math.min(Math.max(amp * 0.75, 0.1), 0.16),
      focal,
      travel: 0,
      sec: 3,
    };
  }
  // Pans / tilts / diagonals — PAN_BASE_ZOOM so the sweep reads, 50% travel.
  const z = PAN_BASE_ZOOM(intensity);
  return { kind, zStart: z, zEnd: z, focal, travel: 0.5, sec: 3 };
}

/** One entry of the M2 multi-image graph — a shot execution projected onto
 *  the ffmpeg command. `input` is the index of the `-i` that carries this
 *  shot's still; several shots may share one input (pseudo crops). */
export interface GraphShotInput {
  kind: MoveKind;
  sec: number;
  input: number;
  /** Pseudo-shot crop in 3840x2160 REFERENCE pixels (PSEUDO_CROPS space),
   *  scaled to the actual work canvas by the builder. */
  crop?: { w: number; h: number; x: number; y: number };
  /** Per-shot override of the scene focal (defaults to opts.focal). */
  focal?: Focal;
  /** S48 — per-shot intensity multiplier (Director moveSpeed; 1 = the
   *  video-level motion intensity, the pre-S48 behavior). */
  speed?: number;
  /** S50 — the S48 deferred field, executing: "fade" crossfades THIS shot
   *  into the next ("cut"/absent = the hard concat cut, the pre-S50
   *  behavior). The LAST shot's hand-off is ignored — the scene-level
   *  transitionIn governs scene boundaries. */
  transitionOut?: string;
}

/** PSEUDO_CROPS coordinates are authored against the 16:9 work canvas. */
const CROP_REF: [number, number] = [3840, 2160];

/** Crop chain for one pseudo shot, reference-space → work-canvas, clamped
 *  legal for any aspect (the rect is a framing hint; cover already scaled
 *  the art, so an approximate mapping on 9:16/1:1 is acceptable). */
function cropChain(
  c: { w: number; h: number; x: number; y: number },
  W: number,
  H: number
): string {
  const sx = W / CROP_REF[0];
  const sy = H / CROP_REF[1];
  const w = Math.max(2, Math.min(Math.round(c.w * sx), W));
  const h = Math.max(2, Math.min(Math.round(c.h * sy), H));
  const x = Math.max(0, Math.min(Math.round(c.x * sx), W - w));
  const y = Math.max(0, Math.min(Math.round(c.y * sy), H - h));
  return `crop=${w}:${h}:${x}:${y},`;
}

/** Exact per-shot frame counts: proportional scaling of the planned frame
 *  counts to hit `total` exactly, every shot ≥ 2 frames (largest-remainder
 *  distribution — no shot absorbs the whole rounding drift). */
function fitFrames(raw: number[], total: number): number[] {
  const sum = raw.reduce((a, b) => a + b, 0);
  if (sum <= 0) return raw.map(() => Math.max(2, Math.floor(total / raw.length)));
  const out = raw.map((f) => Math.max(2, Math.round((f / sum) * total)));
  let diff = total - out.reduce((a, b) => a + b, 0);
  const order = out.map((f, i) => [i, f] as const).sort((a, b) => b[1] - a[1]);
  let k = 0;
  while (diff !== 0 && k < total * 4 + 16) {
    const i = order[k % order.length][0];
    const step = Math.sign(diff);
    if (out[i] + step >= 2) {
      out[i] += step;
      diff -= step;
    }
    k++;
  }
  return out;
}

/** S50 — the intra-scene shot hand-off duration (seconds) when the plan asks
 * for transitionOut "fade". Capped at 1/4 of the shorter adjacent shot so a
 * dissolve never eats a beat. Exported for the tests that pin the math. */
export const SHOT_FADE_SEC = 0.4;

/** S50 — the palindrome loop graph (render.ts#ensureSceneLoop executes it):
 * forward + reverse joined, so a clip shorter than its scene loops with NO
 * visible rewind (the raw forward loop's jump-cut every clip-length
 * seconds). The two turning points duplicate one frame each — 33 ms at
 * 30 fps, imperceptible — and looping the palindrome crosses the boundary
 * with a 1-frame step. Exported so the real-ffmpeg test pins the exact graph
 * the renderer runs. */
export const PALINDROME_LOOP_GRAPH =
  "[0:v]split=2[f][r];[r]reverse[rr];[f][rr]concat=n=2:v=1:a=0[v]";

/**
 * M2 — the multi-image scene graph (the spec's ONE real render change).
 * Where sceneFilterGraph splits ONE image into N movement segments, this
 * gives every shot its OWN input image (the scene art for shot 0 and pseudo
 * crops, fresh AI renders for extras), runs each through its own zoompan
 * (d=1, pre-timed — the same shape the single-image graph uses, and the
 * slides compositor's no-looped-demuxer lesson), then joins them. S50: the
 * join honors the plan's per-shot hand-off — "fade" pairs blend through an
 * xfade chain (frame-budget compensated, below), everything else keeps the
 * single hard concat. The frame budget stays EXACT either way: per-shot
 * frame counts (minus the xfade overlaps) sum to round(dur*fps), so the cut
 * points land on the reconciled ShotExecution.sec boundaries and the audio
 * (mixed against the same timeline) never drifts.
 */
export function multiShotSceneGraph(opts: {
  dur: number;
  shots: GraphShotInput[];
  settings: MotionSettings;
  fps: number;
  aspect?: Aspect;
  grade?: string;
  /** Scene-level focal for shots without their own (focalForScene). */
  focal?: Focal;
}): string {
  const { dur, settings, fps, grade = "" } = opts;
  const aspect = opts.aspect ?? "16:9";
  const { work, out } = OUTPUT_SIZES[aspect];
  const [W, H] = work;
  const [ow, oh] = out;
  const totalFrames = Math.max(Math.round(dur * fps), 2);
  const list = opts.shots.slice(0, MAX_SHOTS);
  if (list.length === 0) {
    // Degenerate plan — behave like a static scene rather than emit an
    // empty graph (never a failed render; spec §1.8 floor).
    return `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},scale=${ow}:${oh},format=yuv420p${grade ? `,${grade}` : ""}[v]`;
  }

  // S50 — the per-shot hand-offs: "fade" crossfades into the next shot. The
  // frame-budget law survives the xfade by construction: an xfade OVERLAPS
  // its duration (the pair's output runs `fade` frames shorter), so the trim
  // budget is EXTENDED by exactly the fade total — the visible timeline
  // still lands on round(dur*fps) and the audio never drifts. (S55: the
  // allocation lives in allocateShotFrames so shotGraphJoins — the render→QC
  // boundary contract — executes the SAME math.)
  const { frames, fades } = allocateShotFrames(list, totalFrames, fps);

  const cover = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;

  // One base chain per DISTINCT input; inputs feeding several shots (the
  // scene image behind its pseudo crops) split once.
  const byInput = new Map<number, number[]>(); // input idx → shot positions
  list.forEach((s, i) => {
    const arr = byInput.get(s.input);
    if (arr) arr.push(i);
    else byInput.set(s.input, [i]);
  });
  const parts: string[] = [];
  for (const [input, positions] of byInput) {
    const labels = positions.map((_, j) => `[b${input}_${j}]`);
    parts.push(
      `[${input}:v]${cover}${
        positions.length > 1 ? `,split=${positions.length}${labels.join("")}` : labels[0]
      }`
    );
  }

  list.forEach((s, i) => {
    // byInput is grouped from this same list — a miss is a broken invariant.
    const pos = must(`positions for input ${s.input}`, byInput.get(s.input)).indexOf(i);
    // S48: the shot's own focal anchor + speed multiplier ride verbatim —
    // absent values keep the scene focal + video intensity exactly.
    const shot = movementForKind(
      s.kind,
      s.focal ?? opts.focal ?? FOCAL_CENTER,
      shotIntensity(settings.intensity, s.speed)
    );
    const zp = shotZoompan(shot, frames[i], settings, work, out, fps, 1);
    parts.push(
      `[b${s.input}_${pos}]${s.crop ? cropChain(s.crop, W, H) : ""}trim=end_frame=${frames[i]},setpts=PTS-STARTPTS,${zp},format=yuv420p[v${i}]`
    );
  });

  if (fades.every((f) => f === 0)) {
    // The pre-S50 join: one hard concat, byte-identical.
    parts.push(
      `${list.map((_, i) => `[v${i}]`).join("")}concat=n=${list.length}:v=1:a=0[vc]`,
      `[vc]${grade ? grade : "null"}[v]`
    );
    return parts.join(";");
  }

  // S50 — the mixed join: fade pairs blend through xfade, cut pairs concat.
  // accLen tracks the accumulated OUTPUT frames (xfade consumes its overlap)
  // so every xfade offset lands exactly where the pair meets.
  let accLen = frames[0];
  let acc = "[v0]";
  for (let k = 1; k < list.length; k++) {
    const f = fades[k - 1];
    const outLabel = k === list.length - 1 ? "[vc]" : `[x${k}]`;
    if (f > 0) {
      const offset = (accLen - f) / fps;
      parts.push(
        `${acc}[v${k}]xfade=transition=fade:duration=${fmt(f / fps, 4)}:offset=${fmt(Math.max(offset, 0), 4)}${outLabel}`
      );
      accLen = accLen - f + frames[k];
    } else {
      parts.push(`${acc}[v${k}]concat=n=2:v=1:a=0${outLabel}`);
      accLen += frames[k];
    }
    acc = outLabel;
  }
  // Invariant: accLen === totalFrames (the audio-sync law).
  parts.push(`[vc]${grade ? grade : "null"}[v]`);
  return parts.join(";");
}

/** Unused-import guard: FOCAL_CENTER is exported for tests. */
export { FOCAL_CENTER };

/** S55 (T-55.3a) — one intra-scene shot join on the scene-LOCAL clock (the
 * segment's own timeline, before the stitch shifts it onto the blended
 * clock). `fadeSec` 0 = the hard-concat flip; > 0 = the xfade hand-off
 * (SHOT_FADE_SEC), with `at` = the xfade offset. */
export interface ShotJoinMark {
  at: number;
  fadeSec: number;
}

/** S55 (T-55.3a) — the M2 shot graph's own boundaries, frame-exact by
 * construction: the SAME fitted allocation multiShotSceneGraph executes
 * (shared allocateShotFrames), walked with the same accumulator the join
 * loop uses, so the marks can never drift from the rendered graph. The
 * render→QC contract books these (expectedCutsForTimeline) so the
 * cut-alignment lens stops reading the graph's own flips as "unexpected"
 * (T-55.2: the expectation was incomplete, not the render). */
export function shotGraphJoins(opts: {
  dur: number;
  shots: GraphShotInput[];
  fps: number;
}): ShotJoinMark[] {
  const totalFrames = Math.max(Math.round(opts.dur * opts.fps), 2);
  const list = opts.shots.slice(0, MAX_SHOTS);
  if (list.length < 2) return [];
  const { frames, fades } = allocateShotFrames(list, totalFrames, opts.fps);
  const joins: ShotJoinMark[] = [];
  // accLen tracks the accumulated OUTPUT frames — the same walk the xfade
  // chain performs, so every join lands exactly where the graph puts it.
  let accLen = frames[0];
  for (let k = 1; k < list.length; k++) {
    const f = fades[k - 1];
    if (f > 0) {
      joins.push({ at: Math.max((accLen - f) / opts.fps, 0), fadeSec: f / opts.fps });
      accLen = accLen - f + frames[k];
    } else {
      joins.push({ at: accLen / opts.fps, fadeSec: 0 });
      accLen += frames[k];
    }
  }
  return joins;
}

/** S55 — the fitted per-shot frame allocation + re-capped fades, extracted
 * VERBATIM from multiShotSceneGraph so the graph and shotGraphJoins (the
 * render→QC boundary contract) can never disagree about where a join sits.
 * Output invariant: Σframes − Σfades === totalFrames (the audio-sync law). */
function allocateShotFrames(
  list: GraphShotInput[],
  totalFrames: number,
  fps: number
): { frames: number[]; fades: number[] } {
  const wantsFade = (i: number) =>
    i >= 0 && i < list.length - 1 && list[i].transitionOut === "fade";
  const fadeRaw = list.map((s, i) =>
    wantsFade(i)
      ? Math.max(
          2,
          Math.round(
            Math.min(
              SHOT_FADE_SEC,
              Math.min(Math.max(s.sec, 0.01), Math.max(list[i + 1].sec, 0.01)) / 4
            ) * fps
          )
        )
      : 0
  );
  const fadeTotal = fadeRaw.reduce((a, b) => a + b, 0);

  const secs = list.map((s) => Math.max(s.sec, 0.01));
  const frames = fitFrames(secs, totalFrames + fadeTotal);
  // Re-cap the fades against the FITTED allocation (a rounding edge could
  // fit a neighbor tighter than its raw seconds) and pay any debt back from
  // the largest shots so the OUTPUT total stays exactly totalFrames:
  // output = Σframes − Σfades.
  let debt = 0;
  const fades = fadeRaw.map((f, i) => {
    if (f <= 0) return 0;
    const cap = Math.floor(Math.min(frames[i], frames[i + 1]) / 4);
    const v = Math.min(f, cap);
    debt += f - v;
    return v;
  });
  if (debt > 0) {
    const bySize = frames.map((f, i) => [f, i] as const).sort((a, b) => b[0] - a[0]);
    for (let g = 0; debt > 0 && g < bySize.length * 4; g++) {
      const i = bySize[g % bySize.length][1];
      if (frames[i] > 2) {
        frames[i] -= 1;
        debt -= 1;
      }
    }
  }
  return { frames, fades };
}
/**
 * zoompan segment builder shared with the slides compositor — slides feed a
 * SINGLE still frame and let zoompan `d` emit the whole shot, which avoids
 * the looped-image demuxer entirely (large looped PNGs deadlock this ffmpeg
 * build's teardown). Exported so the shot math stays in one place.
 */
export { shotZoompan as zoompanForShot };

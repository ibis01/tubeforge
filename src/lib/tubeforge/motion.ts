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

// ---------- settings ----------

export type MotionMode = "smart" | "zoom" | "pan" | "off";
export type MotionCurve = "smooth" | "linear";
export type Aspect = "16:9" | "9:16";

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

const MOTION_MODE_IDS: readonly string[] = MOTION_MODES.map((m) => m.id);
const MOTION_CURVE_IDS: readonly string[] = MOTION_CURVES.map((c) => c.id);

/** Coerce anything (API body, DB row) into a valid MotionSettings. */
export function sanitizeMotion(raw: {
  mode?: unknown;
  intensity?: unknown;
  curve?: unknown;
  vary?: unknown;
} | null | undefined): MotionSettings {
  const mode = MOTION_MODE_IDS.includes(String(raw?.mode))
    ? (String(raw?.mode) as MotionMode)
    : MOTION_DEFAULTS.mode;
  const n = Number(raw?.intensity);
  const intensity = Number.isFinite(n)
    ? Math.round(Math.min(Math.max(n, 0), 30))
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

/**
 * Where the eye must stay. Priority: the storyboard LLM's explicit "focal"
 * token > composition keywords in the visual prompt > center.
 * Faces sit slightly above frame center (eyes on the upper third).
 */
export function focalForScene(scene: Scene): Focal {
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
  | "hold"; // static frame

export interface MotionShot {
  kind: MoveKind;
  zStart: number;
  zEnd: number; // == zStart for pans/tilts
  focal: Focal; // point locked in frame for this shot
  travel: number; // 0..1 fraction of max window travel (pans/tilts/diags)
  sec: number; // target seconds for this shot
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
  hold: "Static hold",
};

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

const flipPan = (k: MoveKind): MoveKind =>
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

  const amp = Math.min((intensity / 100) * AMP_SCALE[kind], AMP_CAP);
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
    let a = mandatory.amp;

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
  const to = Math.min(Math.max(from + dir * travel * maxTravel, lo), hi);
  return [from, to];
}

/** zoompan filter segment for one shot. */
function shotZoompan(
  shot: MotionShot,
  frames: number,
  settings: MotionSettings,
  work: [number, number],
  out: [number, number],
  fps: number
): string {
  const last = Math.max(frames - 1, 1);
  const p = progressExpr(settings.curve, last);
  const [ow, oh] = out;
  const { kind } = shot;

  let zExpr: string;
  let xExpr: string;
  let yExpr: string;

  if (kind === "hold") {
    zExpr = "1";
    xExpr = "iw/2-(iw/zoom)/2";
    yExpr = "ih/2-(ih/zoom)/2";
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

  return `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=1:s=${ow}x${oh}:fps=${fps}`;
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

/** Unused-import guard: FOCAL_CENTER is exported for tests. */
export { FOCAL_CENTER };

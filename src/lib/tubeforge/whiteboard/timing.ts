// S64 — the Whiteboard Engine: narration timing, draw scheduling, and the
// frame plan. PURE — the deterministic heart the renderer merely applies.
//
// Laws:
//   - Narration rules the clock: a scene's duration is its VO file's
//     measured length when one exists, else the house 2.6-wps estimate
//     (the same constant the director lane uses), clamped to [4s, 30s].
//   - Drawing fills the narration window: after a lead-in (400ms) every
//     drawable path gets a length-weighted slice of the draw budget; the
//     scene closes on a hold (900ms) so the last stroke can breathe.
//   - The frame plan is a pure function of (project, assets, durations):
//     same inputs, same frames — the determinism the S64 record froze.
import {
  pathSegments,
  sampleAtLength,
  totalLength,
  transformPoint,
  type PathSegment,
  type Placement,
} from "./svg";
import {
  BOARD_EXIT_DEFAULT_MS,
  type AnimationEvent,
  type BoardExit,
  type BoardPolicy,
  type WhiteboardProject,
  type WhiteboardScene,
} from "./storyboard";
// Type-only: erased at runtime, so the timing ← assets cycle cannot exist
// (assets.ts imports this module's text registries at init).
import type { AssetRole, HandPose } from "./assets";
// P0 — the traced-placement budgets (pure constants; no cycle: trace-budget
// imports nothing).
import { WB_TRACED_FADE_MS, tracedCapForWindow } from "./trace-budget";

/** The house narration pace (words/sec) — the director lane's constant. */
export const WORDS_PER_SEC = 2.6;
export const LEAD_IN_MS = 400;
export const HOLD_END_MS = 900;
// W2: exported for beat-plan.ts — the beat compiler reuses the fill law's
// arithmetic (ONE scheduler's numbers; never a second implementation).
export const PATH_GAP_MS = 130; // pen lift between strokes
export const MIN_PATH_MS = 260; // even a dot takes a moment
export const MAX_PATH_MS = 2600; // even a long contour stays snappy
export const MS_PER_CHAR = 55; // text writing speed

// S139 — the naturalist pen laws.

/** The eased within-stroke progress (sine-in-out): the pen accelerates
 *  out of each stroke's start and settles into its end — constant-speed
 *  dash fronts read robotic; every reference engine eases per stroke.
 *  Endpoints exact (p=0→0, p=1→1): schedules, carried ink and the QC
 *  envelopes are untouched. THE one progress both the ink front and the
 *  hand ride (the lockstep law — the hand may never lead or trail the
 *  ink it is laying down). */
export function penProgress(p: number): number {
  const c = Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : 0;
  // 4dp quantization: sub-pixel on any board (1000-unit stroke → 0.1-unit
  // steps), byte-stable across machines, and the mid-stroke half point
  // stays EXACTLY 0.5 (the wire-format pins ride through unchanged).
  return Math.round((0.5 - 0.5 * Math.cos(Math.PI * c)) * 10000) / 10000;
}

/** The hand's micro-tremble: two sines perpendicular to the stroke
 *  tangent (the 7.3:3 ratio pair the reference study credits), wrapped
 *  in sin(π·u) so the amplitude is ZERO at stroke ends, phase advanced
 *  by the golden angle per stroke ordinal — deterministic, never loops
 *  visibly. Scene units on the 1920-wide board. */
export const HAND_TREMBLE_SCALE = 1.15;
export function handTrembleOffset(u: number, ordinal: number): number {
  const p = Number.isFinite(u) ? Math.max(0, Math.min(1, u)) : 0;
  if (p <= 0 || p >= 1) return 0; // exact endpoints — floating π residue never leaks
  const wrap = Math.sin(Math.PI * p);
  if (wrap <= 0) return 0;
  const ph = 2.399963 * ordinal;
  const o1 = Math.sin(2 * Math.PI * 7.3 * p + ph) * 1.8;
  const o2 = Math.sin(2 * Math.PI * 3.0 * p + ph * 1.7) * 0.7;
  return (o1 + o2) * wrap * HAND_TREMBLE_SCALE;
}

/** The pen-width breathing mirror constant — the applier multiplies the
 *  authored stroke-width by (0.78 + 0.22·sin(π·progress)) so the ink
 *  swells mid-stroke like real marker pressure. The SAME arithmetic is
 *  embedded in wb-page.ts's applier string (one formula, two riders —
 *  pinned together). */
export const PEN_WIDTH_BREATHE = { base: 0.78, amp: 0.22 } as const;

export interface AssetGeometry {
  /** Flattened segments per drawable path id. */
  paths: Map<string, PathSegment[]>;
  /** Total path length per asset. */
  totalLen: number;
}

/** Estimated scene duration from narration (ms). */
export function estimateNarrationMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.round(Math.max(4000, Math.min(30_000, (words / WORDS_PER_SEC) * 1000)));
}

/** Effective scene duration: explicit > VO-provided > estimated. The
 *  caller supplies measured VO durations (renderer-side ffprobe); this
 *  module stays pure. */
export function sceneDurationMs(scene: WhiteboardScene, voMs: number | null): number {
  if (scene.durationMs && scene.durationMs > 0) return Math.round(scene.durationMs);
  if (voMs && voMs > 0) return Math.round(voMs + 350); // small tail for the last stroke
  return estimateNarrationMs(scene.narration);
}

// ---------------------------------------------------------------------------
// W4 — word anchors (S120 §3 W4): the ASR/captions lane's per-word timing,
// passed as an INPUT to the scheduler — never a doc field (the
// compile-only law: the validator and the serializer never see it).
// ---------------------------------------------------------------------------

/** One word's spoken span. `index` is the word's position in the scene's
 *  narration (0-based, the SAME tokenization the beat compiler's `words()`
 *  uses) — the captions lane's contract, enforced by the envelope's
 *  validation below. */
export interface WordAnchor {
  index: number;
  startMs: number;
  endMs: number;
}

export interface WordAnchors {
  byWord: WordAnchor[];
}

/** Validate + collapse anchors to their envelope [firstStart, lastEnd].
 *  Returns null when the anchors are absent or DEGENERATE (empty spans,
 *  non-monotonic indexes, negative starts, an envelope past the scene
 *  clock) — the caller then schedules exactly as if no anchors existed
 *  (the tolerant-read law: misheard ASR degrades to the estimator, it
 *  never corrupts the schedule). */
export function anchorEnvelope(
  anchors: WordAnchors | undefined,
  durationMs = Number.POSITIVE_INFINITY
): { startMs: number; endMs: number } | null {
  if (!anchors || anchors.byWord.length === 0) return null;
  const sorted = [...anchors.byWord].sort((a, b) => a.index - b.index);
  let prevIndex = -1;
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;
  for (const w of sorted) {
    if (!Number.isFinite(w.startMs) || !Number.isFinite(w.endMs)) return null;
    if (w.endMs < w.startMs) return null;
    if (w.index <= prevIndex) return null; // duplicate or unordered indexes
    prevIndex = w.index;
    if (w.startMs < startMs) startMs = w.startMs;
    if (w.endMs > endMs) endMs = w.endMs;
  }
  if (!(endMs > startMs) || startMs < 0 || endMs > durationMs) return null;
  return { startMs: Math.round(startMs), endMs: Math.round(endMs) };
}

/**
 * Schedule a scene: fill in animation events for every drawable path and
 * text element the placements bring, in draw order, inside the narration
 * window. Pre-existing events for an element are RESPECTED (the editor's
 * explicit timing is senior — the studio's precedence law).
 *
 * P0 — `opts` carries the traced-placement cap split (built by
 * tracedSplitForScene): over-cap paths of traced assets never become draw
 * events (the fill law cannot fit them — they would schedule past the
 * scene clock and stay invisible forever); instead they fade in as a
 * group at the stroke-completion boundary through the EXISTING
 * reveal_color grammar (no new event type). Absent opts → byte-for-byte
 * today's schedule (the fallback law).
 */
export interface SceneScheduleOpts {
  /** assetId → the path ids allowed to DRAW (first-cap, draw order). */
  allowed?: ReadonlyMap<string, ReadonlySet<string>>;
  /** "assetId::pathId" keys that fade-reveal at the boundary. */
  remainder?: readonly string[];
}

export function scheduleScene(
  scene: WhiteboardScene,
  durationMs: number,
  geometry: Map<string, AssetGeometry>,
  anchors?: WordAnchors,
  opts?: SceneScheduleOpts
): AnimationEvent[] {
  const events: AnimationEvent[] = [];
  const claimed = new Set<string>(); // "assetId::pathId" / "assetId::text:textId" / "assetId::color[:pathId]"
  for (const e of scene.animations) {
    if (e.type === "draw_path") claimed.add(`${e.assetId}::${e.pathId}`);
    else if (e.type === "write_text") claimed.add(`${e.assetId}::text:${e.textId}`);
    else if (e.type === "reveal_color") claimed.add(`${e.assetId}::color${e.pathId ? ":" + e.pathId : ""}`);
    events.push(e);
  }

  // Collect work items in (placement order × asset draw order).
  interface Work {
    kind: "path" | "text";
    assetId: string;
    id: string;
    weight: number; // relative cost
  }
  // S139 — the sketch pass's derived strokes ride the same window with
  // their own cost laws: a retrace (-od) moves faster than its main
  // stroke (the pen re-traces with confidence, not care), and a hatch
  // (-h) scribbles quicker still. Weights keep the window arithmetic
  // one-law: only the cost model changes.
  const derivedFactor = (id: string): number =>
    id.endsWith("-od") ? 0.45 : id.endsWith("-h") ? 0.55 : 1;
  const work: Work[] = [];
  const ordered = [...scene.placements].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const pl of ordered) {
    const geo = geometry.get(pl.assetId);
    if (!geo) continue;
    // P0 — the traced cap: over-cap paths are the fade remainder (they are
    // EXCLUDED from the work list here, revealed by the boundary fade below).
    const allowedSet = opts?.allowed?.get(pl.assetId);
    for (const [pathId, segs] of geo.paths) {
      if (claimed.has(`${pl.assetId}::${pathId}`)) continue;
      if (allowedSet && !allowedSet.has(pathId)) continue;
      const len = totalLength(segs) * pl.placement.scale;
      work.push({ kind: "path", assetId: pl.assetId, id: pathId, weight: Math.max(120, len) * derivedFactor(pathId) });
    }
    const texts = TEXT_IDS_BY_ASSET.get(pl.assetId) ?? [];
    for (const textId of texts) {
      if (claimed.has(`${pl.assetId}::text:${textId}`)) continue;
      const chars = TEXT_CHARS_BY_ID.get(`${pl.assetId}::${textId}`) ?? 12;
      work.push({ kind: "text", assetId: pl.assetId, id: textId, weight: 40 * chars });
    }
  }
  if (work.length === 0) return events;

  // Budget: the draw window minus lead-in/hold/gaps. W4: when word
  // anchors are present AND sane, the draw fills the SPOKEN window
  // [firstWord.start, lastWord.end] — the strokes land on the words that
  // introduce them, and the hold extends to the scene clock's own edge.
  // Absent/degenerate anchors → today's nominal window, byte-for-byte.
  const spoken = anchorEnvelope(anchors, durationMs);
  const winStart = spoken ? spoken.startMs : LEAD_IN_MS;
  const winEnd = spoken ? spoken.endMs : durationMs - HOLD_END_MS;
  // S139 — sparse boards breathe: a scene with ≤3 strokes is a big-draw
  // scene, and its pen lifts carry a beat longer (the robotic-constant-
  // gap receipt). Dense boards keep the tight 130ms cadence.
  const gapMs = work.length > 0 && work.length <= 3 ? PATH_GAP_MS + 90 : PATH_GAP_MS;
  const gaps = gapMs * Math.max(0, work.length - 1);
  const avail = Math.max(1200, winEnd - winStart - gaps);
  const totalWeight = work.reduce((a, w) => a + w.weight, 0);
  // Raw durations: weight-shared ideals, snappiness-clamped; texts ride
  // their character-count model.
  let rawSum = 0;
  const raw: number[] = work.map((w) => {
    const ideal = (w.weight / totalWeight) * avail;
    const d =
      w.kind === "path"
        ? Math.max(MIN_PATH_MS, Math.min(MAX_PATH_MS, ideal))
        : Math.max(500, (TEXT_CHARS_BY_ID.get(`${w.assetId}::${w.id}`) ?? 12) * MS_PER_CHAR);
    rawSum += d;
    return d;
  });
  // The fill law (the S64 QC receipts): scale uniformly so the draw span
  // ENDS at the window's right edge (nominal: durationMs − HOLD_END_MS;
  // W4: the last spoken word's end) — capped raw schedules finished 3–6s
  // early, and the static tails failed frozen-frames/static-shots.
  const f = rawSum > 0 ? Math.min(2.8, Math.max(0.5, avail / rawSum)) : 1;
  let t = winStart;
  work.forEach((w, i) => {
    const durationMs = Math.max(120, Math.round(raw[i] * f));
    if (w.kind === "path") {
      events.push({ type: "draw_path", assetId: w.assetId, pathId: w.id, startMs: Math.round(t), durationMs });
    } else {
      events.push({ type: "write_text", assetId: w.assetId, textId: w.id, startMs: Math.round(t), durationMs });
    }
    t += durationMs + gapMs;
  });
  // P0 — the completion-boundary fade: the over-cap remainder of traced
  // placements reveals through the EXISTING reveal_color grammar (per-path;
  // the applier drives opacity for the marked stroke elements). The fade
  // starts when the last drawn stroke finishes and never outlasts the
  // scene clock. Explicit author events stay senior: a remainder path the
  // author already scheduled is not faded twice.
  const fadeKeys = (opts?.remainder ?? []).filter((k) => !claimed.has(k));
  if (fadeKeys.length > 0) {
    const boundary = Math.min(t - gapMs, durationMs);
    const fadeStart = Math.max(0, Math.min(boundary, durationMs - WB_TRACED_FADE_MS));
    for (const key of fadeKeys) {
      const sep = key.indexOf("::");
      events.push({
        type: "reveal_color",
        assetId: key.slice(0, sep),
        pathId: key.slice(sep + 2),
        startMs: Math.round(fadeStart),
        durationMs: WB_TRACED_FADE_MS,
      });
    }
  }
  return events.sort((a, b) => a.startMs - b.startMs);
}

// ---------------------------------------------------------------------------
// P0 — the traced-placement cap split (the one source the schedulers AND
// both surfaces read; one derivation, so the fade keys the setup pre-hides
// are byte-identical to the keys the scheduler excludes).
// ---------------------------------------------------------------------------

/** The draw window (the fill law's envelope) — extracted so the split
 * below computes the SAME window scheduleScene schedules inside. */
export function drawWindow(durationMs: number, anchors?: WordAnchors): { startMs: number; endMs: number } {
  const spoken = anchorEnvelope(anchors, durationMs);
  return {
    startMs: spoken ? spoken.startMs : LEAD_IN_MS,
    endMs: spoken ? spoken.endMs : durationMs - HOLD_END_MS,
  };
}

export interface TracedPlacementSplit {
  /** assetId → the path ids allowed to DRAW (first-cap, draw order). */
  allowed: Map<string, Set<string>>;
  /** "assetId::pathId" keys the boundary fade reveals. */
  remainder: string[];
}

/** The cap split for one scene's traced placements: assets tagged
 * "traced" draw at most tracedCapForWindow(window) strokes per placement
 * (the fill law's honest arithmetic); the rest are the fade remainder.
 * Returns null when no traced placement overflows — every caller takes
 * the byte-for-byte legacy path (the fallback law). PURE + deterministic. */
export function tracedSplitForScene(
  scene: WhiteboardScene,
  geometry: Map<string, AssetGeometry>,
  assetTags: ReadonlyMap<string, readonly string[]> | undefined,
  durationMs: number,
  anchors?: WordAnchors
): TracedPlacementSplit | null {
  const win = drawWindow(durationMs, anchors);
  const winMs = Math.max(1200, win.endMs - win.startMs);
  const capped = new Set<string>();
  for (const pl of scene.placements) {
    const tags = assetTags?.get(pl.assetId);
    if (tags && tags.includes("traced")) capped.add(pl.assetId);
  }
  if (capped.size === 0) return null;
  const allowed = new Map<string, Set<string>>();
  const remainder: string[] = [];
  for (const assetId of capped) {
    const geo = geometry.get(assetId);
    if (!geo) continue;
    const cap = tracedCapForWindow(winMs);
    const keep = new Set<string>();
    let n = 0;
    for (const pathId of geo.paths.keys()) {
      if (n < cap) {
        keep.add(pathId);
        n++;
      } else {
        remainder.push(`${assetId}::${pathId}`);
      }
    }
    allowed.set(assetId, keep);
  }
  if (remainder.length === 0) return null; // every traced asset fits the window
  return { allowed, remainder };
}

// Filled by assets.ts at module init (the asset library is static data —
// the pure scheduler needs its text lengths without touching markup).
export const TEXT_IDS_BY_ASSET = new Map<string, string[]>();
export const TEXT_CHARS_BY_ID = new Map<string, number>();

// ---------------------------------------------------------------------------
// The frame plan
// ---------------------------------------------------------------------------

export interface FrameHandState {
  visible: boolean;
  /** Scene-space point of the pen tip. */
  x: number;
  y: number;
  /** Pen rotation (radians) — path tangent + placement rotation. */
  angle: number;
  /** W7 — the pose: which hand sub-asset the page shows (write/draw ride
   *  the style hand; point/circle ride hand-point; rest rides hand-rest). */
  pose: HandPose;
  /** W7 — per-frame scale multiplier (the pen-lift breathe; 1 = none).
   *  The applier multiplies it with the project's hand.scale. */
  scale: number;
}

export interface FrameCameraState {
  cx: number;
  cy: number;
  scale: number;
}

export interface FrameState {
  /** Scene-relative time (ms). */
  tMs: number;
  /** pathId → draw progress 0..1, keyed "assetId::pathId". */
  draws: Map<string, number>;
  /** textId → write progress 0..1, keyed "assetId::text:textId". */
  texts: Map<string, number>;
  /** assetId (+"::"+pathId) → color reveal progress 0..1. */
  colors: Map<string, number>;
  /** assetId → animated placement (move_object applied). */
  placements: Map<string, Placement>;
  /** W6 — the carried-ink layer (null = clean scene, no carry). The
   *  carried ink rides the SAME maps above (injected fully drawn), so the
   *  page's one applier needs no second machinery. */
  carried: CarriedFrameLayer | null;
  hand: FrameHandState;
  camera: FrameCameraState;
}

function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** The permanent gentle camera drift (a two-axis Lissajous, PURE and
 *  deterministic). Whiteboard ink growth is spatially tiny — a stroke
 *  extending one pixel per frame reads as a frozen frame to the house QC
 *  lenses, which are calibrated on cinematic FULL-FRAME motion (the slides
 *  mode survives them via constant zoompan). The drift keeps every frame
 *  alive; it swells ×3 while the canvas is still empty (the scene-open
 *  receipts: the freeze runs sat exactly on thin-ink scene starts) and
 *  settles to ±32px once the drawing is established. */
export function cameraDrift(tMs: number): { dx: number; dy: number } {
  const settle = 1 + 2 * Math.max(0, 1 - tMs / 4500);
  return {
    dx: 32 * settle * Math.sin((2 * Math.PI * tMs) / 3400),
    dy: 22 * settle * Math.sin((2 * Math.PI * tMs) / 5300 + 1.3),
  };
}

/** The DIRECTED lane's motion floor (W5). The QC lenses are calibrated on
 *  FULL-FRAME motion — a static camera starves them even while strokes
 *  draw (the W5 proof receipts: a fully-static directed camera failed
 *  frozen-frames at thin-ink stretches; a slower breath starved the
 *  noise floor at 0.3px/frame). So the motion floor is the SAME
 *  calibrated Lissajous the fallback uses — but its MEANING differs by
 *  lane: for a cameraless scene it is the blind absolute wander; for a
 *  keyed scene it is CONTENT-ANCHORED — it breathes around whatever the
 *  director framed (the keys lead, the floor follows). The demotion is
 *  real in the only sense that matters: the camera now goes where the
 *  CONTENT says, and the calibrated micro-motion can no longer wander
 *  away from it. */
export function directedBreath(tMs: number): { dx: number; dy: number } {
  return cameraDrift(tMs);
}

/** Interpolate the camera at scene time t (ms). S68: the empty-camera
 *  fallback centers on the PROJECT's own dimensions — the hardcoded 16:9
 *  center (960, 540) put a 9:16 board's viewport at its right edge (cx 960
 *  of a 1080-wide canvas). The validator leaves cameraless docs EMPTY and
 *  this fallback covers them, so stored docs and in-memory scenes agree.
 *
 *  W5 — the drift demotion (landed in the same slice as the director,
 *  camera-director.ts): the permanent Lissajous drift is the
 *  NO-CAMERA-KEYS fallback ONLY. A scene carrying camera keys — the
 *  content-driven director's or the author's — rides them with NO drift:
 *  the content decides where the camera looks. A cameraless scene keeps
 *  today's behavior byte-for-byte (the W1 baseline pin: the drift is
 *  load-bearing for the QC frozen-frame/static-shot lenses). */
export function cameraAt(
  scene: WhiteboardScene,
  width: number,
  height: number,
  tMs: number
): FrameCameraState {
  const keys = scene.camera.length > 0
    ? scene.camera
    : [{ cx: width / 2, cy: height / 2, scale: 1, startMs: 0, durationMs: 0 }];
  let state = { cx: keys[0].cx, cy: keys[0].cy, scale: keys[0].scale };
  for (let i = 1; i < keys.length; i++) {
    const k = keys[i];
    if (tMs < k.startMs) break;
    const prev = keys[i - 1];
    const span = Math.max(1, k.durationMs);
    const u = Math.max(0, Math.min(1, (tMs - k.startMs) / span));
    const e = easeInOut(u);
    state = {
      cx: prev.cx + (k.cx - prev.cx) * e,
      cy: prev.cy + (k.cy - prev.cy) * e,
      scale: prev.scale + (k.scale - prev.scale) * e,
    };
  }
  if (scene.camera.length === 0) {
    const drift = cameraDrift(tMs);
    return { cx: state.cx + drift.dx, cy: state.cy + drift.dy, scale: state.scale };
  }
  // W5: a keyed scene rides the DIRECTED lane's own motion floor — the
  // breathing around the content framing (NOT the fallback drift).
  const breath = directedBreath(tMs);
  return { cx: state.cx + breath.dx, cy: state.cy + breath.dy, scale: state.scale };
}

// ---------------------------------------------------------------------------
// W6 — the carried-ink layer (S120 §3): a continuous scene inherits the
// previous scene's ink as DATA — the carry plan is resolved from the
// PREVIOUS SCENE's placements (move_object applied at its end clock) and
// rides the SAME frame maps the scene's own strokes use (draws/texts/
// colors), so the page's one applier carries it with zero new machinery.
// ---------------------------------------------------------------------------

/** The carried ink PLAN for one scene (fixed for the scene's duration). */
export interface CarriedInkPlan {
  /** Carried placements keyed by the REAL assetId (a carried asset cannot
   *  be re-placed — the validator pins that), each resolved to its
   *  END-OF-PREVIOUS-SCENE placement. */
  placements: Map<string, Placement>;
  /** The previous scene's reveal_color state at ITS end clock (key →
   *  progress), so fills carry AS SEEN. */
  colors: Map<string, number>;
  exit: BoardExit;
  transitionMs: number;
}

/** The shared exit state, precomputed per frame (the applier stays dumb). */
export interface CarriedExitState {
  /** fade: 1 → 0. */
  opacity: number;
  /** erase: the un-draw progress 0 → 1 (the dash law runs backwards). */
  erase: number;
  /** pan-away offset in scene units (dx negative = off the left edge). */
  dx: number;
  dy: number;
}

/** The carried layer of one frame (null = this scene carries nothing). */
export interface CarriedFrameLayer {
  placements: Map<string, Placement>;
  exit: CarriedExitState;
}

/** pan-away slides the layer by this multiple of the board width — two
 *  widths clear any sane placement (content fully on-board, the studio's
 *  and planner's invariant) without needing geometry at exit time. */
const PAN_AWAY_BOARD_WIDTHS = 2;

/**
 * Resolve what scene K+1 inherits from scene K, PURE. `prevDurationMs` is
 * the clock the previous scene actually ran (the estimator's clamped
 * value — the same one the render loop and the editor preview use).
 * Returns null for clean boards (the caller schedules exactly as before).
 */
export function resolveCarriedInk(
  prev: WhiteboardScene,
  prevDurationMs: number,
  board: BoardPolicy
): CarriedInkPlan | null {
  if (board.mode !== "continuous") return null;
  const wanted =
    board.carryPlacements && board.carryPlacements.length > 0
      ? new Set(board.carryPlacements)
      : null; // null = every placement carries
  const placements = new Map<string, Placement>();
  for (const pl of prev.placements) {
    if (wanted && !wanted.has(pl.assetId)) continue;
    // The END-OF-PREVIOUS-SCENE placement: move_object runs to completion
    // (placementAt clamps progress at the scene's own clock).
    placements.set(pl.assetId, placementAt(prev, pl.assetId, pl.placement, prevDurationMs));
  }
  const colors = new Map<string, number>();
  for (const e of prev.animations) {
    if (e.type !== "reveal_color") continue;
    const p = Math.max(0, Math.min(1, (prevDurationMs - e.startMs) / e.durationMs));
    if (p <= 0) continue;
    if (wanted && !wanted.has(e.assetId)) continue;
    colors.set(`${e.assetId}${e.pathId ? "::" + e.pathId : ""}`, p);
  }
  return {
    placements,
    colors,
    exit: board.exit ?? "keep",
    transitionMs: board.transitionMs ?? BOARD_EXIT_DEFAULT_MS,
  };
}

/**
 * The exit state at scene time t (PURE, deterministic, continuous at both
 * joints): fade unweights opacity, erase un-draws (dashoffset runs from 0
 * back to each stroke's length — the ink retreats along the stroke),
 * pan-away slides the layer off the left edge. All eased with the SAME
 * easeInOut the camera and move_object ride — one easing vocabulary.
 */
export function carriedExitAt(
  plan: CarriedInkPlan,
  width: number,
  tMs: number
): CarriedExitState {
  if (plan.exit === "keep") return { opacity: 1, erase: 0, dx: 0, dy: 0 };
  const u = Math.max(0, Math.min(1, tMs / Math.max(1, plan.transitionMs)));
  if (u >= 1) {
    switch (plan.exit) {
      case "fade": return { opacity: 0, erase: 0, dx: 0, dy: 0 };
      case "erase": return { opacity: 1, erase: 1, dx: 0, dy: 0 };
      default: return { opacity: 1, erase: 0, dx: -width * PAN_AWAY_BOARD_WIDTHS, dy: 0 };
    }
  }
  const e = easeInOut(u);
  switch (plan.exit) {
    case "fade": return { opacity: 1 - e, erase: 0, dx: 0, dy: 0 };
    case "erase": return { opacity: 1, erase: e, dx: 0, dy: 0 };
    default: return { opacity: 1, erase: 0, dx: -width * PAN_AWAY_BOARD_WIDTHS * e, dy: 0 };
  }
}

/** Placement at time t with move_object animations applied. */
export function placementAt(
  scene: WhiteboardScene,
  assetId: string,
  base: Placement,
  tMs: number
): Placement {
  let pl = { ...base };
  for (const e of scene.animations) {
    if (e.type !== "move_object" || e.assetId !== assetId) continue;
    const u = Math.max(0, Math.min(1, (tMs - e.startMs) / e.durationMs));
    if (u <= 0) continue;
    const w = easeInOut(u);
    pl = {
      x: pl.x + (e.to.x - pl.x) * w,
      y: pl.y + (e.to.y - pl.y) * w,
      scale: pl.scale + (e.to.scale - pl.scale) * w,
      rotateDeg: pl.rotateDeg + (e.to.rotateDeg - pl.rotateDeg) * w,
    };
  }
  return pl;
}

/** The pen state at time t: follow the ACTIVE stroke; glide in before the
 *  first stroke; TRAVEL between strokes (W7 — the hand follows the path
 *  between a stroke's end and the next stroke's start instead of vanish-
 *  reappear: an eased lerp with a pen-lift bump, bounded by the two
 *  endpoints by construction); rest (wobbling) after the last. The S64
 *  freeze receipts: a hidden pen leaves stretches pixel-identical and the
 *  QC frozen-frames lens fires.
 *
 *  W7 poses: selected by the W3 role metadata of the target stroke
 *  (label → write, arrow → point, emphasis → circle, else draw; text
 *  targets write) — `roles` maps assetId → AssetRole (the library build).
 *  Determinism: same events + roles, byte-identical state. */
export function handAt(
  events: AnimationEvent[],
  scene: WhiteboardScene,
  geometry: Map<string, AssetGeometry>,
  tMs: number,
  roles?: Map<string, AssetRole>
): FrameHandState {
  const hidden: FrameHandState = { visible: false, x: 0, y: 0, angle: 0, pose: "rest", scale: 1 };
  type PenEvent = Extract<AnimationEvent, { type: "draw_path" | "write_text" }>;
  const pen: PenEvent[] = [];
  for (const e of events) {
    if (e.type === "draw_path" || e.type === "write_text") pen.push(e);
  }
  if (pen.length === 0) return hidden;
  // Chronological order for the gap scan (stable: startMs, then duration).
  const ordered = [...pen].sort((a, b) => a.startMs - b.startMs || a.durationMs - b.durationMs);
  // S139 — the tremble's per-stroke phase: the golden-angle ordinal of the
  // chronological order (stable across calls; the same events → the same
  // phase book, so the tremble never re-rolls between frames).

  const poseOf = (e: PenEvent): HandPose => {
    if (e.type === "write_text") return "write";
    const role = roles?.get(e.assetId);
    if (role === "label") return "write";
    if (role === "arrow") return "point";
    if (role === "emphasis") return "circle";
    return "draw"; // outline, fill, and role-less assets
  };

  const ordinalOf = new Map<PenEvent, number>();
  ordered.forEach((e, i) => ordinalOf.set(e, i));

  // The pen-tip state on ONE stroke at progress p — the SAME evaluation the
  // active branch and the travel endpoints ride (one follow math).
  const strokePoint = (e: PenEvent, p: number): FrameHandState | null => {
    const placement = scene.placements.find((pl) => pl.assetId === e.assetId)?.placement;
    const base = placement ? placementAt(scene, e.assetId, placement, tMs) : { x: 0, y: 0, scale: 1, rotateDeg: 0 };
    if (e.type === "write_text") {
      // The pen rides the text baseline: measured bbox is a renderer concern;
      // the plan approximates with the character-count width model.
      const chars = TEXT_CHARS_BY_ID.get(`${e.assetId}::${e.textId}`) ?? 12;
      const widthUnits = chars * 11; // ≈ DejaVu Sans 32px average advance at asset scale
      const anchor = TEXT_ANCHORS.get(`${e.assetId}::${e.textId}`) ?? { x: 20, y: 40, size: 32 };
      const local = { x: anchor.x + widthUnits * p, y: anchor.y };
      const pt = transformPoint(local, base);
      return { visible: true, x: pt.x, y: pt.y, angle: (base.rotateDeg * Math.PI) / 180, pose: poseOf(e), scale: 1 };
    }
    const segs = geometry.get(e.assetId)?.paths.get(e.pathId);
    if (!segs) return null;
    const s = sampleAtLength(segs, p * totalLength(segs));
    const pt = transformPoint(s.point, base);
    // S139 — the micro-tremble rides the stroke's LOCAL normal (the hand
    // quivers across the line it is laying, amplitude zero at both ends,
    // phase owned by the stroke's ordinal). Applied after the placement
    // transform, using the SAME angle the hand pose consumes — one frame
    // of reference, no divergence.
    const off = handTrembleOffset(p, ordinalOf.get(e) ?? 0);
    return {
      visible: true,
      x: pt.x - Math.sin(s.angle) * off,
      y: pt.y + Math.cos(s.angle) * off,
      angle: s.angle + (base.rotateDeg * Math.PI) / 180,
      pose: poseOf(e),
      scale: 1,
    };
  };

  // The ACTIVE stroke: the most recently started one with progress in [0,1).
  let active: PenEvent | null = null;
  for (const e of ordered) {
    const p = (tMs - e.startMs) / e.durationMs;
    if (p >= 0 && p < 1 && (!active || e.startMs >= active.startMs)) active = e;
  }

  const first = ordered[0];
  const last = pen.reduce((a, b) => (a.startMs + a.durationMs >= b.startMs + b.durationMs ? a : b));

  if (active) {
    // S139 — the hand rides the EASED progress (the same penProgress the
    // ink front consumes): the lockstep law survives the naturalist speed
    // law — the tip can never lead or trail the ink it lays down.
    const s = strokePoint(active, penProgress((tMs - active.startMs) / active.durationMs));
    return s ?? hidden;
  }

  // W7 — PEN-UP TRAVEL: the window between a stroke's end and the next
  // stroke's start (where the old plan hid the pen — the vanish-reappear
  // teleport). The hand crosses the gap on an eased line between the two
  // stroke endpoints, with a sine pen-lift bump (y up, slight scale) that
  // is ZERO at both joints — the tip never teleports, and the whole path
  // sits inside the two endpoints' bounding box minus the lift.
  for (let i = 0; i < ordered.length - 1; i++) {
    const a = ordered[i];
    const b = ordered[i + 1];
    const gapStart = a.startMs + a.durationMs;
    const gapEnd = b.startMs;
    if (gapEnd <= gapStart || tMs < gapStart || tMs >= gapEnd) continue;
    const from = strokePoint(a, 1);
    const to = strokePoint(b, 0);
    if (!from || !to) return hidden; // degenerate geometry keeps the old mask
    const u = (tMs - gapStart) / (gapEnd - gapStart);
    const g = easeInOut(Math.max(0, Math.min(1, u)));
    const lift = Math.sin(Math.PI * u);
    // Shortest-path angle lerp (tangents can wrap ±π between strokes).
    let dAngle = (to.angle - from.angle) % (Math.PI * 2);
    if (dAngle > Math.PI) dAngle -= Math.PI * 2;
    if (dAngle < -Math.PI) dAngle += Math.PI * 2;
    return {
      visible: true,
      x: from.x + (to.x - from.x) * g,
      y: from.y + (to.y - from.y) * g - HAND_TRAVEL_LIFT * lift,
      angle: from.angle + dAngle * g,
      pose: poseOf(b), // the hand arrives holding the next stroke's tool
      scale: 1 + HAND_TRAVEL_SCALE_BUMP * lift,
    };
  }

  if (tMs <= first.startMs) {
    const rest = strokePoint(first, 0);
    if (!rest) return hidden;
    if (first.startMs > 0) {
      // The pen ENTERS the frame fast and decelerates into the first
      // stroke (ease-out) — the scene-open receipt: a resting pen on an
      // empty canvas is indistinguishable from a frozen frame.
      const u = 1 - Math.pow(1 - Math.max(0, Math.min(1, tMs / first.startMs)), 2);
      const entryX = Math.min(1860, rest.x + 420);
      const entryY = Math.max(60, rest.y - 240);
      return { visible: true, x: entryX + (rest.x - entryX) * u, y: entryY + (rest.y - entryY) * u, angle: rest.angle, pose: rest.pose, scale: 1 };
    }
    return rest;
  }
  const tail = strokePoint(last, 1);
  // W7 — the tail holds the REST pose (the open hand, tool lowered): the
  // hold's micro-motion keeps the lens fed while the grip visibly relaxes.
  return tail ? { ...tail, pose: "rest" } : hidden;
}

// W7 — the pen-lift bump during inter-stroke travel: the tip rises this
// many scene units at mid-gap (zero at both joints — the sine keeps the
// continuity) and the hand grows by this scale fraction while lifted.
export const HAND_TRAVEL_LIFT = 26;
export const HAND_TRAVEL_SCALE_BUMP = 0.05;

// Text anchors (asset-space) — registered by assets.ts.
export const TEXT_ANCHORS = new Map<string, { x: number; y: number; size: number }>();

/** Compute one frame's full state. PURE.
 *
 *  W6 — `carried` is the resolved carry plan (resolveCarriedInk); the
 *  carried ink injects into the SAME maps the scene's own strokes use:
 *  every path fully drawn, every text fully written, fills as the
 *  previous scene left them. Absent/null → byte-for-byte today's frame. */
export function frameAt(
  project: WhiteboardProject,
  scene: WhiteboardScene,
  events: AnimationEvent[],
  geometry: Map<string, AssetGeometry>,
  tMs: number,
  carried?: CarriedInkPlan | null,
  roles?: Map<string, AssetRole>
): FrameState {
  const draws = new Map<string, number>();
  const texts = new Map<string, number>();
  const colors = new Map<string, number>();
  for (const e of events) {
    const p = Math.max(0, Math.min(1, (tMs - e.startMs) / e.durationMs));
    // S139 — every reveal rides the eased pen progress (one speed law for
    // ink, text wipes and the hand); carried ink pins p=1 which penProgress
    // preserves exactly.
    const pe = penProgress(p);
    if (e.type === "draw_path") draws.set(`${e.assetId}::${e.pathId}`, pe);
    else if (e.type === "write_text") texts.set(`${e.assetId}::text:${e.textId}`, pe);
    else if (e.type === "reveal_color") colors.set(`${e.assetId}${e.pathId ? "::" + e.pathId : ""}`, pe);
  }
  const placements = new Map<string, Placement>();
  for (const pl of scene.placements) {
    placements.set(pl.assetId, placementAt(scene, pl.assetId, pl.placement, tMs));
  }
  let carriedLayer: CarriedFrameLayer | null = null;
  if (carried && carried.placements.size > 0) {
    for (const [assetId, pl] of carried.placements) {
      placements.set(assetId, pl);
      // The scheduler's fill law draws EVERY drawable path of a placed
      // asset by scene end (the W2/W4 schedules included), so carrying all
      // of the asset's paths ≡ the previous scene's end visual.
      const geo = geometry.get(assetId);
      if (geo) for (const pathId of geo.paths.keys()) draws.set(`${assetId}::${pathId}`, 1);
      for (const textId of TEXT_IDS_BY_ASSET.get(assetId) ?? []) {
        texts.set(`${assetId}::text:${textId}`, 1);
      }
      for (const [k, v] of carried.colors) {
        if (k === assetId || k.startsWith(assetId + "::")) colors.set(k, v);
      }
    }
    carriedLayer = {
      placements: carried.placements,
      exit: carriedExitAt(carried, project.width, tMs),
    };
  }
  return {
    tMs,
    draws,
    texts,
    colors,
    placements,
    carried: carriedLayer,
    hand: handAt(events, scene, geometry, tMs, roles),
    camera: cameraAt(scene, project.width, project.height, tMs),
  };
}

/** Frame count for a scene duration. */
export function frameCount(durationMs: number, fps: number): number {
  return Math.max(1, Math.round((durationMs / 1000) * fps));
}

// ---------------------------------------------------------------------------
// S65 (E1) — the render frame budget (pure, so CI can pin it).
//
// The renderer MUST refuse a project whose estimated frame count exceeds
// this budget BEFORE chromium launches (E0 audit §6 risk 4: chromium memory
// on 4GB workers for long videos). 25,920 frames = 18 min at 24 fps — the
// validator's explicit-duration budgets (storyboard.ts WB_BUDGETS) already
// cap author intent at 15 min; this is the hard wall that also bounds
// VO-measured durations the validator cannot see. Arithmetic for the
// record: 24 fps × 1080 s = 25,920; a 30 fps project hits it at 14.4 min.
// ---------------------------------------------------------------------------

export const WB_RENDER_FRAME_BUDGET = 25_920;

/**
 * Total estimated frames for a project — the exact durations the renderer
 * will use (explicit > VO-measured > narration estimate), so the pre-flight
 * and the render loop can never disagree. Pure: the caller supplies VO
 * durations (renderer-side ffprobe); this module stays pure.
 */
export function estimateProjectFrames(
  project: WhiteboardProject,
  voMsBySceneId: Map<string, number>
): { totalFrames: number; sceneMs: number[] } {
  const sceneMs: number[] = [];
  let totalFrames = 0;
  for (const scene of project.scenes) {
    const ms = sceneDurationMs(scene, voMsBySceneId.get(scene.id) ?? null);
    sceneMs.push(ms);
    totalFrames += frameCount(ms, project.fps);
  }
  return { totalFrames, sceneMs };
}

/** Build the asset geometry map from raw path data (renderer-agnostic). */
export function buildGeometry(
  assets: { id: string; paths: { id: string; d: string }[] }[]
): Map<string, AssetGeometry> {
  const geo = new Map<string, AssetGeometry>();
  for (const a of assets) {
    const paths = new Map<string, PathSegment[]>();
    let totalLen = 0;
    for (const p of a.paths) {
      const segs = pathSegments(p.d);
      paths.set(p.id, segs);
      totalLen += totalLength(segs);
    }
    geo.set(a.id, { paths, totalLen });
  }
  return geo;
}

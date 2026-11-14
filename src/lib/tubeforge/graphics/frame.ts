// G1.2 — frame truth: the ONE source of motion truth for the graphics
// engine (S120 §5 / Part B). Pure: same (doc, tMs) → byte-identical frame
// state; no fs, no DOM, no clock, no randomness (the S64 law generalizes).
//
// THE CONTRACT: callers pass a VALIDATED GraphicsDoc (graphics/types.ts is
// the guarantee) — frameAt carries no defensive branches (the Part F law:
// validate integrity once, schedule purely everywhere else).
//
// THE MOTION MODEL (v1 semantics — the numbers are receipts to tune; the
// NAMES are the contract, exported as GRAPHICS_MOTION_SEMANTICS):
//
//   Each motion owns the window [delayMs, delayMs + durationMs] on its
//   scene clock. Local progress is CLAMPED: before the window a motion
//   holds its start state, after it its end state — so every channel is
//   continuous and finite for ALL t (the never-NaN pin holds outside every
//   motion window by construction, not by guarding).
//
//   Channels (what a frame carries per element):
//     opacity     base opacity × the owned opacity factor
//     x / y       placement + the owned offsets (scene units)
//     scale       placement scale × the owned scale factor
//     rotateDeg   placement rotation (no motion rotates in v1)
//     progress    0..1 reveal — the composer's wipe/grow/draw channel
//                 (bar lengths, shape reveals, icon stroke-dash); 1 when
//                 no motion drives it
//     counterValue counter kind only — the tweened number
//
//   Composition order is FIXED: enter → exit → emphasis (the G1.2
//   precedence pin, emphasis > exit > enter, manifests as composition
//   order — emphasis is applied LAST, so it shapes the final state over
//   whatever the exit/enter layers produced):
//     enter  drives its channels from their start state to the placed
//            state (clamped: the start state holds pre-window);
//     exit   multiplies the placed state down to its end state (a fade
//            exits 1→0, a wipe un-reveals ×(1−e), a count drains the
//            captured value back to `from` — captured at the exit's start
//            so the boundary is continuous even mid-enter);
//     emphasis is IN-WINDOW only (identity outside) and is env-bounded:
//            the triangle phase q(p) eased by the motion's own curve —
//            0 at both window edges, so emphasis never discontinues the
//            state it lands on.
//
//   Emphasis semantics per kind: fade → opacity dip; pop/grow → scale
//   pulse; rise/slide → offset nudge; wipe/draw → progress re-trace;
//   count → the POP channel only (the value channel is untouched — an
//   overshoot would falsify the number).
//
//   The scene clock: explicit durationMs > the house 2.6-wps estimate
//   (timing.ts#estimateNarrationMs — ONE clock model, reused, never
//   re-implemented). frameAt resolves the ACTIVE scene for the doc clock
//   and clamps to [0, total].
//
// Deviation from the Part B sketch, recorded: frameAt(doc, tMs) — the
// sketch's geometry arg came from the whiteboard pattern; the graphics
// grammar carries placement inline (GraphicsElement.at), so there is no
// external geometry to resolve.
import { frameCountOf } from "../anim/clock";
import { evalEase } from "../anim/easing";
import { estimateNarrationMs } from "../whiteboard/timing";
import type { ElementMotion, GraphicsDoc, GraphicsElement } from "./types";

/** The v1 motion semantics — ONE source, cited by the pins and the design
 *  record. Values are receipts to tune; the names are the contract. */
export const GRAPHICS_MOTION_SEMANTICS = {
  /** enter rise offset (scene units, from below). */
  risePx: 48,
  /** enter slide offset (scene units, from the left). */
  slidePx: 120,
  /** enter pop start scale. */
  popFrom: 0.6,
  /** exit rise offset (scene units, upward). */
  exitRisePx: 48,
  /** exit slide offset (scene units, rightward). */
  exitSlidePx: 120,
  /** emphasis opacity dip (fade). */
  emphasisFadeDip: 0.4,
  /** emphasis scale pulse (pop / grow / count). */
  emphasisPopScale: 0.15,
  /** emphasis rise nudge (scene units). */
  emphasisRisePx: 24,
  /** emphasis slide nudge (scene units). */
  emphasisSlidePx: 48,
  /** emphasis re-trace dip (wipe / draw). */
  emphasisNudge: 0.25,
} as const;

/** The motion kinds that drive the opacity channel (enter: 0→1; exit:
 *  1→0; emphasis: the dip). wipe/grow drive reveal, count drives the
 *  value — their opacity stays at the base. */
const OPACITY_KINDS = new Set(["fade", "rise", "slide", "pop"]);
/** The motion kinds that drive the reveal-progress channel. */
const PROGRESS_KINDS = new Set(["wipe", "grow", "draw"]);

export interface GraphicsElementFrame {
  id: string;
  /** base opacity × the composed factor, 0..1. */
  opacity: number;
  /** scene-space position: placement + the composed offsets. */
  x: number;
  y: number;
  /** placement scale × the composed factor. */
  scale: number;
  rotateDeg: number;
  /** 0..1 reveal — the composer's wipe/grow/draw channel. */
  progress: number;
  /** counter kind only — the tweened value (absent otherwise). */
  counterValue?: number;
}

export interface GraphicsFrameState {
  /** the scene the doc clock resolved to. */
  sceneId: string;
  /** the scene-local clock (ms into THIS scene) — what the composer renders against. */
  sceneTMs: number;
  /** the active scene's elements in doc order, each at its frame state. */
  elements: GraphicsElementFrame[];
}

interface SceneClock {
  scene: GraphicsDoc["scenes"][number];
  startMs: number;
  endMs: number;
  durationMs: number;
}

/** The per-scene effective clocks: explicit > the house estimate (ONE
 *  clock model). Pure — recomputed per call, cheap at the grammar's
 *  walls (≤24 scenes). */
function sceneClocks(doc: GraphicsDoc): SceneClock[] {
  if (doc.scenes.length === 0) {
    // Junk input is a CALLER bug (the keyframe.ts law) — the validator
    // refuses empty docs; frameAt refuses loudly too, never fabricates.
    throw new Error("frameAt: the doc has no scenes — pass a validated GraphicsDoc");
  }
  const clocks: SceneClock[] = [];
  let cursor = 0;
  for (const scene of doc.scenes) {
    const durationMs = scene.durationMs !== undefined && scene.durationMs > 0
      ? scene.durationMs
      : estimateNarrationMs(scene.narration);
    clocks.push({ scene, startMs: cursor, endMs: cursor + durationMs, durationMs });
    cursor += durationMs;
  }
  return clocks;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The emphasis envelope: triangle phase eased by the motion's own curve —
 *  0 at both window edges (continuity at emphasis boundaries), 1 at the
 *  window midpoint. */
function emphasisEnv(m: ElementMotion, tMs: number): number {
  const p = clamp01((tMs - m.delayMs) / m.durationMs);
  const q = p <= 0.5 ? p * 2 : (1 - p) * 2;
  return evalEase(m.ease, q);
}

interface Channels {
  opacityFactor: number;
  dx: number;
  dy: number;
  scaleFactor: number;
  progress: number;
  /** the counter value the ENTER layer produces at clamped progress —
   *  captured by the exit's drain (continuity at the exit boundary). */
  counterFromEnter: number;
}

/** The counter value the enter layer holds at time t (clamped): from at
 *  the window start, to after it. */
function counterAtEnter(el: GraphicsElement, enter: ElementMotion, tMs: number): number {
  const payload = el.counter;
  if (payload === undefined) return 0;
  const e = evalEase(enter.ease, clamp01((tMs - enter.delayMs) / enter.durationMs));
  return payload.from + (payload.to - payload.from) * e;
}

function enterChannels(el: GraphicsElement, tMs: number, out: Channels): void {
  const m = el.enter;
  const e = evalEase(m.ease, clamp01((tMs - m.delayMs) / m.durationMs));
  if (OPACITY_KINDS.has(m.kind)) out.opacityFactor = e;
  if (PROGRESS_KINDS.has(m.kind)) out.progress = e;
  if (m.kind === "rise") out.dy += GRAPHICS_MOTION_SEMANTICS.risePx * (1 - e);
  if (m.kind === "slide") out.dx -= GRAPHICS_MOTION_SEMANTICS.slidePx * (1 - e);
  if (m.kind === "pop") out.scaleFactor = GRAPHICS_MOTION_SEMANTICS.popFrom + (1 - GRAPHICS_MOTION_SEMANTICS.popFrom) * e;
  if (m.kind === "count") out.counterFromEnter = counterAtEnter(el, m, tMs);
}

function exitChannels(el: GraphicsElement, exit: ElementMotion, tMs: number, out: Channels): void {
  const e = evalEase(exit.ease, clamp01((tMs - exit.delayMs) / exit.durationMs));
  if (OPACITY_KINDS.has(exit.kind)) out.opacityFactor *= 1 - e;
  if (PROGRESS_KINDS.has(exit.kind)) out.progress *= 1 - e;
  if (exit.kind === "rise") out.dy -= GRAPHICS_MOTION_SEMANTICS.exitRisePx * e;
  if (exit.kind === "slide") out.dx += GRAPHICS_MOTION_SEMANTICS.exitSlidePx * e;
  if (exit.kind === "pop") out.scaleFactor *= 1 - (1 - GRAPHICS_MOTION_SEMANTICS.popFrom) * e;
  if (exit.kind === "count") {
    // The drain is captured at the exit's START (continuity even when the
    // exit begins mid-enter): V0 = the enter value at exitStart → from.
    const v0 = counterAtEnter(el, el.enter, exit.delayMs);
    const payload = el.counter;
    const from = payload !== undefined ? payload.from : 0;
    out.counterFromEnter = v0 + (from - v0) * e;
  }
}

function emphasisChannels(emphasis: ElementMotion, tMs: number, out: Channels): void {
  // IN-WINDOW ONLY — identity outside (emphasis never holds a state).
  if (tMs < emphasis.delayMs || tMs > emphasis.delayMs + emphasis.durationMs) return;
  const env = emphasisEnv(emphasis, tMs);
  const S = GRAPHICS_MOTION_SEMANTICS;
  if (emphasis.kind === "fade") out.opacityFactor *= 1 - S.emphasisFadeDip * env;
  if (emphasis.kind === "pop" || emphasis.kind === "grow" || emphasis.kind === "count") {
    out.scaleFactor *= 1 + S.emphasisPopScale * env;
  }
  if (emphasis.kind === "rise") out.dy -= S.emphasisRisePx * env;
  if (emphasis.kind === "slide") out.dx += S.emphasisSlidePx * env;
  if (emphasis.kind === "wipe" || emphasis.kind === "draw") out.progress *= 1 - S.emphasisNudge * env;
}

function elementFrame(el: GraphicsElement, tMs: number): GraphicsElementFrame {
  const out: Channels = {
    opacityFactor: 1,
    dx: 0,
    dy: 0,
    scaleFactor: 1,
    progress: 1,
    counterFromEnter: el.counter !== undefined ? el.counter.to : 0,
  };
  enterChannels(el, tMs, out);
  if (el.exit !== undefined) exitChannels(el, el.exit, tMs, out);
  if (el.emphasis !== undefined) emphasisChannels(el.emphasis, tMs, out);
  const frame: GraphicsElementFrame = {
    id: el.id,
    opacity: clamp01((el.opacity ?? 1) * out.opacityFactor),
    x: el.at.x + out.dx,
    y: el.at.y + out.dy,
    scale: el.at.scale * out.scaleFactor,
    rotateDeg: el.at.rotateDeg,
    progress: clamp01(out.progress),
  };
  if (el.counter !== undefined) frame.counterValue = out.counterFromEnter;
  return frame;
}

/**
 * frameAt — the one source of motion truth. Resolves the doc clock to the
 * active scene (clamped to [0, total]) and returns that scene's elements
 * at their composed frame state. PURE: same input → byte-identical output
 * (pinned by the sweep-hash test).
 */
export function frameAt(doc: GraphicsDoc, tMs: number): GraphicsFrameState {
  const clocks = sceneClocks(doc);
  const last: SceneClock | undefined = clocks[clocks.length - 1];
  if (last === undefined) throw new Error("frameAt: the doc has no scenes — pass a validated GraphicsDoc");
  const total = last.endMs;
  const t = tMs < 0 ? 0 : tMs > total ? total : tMs;
  let active: SceneClock = last;
  for (const clock of clocks) {
    if (t < clock.endMs) {
      active = clock;
      break;
    }
  }
  return {
    sceneId: active.scene.id,
    sceneTMs: t - active.startMs,
    elements: active.scene.elements.map((el) => elementFrame(el, t)),
  };
}

/** The doc-level frame count — the render pre-flight's arithmetic (G1.5)
 *  against GRAPHICS_FRAME_BUDGET, exposed here so the wall has one
 *  calculator. Uses the anim/clock frame rule (ceil to whole frames). */
export function graphicsFrameCount(doc: GraphicsDoc): number {
  const clocks = sceneClocks(doc);
  const last: SceneClock | undefined = clocks[clocks.length - 1];
  if (last === undefined) throw new Error("graphicsFrameCount: the doc has no scenes — pass a validated GraphicsDoc");
  return frameCountOf(last.endMs, doc.fps);
}

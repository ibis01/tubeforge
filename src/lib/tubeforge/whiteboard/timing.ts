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
import type { AnimationEvent, WhiteboardProject, WhiteboardScene } from "./storyboard";

/** The house narration pace (words/sec) — the director lane's constant. */
export const WORDS_PER_SEC = 2.6;
export const LEAD_IN_MS = 400;
export const HOLD_END_MS = 900;
const PATH_GAP_MS = 130; // pen lift between strokes
const MIN_PATH_MS = 260; // even a dot takes a moment
const MAX_PATH_MS = 2600; // even a long contour stays snappy
const MS_PER_CHAR = 55; // text writing speed

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

/**
 * Schedule a scene: fill in animation events for every drawable path and
 * text element the placements bring, in draw order, inside the narration
 * window. Pre-existing events for an element are RESPECTED (the editor's
 * explicit timing is senior — the studio's precedence law).
 */
export function scheduleScene(
  scene: WhiteboardScene,
  durationMs: number,
  geometry: Map<string, AssetGeometry>
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
  const work: Work[] = [];
  const ordered = [...scene.placements].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const pl of ordered) {
    const geo = geometry.get(pl.assetId);
    if (!geo) continue;
    for (const [pathId, segs] of geo.paths) {
      if (claimed.has(`${pl.assetId}::${pathId}`)) continue;
      const len = totalLength(segs) * pl.placement.scale;
      work.push({ kind: "path", assetId: pl.assetId, id: pathId, weight: Math.max(120, len) });
    }
    const texts = TEXT_IDS_BY_ASSET.get(pl.assetId) ?? [];
    for (const textId of texts) {
      if (claimed.has(`${pl.assetId}::text:${textId}`)) continue;
      const chars = TEXT_CHARS_BY_ID.get(`${pl.assetId}::${textId}`) ?? 12;
      work.push({ kind: "text", assetId: pl.assetId, id: textId, weight: 40 * chars });
    }
  }
  if (work.length === 0) return events;

  // Budget: narration window minus lead-in/hold/gaps.
  const gaps = PATH_GAP_MS * Math.max(0, work.length - 1);
  const avail = Math.max(1200, durationMs - LEAD_IN_MS - HOLD_END_MS - gaps);
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
  // ENDS at durationMs − HOLD_END_MS — capped raw schedules finished 3–6s
  // early, and the static tails failed frozen-frames/static-shots.
  const f = rawSum > 0 ? Math.min(2.8, Math.max(0.5, avail / rawSum)) : 1;
  let t = LEAD_IN_MS;
  work.forEach((w, i) => {
    const durationMs = Math.max(120, Math.round(raw[i] * f));
    if (w.kind === "path") {
      events.push({ type: "draw_path", assetId: w.assetId, pathId: w.id, startMs: Math.round(t), durationMs });
    } else {
      events.push({ type: "write_text", assetId: w.assetId, textId: w.id, startMs: Math.round(t), durationMs });
    }
    t += durationMs + PATH_GAP_MS;
  });
  return events.sort((a, b) => a.startMs - b.startMs);
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

/** Interpolate the camera at scene time t (ms), plus the permanent drift. */
export function cameraAt(scene: WhiteboardScene, tMs: number): FrameCameraState {
  const keys = scene.camera.length > 0 ? scene.camera : [{ cx: 960, cy: 540, scale: 1, startMs: 0, durationMs: 0 }];
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
  const drift = cameraDrift(tMs);
  return { cx: state.cx + drift.dx, cy: state.cy + drift.dy, scale: state.scale };
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

/** The pen state at time t: follow the ACTIVE stroke; rest (wobbling)
 *  during the lead-in before the first stroke and the hold after the last.
 *  The S64 freeze receipts: a hidden pen leaves those stretches
 *  pixel-identical and the QC frozen-frames lens fires. Inter-stroke gaps
 *  stay hidden — the pen-lift mask for travel teleports. */
export function handAt(
  events: AnimationEvent[],
  scene: WhiteboardScene,
  geometry: Map<string, AssetGeometry>,
  tMs: number
): FrameHandState {
  const hidden: FrameHandState = { visible: false, x: 0, y: 0, angle: 0 };
  type PenEvent = Extract<AnimationEvent, { type: "draw_path" | "write_text" }>;
  const pen: PenEvent[] = [];
  for (const e of events) {
    if (e.type === "draw_path" || e.type === "write_text") pen.push(e);
  }
  if (pen.length === 0) return hidden;

  // The ACTIVE stroke: the most recently started one with progress in [0,1).
  let active: PenEvent | null = null;
  for (const e of pen) {
    const p = (tMs - e.startMs) / e.durationMs;
    if (p >= 0 && p < 1 && (!active || e.startMs >= active.startMs)) active = e;
  }

  const first = pen.reduce((a, b) => (a.startMs <= b.startMs ? a : b));
  const last = pen.reduce((a, b) => (a.startMs + a.durationMs >= b.startMs + b.durationMs ? a : b));

  let target: PenEvent;
  let progress: number;
  if (active) {
    target = active;
    progress = (tMs - active.startMs) / active.durationMs;
  } else if (tMs <= first.startMs) {
    target = first;
    progress = 0;
  } else if (tMs >= last.startMs + last.durationMs) {
    target = last;
    progress = 1;
  } else {
    return hidden;
  }

  const placement = scene.placements.find((pl) => pl.assetId === target.assetId)?.placement;
  const base = placement ? placementAt(scene, target.assetId, placement, tMs) : { x: 0, y: 0, scale: 1, rotateDeg: 0 };

  const positionOf = (p: number): FrameHandState => {
    if (target.type === "write_text") {
      // The pen rides the text baseline: measured bbox is a renderer concern;
      // the plan approximates with the character-count width model.
      const chars = TEXT_CHARS_BY_ID.get(`${target.assetId}::${target.textId}`) ?? 12;
      const widthUnits = chars * 11; // ≈ DejaVu Sans 32px average advance at asset scale
      const anchor = TEXT_ANCHORS.get(`${target.assetId}::${target.textId}`) ?? { x: 20, y: 40, size: 32 };
      const local = { x: anchor.x + widthUnits * p, y: anchor.y };
      const pt = transformPoint(local, base);
      return { visible: true, x: pt.x, y: pt.y, angle: (base.rotateDeg * Math.PI) / 180 };
    }
    const segs = geometry.get(target.assetId)?.paths.get(target.pathId);
    if (!segs) return hidden;
    const s = sampleAtLength(segs, p * totalLength(segs));
    const pt = transformPoint(s.point, base);
    return {
      visible: true,
      x: pt.x,
      y: pt.y,
      angle: s.angle + (base.rotateDeg * Math.PI) / 180,
    };
  };

  if (active) return positionOf(progress);

  if (tMs <= first.startMs) {
    const rest = positionOf(0);
    if (first.startMs > 0) {
      // The pen ENTERS the frame fast and decelerates into the first
      // stroke (ease-out) — the scene-open receipt: a resting pen on an
      // empty canvas is indistinguishable from a frozen frame.
      const u = 1 - Math.pow(1 - Math.max(0, Math.min(1, tMs / first.startMs)), 2);
      const entryX = Math.min(1860, rest.x + 420);
      const entryY = Math.max(60, rest.y - 240);
      return {
        visible: true,
        x: entryX + (rest.x - entryX) * u,
        y: entryY + (rest.y - entryY) * u,
        angle: rest.angle,
      };
    }
    return rest;
  }
  return positionOf(1);
}

// Text anchors (asset-space) — registered by assets.ts.
export const TEXT_ANCHORS = new Map<string, { x: number; y: number; size: number }>();

/** Compute one frame's full state. PURE. */
export function frameAt(
  project: WhiteboardProject,
  scene: WhiteboardScene,
  events: AnimationEvent[],
  geometry: Map<string, AssetGeometry>,
  tMs: number
): FrameState {
  const draws = new Map<string, number>();
  const texts = new Map<string, number>();
  const colors = new Map<string, number>();
  for (const e of events) {
    const p = Math.max(0, Math.min(1, (tMs - e.startMs) / e.durationMs));
    if (e.type === "draw_path") draws.set(`${e.assetId}::${e.pathId}`, p);
    else if (e.type === "write_text") texts.set(`${e.assetId}::text:${e.textId}`, p);
    else if (e.type === "reveal_color") colors.set(`${e.assetId}${e.pathId ? "::" + e.pathId : ""}`, p);
  }
  const placements = new Map<string, Placement>();
  for (const pl of scene.placements) {
    placements.set(pl.assetId, placementAt(scene, pl.assetId, pl.placement, tMs));
  }
  return {
    tMs,
    draws,
    texts,
    colors,
    placements,
    hand: handAt(events, scene, geometry, tMs),
    camera: cameraAt(scene, tMs),
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

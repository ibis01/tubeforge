// W5 — the content-driven camera director (S120 §3 W5).
//
// The whiteboard camera has ONE motion source today: the permanent
// Lissajous drift (timing.ts cameraDrift) — load-bearing for the QC
// frozen-frame/static-shot lenses, but blind to CONTENT: the viewport
// wanders the same Lissajous whether the board shows one label or a
// four-beat diagram. This module is the content-driven director: focus
// rects derived from the BEAT PLAN (W2's planner — one planner, two
// consumers), framing before each beat's first stroke, eased travel
// between rects, rest at every stroke onset.
//
// The demotion law (the drift tension, landed in the SAME slice): the
// drift becomes the NO-CAMERA-KEYS fallback only — a scene carrying
// camera keys (the director's or the author's) rides them with NO drift;
// a cameraless scene keeps today's behavior byte-for-byte (the W1
// baseline pin). The pen-tip truth is architectural: the hand lives
// INSIDE the camera group (wb-page), so the tip tracks its path point
// under any camera motion — the S64 drift receipts proved it.
//
// Pure: no fs, no DOM, no clock. Deterministic: same scene in → same
// keys out, byte-identical (the suite pins the double-run).
import { planBeats, type PlanBeatsOptions } from "./beat-plan";
import type { AnimationEvent, CameraEvent, WhiteboardScene } from "./storyboard";
import type { AssetGeometry } from "./timing";

/** Travel floor: a reframe shorter than this reads as a jump-cut. The
 *  studio's own key UI inserts 800ms travels — manual keys clear it. */
export const CAMERA_MIN_TRAVEL_MS = 420;

/** The zoom-speed wall: |Δscale| per second of travel. A full 1→1.6
 *  punch needs ≥ 1.5s — fast enough to feel deliberate, slow enough to
 *  track. */
export const CAMERA_MAX_ZOOM_PER_SEC = 0.4;

/** The safe margin (scene units) the viewport must keep inside the board:
 *  the world painted behind the board is 3W×3H (wb-page), so the REAL
 *  wall is the board's own edge with breathing room. */
export const CAMERA_SAFE_MARGIN = 24;

/** Zoom clamps: the director only zooms IN (the board fills the frame at
 *  scale 1; beyond 1.6 the strokes get too wide for the pen aesthetic). */
export const CAMERA_SCALE_MIN = 1;
export const CAMERA_SCALE_MAX = 1.6;

/** Focus-rect padding: a fraction of the rect's larger side (min floor),
 *  so ink never touches the viewport edge. */
export const CAMERA_RECT_PAD_RATIO = 0.18;
export const CAMERA_RECT_PAD_MIN = 40;

export interface CameraFocusRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The beat plan's shape, narrowed to what the director reads. */
interface DirectedBeat {
  assetIds: string[];
  startMs: number;
  endMs: number;
}

/** The transformed bounding box of one placed asset (sampled through the
 *  real flattened geometry — the same points the pen rides). */
function assetBBox(
  scene: WhiteboardScene,
  assetId: string,
  geometry: Map<string, AssetGeometry>
): CameraFocusRect | null {
  const pl = scene.placements.find((p) => p.assetId === assetId)?.placement;
  const geo = geometry.get(assetId);
  if (!pl || !geo) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const segs of geo.paths.values()) {
    for (const seg of segs) {
      for (const pt of seg.points) {
        const cos = Math.cos((pl.rotateDeg * Math.PI) / 180);
        const sin = Math.sin((pl.rotateDeg * Math.PI) / 180);
        const sx = pt.x * pl.scale;
        const sy = pt.y * pl.scale;
        const x = pl.x + sx * cos - sy * sin;
        const y = pl.y + sx * sin + sy * cos;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  if (!Number.isFinite(x0)) return null;
  return { x0, y0, x1, y1 };
}

function unionRect(a: CameraFocusRect | null, b: CameraFocusRect | null): CameraFocusRect | null {
  if (!a) return b;
  if (!b) return a;
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

function padRect(r: CameraFocusRect): CameraFocusRect {
  const pad = Math.max(CAMERA_RECT_PAD_MIN, CAMERA_RECT_PAD_RATIO * Math.max(r.x1 - r.x0, r.y1 - r.y0));
  return { x0: r.x0 - pad, y0: r.y0 - pad, x1: r.x1 + pad, y1: r.y1 + pad };
}

/** The framing one focus rect demands: viewport (W/s × H/s) contains the
 *  rect, center clamped so the viewport stays inside the board. */
export function framingFor(rect: CameraFocusRect, width: number, height: number): { cx: number; cy: number; scale: number } {
  const w = Math.max(1, rect.x1 - rect.x0);
  const h = Math.max(1, rect.y1 - rect.y0);
  const scale = Math.min(CAMERA_SCALE_MAX, Math.max(CAMERA_SCALE_MIN, Math.min(width / w, height / h)));
  const halfW = width / (2 * scale);
  const halfH = height / (2 * scale);
  const cx = Math.min(Math.max((rect.x0 + rect.x1) / 2, halfW), width - halfW);
  const cy = Math.min(Math.max((rect.y0 + rect.y1) / 2, halfH), height - halfH);
  return { cx: Math.round(cx * 1000) / 1000, cy: Math.round(cy * 1000) / 1000, scale: Math.round(scale * 1000) / 1000 };
}

/** Each beat's stroke ONSET: the earliest pen event whose asset the beat
 *  owns. The camera must rest by then (the stable writing window). */
function beatOnsets(beats: DirectedBeat[], events: AnimationEvent[]): number[] {
  const owner = new Map<string, number>();
  beats.forEach((b, i) => {
    for (const id of b.assetIds) if (!owner.has(id)) owner.set(id, i);
  });
  const onsets = beats.map(() => Number.POSITIVE_INFINITY);
  for (const e of events) {
    if (e.type !== "draw_path" && e.type !== "write_text") continue;
    const beat = owner.get(e.assetId);
    if (beat === undefined) continue;
    if (e.startMs < onsets[beat]) onsets[beat] = e.startMs;
  }
  return onsets;
}

/** Every stroke onset, sorted — the travel windows may not CONTAIN one
 *  (the onset-stability policy the director obeys by construction). */
function penOnsets(events: AnimationEvent[]): number[] {
  return events
    .filter((e) => e.type === "draw_path" || e.type === "write_text")
    .map((e) => e.startMs)
    .sort((a, b) => a - b);
}

/** directCamera — the beat plan → CameraEvent[]. Returns [] when the
 *  scene has no content-driven story to frame (≤1 beat): the drift
 *  fallback stays (the demotion law). Keys[0] frames beat 0 from the
 *  scene's first frame; every later key's travel COMPLETES by its beat's
 *  stroke onset (the camera rests when the pen lands). */
export function directCamera(
  scene: WhiteboardScene,
  width: number,
  height: number,
  durationMs: number,
  geometry: Map<string, AssetGeometry>,
  events: AnimationEvent[],
  opts?: Omit<PlanBeatsOptions, "durationMs" | "geometry">
): CameraEvent[] {
  if (!(durationMs > 0)) return [];
  const beats = planBeats(scene, { durationMs, geometry, ...opts }) as DirectedBeat[];
  if (beats.length <= 1) return [];

  const rects: (CameraFocusRect | null)[] = beats.map((b) => {
    let u: CameraFocusRect | null = null;
    for (const id of b.assetIds) u = unionRect(u, assetBBox(scene, id, geometry));
    return u; // RAW (unpadded) — the pad is applied once, at framing time
  });
  // A beat with no drawable geometry cannot frame — it inherits nothing
  // and the director skips a key for it (the previous framing holds).
  const framings = rects.map((r) => (r ? framingFor(padRect(r), width, height) : null));
  const onsets = beatOnsets(beats, events);
  const strokes = penOnsets(events);

  // The director walks the beats: travel to a beat's framing when the
  // schedule gives the move room (no stroke onset inside the travel — the
  // policy the validator runs), MERGE the beat's rect into the resting
  // framing when it does not. Merging is the honest answer to W2's
  // interleaved windows (a tight beat's min-clamped strokes spill past
  // its window into the next beat's airtime): the camera frames the
  // WHOLE composition instead of panning blind or drifting. `curRect`
  // tracks the RAW (unpadded) union — the pad is applied once, at
  // framing time, so a merge never double-pads.
  const keys: CameraEvent[] = [];
  let restAt = 0; // the time the camera came to rest (travel completed)
  let rest: { cx: number; cy: number; scale: number } | null = null;
  let curRect: CameraFocusRect | null = null;
  for (let i = 0; i < beats.length; i++) {
    const rect = rects[i];
    const f = framings[i];
    if (!f || !rect) continue;
    if (keys.length === 0) {
      keys.push({ ...f, startMs: 0, durationMs: 0 });
      restAt = 0;
      rest = f;
      curRect = rect;
      continue;
    }
    if (rest && f.cx === rest.cx && f.cy === rest.cy && f.scale === rest.scale) continue; // same framing — no travel
    const onset = Number.isFinite(onsets[i]) ? onsets[i] : beats[i].startMs;
    // The travel may not CONTAIN a stroke onset (the eye locks onto the
    // pen landing on a settled frame) — so it starts at/after the latest
    // stroke onset before this beat's own.
    let lower = restAt;
    for (const o of strokes) {
      if (o < onset) lower = Math.max(lower, o);
      else break;
    }
    const available = onset - lower;
    if (available >= (CAMERA_MIN_TRAVEL_MS * 2) / 3) {
      const travel = Math.min(available, 1400);
      const startMs = Math.round(onset - travel);
      keys.push({ ...f, startMs, durationMs: Math.max(1, travel) });
      restAt = onset;
      rest = f;
      curRect = rect;
    } else if (curRect) {
      // No room to travel with composure — the beat joins the resting
      // framing: re-frame the last key to the union rect. The camera then
      // holds a composition that shows BOTH subjects while they interleave.
      const mergedRect = unionRect(curRect, rect);
      if (!mergedRect) continue;
      curRect = mergedRect;
      const merged = framingFor(padRect(curRect), width, height);
      const last = keys[keys.length - 1];
      keys[keys.length - 1] = { ...merged, startMs: last.startMs, durationMs: last.durationMs };
      rest = merged;
    }
  }
  // The closing move (the drift tension's answer, landed in the same
  // slice): a directed scene's static tail (the final-idea hold beyond
  // the last stroke) was previously kept alive by the demoted drift —
  // freezedetect fires on a >1s still frame. The director breathes the
  // camera OUT over the tail: a slow, bounded settle to a slightly wider
  // framing. Content-driven (the framing widens to give the finished
  // board its air), speed-policied, and it ends before the scene does.
  if (keys.length > 0 && rest && curRect) {
    let lastPenEnd = 0;
    for (const e of events) {
      if (e.type === "draw_path" || e.type === "write_text") {
        const end = e.startMs + e.durationMs;
        if (end > lastPenEnd) lastPenEnd = end;
      }
    }
    const tail = durationMs - lastPenEnd;
    if (tail >= 1400) {
      // Widen the composition ~6% around its center — the finished board
      // gets its air, the motion stays gentle and bounded.
      const grow = 1.06;
      const cx = (curRect.x0 + curRect.x1) / 2;
      const cy = (curRect.y0 + curRect.y1) / 2;
      const wider = framingFor(
        {
          x0: cx - (cx - curRect.x0) * grow,
          y0: cy - (cy - curRect.y0) * grow,
          x1: cx + (curRect.x1 - cx) * grow,
          y1: cy + (curRect.y1 - cy) * grow,
        },
        width,
        height
      );
      if (wider.scale !== rest.scale || wider.cx !== rest.cx || wider.cy !== rest.cy) {
        const startMs = lastPenEnd + 300;
        // The settle spans the WHOLE remaining tail (minus a 200ms landing
        // pad): a capped move would leave a >1s static stretch after it —
        // the exact freezedetect trip the drift used to cover. The speed
        // wall (0.4/s) is the real bound; a 3.5s tail settles at ~0.02/s.
        const closeDur = durationMs - 200 - startMs;
        if (closeDur >= CAMERA_MIN_TRAVEL_MS) {
          keys.push({ ...wider, startMs, durationMs: closeDur });
        }
      }
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// The policy set — pure checks the validator consumes (invalid keys are a
// validation ERROR, never a silent clamp) and the proof script re-runs as
// receipts.
// ---------------------------------------------------------------------------

export interface CameraViolation {
  policy: "min-travel" | "zoom-speed" | "containment" | "onset-stability";
  reason: string;
  keyIndex?: number;
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Every travel (a key that MOVES the camera) must give the eye time. */
function checkMinTravel(keys: CameraEvent[]): CameraViolation[] {
  const out: CameraViolation[] = [];
  for (let i = 1; i < keys.length; i++) {
    const k = keys[i];
    const prev = keys[i - 1];
    const moves = k.cx !== prev.cx || k.cy !== prev.cy || k.scale !== prev.scale;
    if (moves && k.durationMs < 120) {
      out.push({
        policy: "min-travel",
        reason: `camera key ${i} travels for only ${k.durationMs}ms — below the 120ms floor (a jump-cut, not a move)`,
        keyIndex: i,
      });
    }
  }
  return out;
}

/** Bounded zoom speed — the drawing stays watchable while the camera works. */
function checkZoomSpeed(keys: CameraEvent[]): CameraViolation[] {
  const out: CameraViolation[] = [];
  for (let i = 1; i < keys.length; i++) {
    const k = keys[i];
    const prev = keys[i - 1];
    const ds = Math.abs(k.scale - prev.scale);
    const sec = k.durationMs / 1000;
    if (sec > 0 && ds / sec > CAMERA_MAX_ZOOM_PER_SEC) {
      out.push({
        policy: "zoom-speed",
        reason: `camera key ${i} zooms ${r3(ds)} in ${k.durationMs}ms — ${r3(ds / sec)}/s exceeds the ${CAMERA_MAX_ZOOM_PER_SEC}/s wall`,
        keyIndex: i,
      });
    }
  }
  return out;
}

/** The viewport must stay on the painted board (with its safe margin). */
function checkContainment(keys: CameraEvent[], width: number, height: number): CameraViolation[] {
  const out: CameraViolation[] = [];
  for (const [i, k] of keys.entries()) {
    const halfW = width / (2 * k.scale);
    const halfH = height / (2 * k.scale);
    const m = CAMERA_SAFE_MARGIN;
    if (
      k.cx - halfW < -m || k.cx + halfW > width + m ||
      k.cy - halfH < -m || k.cy + halfH > height + m
    ) {
      out.push({
        policy: "containment",
        reason: `camera key ${i} viewport (center ${r3(k.cx)},${r3(k.cy)} @${r3(k.scale)}) leaves the board's safe margins`,
        keyIndex: i,
      });
    }
  }
  return out;
}

/** Stable writing windows: a TRAVEL must not be in flight when a stroke
 *  starts — the eye locks onto the pen landing on a settled frame. Keys
 *  that hold the previous framing (no movement) are at rest by
 *  definition and never violate. */
function checkOnsetStability(keys: CameraEvent[], events: AnimationEvent[]): CameraViolation[] {
  const out: CameraViolation[] = [];
  const onsets = events
    .filter((e): e is Extract<AnimationEvent, { type: "draw_path" | "write_text" }> =>
      e.type === "draw_path" || e.type === "write_text")
    .map((e) => e.startMs);
  for (const onset of onsets) {
    for (const [i, k] of keys.entries()) {
      if (i === 0) continue; // the origin key never travels
      const prev = keys[i - 1];
      const moves = k.cx !== prev.cx || k.cy !== prev.cy || k.scale !== prev.scale;
      if (!moves || k.durationMs <= 0) continue; // at rest — nothing in flight
      if (k.startMs < onset && onset < k.startMs + k.durationMs) {
        out.push({
          policy: "onset-stability",
          reason: `a stroke starts at ${onset}ms while camera key ${i} is still traveling (${k.startMs}..${k.startMs + k.durationMs}ms) — the camera must rest before the pen lands`,
          keyIndex: i,
        });
      }
    }
  }
  return out;
}

/** The whole policy set in one call — what the validator runs. */
export function cameraPolicies(
  keys: CameraEvent[],
  events: AnimationEvent[],
  width: number,
  height: number
): CameraViolation[] {
  if (keys.length === 0) return [];
  return [
    ...checkMinTravel(keys),
    ...checkZoomSpeed(keys),
    ...checkContainment(keys, width, height),
    ...checkOnsetStability(keys, events),
  ];
}

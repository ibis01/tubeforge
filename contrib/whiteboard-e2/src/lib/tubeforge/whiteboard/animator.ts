// animator.ts — pure frame-state evaluator (E2 §5).
//
// The single source of truth for "what should the frame look like at time t".
// Pure: no I/O, no Date.now(), no Math.random. The composer renders whatever
// this returns; the rasterizer rasterizes whatever the composer emits; the
// encoder pipes whatever the rasterizer produces. Determinism of the whole
// pipeline reduces to determinism of this function.

import type {
  AnimationEvent,
  CameraEvent,
  PlacedAsset,
  WhiteboardProject,
  WhiteboardScene,
} from "./schemas";
import {
  applyEasing,
  clamp,
  pointAt,
  tangentAngleDeg,
  tangentAt,
  type SampledPath,
} from "./geometry";
import { assetRegistry } from "./asset-registry";

export interface FramePath {
  /** Original `d` attribute (so the composer can emit the path verbatim). */
  d: string;
  stroke: string;
  strokeWidth: number;
  /** dashArray = path length; dashOffset = length * (1 - progress). */
  dashArray: number;
  dashOffset: number;
  fill: string | null;
  fillOpacity: number;
  strokeLinecap: "butt" | "round" | "square";
  strokeLinejoin: "miter" | "round" | "bevel";
}

export interface FrameLayer {
  assetId: string;
  x: number;
  y: number;
  scale: number;
  opacity: number;
  /** Optional translate offset from a `move` event (canvas coords). */
  translateX: number;
  translateY: number;
  paths: FramePath[];
}

export interface FrameHand {
  x: number;
  y: number;
  angleDeg: number;
  visible: boolean;
}

export interface FrameCamera {
  x: number;
  y: number;
  scale: number;
}

export interface FrameState {
  background: string;
  layers: FrameLayer[];
  hand: FrameHand | null;
  camera: FrameCamera;
}

/**
 * Per-asset runtime state, computed fresh for each scene at frame time.
 * Resolves the placed asset's local geometry against the events whose
 * windows contain `tMs`.
 */
interface AssetRuntime {
  placed: PlacedAsset;
  /** Map pathId → geometry + draw state at tMs. */
  pathStates: Map<string, {
    progress: number;        // 0..1 reveal of the stroke
    fillOpacity: number;     // color_reveal state (0 unless event active)
    fill: string | null;     // override fill (color_reveal) or asset default
  }>;
  opacity: number;           // from `fade`
  translateX: number;        // from `move`
  translateY: number;
  /** True when a `draw` event is currently active for this asset. */
  hasActiveDraw: boolean;
  /** Latest end-point of the most recently completed draw event (canvas coords). */
  lastDrawEnd: { x: number; y: number } | null;
  /** Start point of the next imminent draw event (canvas coords). */
  nextDrawStart: { x: number; y: number } | null;
}

const HAND_TRAVEL_MAX_MS = 400; // cap on hand traveling between draw events

/**
 * Find the active scene for time `tMs` (global timeline). Returns null
 * after the last scene ends (the renderer pre-clips to the project duration).
 */
function sceneAt(project: WhiteboardProject, tMs: number): WhiteboardScene | null {
  for (const scene of project.scenes) {
    if (tMs >= scene.startMs && tMs < scene.startMs + scene.durationMs) {
      return scene;
    }
  }
  return null;
}

function interpolateCamera(events: CameraEvent[], tMs: number): FrameCamera {
  // Default: centered on canvas, scale 1
  let state: FrameCamera = { x: 960, y: 540, scale: 1 };
  for (const ev of events) {
    const local = tMs - ev.startMs;
    if (local < 0) continue;
    if (local >= ev.durationMs) {
      // event complete — hold its `to`
      state = { x: ev.to.x, y: ev.to.y, scale: ev.to.scale };
      continue;
    }
    const p = applyEasing(local / ev.durationMs, ev.easing);
    state = {
      x: ev.from.x + (ev.to.x - ev.from.x) * p,
      y: ev.from.y + (ev.to.y - ev.from.y) * p,
      scale: ev.from.scale + (ev.to.scale - ev.from.scale) * p,
    };
  }
  return state;
}

function buildAssetRuntime(
  scene: WhiteboardScene,
  tMs: number,
  localMs: number,
): AssetRuntime[] {
  return scene.assets.map((placed) => {
    const registry = assetRegistry();
    const pathStates = new Map<string, {
      progress: number;
      fillOpacity: number;
      fill: string | null;
    }>();
    let opacity = 1;
    let translateX = 0;
    let translateY = 0;
    let hasActiveDraw = false;
    let lastDrawEnd: { x: number; y: number } | null = null;
    let nextDrawStart: { x: number; y: number } | null = null;

    // Build a per-path progress map for draw + color_reveal events
    // (we walk events in startMs order; later events override earlier ones
    // only for the same pathId — typical case is one draw per path).
    const drawsByPath = new Map<string, AnimationEvent & { type: "draw" }>();
    const colorRevealByPath = new Map<string, AnimationEvent & { type: "color_reveal" }>();
    for (const ev of scene.events) {
      if (ev.assetId !== placed.assetId) continue;
      if (ev.type === "draw") drawsByPath.set(ev.pathId, ev);
      else if (ev.type === "color_reveal") colorRevealByPath.set(ev.pathId, ev);
    }

    // Pre-compute per-path progress (clamp + easing)
    for (const [pathId, ev] of drawsByPath) {
      const path = registry.path(placed.assetId, pathId);
      const local = localMs - ev.startMs;
      let progress: number;
      if (local <= 0) {
        progress = 0;
        // Register as next imminent draw
        if (local > -2000) {
          nextDrawStart = canvasPointAt(path, 0, placed);
        }
      } else if (local >= ev.durationMs) {
        progress = 1;
        lastDrawEnd = canvasPointAt(path, path.sampled.totalLength, placed);
      } else {
        progress = applyEasing(local / ev.durationMs, ev.easing);
        hasActiveDraw = true;
      }
      let fillOpacity = 0;
      let fill: string | null = null;
      const cr = colorRevealByPath.get(pathId);
      if (cr) {
        const clocal = localMs - cr.startMs;
        if (clocal <= 0) {
          fillOpacity = 0;
        } else if (clocal >= cr.durationMs) {
          fillOpacity = 1;
        } else {
          fillOpacity = applyEasing(clocal / cr.durationMs, "easeInOut");
        }
        fill = cr.fill;
      } else if (path.fill) {
        // Asset default fill, fade in after the path is fully drawn
        fillOpacity = progress >= 1 ? 1 : 0;
        fill = path.fill;
      }
      pathStates.set(pathId, { progress, fillOpacity, fill });
    }
    // Paths without an explicit draw event stay fully drawn (they are
    // already on the canvas — e.g. background scaffolding). The composer
    // emits them with progress=1.
    for (const ps of registry.extracted(placed.assetId).paths) {
      if (!pathStates.has(ps.id)) {
        pathStates.set(ps.id, {
          progress: 1,
          fillOpacity: ps.fill ? 1 : 0,
          fill: ps.fill,
        });
      }
    }

    // Fade events (asset-level opacity)
    for (const ev of scene.events) {
      if (ev.assetId !== placed.assetId) continue;
      if (ev.type !== "fade") continue;
      const local = localMs - ev.startMs;
      if (local <= 0) {
        opacity = 0;
      } else if (local >= ev.durationMs) {
        opacity = 1;
      } else {
        opacity = clamp(local / ev.durationMs, 0, 1);
      }
    }

    // Move events (translate offset)
    for (const ev of scene.events) {
      if (ev.assetId !== placed.assetId) continue;
      if (ev.type !== "move") continue;
      const local = localMs - ev.startMs;
      let p: number;
      if (local <= 0) p = 0;
      else if (local >= ev.durationMs) p = 1;
      else p = local / ev.durationMs;
      translateX = ev.from.x + (ev.to.x - ev.from.x) * p;
      translateY = ev.from.y + (ev.to.y - ev.from.y) * p;
    }

    return {
      placed,
      pathStates,
      opacity,
      translateX,
      translateY,
      hasActiveDraw,
      lastDrawEnd,
      nextDrawStart,
    };
  });
}

/** Convert a local path point (in the asset's viewBox) to canvas coordinates. */
function canvasPointAt(
  path: { sampled: SampledPath },
  len: number,
  placed: PlacedAsset,
): { x: number; y: number } {
  // Defensive: the path's sampled data lives in the asset's local viewBox
  // (typically 200x200). We scale to the placed size and offset to canvas
  // position. The composer applies the same transform; the hand uses it too.
  const pt = pointAt(path.sampled, len);
  return {
    x: placed.x + pt.x * placed.scale,
    y: placed.y + pt.y * placed.scale,
  };
}

function buildHand(
  scene: WhiteboardScene,
  localMs: number,
  runtime: AssetRuntime[],
  handStyle: "right" | "left" | "none",
): FrameHand | null {
  if (handStyle === "none") return null;

  // Find the asset currently being drawn
  let activeDraw: { runtime: AssetRuntime; ev: AnimationEvent & { type: "draw" } } | null = null;
  for (const rt of runtime) {
    for (const ev of scene.events) {
      if (ev.type !== "draw" || ev.assetId !== rt.placed.assetId) continue;
      const local = localMs - ev.startMs;
      if (local >= 0 && local < ev.durationMs) {
        activeDraw = { runtime: rt, ev };
        break;
      }
    }
    if (activeDraw) break;
  }

  if (activeDraw) {
    const { runtime: rt, ev } = activeDraw;
    const path = assetRegistry().path(rt.placed.assetId, ev.pathId);
    const local = localMs - ev.startMs;
    const p = applyEasing(clamp(local / ev.durationMs, 0, 1), ev.easing);
    const len = p * path.sampled.totalLength;
    const canvasPt = canvasPointAt(path, len, rt.placed);
    const tangent = tangentAt(path.sampled, len);
    let angleDeg = tangentAngleDeg(tangent);
    if (handStyle === "left") angleDeg = 180 - angleDeg;
    return { x: canvasPt.x, y: canvasPt.y, angleDeg, visible: true };
  }

  // No active draw — check for an imminent next draw to travel toward
  let earliestNext: { startMs: number; canvasPt: { x: number; y: number } } | null = null;
  for (const rt of runtime) {
    if (!rt.nextDrawStart) continue;
    // Find the actual event that produced nextDrawStart to read its startMs
    for (const ev of scene.events) {
      if (ev.type !== "draw" || ev.assetId !== rt.placed.assetId) continue;
      if (localMs - ev.startMs > -2000 && localMs - ev.startMs <= 0) {
        if (!earliestNext || ev.startMs < earliestNext.startMs) {
          earliestNext = { startMs: ev.startMs, canvasPt: rt.nextDrawStart! };
        }
      }
    }
  }

  // If we just finished a draw, travel from the last end toward the next start
  let lastEnd: { x: number; y: number } | null = null;
  for (const rt of runtime) {
    if (rt.lastDrawEnd) {
      lastEnd = rt.lastDrawEnd; // latest seen
    }
  }

  if (earliestNext && lastEnd) {
    const timeUntilNext = earliestNext.startMs - localMs;
    if (timeUntilNext <= 0 || timeUntilNext > HAND_TRAVEL_MAX_MS) {
      return null; // too far away — hide the hand
    }
    // Linear travel from lastEnd → earliestNext.canvasPt
    // over HAND_TRAVEL_MAX_MS ending at the next startMs.
    const travelStart = earliestNext.startMs - HAND_TRAVEL_MAX_MS;
    if (localMs < travelStart) return null;
    const p = clamp((localMs - travelStart) / HAND_TRAVEL_MAX_MS, 0, 1);
    return {
      x: lastEnd.x + (earliestNext.canvasPt.x - lastEnd.x) * p,
      y: lastEnd.y + (earliestNext.canvasPt.y - lastEnd.y) * p,
      angleDeg: 0,
      visible: true,
    };
  }

  return null;
}

function buildLayers(
  scene: WhiteboardScene,
  runtime: AssetRuntime[],
): FrameLayer[] {
  const registry = assetRegistry();
  const layers: FrameLayer[] = runtime.map((rt) => {
    const extracted = registry.extracted(rt.placed.assetId);
    const paths: FramePath[] = extracted.paths.map((ep) => {
      const st = rt.pathStates.get(ep.id)!;
      const L = ep.sampled.totalLength;
      return {
        d: ep.d,
        stroke: ep.stroke,
        strokeWidth: ep.strokeWidth,
        dashArray: L,
        dashOffset: L * (1 - st.progress),
        fill: st.fill,
        fillOpacity: st.fillOpacity,
        strokeLinecap: ep.strokeLinecap,
        strokeLinejoin: ep.strokeLinejoin,
      };
    });
    return {
      assetId: rt.placed.assetId,
      x: rt.placed.x,
      y: rt.placed.y,
      scale: rt.placed.scale,
      opacity: rt.opacity,
      translateX: rt.translateX,
      translateY: rt.translateY,
      paths,
    };
  });
  // Stable sort by layer, then by original order
  return layers
    .map((l, i) => ({ l, i }))
    .sort((a, b) => {
      const la = scene.assets[a.i].layer;
      const lb = scene.assets[b.i].layer;
      if (la !== lb) return la - lb;
      return a.i - b.i;
    })
    .map((x) => x.l);
}

/**
 * Evaluate the frame state at time `tMs` on the project's global timeline.
 *
 * Pure function. Determinism contract: same (project, tMs) → same FrameState
 * byte-for-byte (verified in the unit suite via deep equality).
 */
export function evaluateFrame(project: WhiteboardProject, tMs: number): FrameState {
  const scene = sceneAt(project, tMs);
  if (!scene) {
    // Past the last scene end — emit an empty frame (the renderer pre-clips
    // so this is defensive only).
    return {
      background: project.settings.background,
      layers: [],
      hand: null,
      camera: { x: 960, y: 540, scale: 1 },
    };
  }
  const localMs = tMs - scene.startMs;
  const runtime = buildAssetRuntime(scene, tMs, localMs);
  const layers = buildLayers(scene, runtime);
  const hand = buildHand(scene, localMs, runtime, project.settings.handStyle);
  const camera = interpolateCamera(scene.camera, localMs);
  return {
    background: project.settings.background,
    layers,
    hand,
    camera,
  };
}

/**
 * Project duration in milliseconds. The renderer renders exactly this many
 * frames at `1000/fps` ms each.
 */
export function projectDurationMs(project: WhiteboardProject): number {
  let end = 0;
  for (const s of project.scenes) {
    end = Math.max(end, s.startMs + s.durationMs);
  }
  return end;
}

// S64 — the Whiteboard Engine: the storyboard schema.
//
// The engine's data model, adapted to house conventions (the plan's §5:
// "adapted to TubeForge's existing type conventions rather than introduced
// as conflicting parallel definitions"). Hand-rolled validation with the
// parsePlan discipline: null on invalid, never throw on untrusted JSON.
//
// The scene is EDITABLE and REPRODUCIBLE by design: every visual change is
// an event with an identity, a start and a duration — the timeline editor
// (later phase) edits exactly these.
import type { Placement } from "./svg";

export type HandStyle = "marker" | "pencil" | "chalk";

/** Where an asset lives in the scene. */
export interface WhiteboardAssetPlacement {
  /** The asset-library id. */
  assetId: string;
  placement: Placement;
  /** Draw order across placements (lower first). Defaults to array order. */
  order?: number;
}

/** One drawing/motion instruction. The engine's atomic unit. */
export type AnimationEvent =
  | {
      type: "draw_path";
      assetId: string;
      pathId: string;
      startMs: number;
      durationMs: number;
    }
  | {
      type: "write_text";
      assetId: string;
      /** The <text> element id inside the asset. */
      textId: string;
      startMs: number;
      durationMs: number;
    }
  | {
      type: "reveal_color";
      assetId: string;
      /** Which path gains its fill (omit = the asset's colorable group). */
      pathId?: string;
      startMs: number;
      durationMs: number;
    }
  | {
      type: "move_object";
      assetId: string;
      startMs: number;
      durationMs: number;
      /** The placement to animate TO (from wherever the scene placed it). */
      to: Placement;
    };

/** A camera keyframe: viewport center (scene units) + zoom. */
export interface CameraEvent {
  startMs: number;
  /** Time to reach this state from the previous keyframe (0 = jump). */
  durationMs: number;
  cx: number;
  cy: number;
  scale: number;
}

export interface WhiteboardScene {
  id: string;
  narration: string;
  /** Narration WAV path (scratch-relative) when a real voiceover exists —
   *  the timing engine consumes its measured duration. */
  voFile?: string;
  /** Fallback duration when no VO: the timing engine derives from narration
   *  (2.6 wps, clamped) unless this is set. */
  durationMs?: number;
  background: "#ffffff" | "#f8f5ee";
  placements: WhiteboardAssetPlacement[];
  animations: AnimationEvent[];
  camera: CameraEvent[];
}

export interface WhiteboardProject {
  title: string;
  width: number;
  height: number;
  fps: number;
  hand: { style: HandStyle; scale: number };
  scenes: WhiteboardScene[];
}

// ---------------------------------------------------------------------------
// Validation — tolerant of field order, strict about integrity.
// ---------------------------------------------------------------------------

export interface ValidationResult {
  project: WhiteboardProject | null;
  errors: string[];
}

function isPlacement(v: unknown): v is Placement {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.x === "number" && Number.isFinite(p.x) &&
    typeof p.y === "number" && Number.isFinite(p.y) &&
    typeof p.scale === "number" && p.scale > 0 && Number.isFinite(p.scale) &&
    typeof p.rotateDeg === "number" && Number.isFinite(p.rotateDeg)
  );
}

function validEventTimes(e: { startMs?: unknown; durationMs?: unknown }): boolean {
  return (
    typeof e.startMs === "number" && e.startMs >= 0 &&
    typeof e.durationMs === "number" && e.durationMs > 0
  );
}

/**
 * Validate a parsed project JSON. `assetIds`/`pathIdsByAsset`/`textIdsByAsset`
 * come from the loaded library — events may only reference what exists.
 */
export function validateWhiteboardProject(
  raw: unknown,
  library: {
    assetIds: Set<string>;
    pathIdsByAsset: Map<string, Set<string>>;
    textIdsByAsset: Map<string, Set<string>>;
  }
): ValidationResult {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null) return { project: null, errors: ["not an object"] };
  const p = raw as Record<string, unknown>;

  const scenes: WhiteboardScene[] = [];
  if (!Array.isArray(p.scenes) || p.scenes.length === 0) {
    return { project: null, errors: ["scenes must be a non-empty array"] };
  }
  for (let i = 0; i < p.scenes.length; i++) {
    const s = p.scenes[i] as Record<string, unknown>;
    const id = typeof s.id === "string" && s.id ? s.id : `scene-${i + 1}`;
    if (typeof s.narration !== "string" || !s.narration.trim()) {
      errors.push(`scene ${i + 1}: narration missing`);
      continue;
    }
    const background = s.background === "#f8f5ee" ? "#f8f5ee" : "#ffffff";
    const placements: WhiteboardAssetPlacement[] = [];
    const seenAssets = new Set<string>();
    for (const pl of Array.isArray(s.placements) ? s.placements : []) {
      const e = pl as Record<string, unknown>;
      if (typeof e.assetId !== "string" || !library.assetIds.has(e.assetId)) {
        errors.push(`scene ${i + 1}: unknown asset "${String(e.assetId)}"`);
        continue;
      }
      if (seenAssets.has(e.assetId)) {
        errors.push(`scene ${i + 1}: asset "${e.assetId}" placed twice (move_object instead)`);
        continue;
      }
      seenAssets.add(e.assetId);
      if (!isPlacement(e.placement)) {
        errors.push(`scene ${i + 1}: asset "${e.assetId}" has an invalid placement`);
        continue;
      }
      placements.push({
        assetId: e.assetId,
        placement: e.placement,
        order: typeof e.order === "number" ? e.order : undefined,
      });
    }
    const animations: AnimationEvent[] = [];
    for (const a of Array.isArray(s.animations) ? s.animations : []) {
      const e = a as Record<string, unknown>;
      const type = String(e.type);
      const assetOk = typeof e.assetId === "string" && library.assetIds.has(e.assetId);
      if (!assetOk) {
        errors.push(`scene ${i + 1}: animation references unknown asset "${String(e.assetId)}"`);
        continue;
      }
      if (!validEventTimes(e)) {
        errors.push(`scene ${i + 1}: ${type} needs startMs ≥ 0 and durationMs > 0`);
        continue;
      }
      if (type === "draw_path") {
        const paths = library.pathIdsByAsset.get(String(e.assetId)) ?? new Set<string>();
        if (typeof e.pathId !== "string" || !paths.has(e.pathId)) {
          errors.push(`scene ${i + 1}: draw_path references unknown path "${String(e.pathId)}"`);
          continue;
        }
        animations.push({ type, assetId: String(e.assetId), pathId: String(e.pathId), startMs: e.startMs as number, durationMs: e.durationMs as number });
      } else if (type === "write_text") {
        const texts = library.textIdsByAsset.get(String(e.assetId)) ?? new Set<string>();
        if (typeof e.textId !== "string" || !texts.has(e.textId)) {
          errors.push(`scene ${i + 1}: write_text references unknown text "${String(e.textId)}"`);
          continue;
        }
        animations.push({ type, assetId: String(e.assetId), textId: String(e.textId), startMs: e.startMs as number, durationMs: e.durationMs as number });
      } else if (type === "reveal_color") {
        if (e.pathId !== undefined) {
          const paths = library.pathIdsByAsset.get(String(e.assetId)) ?? new Set<string>();
          if (typeof e.pathId !== "string" || !paths.has(e.pathId)) {
            errors.push(`scene ${i + 1}: reveal_color references unknown path "${String(e.pathId)}"`);
            continue;
          }
        }
        animations.push({ type, assetId: String(e.assetId), pathId: e.pathId as string | undefined, startMs: e.startMs as number, durationMs: e.durationMs as number });
      } else if (type === "move_object") {
        if (!isPlacement(e.to)) {
          errors.push(`scene ${i + 1}: move_object needs a valid target placement`);
          continue;
        }
        animations.push({ type, assetId: String(e.assetId), startMs: e.startMs as number, durationMs: e.durationMs as number, to: e.to });
      } else {
        errors.push(`scene ${i + 1}: unknown animation type "${type}"`);
      }
    }
    const camera: CameraEvent[] = [];
    for (const c of Array.isArray(s.camera) ? s.camera : []) {
      const e = c as Record<string, unknown>;
      if (
        typeof e.cx !== "number" || !Number.isFinite(e.cx) ||
        typeof e.cy !== "number" || !Number.isFinite(e.cy) ||
        typeof e.scale !== "number" || !(e.scale > 0) ||
        typeof e.startMs !== "number" || e.startMs < 0 ||
        typeof e.durationMs !== "number" || e.durationMs < 0
      ) {
        errors.push(`scene ${i + 1}: malformed camera keyframe`);
        continue;
      }
      camera.push({ cx: e.cx, cy: e.cy, scale: e.scale, startMs: e.startMs, durationMs: e.durationMs });
    }
    if (camera.length === 0) camera.push({ cx: 960, cy: 540, scale: 1, startMs: 0, durationMs: 0 });
    camera.sort((a, b) => a.startMs - b.startMs);
    scenes.push({
      id,
      narration: s.narration,
      voFile: typeof s.voFile === "string" ? s.voFile : undefined,
      durationMs: typeof s.durationMs === "number" && s.durationMs > 0 ? s.durationMs : undefined,
      background,
      placements,
      animations,
      camera,
    });
  }
  if (errors.length > 0 || scenes.length === 0) return { project: null, errors };

  const handScale = typeof p.hand === "object" && p.hand !== null && typeof (p.hand as Record<string, unknown>).scale === "number"
    ? Math.max(0.2, Math.min(4, (p.hand as Record<string, unknown>).scale as number))
    : 1;
  const handStyle: HandStyle =
    typeof p.hand === "object" && p.hand !== null && (p.hand as Record<string, unknown>).style === "pencil"
      ? "pencil"
      : (p.hand as Record<string, unknown>)?.style === "chalk" ? "chalk" : "marker";

  return {
    project: {
      title: typeof p.title === "string" && p.title ? p.title : "Untitled whiteboard",
      width: typeof p.width === "number" && p.width >= 320 && p.width <= 3840 ? Math.round(p.width) : 1920,
      height: typeof p.height === "number" && p.height >= 320 && p.height <= 3840 ? Math.round(p.height) : 1080,
      fps: typeof p.fps === "number" && p.fps >= 12 && p.fps <= 60 ? Math.round(p.fps) : 24,
      hand: { style: handStyle, scale: handScale },
      scenes,
    },
    errors: [],
  };
}

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
import { cameraPolicies } from "./camera-director";

export type HandStyle = "marker" | "pencil" | "chalk";
/** W7 — which hand holds the tool (additive; absent = right, today). */
export type HandSide = "left" | "right";

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
  /** W6 (S120 §3) — the board policy: how this scene relates to the board
   *  the previous scene drew. ABSENT = a clean scene (today's hard wipe,
   *  byte-for-byte — the additive-parse law). */
  board?: BoardPolicy;
}

// ---------------------------------------------------------------------------
// W6 — the board policy: scenes can CARRY the board (keep/fade/erase/
// pan-away) instead of four hard board-wipes per video (the continuity
// row the W1 baseline scored 1/5). The carried ink is DATA resolved from
// the previous scene's placements at the render seam — never page residue
// (per-scene chromium recycling stays untouched; the S75 OOM receipt is
// the reason).
// ---------------------------------------------------------------------------

export type BoardMode = "clean" | "continuous";
export type BoardExit = "keep" | "fade" | "erase" | "pan-away";

export interface BoardPolicy {
  /** "clean" = the hard wipe (default); "continuous" = inherit the
   *  previous scene's ink at frame 0. */
  mode: BoardMode;
  /** Which of the PREVIOUS scene's placements carry forward (assetIds).
   *  Absent/empty = every placement carries. */
  carryPlacements?: string[];
  /** How the carried ink leaves this scene's stage. Default "keep". */
  exit?: BoardExit;
  /** The exit transition's duration (ms). Default
   *  BOARD_EXIT_DEFAULT_MS, bounded by BOARD_TRANSITION_MS_MAX. */
  transitionMs?: number;
}

export const BOARD_EXITS: readonly BoardExit[] = ["keep", "fade", "erase", "pan-away"];
export const BOARD_EXIT_DEFAULT_MS = 600;
export const BOARD_TRANSITION_MS_MAX = 5000;

function isBoardPolicy(v: unknown): v is BoardPolicy {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Record<string, unknown>;
  if (b.mode !== "clean" && b.mode !== "continuous") return false;
  if (b.exit !== undefined && !BOARD_EXITS.includes(b.exit as BoardExit)) return false;
  if (b.transitionMs !== undefined && (typeof b.transitionMs !== "number" || !(b.transitionMs > 0) || b.transitionMs > BOARD_TRANSITION_MS_MAX)) return false;
  if (b.carryPlacements !== undefined && (!Array.isArray(b.carryPlacements) || b.carryPlacements.some((c) => typeof c !== "string"))) return false;
  return true;
}

export interface WhiteboardProject {
  title: string;
  width: number;
  height: number;
  fps: number;
  hand: { style: HandStyle; scale: number; /** W7 — absent = right. */ side?: HandSide };
  /** W7 — optional whiteboard SFX (pen strokes, page turns). OFF by
   *  default (decision §10.4); audio-only, frames never depend on it. */
  sfxOn?: boolean;
  scenes: WhiteboardScene[];
}

// ---------------------------------------------------------------------------
// Validation — tolerant of field order, strict about integrity.
// ---------------------------------------------------------------------------

export interface ValidationResult {
  project: WhiteboardProject | null;
  errors: string[];
}

// -------------------------------------------------------------------------
// S65 (E1) — the id-charset law + the resource budgets.
//
// The renderer namespaces DOM ids as `${assetId}--${pathId}` and frame-plan
// keys as `assetId::pathId` (render.ts composeScene / the applier's id
// maps). An id carrying either separator — or characters outside this
// charset — corrupts that seam. The law applies at BOTH layers: the
// library loader excludes violating ids from the drawable index, and the
// project validator rejects them here (defense in depth: a hand-edited
// project JSON is untrusted input like any other).
// -------------------------------------------------------------------------

/** Legal whiteboard id: starts alnum/underscore, then alnum/_.- , ≤ 64
 *  chars, and never contains the namespace separators `--` / `::`. */
export const WB_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

export function validWhiteboardId(id: string): boolean {
  return WB_ID_RE.test(id) && !id.includes("--") && !id.includes("::");
}

/** E1 resource budgets — the E0 audit §6 risks 2 + 4, pinned as constants
 *  so the validator, the tests, and WHITEBOARD_ENGINE_DESIGN.md §6 cite
 *  ONE source. Per-path command + per-asset totals live in assets.ts
 *  (extraction-time); the frame budget lives in timing.ts (render
 *  pre-flight). */
export const WB_BUDGETS = {
  /** Max scenes per project. */
  scenesPerProject: 24,
  /** Max asset placements per scene. */
  placementsPerScene: 64,
  /** Max animation events per scene. */
  animationsPerScene: 256,
  /** Max camera keyframes per scene. */
  cameraKeysPerScene: 32,
  /** Max EXPLICIT scene duration (narration estimates clamp lower). */
  sceneDurationMsMax: 120_000,
  /** Max Σ explicit scene durations (VO-measured totals are bounded at
   *  render pre-flight by the frame budget instead). */
  projectExplicitDurationMsMax: 900_000,
} as const;

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

  // S68 — the project dimensions parsed ONCE here (same clamp as the tail):
  // the default camera key inserted below must center on the dimensions the
  // project will actually carry, or a 9:16 board starts with its viewport
  // pinned to a 16:9 center (960, 540 — off the right edge of a 1080-wide
  // canvas).
  const projW = typeof p.width === "number" && p.width >= 320 && p.width <= 3840 ? Math.round(p.width) : 1920;
  const projH = typeof p.height === "number" && p.height >= 320 && p.height <= 3840 ? Math.round(p.height) : 1080;

  const scenes: WhiteboardScene[] = [];
  if (!Array.isArray(p.scenes) || p.scenes.length === 0) {
    return { project: null, errors: ["scenes must be a non-empty array"] };
  }
  if (p.scenes.length > WB_BUDGETS.scenesPerProject) {
    return {
      project: null,
      errors: [`scenes: ${p.scenes.length} exceeds the ${WB_BUDGETS.scenesPerProject}-scene project budget`],
    };
  }
  let explicitDurationTotalMs = 0;
  for (let i = 0; i < p.scenes.length; i++) {
    const s = p.scenes[i] as Record<string, unknown>;
    const id = typeof s.id === "string" && s.id ? s.id : `scene-${i + 1}`;
    // S65: an EXPLICIT id must respect the namespace charset (a missing id
    // still gets the safe default). `--`/`::` would corrupt the renderer's
    // id seam; stray characters would break DOM addressing.
    if (typeof s.id === "string" && s.id && !validWhiteboardId(s.id)) {
      errors.push(`scene ${i + 1}: id "${s.id.slice(0, 40)}" violates the id charset (namespace separators --/:: and exotic characters are forbidden)`);
      continue;
    }
    if (typeof s.narration !== "string" || !s.narration.trim()) {
      errors.push(`scene ${i + 1}: narration missing`);
      continue;
    }
    if (
      typeof s.durationMs === "number" &&
      (s.durationMs > WB_BUDGETS.sceneDurationMsMax || s.durationMs <= 0)
    ) {
      errors.push(`scene ${i + 1}: durationMs ${s.durationMs} is outside the (0, ${WB_BUDGETS.sceneDurationMsMax}] budget`);
      continue;
    }
    if (typeof s.durationMs === "number" && s.durationMs > 0) {
      explicitDurationTotalMs += s.durationMs;
    }
    const background = s.background === "#f8f5ee" ? "#f8f5ee" : "#ffffff";
    // W6 — the board policy, parsed BEFORE the placements so the carry
    // integrity checks (below) can gate them. Tolerant-read law: a doc with
    // no `board` field parses as a clean scene — everything else about the
    // scene is unchanged.
    let board: BoardPolicy | undefined;
    if (s.board !== undefined) {
      if (!isBoardPolicy(s.board)) {
        errors.push(
          `scene ${i + 1}: board must be { mode: "clean" | "continuous", carryPlacements?: string[], exit?: ${BOARD_EXITS.join("|")}, transitionMs?: (0, ${BOARD_TRANSITION_MS_MAX}] }`
        );
        continue;
      }
      const b = s.board as BoardPolicy;
      if (b.mode === "clean") {
        if (b.carryPlacements !== undefined || b.exit !== undefined || b.transitionMs !== undefined) {
          errors.push(`scene ${i + 1}: a clean board takes no carry/exit fields — those belong to mode "continuous"`);
          continue;
        }
      } else {
        // continuous: the FIRST scene has no board to inherit.
        if (i === 0) {
          errors.push(`scene ${i + 1}: the first scene has no board to carry (mode "continuous" needs a previous scene)`);
          continue;
        }
        if (b.exit !== undefined && b.transitionMs !== undefined && b.exit === "keep") {
          errors.push(`scene ${i + 1}: a "keep" exit takes no transitionMs (nothing transitions)`);
          continue;
        }
        // The carry's integrity against the PREVIOUS RAW scene: the named
        // placements must exist there, and a carried asset may not be
        // re-placed here (duplicate ink + ambiguous ids at the page seam).
        const prevRaw = p.scenes[i - 1] as Record<string, unknown> | undefined;
        const prevPlaced = new Set<string>(
          (Array.isArray(prevRaw?.placements) ? (prevRaw.placements as Record<string, unknown>[]) : [])
            .map((pl) => (typeof pl.assetId === "string" ? pl.assetId : ""))
            .filter(Boolean)
        );
        const carryNames = Array.isArray(b.carryPlacements) ? (b.carryPlacements as string[]) : [];
        if (new Set(carryNames).size !== carryNames.length) {
          errors.push(`scene ${i + 1}: carryPlacements names an asset twice`);
          continue;
        }
        let carryOk = true;
        for (const name of carryNames) {
          if (!prevPlaced.has(name)) {
            errors.push(`scene ${i + 1}: carryPlacements names "${name.slice(0, 40)}", which the previous scene does not place`);
            carryOk = false;
          }
        }
        if (!carryOk) continue;
        // The carried set (named subset, or ALL of the previous scene's
        // placements) must not reappear in this scene's own placements —
        // checked after placements parse, below.
        board = { ...b };
      }
    }
    const carriedAssets: Set<string> | null =
      board?.mode === "continuous"
        ? new Set(
            board.carryPlacements && board.carryPlacements.length > 0
              ? board.carryPlacements
              : (Array.isArray((p.scenes[i - 1] as Record<string, unknown> | undefined)?.placements)
                  ? ((p.scenes[i - 1] as Record<string, unknown>).placements as Record<string, unknown>[])
                      .map((pl) => (typeof pl.assetId === "string" ? pl.assetId : ""))
                      .filter(Boolean)
                  : [])
          )
        : null;
    const placements: WhiteboardAssetPlacement[] = [];
    const seenAssets = new Set<string>();
    const rawPlacements = Array.isArray(s.placements) ? s.placements : [];
    if (rawPlacements.length > WB_BUDGETS.placementsPerScene) {
      errors.push(`scene ${i + 1}: ${rawPlacements.length} placements exceed the ${WB_BUDGETS.placementsPerScene}/scene budget`);
      continue;
    }
    for (const pl of rawPlacements) {
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
    // W6 — a carried asset may not be re-placed in the scene that carries it
    // (duplicate ink on the board, and the page's namespaced element ids
    // would collide). The carried set is computed above from the carry
    // names (or all of the previous scene's placements).
    if (carriedAssets) {
      for (const a of seenAssets) {
        if (carriedAssets.has(a)) {
          errors.push(`scene ${i + 1}: asset "${a}" is carried AND re-placed — carried ink must not be placed again (drop the placement or narrow carryPlacements)`);
        }
      }
    }
    const animations: AnimationEvent[] = [];
    const rawAnimations = Array.isArray(s.animations) ? s.animations : [];
    if (rawAnimations.length > WB_BUDGETS.animationsPerScene) {
      errors.push(`scene ${i + 1}: ${rawAnimations.length} animation events exceed the ${WB_BUDGETS.animationsPerScene}/scene budget`);
      continue;
    }
    for (const a of rawAnimations) {
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
      // W6 — animations may not target a carried asset: the carried layer
      // owns those elements' transforms and reveal state for the whole
      // scene, so a draw/write/reveal/move would fight the carry plan.
      if (carriedAssets?.has(String(e.assetId))) {
        errors.push(`scene ${i + 1}: animation targets carried asset "${String(e.assetId)}" — carried ink is fully drawn at frame 0 and owned by the carry plan`);
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
    const rawCamera = Array.isArray(s.camera) ? s.camera : [];
    if (rawCamera.length > WB_BUDGETS.cameraKeysPerScene) {
      errors.push(`scene ${i + 1}: ${rawCamera.length} camera keyframes exceed the ${WB_BUDGETS.cameraKeysPerScene}/scene budget`);
      continue;
    }
    for (const c of rawCamera) {
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
    // W5: a cameraless scene stays EMPTY — the drift fallback (the
    // no-camera-keys law, timing.ts cameraAt) owns the motion. The old
    // dimension-aware center key insertion is gone: it would silently
    // DEMOTE the drift (an inserted key counts as authored work) and
    // freeze the W1 baseline's calibrated motion. The render-time
    // fallback centers on the project's own dimensions anyway — the
    // same numbers, one source.
    camera.sort((a, b) => a.startMs - b.startMs);
    // W5 — the camera policies: authored keys are CHECKED, never silently
    // clamped (the spec: an invalid CameraEvent[] is a validation error).
    // A cameraless scene has nothing to check; the drift fallback's
    // motion is the scheduler's own calibrated behavior.
    if (camera.length > 0) {
      for (const v of cameraPolicies(camera, animations, projW, projH)) {
        errors.push(`scene ${i + 1}: ${v.reason}`);
      }
    }
    scenes.push({
      id,
      narration: s.narration,
      voFile: typeof s.voFile === "string" ? s.voFile : undefined,
      durationMs: typeof s.durationMs === "number" && s.durationMs > 0 ? s.durationMs : undefined,
      background,
      placements,
      animations,
      camera,
      board,
    });
  }
  if (errors.length > 0 || scenes.length === 0) return { project: null, errors };
  if (explicitDurationTotalMs > WB_BUDGETS.projectExplicitDurationMsMax) {
    errors.push(`Σ explicit scene durations ${Math.round(explicitDurationTotalMs / 1000)}s exceeds the ${WB_BUDGETS.projectExplicitDurationMsMax / 1000}s project budget`);
    return { project: null, errors };
  }

  const handScale = typeof p.hand === "object" && p.hand !== null && typeof (p.hand as Record<string, unknown>).scale === "number"
    ? Math.max(0.2, Math.min(4, (p.hand as Record<string, unknown>).scale as number))
    : 1;
  const handStyle: HandStyle =
    typeof p.hand === "object" && p.hand !== null && (p.hand as Record<string, unknown>).style === "pencil"
      ? "pencil"
      : (p.hand as Record<string, unknown>)?.style === "chalk" ? "chalk" : "marker";
  const handSide: HandSide | undefined =
    typeof p.hand === "object" && p.hand !== null && (p.hand as Record<string, unknown>).side === "left"
      ? "left"
      : undefined;

  return {
    project: {
      title: typeof p.title === "string" && p.title ? p.title : "Untitled whiteboard",
      width: projW,
      height: projH,
      fps: typeof p.fps === "number" && p.fps >= 12 && p.fps <= 60 ? Math.round(p.fps) : 24,
      hand: { style: handStyle, scale: handScale, ...(handSide ? { side: handSide } : {}) },
      // Strict boolean write: absent/false reads off; anything else is not on.
      ...(p.sfxOn === true ? { sfxOn: true } : {}),
      scenes,
    },
    errors: [],
  };
}

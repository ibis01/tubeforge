// P5 — the production profiles: the configuration layer the audit named
// (§I.6: "the per-project knobs that today are scattered — hand {style,
// scale, side}, sfxOn, per-scene background + BoardPolicy — a profile
// layer over per-project config"). The five recipes ride the operator's
// own roster (Classic Whiteboard / Storytelling / Mathematical &
// Scientific / Technical & Engineering / Modern Motion).
//
// The laws this module obeys:
//   PURE — no fs, no clock, no randomness; applyWhiteboardProfile is a
//   pure function (never mutates its input, deterministic output).
//   ADDITIVE — a project without a profile field is byte-identical to
//   its pre-P5 shape; the renderer, the scheduler and the editor read
//   the SAME per-project knobs they always did (hand, sfxOn, scene
//   background, board policies). The profile never grows the event
//   grammar, never touches the frame clock, never adds a knob the
//   pipeline does not already consume.
//   HONEST — a profile only writes what its recipe actually contains;
//   an unknown profile id is a no-op that reports itself; an authored
//   choice (a scene background a user picked deliberately, an explicit
//   board policy) is NEVER overwritten by a later profile apply.
//
// Scope note (the P5 ladder's honest line): stroke-texture knobs
// (roughness/bowing per asset) and camera temperament stay OUT of v1 —
// the library's sketch passes ride global derivation (the W1 determinism
// pins), and the camera director's constants carry their own W5
// receipts. The profile stamps what it changed onto the project (`profile`)
// so the UI can say what a recipe did.

import type { BoardExit, BoardMode, HandSide, HandStyle, WhiteboardProject } from "./storyboard";

// ---------------------------------------------------------------------------
// The five ids — the operator's roster, frozen (saved docs cite these).
// ---------------------------------------------------------------------------

export const WHITEBOARD_PROFILE_IDS = [
  "classic-whiteboard",
  "storytelling",
  "mathematical-scientific",
  "technical-engineering",
  "modern-motion",
] as const;

export type WhiteboardProfileId = (typeof WHITEBOARD_PROFILE_IDS)[number];

// ---------------------------------------------------------------------------
// The recipe — every field maps onto a knob the pipeline already reads.
// ---------------------------------------------------------------------------

export interface WhiteboardProfileRecipe {
  /** The pen the scenes ride: hand asset family + display scale + side. */
  hand: { style: HandStyle; scale: number; side?: HandSide };
  /** Whiteboard SFX (pen strokes) — audio-only, frames never depend on it. */
  sfxOn?: boolean;
  /** Scene background for scenes that carry NO authored color (the house
   *  default "#ffffff" counts as un-authored — a deliberate non-default
   *  paper is never overridden). The two allowed papers are the scene
   *  type's own union — the profile introduces NO new color. */
  sceneBackground?: "#ffffff" | "#f8f5ee";
  /** Default board policy for scenes that carry NO explicit one. */
  board?: { mode: BoardMode; exit?: BoardExit };
}

export interface WhiteboardProfileMeta {
  id: WhiteboardProfileId;
  label: string;
  description: string;
  recipe: WhiteboardProfileRecipe;
}

// The five profiles. Values are conservative deltas from the house
// default (the classic recipe IS the W1 baseline shape — marker, scale 1,
// clean board, white, no SFX), so every profile stays inside the budgets
// the W1 baseline proved.
export const WHITEBOARD_PROFILES: Record<WhiteboardProfileId, WhiteboardProfileMeta> = {
  "classic-whiteboard": {
    id: "classic-whiteboard",
    label: "Classic Whiteboard",
    description:
      "The house baseline: marker pen, clean board per scene, plain white paper. What the W1 benchmark scores is this recipe.",
    recipe: {
      hand: { style: "marker", scale: 1 },
      sfxOn: false,
      sceneBackground: "#ffffff",
      board: { mode: "clean" },
    },
  },
  storytelling: {
    id: "storytelling",
    label: "Storytelling",
    description:
      "Pencil warmth and a continuous board: scenes flow into each other instead of wiping, pen sounds ride along, paper leans cream.",
    recipe: {
      hand: { style: "pencil", scale: 1.05 },
      sfxOn: true,
      sceneBackground: "#f8f5ee",
      board: { mode: "continuous", exit: "keep" },
    },
  },
  "mathematical-scientific": {
    id: "mathematical-scientific",
    label: "Mathematical & Scientific",
    description:
      "A slightly larger marker for formulas and diagrams, strict clean boards, pure white — readability first, exactly as the science lane ships.",
    recipe: {
      hand: { style: "marker", scale: 1.1 },
      sfxOn: false,
      sceneBackground: "#ffffff",
      board: { mode: "clean" },
    },
  },
  "technical-engineering": {
    id: "technical-engineering",
    label: "Technical & Engineering",
    description:
      "Fine pencil line-work on clean white, left-hand option off, no sound — the drafting-table feel for schematics and process diagrams.",
    recipe: {
      hand: { style: "pencil", scale: 1.15 },
      sfxOn: false,
      sceneBackground: "#ffffff",
      board: { mode: "clean" },
    },
  },
  "modern-motion": {
    id: "modern-motion",
    label: "Modern Motion",
    description:
      "A bolder pen and scenes that exit with a pan — the snappier, social-cut feel. Audio stays off; motion comes from the board exits.",
    recipe: {
      hand: { style: "marker", scale: 1.2 },
      sfxOn: false,
      sceneBackground: "#ffffff",
      board: { mode: "clean", exit: "pan-away" },
    },
  },
};

/** The house default background — a scene whose color equals this counts
 *  as un-authored (profile-apply may restyle it). */
export const WB_DEFAULT_SCENE_BACKGROUND = "#ffffff";

/** Resolve one profile meta — null on an unknown id (callers decide
 *  whether that is an error; the applier treats it as a no-op). */
export function resolveWhiteboardProfile(id: string | undefined | null): WhiteboardProfileMeta | null {
  if (!id) return null;
  return (WHITEBOARD_PROFILES as Record<string, WhiteboardProfileMeta>)[id] ?? null;
}

export interface WhiteboardProfileApplyReport {
  /** The applied profile id (null = nothing applied). */
  applied: WhiteboardProfileId | null;
  /** Scene ids whose background the recipe restyled. */
  backgroundsChanged: string[];
  /** Scene ids whose board policy the recipe defaulted. */
  boardPoliciesChanged: string[];
  handChanged: boolean;
  sfxChanged: boolean;
}

/** Apply one profile's recipe ONTO a project copy — PURE. Absent or
 *  unknown id → the input content is returned unchanged (byte-identical
 *  fields; the report says nothing was applied). Authored choices are
 *  never overwritten: a scene background that is present and is NOT the
 *  house default, and a scene with an explicit boardPolicy, stay as the
 *  author wrote them. */
export function applyWhiteboardProfile(
  project: WhiteboardProject,
  profileId: string | undefined | null
): { project: WhiteboardProject; report: WhiteboardProfileApplyReport } {
  const meta = resolveWhiteboardProfile(profileId);
  const report: WhiteboardProfileApplyReport = {
    applied: null,
    backgroundsChanged: [],
    boardPoliciesChanged: [],
    handChanged: false,
    sfxChanged: false,
  };
  if (!meta) return { project, report };

  const next: WhiteboardProject = {
    ...project,
    profile: meta.id,
    hand: {
      style: meta.recipe.hand.style,
      scale: meta.recipe.hand.scale,
      ...(meta.recipe.hand.side !== undefined ? { side: meta.recipe.hand.side } : {}),
    },
    ...(meta.recipe.sfxOn !== undefined ? { sfxOn: meta.recipe.sfxOn } : {}),
    scenes: project.scenes.map((scene) => {
      const bgAuthored =
        scene.background !== undefined && scene.background !== WB_DEFAULT_SCENE_BACKGROUND;
      const boardAuthored = scene.board !== undefined;
      const background =
        bgAuthored || meta.recipe.sceneBackground === undefined
          ? scene.background
          : meta.recipe.sceneBackground;
      const board =
        boardAuthored || meta.recipe.board === undefined ? scene.board : { ...meta.recipe.board };
      if (background !== scene.background) report.backgroundsChanged.push(scene.id);
      if (board !== scene.board) report.boardPoliciesChanged.push(scene.id);
      return {
        ...scene,
        ...(background !== scene.background ? { background } : {}),
        ...(board !== scene.board ? { board } : {}),
      };
    }),
  };
  report.applied = meta.id;
  report.handChanged =
    project.hand.style !== next.hand.style ||
    project.hand.scale !== next.hand.scale ||
    project.hand.side !== next.hand.side;
  report.sfxChanged = project.sfxOn !== next.sfxOn;
  return { project: next, report };
}

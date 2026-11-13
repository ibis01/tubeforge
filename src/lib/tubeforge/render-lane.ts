import { RENDER_MODES } from "./types";

/**
 * S119 — THE LANE CONTRACT (pure resolver).
 *
 * The row's `renderMode` is the lane truth (the S87 shared path: a
 * whiteboard video renders through its engine lane), but the render
 * body's `mode` is the user's CLICK — the detail dialog's mode picker
 * (which lists Whiteboard alongside the story modes) is local state that
 * only reaches the server in the POST /render body. Before S119 an
 * explicit `mode: "whiteboard"` was silently degraded to "kenburns" (it
 * is not a story sub-mode), so a user who picked Whiteboard in the
 * picker, scaffolded a project in the Whiteboard Studio and hit the big
 * Render button got a Ken Burns video over the storyboard art — the
 * exact "the whiteboard image had generated but nothing to show" report.
 *
 * The resolver closes the loop at admission time:
 *   - an explicit "whiteboard" pins the row to the whiteboard lane;
 *   - an explicit story mode on a whiteboard row flips it back (the
 *     mode-drift law's admission-time twin — the row holds the user's
 *     latest explicit truth, so job replays and bare callers agree);
 *   - a silent (or unrecognized) body defers to the row as before.
 *
 * Pure on purpose: the truth table below is unit-pinned, and the route
 * stays a thin persist-and-dispatch shell around it.
 */

/** The story lane's sub-modes — every RENDER_MODES id except the whiteboard lane. */
export type StoryRenderMode = "kenburns" | "stock" | "slides" | "animated";

const STORY_MODE_IDS: readonly StoryRenderMode[] = ["kenburns", "stock", "slides", "animated"];

export function isStoryRenderMode(mode: string | null | undefined): mode is StoryRenderMode {
  return (STORY_MODE_IDS as readonly string[]).includes(mode ?? "");
}

export type RenderLane = "whiteboard" | "story";

export interface RenderLaneResolution {
  /** The engine lane this render must run through. */
  lane: RenderLane;
  /**
   * The row update to persist BEFORE admission (null = the row already
   * agrees; no write). This is the same update PATCH /api/videos/[id]
   * applies for a manual mode switch — the route has already established
   * format "story" (the whiteboard lane's only legal format) by the time
   * this runs.
   */
  pinRenderMode: StoryRenderMode | "whiteboard" | null;
}

/**
 * Resolve the render lane from the body's explicit `mode` (the click) and
 * the row's `renderMode` (the standing truth). See the module comment for
 * the law; the unit suite pins every row of this table.
 */
export function resolveRenderLane(
  bodyMode: string | null,
  rowRenderMode: string | null
): RenderLaneResolution {
  // Explicit whiteboard ask: take the engine lane, pinning the row when
  // it does not already agree (idempotent — no redundant write).
  if (bodyMode === "whiteboard") {
    return {
      lane: "whiteboard",
      pinRenderMode: rowRenderMode === "whiteboard" ? null : "whiteboard",
    };
  }
  // Explicit story ask on a whiteboard row: the user switched lanes in
  // the picker — flip the row, then the story gates below apply honestly.
  if (isStoryRenderMode(bodyMode) && rowRenderMode === "whiteboard") {
    return { lane: "story", pinRenderMode: bodyMode };
  }
  // Silent or unrecognized body: the row is the truth (garbage never
  // flips a lane — a buggy caller cannot silently kill a whiteboard row).
  return {
    lane: rowRenderMode === "whiteboard" ? "whiteboard" : "story",
    pinRenderMode: null,
  };
}

/**
 * Lockstep law (the priors-table twin): every id the mode picker can send
 * must have a lane decision here. RENDER_MODES minus "whiteboard" must be
 * exactly STORY_MODE_IDS — a new picker mode that forgets its lane row
 * fails this check (and the unit suite that pins it).
 */
export function laneDecisionsComplete(): boolean {
  const pickerIds = RENDER_MODES.map((m) => m.id).filter((id) => id !== "whiteboard");
  return (
    pickerIds.length === STORY_MODE_IDS.length &&
    pickerIds.every((id) => (STORY_MODE_IDS as readonly string[]).includes(id))
  );
}

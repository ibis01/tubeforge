// W7 — the whiteboard SFX cue planner (S120 §3 W7, decision §10.4).
//
// PURE and deterministic: the cue list is a pure function of the project,
// the estimator's clamped scene durations, and the shared frame-quantized
// clock — the SAME clock the tracks and the render loop read (one source;
// cues can never drift from the picture they accent). The renderer turns
// cues into ffmpeg adelay/volume chains and amixes them under the existing
// bed/VO chain; SFX never affects a frame (audio-only — the determinism
// law's audio corollary).
//
// The event mapping (taste, recorded once):
//   • pop        — the project's opening accent (scene 0, t=0).
//   • page-turn  — each scene start AFTER scene 0 whose board is CLEAN
//                  (the hard wipe is the page event; a continuous scene
//                  carries no page — the carry IS the continuity).
//   • pen-stroke — each stroke/text start (the pen touching down).
//   • pen-stop   — each stroke/text end, but ONLY when the following gap
//                  is long enough to hear it (≥ PEN_STOP_MIN_GAP_MS — a
//                  130ms pen-lift between flush strokes would flutter).
// Budget: the amix graph is bounded (WB_SFX_CUES_MAX_PER_SCENE); the cap
// drops the LOWEST-priority overflow chronologically (deterministic).
import type { WhiteboardProject } from "./storyboard";
import { type WhiteboardClockScene } from "./tracks";
import type { AnimationEvent } from "./storyboard";
import type { WbSfxKind } from "../sfx";

export interface SfxCue {
  kind: WbSfxKind;
  /** Scene-relative time (ms) — the assembler adds the scene's clock offset. */
  atMs: number;
  sceneIndex: number;
}

/** The gap that makes a pen-stop audible (the PATH_GAP_MS flush gap of
 *  130ms is too tight; the hold/lead-in stretches are the audience). */
export const PEN_STOP_MIN_GAP_MS = 400;
/** The amix graph's per-scene wall (48 cues ≈ the practical filter budget). */
export const WB_SFX_CUES_MAX_PER_SCENE = 48;

const PRIORITY: Record<WbSfxKind, number> = { pop: 0, "page-turn": 1, "pen-stop": 2, "pen-stroke": 3 };

/** The pen events in chronological order (stable: start, then duration). */
function penEvents(events: AnimationEvent[]): { startMs: number; endMs: number }[] {
  const pen = events
    .filter((e): e is Extract<AnimationEvent, { type: "draw_path" | "write_text" }> => e.type === "draw_path" || e.type === "write_text")
    .map((e) => ({ startMs: e.startMs, endMs: e.startMs + e.durationMs }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return pen;
}

/**
 * Plan the SFX cues for one scene. `isFirstScene` gates the opening pop;
 * `boardClean` gates the page-turn (a continuous scene carries — no page).
 */
export function planSceneSfxCues(
  opts: {
    isFirstScene: boolean;
    boardClean: boolean;
    durationMs: number;
  },
  events: AnimationEvent[]
): SfxCue[] {
  const cues: SfxCue[] = [];
  if (opts.isFirstScene) cues.push({ kind: "pop", atMs: 0, sceneIndex: 0 });
  else if (opts.boardClean) cues.push({ kind: "page-turn", atMs: 0, sceneIndex: -1 });
  const pen = penEvents(events);
  for (let i = 0; i < pen.length; i++) {
    const p = pen[i];
    cues.push({ kind: "pen-stroke", atMs: p.startMs, sceneIndex: -1 });
    const gapAfter = i + 1 < pen.length ? pen[i + 1].startMs - p.endMs : opts.durationMs - p.endMs;
    if (p.endMs < opts.durationMs && gapAfter >= PEN_STOP_MIN_GAP_MS) {
      cues.push({ kind: "pen-stop", atMs: p.endMs, sceneIndex: -1 });
    }
  }
  // The cap: keep the highest-priority cues, ties broken chronologically —
  // deterministic, and the accents (pop/page-turn) always survive.
  if (cues.length > WB_SFX_CUES_MAX_PER_SCENE) {
    const ranked = cues
      .map((c, i) => ({ c, i }))
      .sort((a, b) => PRIORITY[a.c.kind] - PRIORITY[b.c.kind] || a.c.atMs - b.c.atMs || a.i - b.i);
    const kept = new Set(ranked.slice(0, WB_SFX_CUES_MAX_PER_SCENE).map((r) => r.i));
    return cues.filter((_, i) => kept.has(i));
  }
  return cues;
}

/**
 * The project's full cue plan, per scene, with ABSOLUTE composition-clock
 * times (the frame-quantized clock's own scene starts — the same numbers
 * the concat delivers). Pure; the renderer assembles exactly these.
 */
export function whiteboardSfxCues(
  project: WhiteboardProject,
  clock: { scenes: WhiteboardClockScene[] },
  eventsByScene: AnimationEvent[][]
): { cues: SfxCue[]; startMsByScene: number[] } {
  if (clock.scenes.length !== project.scenes.length || eventsByScene.length !== project.scenes.length) {
    throw new Error(
      "whiteboard sfx plan: the clock, the events, and the project disagree — an engine bug, not a project problem"
    );
  }
  const cues: SfxCue[] = [];
  const startMsByScene: number[] = [];
  for (let i = 0; i < project.scenes.length; i++) {
    const sceneStartMs = Math.round(clock.scenes[i].startSec * 1000);
    startMsByScene.push(sceneStartMs);
    for (const c of planSceneSfxCues(
      { isFirstScene: i === 0, boardClean: (project.scenes[i].board?.mode ?? "clean") === "clean", durationMs: Math.round(clock.scenes[i].deliveredSec * 1000) },
      eventsByScene[i] ?? []
    )) {
      // The per-scene cues are scene-relative; the project plan is ABSOLUTE
      // (the scene's own frame-quantized start + the cue's offset).
      cues.push({ kind: c.kind, atMs: sceneStartMs + c.atMs, sceneIndex: i });
    }
  }
  return { cues, startMsByScene };
}

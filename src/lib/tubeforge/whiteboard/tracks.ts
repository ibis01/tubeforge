// S87 slice 3 — the Whiteboard engine EMITS timeline tracks: the planner's
// frame plan mapped onto the Universal Timeline contract's vocabulary.
//
// The peer-MODE law, evolved (design §3 slice 3): the whiteboard engine
// stays a PEER at the engine level (own planner, own renderer, own Studio)
// but is UNIFIED at the contract level — its composition truth (per-scene
// windows on the composition clock, the VO slots, the music bed) is
// expressed in the SAME track/clip grammar every other engine speaks, so
// the compositor, the QC battery and the critic read one composition truth.
//
// The clock law — frame quantization: the whiteboard renderer delivers
// frameCount(durationMs, fps) frames per scene and encodes each scene at
// exactly frames/fps seconds; the contract's windows therefore carry the
// FRAME-QUANTIZED durations (what actually lands in final.mp4), never the
// estimator's raw milliseconds. `framePlanClock` is the one derivation of
// that clock; the renderer and the tracks share it by construction.
//
// Pure, deterministic, ffmpeg-free. The whiteboard module stays a leaf:
// this imports the shared contract types (timeline.ts) + the engine's own
// timing module — never Director, never generation APIs (the §1 laws).
import type { TimelineClip, TimelineTrack, TimelineTrackKind } from "../timeline";
import { frameCount } from "./timing";
import type { WhiteboardProject } from "./storyboard";

/** round to the contract's 2-dp composition clock */
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** One scene's window on the shared frame-quantized clock. */
export interface WhiteboardClockScene {
  /** Delivered frames (the encoder's exact count). */
  frames: number;
  /** Delivered seconds — frames/fps, EXACT (the encode's own -t math). */
  deliveredSec: number;
  /** Window on the composition clock (2-dp edges, contiguous by construction). */
  startSec: number;
  endSec: number;
}

/**
 * The frame plan's clock: per-scene windows + the doc total, derived EXACTLY
 * the way the renderer delivers (frameCount per scene, frames/fps encode).
 * Contiguity holds by construction: each edge is the running exact cursor
 * rounded to the 2-dp clock, so clip[i].endSec === clip[i+1].startSec and
 * totalSec === r2(sum of deliveredSec). Junk input (non-finite or
 * non-positive ms) is a CALLER bug — the estimator (estimateProjectFrames)
 * clamps every scene to [4s, 30s] — so it refuses loudly rather than
 * emitting a window the plan reader would have to reject.
 */
export function framePlanClock(
  sceneMs: number[],
  fps: number
): { scenes: WhiteboardClockScene[]; totalSec: number } {
  const out: WhiteboardClockScene[] = [];
  let cursor = 0; // exact (unrounded) running position
  for (const ms of sceneMs) {
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new Error(
        `whiteboard frame plan received a junk scene duration (${String(ms)}ms) — the estimator clamps every scene, so this is an engine bug`
      );
    }
    const frames = frameCount(ms, fps);
    const deliveredSec = frames / fps;
    const startSec = r2(cursor);
    cursor += deliveredSec;
    out.push({ frames, deliveredSec, startSec, endSec: r2(cursor) });
  }
  return { scenes: out, totalSec: r2(cursor) };
}

/** The story-row linkage: the scaffold names scenes `scene-<storyIndex>`
 * (the only mapping the WAV layout supports); hand-authored ids carry no
 * row linkage — null is the honest read, position still orders the clip. */
function rowSceneIndex(sceneId: string): number | null {
  const m = /^scene-(\d+)$/.exec(sceneId);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 && n <= 999 ? n : null;
}

export interface WhiteboardTracksOptions {
  /** Whiteboard scene ids that carry a real narration WAV this render (the
   *  VO slots — clips exist only where audio actually plays). */
  voSceneIds: Iterable<string>;
  /** Whether the music bed rides this render (the job resolved a track). */
  musicOn: boolean;
}

/**
 * Map the frame plan onto contract tracks — the planner's composition truth
 * in the universal grammar:
 *
 * • VISUAL track, kind "whiteboard" — one clip per whiteboard scene over
 *   its frame-quantized window. `asset: null` (the frame is DRAWN by the
 *   engine — the contract's "null = the frame is generated" law); the
 *   engine's own doc (the project) stays the execution truth, the clip is
 *   the composition fact. Scene boundaries are the concat's hard cuts —
 *   transitionIn/Out stay null (no blend machinery between boards).
 * • AUDIO track — one clip per VO-carrying scene over the same window (the
 *   encoder pads VO to the scene duration, so the window IS the slot), plus
 *   ONE doc-spanning music-bed clip (`a-music`, sceneIndex null) when the
 *   bed is on — the same bed id grammar the story lane's derivation uses.
 * • SUBTITLE track — empty (whiteboard narration is drawn, not captioned;
 *   shape-stable for the compositor's dispatch).
 */
export function whiteboardTracks(
  project: WhiteboardProject,
  sceneMs: number[],
  opts: WhiteboardTracksOptions
): TimelineTrack[] {
  if (sceneMs.length !== project.scenes.length) {
    throw new Error(
      `whiteboard tracks: ${sceneMs.length} durations for ${project.scenes.length} scenes — the frame plan and the project disagree (engine bug)`
    );
  }
  const clock = framePlanClock(sceneMs, project.fps);
  const voIds = new Set(opts.voSceneIds);

  const visualClips: TimelineClip[] = project.scenes.map((scene, i) => ({
    id: `wb${i}`,
    kind: "whiteboard" as TimelineTrackKind,
    sceneIndex: rowSceneIndex(scene.id),
    startSec: clock.scenes[i].startSec,
    endSec: clock.scenes[i].endSec,
    transitionIn: null,
    transitionOut: null,
    asset: null, // the frame is drawn by the engine, not referenced
  }));

  const audioClips: TimelineClip[] = [];
  project.scenes.forEach((scene, i) => {
    if (!voIds.has(scene.id)) return;
    audioClips.push({
      id: `a-wb${i}`,
      kind: "audio",
      sceneIndex: rowSceneIndex(scene.id),
      startSec: clock.scenes[i].startSec,
      endSec: clock.scenes[i].endSec,
      transitionIn: null,
      transitionOut: null,
      asset: null,
    });
  });
  if (opts.musicOn && project.scenes.length > 0) {
    audioClips.push({
      id: "a-music", // the contract's bed grammar — doc-spanning, not scene-bound
      kind: "audio",
      sceneIndex: null,
      startSec: 0,
      endSec: clock.totalSec,
      transitionIn: null,
      transitionOut: null,
      asset: null,
    });
  }

  return [
    { kind: "whiteboard", name: "visual", clips: visualClips },
    { kind: "audio", name: "audio", clips: audioClips },
    { kind: "subtitle", name: "subtitle", clips: [] },
  ];
}

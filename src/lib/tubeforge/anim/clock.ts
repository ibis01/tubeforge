// Stage S — the shared animation substrate: the clock (S120 §8).
//
// Frame quantization + the shared frame-budget wall — the ONE clock the
// new engines (G1, K1) quantize their windows through, matching the
// whiteboard's framePlanClock BYTE-BEHAVIOR (the suite pins the two side
// by side; the whiteboard keeps its own copy until its soak gate clears —
// S120 §8: byte-identity beats elegance where determinism is pinned).
//
// Laws: pure (no fs, no clock, no randomness); junk durations are a CALLER
// bug (the estimator clamps every scene to [4s, 30s]) and refuse loudly;
// edges ride the exact running cursor rounded to the 2-dp clock, so
// windows are contiguous by construction.

/** The shared frame-budget wall — ONE wall, two engines. 25,920 frames =
 *  18 minutes at 24 fps, the same number the whiteboard's
 *  WB_RENDER_FRAME_BUDGET pins (timing.ts S65); G1/K1 declare their own
 *  named walls against this constant. The renderer MUST refuse a project
 *  whose estimated frame count exceeds the wall BEFORE chromium launches
 *  (the E0 audit §6 risk 4 receipt: 4GB workers OOM on long renders). */
export const ANIM_FRAME_BUDGET = 25_920;

/** round to the contract's 2-dp composition clock (tracks.ts r2 — the
 *  same arithmetic, generalized). */
export function quantizeClock(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Delivered frames for a duration at fps — the encoder's exact count
 *  (whiteboard timing.ts frameCount — the same arithmetic, generalized). */
export function frameCountOf(durationMs: number, fps: number): number {
  return Math.max(1, Math.round((durationMs / 1000) * fps));
}

export interface AnimClockScene {
  /** Delivered frames (the encoder's exact count). */
  frames: number;
  /** Delivered seconds — frames/fps, exactly what the encoder lays down. */
  deliveredSec: number;
  startSec: number;
  endSec: number;
}

/** The frame plan's clock, engine-neutral: per-scene windows + the total,
 *  derived EXACTLY the way a renderer delivers (frameCount per scene,
 *  frames/fps encode). Contiguity holds by construction: each edge is the
 *  running exact cursor rounded to the 2-dp clock, so window[i].endSec ===
 *  window[i+1].startSec and totalSec === quantizeClock(Σ deliveredSec). */
export function framePlanWindows(
  sceneMs: number[],
  fps: number
): { scenes: AnimClockScene[]; totalSec: number } {
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`framePlanWindows received a junk fps (${String(fps)})`);
  }
  const out: AnimClockScene[] = [];
  let cursor = 0; // exact (unrounded) running position
  for (const ms of sceneMs) {
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new Error(
        `the frame plan received a junk scene duration (${String(ms)}ms) — the estimator clamps every scene, so this is a planner bug`
      );
    }
    const frames = frameCountOf(ms, fps);
    const deliveredSec = frames / fps;
    const startSec = quantizeClock(cursor);
    cursor += deliveredSec;
    out.push({ frames, deliveredSec, startSec, endSec: quantizeClock(cursor) });
  }
  return { scenes: out, totalSec: quantizeClock(cursor) };
}

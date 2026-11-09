// rendering/renderer.ts — public renderer surface (E2 §6, plan §6).
//
// The WhiteboardRenderer interface is the engine boundary. It accepts a
// validated WhiteboardProject (zod-parsed, referential integrity checked),
// evaluates every frame on the project timeline, rasterizes each frame to
// PNG and encodes the PNGs into a deterministic MP4.
//
// Queue integration (E12) is intentionally NOT in this module — the
// renderer is the synchronous core invoked by the worker process; the
// queue wraps it with persistence, retries and progress reporting.

import { evaluateFrame, projectDurationMs, type FrameState } from "../animator";
import { composeFrameSvg } from "../composer";
import { rasterizeSvg } from "../rasterizer";
import { encodeFrameStreamToMp4, type EncodeResult } from "../encoder";
import { validateReferences, type WhiteboardProject } from "../schemas";
import { assetRegistry } from "../asset-registry";

export interface RenderOptions {
  /** Output file path. Overwritten if it exists. */
  outPath: string;
  /**
   * Quality preset. "preview" renders at 640×360, fps/2 (faster iteration);
   * "final" renders at the project's full settings.width×height, full fps.
   */
  quality: "preview" | "final";
  /** Optional progress callback (current frame, total frames). */
  onProgress?: (current: number, total: number, label: string) => void;
  /** Optional: cap to the first N scenes (preview render of a long project). */
  sceneLimit?: number;
}

export interface RenderResult {
  outPath: string;
  frameCount: number;
  sha256: string;
  durationSec: number;
  bytes: number;
  width: number;
  height: number;
  fps: number;
}

export class RenderError extends Error {
  constructor(message: string) {
    super(`RenderError: ${message}`);
    this.name = "RenderError";
  }
}

/**
 * Render a whiteboard project to an MP4 file.
 *
 * Pre-conditions (caller's responsibility):
 *  - project has already been zod-parsed (migrateProject)
 *  - referential integrity has been checked (validateReferences)
 *  - all referenced assetIds exist in the registry
 *
 * The renderer double-checks references defensively (defense in depth) and
 * clips the timeline to the project's exact duration so two renders of the
 * same project produce byte-identical output.
 */
export async function renderProject(
  project: WhiteboardProject,
  opts: RenderOptions,
): Promise<RenderResult> {
  const registry = assetRegistry();
  validateReferences(project, registry);

  const fullDurationMs = projectDurationMs(project);
  if (fullDurationMs <= 0) {
    throw new RenderError("project has zero duration");
  }

  const isPreview = opts.quality === "preview";
  const fps = isPreview ? Math.max(12, Math.floor(project.settings.fps / 2)) : project.settings.fps;
  const width = isPreview ? 640 : project.settings.width;
  const height = isPreview ? Math.floor((width * project.settings.height) / project.settings.width) : project.settings.height;

  const frameIntervalMs = 1000 / fps;
  const frameCount = Math.max(1, Math.floor(fullDurationMs / frameIntervalMs));

  let effectiveFrames = frameCount;
  if (opts.sceneLimit && opts.sceneLimit > 0) {
    const cappedScenes = project.scenes.slice(0, opts.sceneLimit);
    const capDuration = cappedScenes.reduce((acc, s) => Math.max(acc, s.startMs + s.durationMs), 0);
    effectiveFrames = Math.max(1, Math.floor(capDuration / frameIntervalMs));
  }

  // Render + encode in a single streaming pass: each frame is rasterized,
  // yielded to the encoder (which writes it to a temp dir immediately),
  // then garbage-collected. This keeps peak memory bounded to ONE frame
  // buffer regardless of project length — essential for 1080p×1800-frame
  // renders that would otherwise hold 3.6 GB of PNGs in memory.
  async function* frameStream(): AsyncIterable<Buffer> {
    for (let i = 0; i < effectiveFrames; i++) {
      const tMs = Math.floor(i * frameIntervalMs);
      const state: FrameState = evaluateFrame(project, tMs);
      const svg = composeFrameSvg(state, width, height, {
        handStyle: project.settings.handStyle,
      });
      const png = rasterizeSvg(svg, {
        width,
        height,
        background: project.settings.background,
      });
      if (opts.onProgress && (i % 5 === 0 || i === effectiveFrames - 1)) {
        opts.onProgress(i + 1, effectiveFrames, `Drawing frame ${i + 1} of ${effectiveFrames}`);
      }
      yield png;
    }
  }

  const encodeResult: EncodeResult = await encodeFrameStreamToMp4(frameStream(), {
    fps,
    width,
    height,
    outPath: opts.outPath,
    onFrame: (i, total) => {
      if (opts.onProgress && total > 0) {
        opts.onProgress(i, total, `Encoding frame ${i} of ${total}`);
      }
    },
  });

  return {
    outPath: encodeResult.outPath,
    frameCount: encodeResult.frameCount,
    sha256: encodeResult.sha256,
    durationSec: encodeResult.durationSec,
    bytes: encodeResult.bytes,
    width,
    height,
    fps,
  };
}

/**
 * Convenience: render to a Buffer instead of a file path. Used by tests +
 * the determinism check.
 */
export async function renderProjectToBuffer(
  project: WhiteboardProject,
  opts: Omit<RenderOptions, "outPath">,
): Promise<{ mp4: Buffer; result: Omit<RenderResult, "outPath"> }> {
  const { mkdtempSync, rmSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const tmp = mkdtempSync(join(tmpdir(), "whiteboard-render-"));
  const outPath = join(tmp, "whiteboard.mp4");
  try {
    const result = await renderProject(project, { ...opts, outPath });
    const mp4 = readFileSync(outPath);
    const { outPath: _drop, ...rest } = result;
    return { mp4, result: rest };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

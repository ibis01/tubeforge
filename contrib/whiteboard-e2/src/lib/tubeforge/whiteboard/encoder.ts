// encoder.ts — PNG frames → MP4 (E2 §6).
//
// Reuses the codebase's zombie-aware proc.runProcess so a hung reaper
// (the bun + Playwright edge case documented in proc.ts) cannot stall a
// whiteboard render. Frames are written to a temp directory and consumed
// via ffmpeg's image2 demuxer (`-framerate FPS -i frame-%05d.png`); this
// avoids stdin-pipe complexity that proc.ts (which captures stdout to a
// temp file) does not natively support.
//
// Reproducibility flags (design §6): +bitexact on flags/fflags, libx264 +
// yuv420p + crf 18 + faststart. No metadata, no encoder tags, no B-frames
// that drift across encodes — same inputs → byte-identical MP4 (verified
// by the determinism test).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runProcess } from "../proc";

export interface EncodeOptions {
  /** Frame rate of the input frames (must match the project's fps). */
  fps: number;
  /** Output width in pixels. */
  width: number;
  /** Output height in pixels. */
  height: number;
  /** Output file path (will be overwritten if it exists). */
  outPath: string;
  /** Called once per frame as PNGs are written (progress reporting). */
  onFrame?: (index: number, total: number) => void;
}

export interface EncodeResult {
  outPath: string;
  frameCount: number;
  sha256: string;
  durationSec: number;
  bytes: number;
}

const FRAME_FILE_PATTERN = "frame-%05d.png";

/**
 * Encode an array of PNG buffers into an MP4 file.
 *
 * @param frames PNG buffers, in order, exactly `total` of them.
 * @param opts    Encode options.
 *
 * @deprecated Prefer {@link encodeFrameStreamToMp4} — accumulating all frames
 * in memory before encoding is impractical for 1080p renders (1800 frames ×
 * ~2 MB = 3.6 GB). This overload is kept for the determinism test.
 */
export async function encodeFramesToMp4(
  frames: Buffer[],
  opts: EncodeOptions,
): Promise<EncodeResult> {
  return encodeFrameStreamToMp4(
    (function* () {
      for (const f of frames) yield f;
    })(),
    opts,
  );
}

/**
 * Encode a stream of PNG buffers into an MP4 file. Frames are written to a
 * temp directory one at a time (no accumulation in memory); ffmpeg reads
 * them via the image2 demuxer once the stream is exhausted. This is the
 * path the renderer uses for full 1080p renders.
 */
export async function encodeFrameStreamToMp4(
  frames: Iterable<Buffer> | AsyncIterable<Buffer>,
  opts: EncodeOptions,
): Promise<EncodeResult> {
  if (!Number.isInteger(opts.fps) || opts.fps < 1) {
    throw new Error(`encodeFrameStreamToMp4: invalid fps ${opts.fps}`);
  }

  const tmp = await mkdtemp(join(tmpdir(), "whiteboard-encode-"));
  try {
    let total = 0;
    const collected: Promise<void>[] = [];
    const writeOne = async (frame: Buffer) => {
      const idx = total + 1; // 1-indexed to match %05d pattern
      const fname = join(tmp, FRAME_FILE_PATTERN.replace("%05d", String(idx).padStart(5, "0")));
      await writeFile(fname, frame);
      opts.onFrame?.(idx, -1); // total unknown while streaming
    };

    const maybeAsync = frames as AsyncIterable<Buffer>;
    if (maybeAsync && typeof maybeAsync[Symbol.asyncIterator] === "function") {
      for await (const f of maybeAsync) {
        total++;
        await writeOne(f);
      }
    } else {
      for (const f of frames as Iterable<Buffer>) {
        total++;
        await writeOne(f);
      }
    }

    if (total === 0) {
      throw new Error("encodeFrameStreamToMp4: no frames to encode");
    }

    // Re-emit final progress with the known total
    opts.onFrame?.(total, total);

    const inputPattern = join(tmp, FRAME_FILE_PATTERN);
    const args = [
      "-y",
      "-framerate", String(opts.fps),
      "-i", inputPattern,
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-vf", `scale=${opts.width}:${opts.height}:flags=lanczos,format=yuv420p`,
      "-map_metadata", "-1",
      "-fflags", "+bitexact",
      "-flags", "+bitexact",
      "-movflags", "+faststart",
      "-bf", "0",
      "-g", String(opts.fps * 2),
      opts.outPath,
    ];

    const result = await runProcess("ffmpeg", args, {
      timeoutMs: 10 * 60 * 1000,
      label: "whiteboard-encode",
    });

    const { statSync } = await import("node:fs");
    let stat;
    try {
      stat = statSync(opts.outPath);
    } catch {
      const tail = (result.stderr || "").split("\n").slice(-15).join("\n");
      throw new Error(
        `encodeFrameStreamToMp4: ffmpeg did not produce output at ${opts.outPath}\n${tail}`,
      );
    }
    if (stat.size < 1024) {
      throw new Error(
        `encodeFrameStreamToMp4: output ${opts.outPath} is suspiciously small (${stat.size} bytes)`,
      );
    }

    const sha256 = await sha256File(opts.outPath);
    const durationSec = await probeDurationSec(opts.outPath);

    return {
      outPath: opts.outPath,
      frameCount: total,
      sha256,
      durationSec,
      bytes: stat.size,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const { createReadStream } = require("node:fs") as typeof import("node:fs");
    const s = createReadStream(filePath);
    s.on("data", (b: Buffer) => h.update(b));
    s.on("end", () => resolve(h.digest("hex")));
    s.on("error", reject);
  });
}

async function probeDurationSec(filePath: string): Promise<number> {
  try {
    const result = await runProcess("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "json",
      filePath,
    ], { timeoutMs: 30_000, label: "whiteboard-probe" });
    const parsed = JSON.parse(result.stdout || result.stderr || "{}") as { format?: { duration?: string } };
    const d = Number(parsed.format?.duration ?? 0);
    if (!Number.isFinite(d) || d <= 0) return 0;
    return d;
  } catch {
    return 0;
  }
}

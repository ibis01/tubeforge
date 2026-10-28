// Music bed preview — "hear it before you pick it".
//
// GET /api/music/preview?id=<bedId> → 7-second audio/wav sample (faded).
//   • Preset beds: synthesized from the same lavfi graphs the render mixer
//     uses, so the preview IS what the video will sound like.
//   • Custom uploads: a slice from the uploaded file (starting ~25% in),
//     loudness-matched so quiet tracks are still audible in the picker.
// Samples are cached on disk (uploads/music/previews) so repeat auditions
// never re-run ffmpeg; custom previews auto-regenerate when the source
// track is re-uploaded (mtime check).

import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { resolveBedPreview, MUSIC_DIR } from "@/lib/tubeforge/music";

const execFileAsync = promisify(execFile);

const PREVIEW_SEC = 7;
const PREVIEW_DIR = path.join(MUSIC_DIR, "previews");
const FADE_FILTER =
  `afade=t=in:d=0.4,afade=t=out:st=${(PREVIEW_SEC - 0.8).toFixed(2)}:d=0.8,` +
  `aformat=sample_rates=44100:channel_layouts=stereo`;

async function probeDuration(file: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", file,
    ]);
    const d = Number(stdout.trim());
    return Number.isFinite(d) ? d : 0;
  } catch {
    return 0;
  }
}

/** Render (or reuse) the cached preview WAV for a bed id. */
async function getPreviewBuffer(bedId: string): Promise<Buffer | null> {
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  const safeId = bedId.replace(/[^a-z0-9-]/g, "").slice(0, 60);
  if (!safeId) return null;
  const cachePath = path.join(PREVIEW_DIR, `${safeId}.wav`);

  const source = await resolveBedPreview(bedId);
  if (!source) return null;
  const { graph, file: customFile, isPreset } = source;
  if (!graph && !customFile) return null;

  // Customs: invalidate the cache when the source file changed (re-upload).
  if (customFile && fs.existsSync(cachePath)) {
    const src = fs.statSync(customFile).mtimeMs;
    const cached = fs.statSync(cachePath).mtimeMs;
    if (cached > src) return fs.readFileSync(cachePath);
  } else if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath);
  }

  const args: string[] = ["-hide_banner", "-loglevel", "error"];
  if (graph) {
    args.push("-f", "lavfi", "-t", String(PREVIEW_SEC), "-i", graph);
  } else if (customFile) {
    // Sample from ~25% into the track (intros are often silent).
    const dur = await probeDuration(customFile);
    const start = dur > PREVIEW_SEC + 1 ? Math.min(dur * 0.25, dur - PREVIEW_SEC - 0.5) : 0;
    args.push("-ss", start.toFixed(2), "-t", String(PREVIEW_SEC), "-i", customFile);
  }
  // Loudness-match customs so quiet uploads are still audible in the picker.
  // (Original beds are loudness-anchored at -16 LUFS — no boost for them.)
  const post = customFile && !isPreset ? `${FADE_FILTER},volume=6dB` : FADE_FILTER;
  args.push("-af", post, "-c:a", "pcm_s16le", "-y", cachePath);

  await execFileAsync("ffmpeg", args, { timeout: 60_000 });
  return fs.readFileSync(cachePath);
}

export async function GET(req: NextRequest) {
  const bedId = req.nextUrl.searchParams.get("id")?.trim() || "";
  if (!bedId || bedId === "none")
    return NextResponse.json({ error: "No preview for this bed" }, { status: 400 });

  try {
    const buffer = await getPreviewBuffer(bedId);
    if (!buffer)
      return NextResponse.json(
        { error: "Unknown music track — pick one from the library" },
        { status: 404 }
      );
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(buffer.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Preview failed" },
      { status: 502 }
    );
  }
}

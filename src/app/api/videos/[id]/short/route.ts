import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { db } from "@/lib/db";
import { startJob, isJobRunning, lastJobError, setJobProgress } from "@/lib/tubeforge/jobs";
import { parseScenes } from "@/lib/tubeforge/story";
import { renderShort } from "@/lib/tubeforge/shorts";
import { serializeVideo } from "@/lib/tubeforge/serialize";

type Ctx = { params: Promise<{ id: string }> };

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

/**
 * POST — cut a 9:16 vertical Short out of the rendered final video as a
 * background job (202). Body: { sceneIndex?: number } — omit for auto-pick.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });

  if (video.format !== "story")
    return NextResponse.json(
      { error: "Shorts are cut from scene-story videos — classic formats have no rendered MP4" },
      { status: 400 }
    );

  const finalPath = path.join(UPLOAD_ROOT, id, "final.mp4");
  if (!fs.existsSync(finalPath))
    return NextResponse.json(
      { error: "Render the final video first — Shorts are cut from the rendered master" },
      { status: 400 }
    );

  let sceneIndex: number | null = null;
  try {
    const body = (await req.json()) as { sceneIndex?: number | null };
    if (body && Number.isInteger(body.sceneIndex))
      sceneIndex = Number(body.sceneIndex);
  } catch {
    /* no body = auto-pick */
  }

  const scenes = parseScenes(video.scenes);
  if (scenes.length === 0)
    return NextResponse.json({ error: "This video has no scenes" }, { status: 400 });

  // Clear any stale error before the job starts.
  await db.video.update({ where: { id }, data: { error: null } });

  const accepted = await startJob(id, "short", async () => {
    try {
      const result = await renderShort({
        videoId: id,
        scenes,
        sceneIndex,
        motion: {
          mode: (video.motionMode ?? "smart") as "smart" | "zoom" | "pan" | "off",
          intensity: video.motionIntensity ?? 12,
          curve: (video.motionCurve ?? "smooth") as "smooth" | "linear",
          vary: video.motionVary ?? true,
        },
        onProgress: (label) => setJobProgress(id, "short", 1, 2, label),
      });

      await db.video.update({
        where: { id },
        data: {
          hasShort: true,
          shortScene: result.sceneIndex,
          shortDuration: result.durationSec,
          error: null,
        },
      });

      await db.activity.create({
        data: {
          videoId: id,
          stage: "short",
          message: `Vertical Short cut from scene ${result.sceneIndex}${result.autoPicked ? " (auto-picked)" : ""} — ${result.durationSec.toFixed(1)}s 9:16`,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Short render failed";
      await db.video.update({ where: { id }, data: { error: message } });
      await db.activity.create({
        data: {
          videoId: id,
          stage: "short",
          level: "error",
          message: `Short render failed: ${message}`,
        },
      });
      throw err;
    }
  });

  return NextResponse.json(
    { accepted, generating: true },
    { status: accepted ? 202 : 200 }
  );
}

/** GET — short state for the detail dialog (drives button + preview). */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const hasFile = video.hasShort && fs.existsSync(path.join(UPLOAD_ROOT, id, "short.mp4"));

  return NextResponse.json({
    generating: isJobRunning(id, "short"),
    error: lastJobError(id, "short") ?? video.error,
    hasShort: hasFile,
    shortUrl: hasFile ? `/api/videos/${id}/mp4?variant=short` : null,
    durationSec: hasFile ? video.shortDuration : null,
    sceneIndex: hasFile ? video.shortScene : null,
    video: serializeVideo(video),
  });
}

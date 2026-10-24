import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { startJob, isJobRunning, lastJobError } from "@/lib/tubeforge/jobs";
import { isConnected, uploadToYouTube } from "@/lib/tubeforge/youtube";
import { serializeVideo } from "@/lib/tubeforge/serialize";
import fs from "fs";
import path from "path";

type Ctx = { params: Promise<{ id: string }> };

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

/**
 * POST — upload the rendered MP4 to YouTube as a background job (202).
 * Requires: a rendered final.mp4 + a connected channel (Settings).
 * On success the video row gets youtubeUrl + status "published".
 */
export async function POST(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const finalPath = path.join(UPLOAD_ROOT, id, "final.mp4");
  if (!fs.existsSync(finalPath))
    return NextResponse.json(
      {
        error:
          video.format === "story"
            ? "Render the final video first — uploads deliver the MP4 file"
            : "Only scene-story videos render an MP4 to upload (classic formats export a ZIP package)",
      },
      { status: 400 }
    );
  if (!(await isConnected()))
    return NextResponse.json(
      { error: "YouTube channel is not connected — add OAuth credentials in Settings first" },
      { status: 400 }
    );
  if (video.youtubeUrl)
    return NextResponse.json(
      { error: "Already uploaded", video: null, youtubeUrl: video.youtubeUrl },
      { status: 409 }
    );

  // Clear any stale error before the job starts.
  await db.video.update({ where: { id }, data: { error: null } });

  const accepted = await startJob(id, "upload", async () => {
    try {
      const tags = video.tags
        ? video.tags.split(",").map((t) => t.trim()).filter(Boolean)
        : [];

      const result = await uploadToYouTube({
        title: (video.title ?? video.topic).slice(0, 100),
        description: video.description ?? "",
        tags,
        filePath: finalPath,
        fileSize: fs.statSync(finalPath).size,
        thumbnailPath: fs.existsSync(path.join(UPLOAD_ROOT, id, "thumbnail.png"))
          ? path.join(UPLOAD_ROOT, id, "thumbnail.png")
          : null,
      });

      await db.video.update({
        where: { id },
        data: { youtubeUrl: result.url, status: "published", error: null },
      });

      await db.activity.create({
        data: {
          videoId: id,
          stage: "upload",
          message: `Uploaded to YouTube${result.thumbnailSet ? " with custom thumbnail" : ""} — ${result.url}`,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed";
      await db.video.update({ where: { id }, data: { error: message } });
      await db.activity.create({
        data: {
          videoId: id,
          stage: "upload",
          level: "error",
          message: `YouTube upload failed: ${message}`,
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

/** GET — quick upload state for the detail dialog (drives the button state). */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });

  return NextResponse.json({
    uploading: isJobRunning(id, "upload"),
    error: lastJobError(id, "upload"),
    youtubeUrl: video.youtubeUrl,
    video: serializeVideo(video),
  });
}
